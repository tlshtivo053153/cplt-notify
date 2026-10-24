#!/bin/bash
set -eu

dir="$HOME/.cache/cplt/notify"
[ -d "$dir" ] && [ ! -L "$dir" ] || { echo "bad spool dir: $dir" >&2; exit 1; }

inotifywait -m -e close_write --format '%f' "$dir" |
while IFS= read -r name; do
  case "$name" in
    done)       paplay "$HOME/.local/share/cplt-notify/notification-success-soft.wav" ;;
    permission) paplay "$HOME/.local/share/cplt-notify/notification-attention-clear.wav" ;;
    question)   paplay "$HOME/.local/share/cplt-notify/notification-message-in-clear.wav" ;;
    error)      paplay "$HOME/.local/share/cplt-notify/notification-error-soft.wav" ;;
  esac
done

