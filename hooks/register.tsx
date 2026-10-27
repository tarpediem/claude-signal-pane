import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Conversation,
  DeliveryStatus,
  SignalAttachment,
  SignalMessage,
  SignalModel,
} from '../types'

const PANE = 'signal'
// Filled at session.start from the plugin options and the host's $HOME.
const paths = {
  log: '',
  // Messages sent from the pane: the daemon does not echo its own sends, so the mod logs them.
  sent: '',
  attachments: '',
  rpc: '',
}
// The host's time zone, read off /etc/localtime: the hooks worker may not run in it.
const zone: Intl.DateTimeFormatOptions = {}
const POLL_MS = 3000
const NAMES_MS = 5 * 60 * 1000
const TYPING_MS = 15000
const SHOWN_MESSAGES = 80
const SHOWN_THUMBNAILS = 6
const THUMB_PX = 320

const model = atom({ plugin: 'signal-pane', key: 'model' } as const, {
  conversations: [],
  status: 'Starting…',
} as SignalModel)
const selected = atom(
  { plugin: 'signal-pane', key: 'selected' } as const,
  null as string | null,
)
const sentCount = atom({ plugin: 'signal-pane', key: 'sentCount' } as const, 0)
// Timestamp of the message whose reaction bar is open.
const reactingTo = atom(
  { plugin: 'signal-pane', key: 'reactingTo' } as const,
  null as number | null,
)
// How many of a thread's newest messages are skipped: the pane pins the
// reply bar to its bottom, so older messages are reached by paging, not scrolling.
const historyOffset = atom({ plugin: 'signal-pane', key: 'historyOffset' } as const, 0)
const HISTORY_STEP = 10
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

export type Directory = {
  // Conversation id → display name, for contacts and groups.
  names: Map<string, string>
  // Phone-number id → uuid id of the same contact.
  aliases: Map<string, string>
  groups: Set<string>
}

type RawAttachment = {
  id?: string
  contentType?: string
  filename?: string | null
  width?: number
  height?: number
}

type DataMessage = {
  timestamp?: number
  message?: string | null
  groupInfo?: { groupId?: string }
  attachments?: RawAttachment[]
  reaction?: {
    emoji?: string
    isRemove?: boolean
    targetSentTimestamp?: number
  }
  remoteDelete?: { timestamp?: number }
  sticker?: unknown
}

type Envelope = {
  sourceUuid?: string
  sourceNumber?: string
  sourceName?: string
  timestamp?: number
  dataMessage?: DataMessage
  editMessage?: { targetSentTimestamp?: number; dataMessage?: DataMessage }
  syncMessage?: {
    sentMessage?: DataMessage & {
      destinationUuid?: string
      destinationNumber?: string
    }
  }
  typingMessage?: { action?: string; timestamp?: number; groupId?: string }
  receiptMessage?: {
    isDelivery?: boolean
    isRead?: boolean
    isViewed?: boolean
    timestamps?: number[]
  }
}

function peerId(uuid?: string, number?: string): string | null {
  if (uuid) return `u:${uuid}`
  if (number) return `n:${number}`
  return null
}

function bodyOf(data: DataMessage): { text: string; attachments: SignalAttachment[] } | null {
  const attachments = (data.attachments ?? [])
    .filter(file => file.id)
    .map(file => ({
      id: file.id as string,
      contentType: file.contentType ?? 'application/octet-stream',
      filename: file.filename ?? undefined,
      width: file.width,
      height: file.height,
    }))
  const text = data.message ?? (data.sticker ? '[sticker]' : '')
  if (!text && attachments.length === 0) return null
  return { text, attachments }
}

const STATUS_RANK: Record<DeliveryStatus, number> = { sent: 0, delivered: 1, read: 2 }

