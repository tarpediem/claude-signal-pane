import { expect, test } from 'claude-code/testing'

import { parseLog } from './register'
import type { Directory } from './register'

const NOW = 10_000

const line = (envelope: object) => JSON.stringify({ envelope, account: '+66000' })

const LOG = [
  line({
    sourceUuid: 'aaa',
    sourceNumber: '+66111',
    sourceName: 'Alice',
    timestamp: 1000,
    dataMessage: {
      timestamp: 1000,
      message: 'salut',
      attachments: [{ id: 'img1', contentType: 'image/jpeg', filename: 'chat.jpg' }],
    },
  }),
  line({
    sourceUuid: 'me',
    timestamp: 2000,
    syncMessage: { sentMessage: { destinationNumber: '+66111', timestamp: 2000, message: 'yo' } },
  }),
  line({ sourceUuid: 'aaa', receiptMessage: { isRead: true, timestamps: [2000] } }),
  line({
    sourceUuid: 'aaa',
    sourceName: 'Alice',
    dataMessage: { timestamp: 2500, reaction: { emoji: '👍', targetSentTimestamp: 2000 } },
  }),
  line({
    sourceUuid: 'bbb',
    sourceName: 'Bob',
    timestamp: 3000,
    dataMessage: { timestamp: 3000, message: 'hello', groupInfo: { groupId: 'G1' } },
  }),
  line({
    sourceUuid: 'bbb',
    sourceName: 'Bob',
    typingMessage: { action: 'STARTED', timestamp: NOW - 2000, groupId: 'G1' },
  }),
  'INFO  DaemonCommand - Starting daemon',
].join('\n')

const directory = (): Directory => ({
  names: new Map([
    ['g:G1', 'Famille'],
    ['u:aaa', 'Alice B.'],
    ['u:zzz', 'Zoé'],
  ]),
  aliases: new Map([['n:+66111', 'u:aaa']]),
  groups: new Set(['g:G1']),
})

test('parseLog merges aliases, applies receipts, reactions and typing', async () => {
  const conversations = parseLog(LOG, directory(), NOW)

  expect(conversations.map(one => one.name)).toEqual(['Famille', 'Alice B.', 'Zoé'])
  const [family, alice, zoe] = conversations
  expect(family?.typing?.name).toBe('Bob')
  expect(alice?.messages.map(one => `${one.sender}:${one.text}`)).toEqual([
    'Alice B.:salut',
    'Moi:yo',
  ])
  expect(alice?.messages[0]?.attachments[0]?.id).toBe('img1')
  expect(alice?.messages[1]?.status).toBe('read')
  expect(alice?.messages[1]?.reactions).toEqual([{ emoji: '👍', from: 'Alice B.' }])
  expect(zoe?.messages.length).toBe(0)
})

test('a typing indicator expires', async () => {
  const conversations = parseLog(LOG, directory(), NOW + 60_000)

  expect(conversations[0]?.typing).toBeUndefined()
})

const PANE = {
  plugin: 'signal-pane',
  component: 'Pane',
  requestId: 'signal',
  props: {
    title: 'Signal',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the pane opens a conversation, sends a reply and a reaction', async ($, on) => {
  const rpcCalls: string[] = []
  on('command.register', () => ({ value: { command: 'signal' } }))
  on('http.fetch', (_, e) => {
    const body = JSON.parse(String(e.init?.body ?? '{}'))
    rpcCalls.push(`${body.method}:${JSON.stringify(body.params ?? null)}`)
    const result =
      body.method === 'send'
        ? { timestamp: 4000 }
        : body.method === 'sendReaction'
          ? { timestamp: 5000 }
          : body.method === 'listContacts'
          ? [{ uuid: 'aaa', number: '+66111', name: 'Alice B.' }]
          : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ result }) } }
  })
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: String(e.argv[2] ?? '').includes('tail') ? LOG : '1',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Moi : yo/ }))?.text).toBe('Moi : yo')

  await ui.input({ key: 'search', text: 'SALU', kind: 'change' })
  expect((await ui.find({ type: 'Text', text: /: salut/ }))?.text).toBe('Alice B. : salut')
  await ui.press({ key: 'clear-search' })

  await ui.press({ key: 'u:aaa' })
  expect((await ui.find({ type: 'Text', text: /✓✓/ }))?.text).toContain('✓✓ lu')
  await ui.input({ key: 'reply-u:aaa-0', text: 'ça roule' })

  expect(rpcCalls.some(call => call === 'send:{"recipient":["aaa"],"message":"ça roule"}')).toBe(true)

  await ui.press({ key: 'reacting-1000' })
  await ui.press({ key: 'react-1000-👍' })
  expect(
    rpcCalls.some(
      call =>
        call ===
        'sendReaction:{"recipient":["aaa"],"emoji":"👍","targetAuthor":"aaa","targetTimestamp":1000,"remove":false}',
    ),
  ).toBe(true)
  await ui.unmount()
})
