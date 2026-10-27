# signal-pane

Signal in a [Claude Code](https://claude.com/claude-code) pane, beside the chat:
your conversations as chat bubbles, replies, reactions, read receipts, typing
indicators and image thumbnails.

It does not touch Signal Desktop. It links a separate
[signal-cli](https://github.com/AsamK/signal-cli) as one more device of your
account, runs it as a local daemon, and the mod reads what that daemon receives.

> The UI text is in French. Contributions to make it translatable are welcome.

## What it shows

- Every contact and group, the active conversations first.
- Threads as bubbles: yours on the right in blue, theirs on the left, grouped by
  sender, with day separators and the sender's name in groups.
- ✓ sent, ✓✓ delivered, ✓✓ lu (read) on your messages.
- Reactions under bubbles; the ☺ button next to a bubble sends one.
- "écrit…" while someone types.
- Attachments with an "Ouvrir" button (opens with `xdg-open`), and thumbnails
  of the latest images in the thread.
- A reply bar pinned to the bottom of the pane. A message is sent only when you
  press Enter in it.

Limits: signal-cli keeps no history, so the pane only shows what arrived after
linking. Signal has no "online" status, so neither does the pane. Messages are
stored by the daemon as plain JSON lines in its data folder (mode 600).

## Requirements

- Linux with systemd (user services), `signal-cli` 0.14+, `qrencode`,
  ImageMagick 7 (`magick`) for thumbnails, `xdg-open`.
- Claude Code with mods (plugins with hooks modules). Thumbnails need a surface
  that draws SVG, such as the Claude desktop app.

## Setup

1. Link the device and start the daemon (have your phone ready, the QR code
   expires after a few minutes):

   ```bash
   git clone https://github.com/tarpediem/claude-signal-pane
   claude-signal-pane/setup/link.sh
   ```

   It links signal-cli to `~/.local/share/signal-cli-perso`, writes your number
   to `~/.config/signal-cli-pane.env` and installs the `signal-cli-pane` user
   service, listening on `127.0.0.1:8081`. Pass another folder and port as
   arguments if you need to, and set the same values in the mod's options.

2. Install the mod.

   At the prompt of a terminal session:

   ```
   /plugin install signal-pane --marketplace tarpediem/claude-signal-pane
   ```

   From a shell:

   ```bash
   claude plugin install signal-pane --marketplace tarpediem/claude-signal-pane
   ```

   In the desktop app, where `/plugin` does not run: click + next to the prompt
   box, then Plugins, Add marketplace with `tarpediem/claude-signal-pane`, then
   Add plugin.

3. Type `/signal` to open the pane.

## Options

| Option    | Default                          | What it is                          |
| --------- | -------------------------------- | ----------------------------------- |
| `dataDir` | `~/.local/share/signal-cli-perso` | signal-cli's `--config` folder      |
| `rpcPort` | `8081`                           | port of the daemon's HTTP JSON-RPC  |

## Removing it

```bash
systemctl --user disable --now signal-cli-pane
```

Then remove the "claude-signal-pane" device in Signal on your phone
(Settings → Linked devices), and uninstall the plugin.

## License

MIT