export function parseLog(text: string, directory: Directory, now = Date.now()): Conversation[] {
  const canon = (id: string) => directory.aliases.get(id) ?? id
  const seenNames = new Map<string, string>()
  const nameOf = (id: string, fallback?: string) =>
    directory.names.get(id) ?? seenNames.get(id) ?? fallback ?? id.replace(/^[un]:/, '')
  const byId = new Map<string, Conversation>()
  const byTimestamp = new Map<number, SignalMessage>()
  const receipts = new Map<number, DeliveryStatus>()
  const reactions: { target: number; emoji: string; from: string; isRemove: boolean }[] = []
  const edits: { target: number; text: string; isDelete: boolean }[] = []

  const conversation = (id: string, isGroup: boolean, fallbackName?: string) => {
    let found = byId.get(id)
    if (!found) {
      found = { id, name: nameOf(id, fallbackName), isGroup, lastAt: 0, messages: [] }
      byId.set(id, found)
    }
    return found
  }
  const add = (target: Conversation, message: SignalMessage) => {
    target.messages.push(message)
    target.lastAt = Math.max(target.lastAt, message.timestamp)
    byTimestamp.set(message.timestamp, message)
  }

  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    let parsed: { envelope?: Envelope; params?: { envelope?: Envelope } }
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const envelope = parsed.envelope ?? parsed.params?.envelope
    if (!envelope) continue
    const rawFrom = peerId(envelope.sourceUuid, envelope.sourceNumber)
    const from = rawFrom ? canon(rawFrom) : null
    if (from && envelope.sourceName) seenNames.set(from, envelope.sourceName)
    const senderName = from ? nameOf(from, envelope.sourceName) : '?'

    const sent = envelope.syncMessage?.sentMessage
    if (sent) {
      const groupId = sent.groupInfo?.groupId
      const rawTo = peerId(sent.destinationUuid, sent.destinationNumber)
      const id = groupId ? `g:${groupId}` : rawTo ? canon(rawTo) : null
      if (!id) continue
      if (sent.reaction?.targetSentTimestamp) {
        reactions.push({
          target: sent.reaction.targetSentTimestamp,
          emoji: sent.reaction.emoji ?? '',
          from: 'Moi',
          isRemove: Boolean(sent.reaction.isRemove),
        })
        continue
      }
      if (sent.remoteDelete?.timestamp) {
        edits.push({ target: sent.remoteDelete.timestamp, text: '', isDelete: true })
        continue
      }
      const body = bodyOf(sent)
      if (!body) continue
      add(conversation(id, Boolean(groupId), sent.destinationNumber), {
        timestamp: sent.timestamp ?? envelope.timestamp ?? 0,
        sender: 'Moi',
        authorId: 'me',
        isMine: true,
        ...body,
        reactions: [],
        status: 'sent',
      })
      continue
    }

    if (!from) continue

    const typing = envelope.typingMessage
    if (typing) {
      const target = conversation(typing.groupId ? `g:${typing.groupId}` : from, Boolean(typing.groupId))
      if (typing.action === 'STARTED') {
        target.typing = { name: senderName, at: typing.timestamp ?? 0 }
      } else if (target.typing?.name === senderName) {
        target.typing = undefined
      }
      continue
    }

    const receipt = envelope.receiptMessage
    if (receipt) {
      const level: DeliveryStatus = receipt.isRead || receipt.isViewed ? 'read' : 'delivered'
      for (const timestamp of receipt.timestamps ?? []) {
        const known = receipts.get(timestamp)
        if (!known || STATUS_RANK[level] > STATUS_RANK[known]) receipts.set(timestamp, level)
      }
      continue
    }

    if (envelope.editMessage?.dataMessage && envelope.editMessage.targetSentTimestamp) {
      edits.push({
        target: envelope.editMessage.targetSentTimestamp,
        text: envelope.editMessage.dataMessage.message ?? '',
        isDelete: false,
      })
      continue
    }

    const data = envelope.dataMessage
    if (!data) continue
    if (data.reaction?.targetSentTimestamp) {
      reactions.push({
        target: data.reaction.targetSentTimestamp,
        emoji: data.reaction.emoji ?? '',
        from: senderName,
        isRemove: Boolean(data.reaction.isRemove),
      })
      continue
    }
    if (data.remoteDelete?.timestamp) {
      edits.push({ target: data.remoteDelete.timestamp, text: '', isDelete: true })
      continue
    }
    const body = bodyOf(data)
    if (!body) continue
    const groupId = data.groupInfo?.groupId
    const target = conversation(groupId ? `g:${groupId}` : from, Boolean(groupId), envelope.sourceName)
    if (target.typing?.name === senderName) target.typing = undefined
    add(target, {
      timestamp: data.timestamp ?? envelope.timestamp ?? 0,
      sender: senderName,
      authorId: from,
      isMine: false,
      ...body,
      reactions: [],
    })
  }

  for (const edit of edits) {
    const message = byTimestamp.get(edit.target)
    if (!message) continue
    message.text = edit.isDelete ? '(message supprimé)' : `(modifié) ${edit.text}`
    if (edit.isDelete) message.attachments = []
  }
  for (const reaction of reactions) {
    const message = byTimestamp.get(reaction.target)
    if (!message) continue
    message.reactions = message.reactions.filter(one => one.from !== reaction.from)
    if (!reaction.isRemove) message.reactions.push({ emoji: reaction.emoji, from: reaction.from })
  }
  for (const [timestamp, status] of receipts) {
    const message = byTimestamp.get(timestamp)
    if (message?.isMine) message.status = status
  }

  for (const [id, name] of directory.names) {
    if (!byId.has(id)) {
      byId.set(id, { id, name, isGroup: directory.groups.has(id), lastAt: 0, messages: [] })
    }
  }

  const conversations = [...byId.values()]
  for (const one of conversations) {
    one.name = directory.names.get(one.id) ?? one.name
    one.messages.sort((a, b) => a.timestamp - b.timestamp)
    if (one.typing && now - one.typing.at > TYPING_MS) one.typing = undefined
  }
  return conversations.sort(
    (a, b) => b.lastAt - a.lastAt || a.name.localeCompare(b.name, 'fr'),
  )
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const options = zone
  const sameDay =
    date.toLocaleDateString('fr-FR', options) ===
    new Date().toLocaleDateString('fr-FR', options)
  return sameDay
    ? date.toLocaleTimeString('fr-FR', { ...options, hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('fr-FR', { ...options, day: '2-digit', month: '2-digit' })
}

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('fr-FR', { ...zone, hour: '2-digit', minute: '2-digit' })
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('fr-FR', zone)
}

