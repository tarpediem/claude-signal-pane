#!/usr/bin/env bash
# Link a dedicated signal-cli as a new device of your Signal account, then
# install and start the user service the signal-pane mod reads from.
#
# Usage: setup/link.sh [data-dir] [port]
#   data-dir  defaults to ~/.local/share/signal-cli-perso (the mod's default)
#   port      defaults to 8081
set -euo pipefail

DATA="${1:-$HOME/.local/share/signal-cli-perso}"
PORT="${2:-8081}"
ENV_FILE="$HOME/.config/signal-cli-pane.env"
UNIT_DIR="$HOME/.config/systemd/user"
HERE="$(cd "$(dirname "$0")" && pwd)"

for tool in signal-cli qrencode systemctl; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }
done
SIGNAL_CLI="$(command -v signal-cli)"

mkdir -p "$DATA" && chmod 700 "$DATA"

echo "On your phone: Signal → Settings → Linked devices → Link new device, then scan:"
"$SIGNAL_CLI" --config "$DATA" link -n "claude-signal-pane" | while IFS= read -r line; do
  case "$line" in
    sgnl://*) qrencode -t ANSIUTF8 -m 2 "$line" ;;
    *) echo "$line" ;;
  esac
done

account=$("$SIGNAL_CLI" --config "$DATA" -o json listAccounts | grep -o '"number":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$account" ]; then
  echo "Linking did not finish (the QR code expires after a few minutes): run this again." >&2
  exit 1
fi

umask 077
mkdir -p "$(dirname "$ENV_FILE")" "$UNIT_DIR"
printf 'SIGNAL_ACCOUNT=%s\n' "$account" > "$ENV_FILE"
umask 022
sed -e "s|@SIGNAL_CLI@|$SIGNAL_CLI|" -e "s|@DATA@|$DATA|g" -e "s|@PORT@|$PORT|" \
  "$HERE/signal-cli-pane.service" > "$UNIT_DIR/signal-cli-pane.service"
systemctl --user daemon-reload
systemctl --user enable --now signal-cli-pane.service
echo "Linked, daemon started. Open the pane with /signal in Claude Code."
