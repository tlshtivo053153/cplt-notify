#!/bin/bash
set -eu

command -v inotifywait >/dev/null || { echo "missing inotifywait" >&2; exit 1; }
command -v paplay >/dev/null || { echo "missing paplay" >&2; exit 1; }

dir="$HOME/.cache/cplt/notify"
[ ! -L "$dir" ] || { echo "bad spool dir: $dir" >&2; exit 1; }

# 音源が無いと無音で失敗するだけなので先に知らせる
for wav in notification-success-soft notification-attention-clear notification-message-in-clear notification-error-soft; do
  [ -f "$HOME/.local/share/cplt-notify/$wav.wav" ] || echo "missing sound: $wav.wav" >&2
done

prev=""
# dirごと消されると古い場所の監視が無音のまま残るので、消えたら監視し直す
while true; do
  mkdir -p "$dir" || { sleep 5; continue; }
  coproc INOTIFY { exec inotifywait -m -e close_write -e moved_to -e delete_self -e move_self --format '%e %f' "$dir" 2>/dev/null; } || { sleep 5; continue; }
  infd=${INOTIFY[0]}
  while read -r evt name <&"$infd"; do
    case "$evt" in
      *DELETE_SELF*|*MOVE_SELF*|*IGNORED*)
        kill "$INOTIFY_PID" 2>/dev/null || true
        break ;;
    esac
    case "$name" in
      done)       wav="notification-success-soft.wav" ;;
      permission) wav="notification-attention-clear.wav" ;;
      question)   wav="notification-message-in-clear.wav" ;;
      error)      wav="notification-error-soft.wav" ;;
      *) continue ;;
    esac
    # 直前の音が残っていたら止める。パターンkillは無関係なプロセスに当たるためPIDで管理する
    [ -n "$prev" ] && kill "$prev" 2>/dev/null || true
    paplay "$HOME/.local/share/cplt-notify/$wav" & prev=$!
  done
  wait "$INOTIFY_PID" 2>/dev/null || true
  exec {infd}<&-
  prev=""
  sleep 1
done