function dayLabel(timestamp: number): string {
  const key = dayKey(timestamp)
  if (key === dayKey(Date.now())) return 'Aujourd’hui'
  if (key === dayKey(Date.now() - 86_400_000)) return 'Hier'
  return new Date(timestamp).toLocaleDateString('fr-FR', {
    ...zone,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  })
}

// Consecutive messages of one sender closer than this share a bubble group.
const GROUP_GAP_MS = 5 * 60 * 1000
const MINE_BACKGROUND = '#2C6BED'
const MINE_TEXT = '#FFFFFF'
const MINE_META = '#C9D8FF'
const THEIRS_BACKGROUND = '#3A3A3C'
const THEIRS_TEXT = '#F2F2F2'
const THEIRS_META = '#A8A8AD'

const STATUS_MARK: Record<DeliveryStatus, string> = {
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓ lu',
}

// Finds the attachment file (signal-cli may add an extension) and prints "W H" then the base64 JPEG.
const THUMB_SCRIPT = `set -e
f=$(ls -1 "$1/$2"* 2>/dev/null | head -n 1)
[ -n "$f" ]
t=$(mktemp --suffix=.jpg)
trap 'rm -f "$t"' EXIT
magick "$f[0]" -auto-orient -thumbnail '${THUMB_PX}x${THUMB_PX}>' -strip -quality 70 "$t"
magick identify -format '%w %h\\n' "$t"
base64 -w0 "$t"`

const OPEN_SCRIPT = `f=$(ls -1 "$1/$2"* 2>/dev/null | head -n 1)
[ -n "$f" ] && setsid -f xdg-open "$f" >/dev/null 2>&1`

