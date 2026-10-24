#!/bin/bash
set -eu

command -v inotifywait >/dev/null || { echo "missing inotifywait" >&2; exit 1; }
command -v paplay >/dev/null || { echo "missing paplay" >&2; exit 1; }

dir="$HOME/.cache/cplt/notify"
[ ! -L "$dir" ] || { echo "bad spool dir: $dir" >&2; exit 1; }
mkdir -p "$dir"

inotifywait -m -e close_write -e moved_to --format '%f' "$dir" |
while IFS= read -r name; do
  case "$name" in
    done)       wav="notification-success-soft.wav" ;;
    permission) wav="notification-attention-clear.wav" ;;
    question)   wav="notification-message-in-clear.wav" ;;
    error)      wav="notification-error-soft.wav" ;;
    *) continue ;;
  esac
  # 既知の通知だけ再生し、古い通知音が溜まらないよう止めてから再生する
  pkill -f "share/cplt-notify" 2>/dev/null || true
  paplay "$HOME/.local/share/cplt-notify/$wav" || true
done