async function rpcWith(
  $: EngineInterface,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const response = await $.http.fetch(paths.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, id: method, params }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const answer = JSON.parse(response.text)
  if (answer.error) throw new Error(answer.error.message ?? 'RPC error')
  return answer.result
}

type Thumb = { svg: string; width: number; height: number } | 'pending' | 'failed'

export const register: Register = (on, options) => {
  const directory: Directory = { names: new Map(), aliases: new Map(), groups: new Set() }
  const thumbs = new Map<string, Thumb>()
  let lastStamp = ''
  let lastNamesAt = 0
  // The linked account's number, read off the log: the author of its own messages in a reaction.
  let account = ''

  on('session.start', async ($, e, next) => {
    const host = await $.process.run([
      'sh',
      '-c',
      'printf "%s\\n" "$HOME"; readlink -f /etc/localtime 2>/dev/null; true',
    ])
    const [home = '', localtime = ''] = host.stdout.split('\n')
    const dataDir = String(options.dataDir || '~/.local/share/signal-cli-perso').replace(/^~(?=\/|$)/, home)
    paths.log = `${dataDir}/messages.jsonl`
    paths.sent = `${dataDir}/sent-from-pane.jsonl`
    paths.attachments = `${dataDir}/attachments`
    paths.rpc = `http://127.0.0.1:${Number(options.rpcPort) || 8081}/api/v1/rpc`
    const timeZone = /zoneinfo\/(.+)$/.exec(localtime)?.[1]
    if (timeZone) zone.timeZone = timeZone

    const rpc = (method: string, params?: Record<string, unknown>) => rpcWith($, method, params)

    const refreshDirectory = async () => {
      const contacts = (await rpc('listContacts')) as {
        uuid?: string
        number?: string
        name?: string
        nickName?: string
        isBlocked?: boolean
        profile?: { givenName?: string; familyName?: string }
      }[]
      for (const contact of contacts ?? []) {
        if (contact.isBlocked) continue
        const profileName = [contact.profile?.givenName, contact.profile?.familyName]
          .filter(Boolean)
          .join(' ')
        const name = contact.nickName || contact.name || profileName
        const id = peerId(contact.uuid, contact.number)
        if (!id) continue
        if (contact.uuid && contact.number) directory.aliases.set(`n:${contact.number}`, id)
        if (name) directory.names.set(id, name)
      }
      const groups = (await rpc('listGroups')) as {
        id?: string
        name?: string
        isMember?: boolean
      }[]
      for (const group of groups ?? []) {
        if (!group.id || group.isMember === false) continue
        directory.names.set(`g:${group.id}`, group.name || 'Groupe sans nom')
        directory.groups.add(`g:${group.id}`)
      }
    }

    const refresh = async () => {
      let warning = ''
      if (Date.now() - lastNamesAt > NAMES_MS) {
        try {
          await refreshDirectory()
          lastNamesAt = Date.now()
          lastStamp = ''
        } catch {
          warning = 'daemon signal-cli injoignable'
        }
      }
      const stamp = await $.process.run(['sh', '-c', 'stat -c %s "$1" "$2" 2>/dev/null; true', 'sh', paths.log, paths.sent])
      if (stamp.stdout === lastStamp && !warning) return
      lastStamp = stamp.stdout
      const logs = await $.process.run([
        'sh',
        '-c',
        'tail -n 5000 "$1" 2>/dev/null; tail -n 2000 "$2" 2>/dev/null; true',
        'sh',
        paths.log,
        paths.sent,
      ])
      account = /"account":"([^"]+)"/.exec(logs.stdout)?.[1] ?? account
      const conversations = parseLog(logs.stdout, directory)
      // A typing indicator expires on its own: parse again next poll so it clears.
      if (conversations.some(one => one.typing)) lastStamp = ''
      const active = conversations.filter(one => one.lastAt > 0).length
      await update($, model, () => ({
        conversations,
        status: warning || `${active} conversations actives · ${conversations.length} au total`,
      }))
    }

    await $.command.register({
      name: 'signal',
      description: 'Show your Signal conversations in a pane',
    })
    void refresh()
    $.clock.every(POLL_MS, () => void refresh())

    return next(e)
  })

  on('command.run', { command: 'signal' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Signal' })

    return {
      text: opened.isPlaced
        ? 'Signal pane opened.'
        : `Signal pane not drawn: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const { conversations, status } = await read($, model)
    const openId = await read($, selected)
    const open = conversations.find(one => one.id === openId)

    const makeThumb = async (attachment: SignalAttachment) => {
      thumbs.set(attachment.id, 'pending')
      try {
        const result = await $.process.run(['sh', '-c', THUMB_SCRIPT, 'sh', paths.attachments, attachment.id])
        const [size, base64] = result.stdout.split('\n')
        const [width, height] = (size ?? '').split(' ').map(Number)
        if (result.exitCode !== 0 || !base64 || !width || !height) throw new Error(result.stderr)
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
          `<image href="data:image/jpeg;base64,${base64}" width="${width}" height="${height}"/></svg>`
        thumbs.set(attachment.id, { svg, width, height })
      } catch {
        thumbs.set(attachment.id, 'failed')
      }
      $.ui.invalidate('ui.render')
    }

    const openFile = (attachment: SignalAttachment) => {
      void $.process.run(['sh', '-c', OPEN_SCRIPT, 'sh', paths.attachments, attachment.id])
    }

    if (open) {
      const offset = Math.min(await read($, historyOffset), Math.max(0, open.messages.length - 1))
      const end = open.messages.length - offset
      const shown = open.messages.slice(Math.max(0, end - SHOWN_MESSAGES), end)
      const imageIds = shown
        .flatMap(message => message.attachments)
        .filter(file => file.contentType.startsWith('image/'))
        .map(file => file.id)
      const thumbnailIds = new Set(imageIds.slice(-SHOWN_THUMBNAILS))
      const count = await read($, sentCount)

      const target = open.id.startsWith('g:')
        ? { groupId: open.id.slice(2) }
        : { recipient: [open.id.slice(2)] }
      const destination = open.id.startsWith('g:')
        ? { groupInfo: { groupId: open.id.slice(2) } }
        : open.id.startsWith('u:')
          ? { destinationUuid: open.id.slice(2) }
          : { destinationNumber: open.id.slice(2) }
      const logSent = async (timestamp: number, sentMessage: Record<string, unknown>) => {
        const line = JSON.stringify({
          envelope: { timestamp, syncMessage: { sentMessage: { timestamp, ...destination, ...sentMessage } } },
        })
        await $.process.run(['sh', '-c', 'umask 077; cat >> "$1"', 'sh', paths.sent], {
          stdin: `${line}\n`,
        })
        lastStamp = ''
      }
      const reactingId = await read($, reactingTo)

      const react = async (message: SignalMessage, emoji: string) => {
        const isRemove = message.reactions.some(one => one.from === 'Moi' && one.emoji === emoji)
        const author = message.isMine ? account : message.authorId.slice(2)
        await update($, reactingTo, () => null)
        if (!author) {
          $.ui.toast('Signal : auteur du message inconnu, réaction impossible')
          return
        }
        try {
          const result = (await rpcWith($, 'sendReaction', {
            ...target,
            emoji,
            targetAuthor: author,
            targetTimestamp: message.timestamp,
            remove: isRemove,
          })) as { timestamp?: number }
          await logSent(result.timestamp ?? Date.now(), {
            reaction: { emoji, targetSentTimestamp: message.timestamp, isRemove },
          })
        } catch (error) {
          $.ui.toast(`Signal : réaction échouée (${error instanceof Error ? error.message : 'erreur'})`)
        }
      }

      const send = async (value: string) => {
        const text = value.trim()
        if (!text) return
        try {
          const result = (await rpcWith($, 'send', { ...target, message: text })) as {
            timestamp?: number
          }
          await logSent(result.timestamp ?? Date.now(), { message: text })
          await update($, sentCount, value => value + 1)
          await update($, historyOffset, () => 0)
          $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
        } catch (error) {
          $.ui.toast(`Signal : envoi échoué (${error instanceof Error ? error.message : 'erreur'})`)
        }
      }

      // Bubbles leave a fifth of the width free on the other side, as a chat app does.
      const gutter = Math.max(4, Math.floor(e.props.bodyColumns * 0.2))
      const isSameGroup = (a?: SignalMessage, b?: SignalMessage) =>
        Boolean(a && b) &&
        a!.sender === b!.sender &&
        Math.abs(b!.timestamp - a!.timestamp) < GROUP_GAP_MS &&
        dayKey(a!.timestamp) === dayKey(b!.timestamp)

      const reactButton = (message: SignalMessage) => (
        <Button
          key={`reacting-${message.timestamp}`}
          plain
          dimColor
          label="☺"
          onPress={() =>
            void update($, reactingTo, current =>
              current === message.timestamp ? null : message.timestamp,
            )
          }
        />
      )

      const bubble = (message: SignalMessage, index: number) => {
        const previous = shown[index - 1]
        const isGroupStart = !isSameGroup(previous, message)
        const isGroupEnd = !isSameGroup(message, shown[index + 1])
        const isNewDay = !previous || dayKey(previous.timestamp) !== dayKey(message.timestamp)
        const mine = message.isMine
        const meta = mine ? MINE_META : THEIRS_META
        return (
          <Box flexDirection="column" marginTop={isGroupStart ? 1 : 0}>
            {isNewDay && (
              <Box justifyContent="center" marginBottom={1}>
                <Text size="caption" dimColor>
                  {dayLabel(message.timestamp)}
                </Text>
              </Box>
            )}
            {isGroupStart && !mine && open.isGroup && (
              <Text size="caption" bold dimColor>
                {message.sender}
              </Text>
            )}
            <Box
              flexDirection="row"
              justifyContent={mine ? 'flex-end' : 'flex-start'}
              alignItems="center"
              gap={1}
              paddingLeft={mine ? gutter : 0}
              paddingRight={mine ? 0 : gutter}
            >
              {mine && reactButton(message)}
              <Box
                flexDirection="column"
                paddingX={1}
                backgroundColor={mine ? MINE_BACKGROUND : THEIRS_BACKGROUND}
                borderStyle="round"
                borderColor={mine ? MINE_BACKGROUND : THEIRS_BACKGROUND}
              >
                {message.attachments.map(attachment => {
                  const isImage = attachment.contentType.startsWith('image/')
                  let thumb = thumbs.get(attachment.id)
                  if (isImage && Svg && thumbnailIds.has(attachment.id) && !thumb) {
                    void makeThumb(attachment)
                    thumb = 'pending'
                  }
                  return (
                    <Box flexDirection="column">
                      {isImage && Svg && typeof thumb === 'object' && (
                        <Svg
                          source={thumb.svg}
                          alt={attachment.filename ?? 'image'}
                          width={thumb.width}
                          height={thumb.height}
                        />
                      )}
                      {thumb === 'pending' && <Text color={meta}>Chargement de l’image…</Text>}
                      <Button key={`open-${attachment.id}`} plain onPress={() => openFile(attachment)}>
                        <Text color={meta}>{`↗ Ouvrir ${attachment.filename ?? attachment.contentType}`}</Text>
                      </Button>
                    </Box>
                  )
                })}
                <Text wrap="wrap" color={mine ? MINE_TEXT : THEIRS_TEXT}>
                  {message.text}
                  {isGroupEnd && (
                    <Text size="caption" color={meta}>
                      {`  ${clockTime(message.timestamp)}${message.status ? ` ${STATUS_MARK[message.status]}` : ''}`}
                    </Text>
                  )}
                </Text>
              </Box>
              {!mine && reactButton(message)}
            </Box>
            {reactingId === message.timestamp && (
              <Box justifyContent={mine ? 'flex-end' : 'flex-start'} gap={1}>
                {QUICK_REACTIONS.map(emoji => (
                  <Button
                    key={`react-${message.timestamp}-${emoji}`}
                    plain
                    label={emoji}
                    onPress={() => void react(message, emoji)}
                  />
                ))}
              </Box>
            )}
            {message.reactions.length > 0 && (
              <Box justifyContent={mine ? 'flex-end' : 'flex-start'}>
                <Text size="caption" dimColor>
                  {message.reactions.map(one => `${one.emoji} ${one.from}`).join('  ')}
                </Text>
              </Box>
            )}
          </Box>
        )
      }

      const page = (delta: number) =>
        void update($, historyOffset, value =>
          Math.min(Math.max(0, value + delta), Math.max(0, open.messages.length - 1)),
        )

      // The whole pane height: the thread takes what the header and the reply bar
      // leave, keeps its newest rows in view and clips the oldest at the top.
      return (
        <Box flexDirection="column" height={e.props.scroll.bodyRows}>
          <Box flexDirection="row" alignItems="center" gap={2}>
            <Button
              key="back"
              dimColor
              onPress={() => {
                void update($, historyOffset, () => 0)
                void update($, selected, () => null)
              }}
            >
              ←
            </Button>
            <Box flexGrow={1}>
              <Text bold size="heading" wrap="truncate-end">
                {open.isGroup ? `# ${open.name}` : open.name}
              </Text>
            </Box>
            {offset < open.messages.length - 1 ? (
              <Button key="older" plain dimColor label="↑ plus ancien" onPress={() => page(HISTORY_STEP)} />
            ) : null}
            {offset > 0 && (
              <Button key="newer" plain dimColor label="↓ récent" onPress={() => page(-HISTORY_STEP)} />
            )}
          </Box>
          <Box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            justifyContent="flex-end"
            overflow="hidden"
          >
          {shown.length === 0 && <Text dimColor>Aucun message depuis la liaison.</Text>}
          {shown.map(bubble)}
          {open.typing && (
            <Box marginTop={1} paddingRight={gutter}>
              <Box
                paddingX={1}
                backgroundColor={THEIRS_BACKGROUND}
                borderStyle="round"
                borderColor={THEIRS_BACKGROUND}
              >
                <Text italic color={THEIRS_META}>
                  {open.isGroup ? `${open.typing.name} écrit…` : 'écrit…'}
                </Text>
              </Box>
            </Box>
          )}
          </Box>
          {Input ? (
            <Box marginTop={1} width="100%" flexShrink={0}>
              <Input
                key={`reply-${open.id}-${count}`}
                placeholder={`Message à ${open.name}`}
                submitLabel="envoyer"
                autoFocus
                onSubmit={value => void send(value)}
              />
            </Box>
          ) : (
            <Text dimColor>Réponse impossible sur cette surface.</Text>
          )}
        </Box>
      )
    }

    const active = conversations.filter(one => one.lastAt > 0)
    const others = conversations.filter(one => one.lastAt === 0)
    const row = (conversation: Conversation) => {
      const last = conversation.messages[conversation.messages.length - 1]
      const preview = conversation.typing
        ? `${conversation.typing.name} écrit…`
        : last
          ? `${last.isMine ? 'Moi : ' : ''}${last.text || '[pièce jointe]'}`
          : ''
      return (
        <Box flexDirection="column" marginTop={1}>
          <Button
            key={conversation.id}
            plain
            onPress={() => {
              void update($, selected, () => conversation.id)
              $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
            }}
          >
            {conversation.isGroup ? `# ${conversation.name}` : conversation.name}
            {conversation.lastAt > 0 && <Text dimColor> {formatTime(conversation.lastAt)}</Text>}
          </Button>
          {preview && (
            <Text dimColor wrap="truncate-end">
              {preview}
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{status}</Text>
        {active.map(row)}
        {others.length > 0 && (
          <Box marginTop={1}>
            <Text bold dimColor>
              Autres contacts et groupes
            </Text>
          </Box>
        )}
        {others.map(conversation => (
          <Button
            key={conversation.id}
            plain
            dimColor
            onPress={() => void update($, selected, () => conversation.id)}
          >
            {conversation.isGroup ? `# ${conversation.name}` : conversation.name}
          </Button>
        ))}
      </Box>
    )
  })
}
