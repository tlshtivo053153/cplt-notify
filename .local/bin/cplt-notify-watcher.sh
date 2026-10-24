#!/bin/bash
set -eu

command -v inotifywait >/dev/null || { echo "missing inotifywait" >&2; exit 1; }
command -v paplay >/dev/null || { echo "missing paplay" >&2; exit 1; }

dir="$HOME/.cache/cplt/notify"
wavs=(notification-success-soft notification-attention-clear notification-message-in-clear notification-error-soft)

prev=""
last_play=""

# $prev がまだ自分の paplay を指している時だけ止める。
# paplay 終了後の PID は使い回されるので、素朴な kill は無関係なプロセスに当たる。
argv0_of() {
  # paplay は一瞬で終了するため /proc が既に無いことがある。open失敗の報告は外側で捨てる
  ( tr '\0' '\n' < "/proc/$1/cmdline" | sed -n '1p' ) 2>/dev/null
}

stop_prev() {
  [ -n "$prev" ] || return 0
  if [ "$(basename "$(argv0_of "$prev")")" = "paplay" ]; then
    kill "$prev" 2>/dev/null || true
  fi
  wait "$prev" 2>/dev/null || true
  prev=""
}

# 終わった paplay の後始末。実行中なら手を付けないので待たない。
reap_prev() {
  [ -n "$prev" ] || return 0
  if kill -0 "$prev" 2>/dev/null && [ "$(basename "$(argv0_of "$prev")")" = "paplay" ]; then
    return 0
  fi
  wait "$prev" 2>/dev/null || true
  prev=""
}

# dirごと消されると古い場所の監視が無音のまま残るので、消えたら監視し直す
while true; do
  # 起動時だけでなく毎回確認する。すり替わっていたら追従しない
  [ ! -L "$dir" ] || { echo "bad spool dir: $dir" >&2; exit 1; }
  mkdir -p "$dir" || { sleep 5; continue; }
  # 音源が無いと無音で失敗するだけなので先に知らせる
  for wav in "${wavs[@]}"; do
    [ -f "$HOME/.local/share/cplt-notify/$wav.wav" ] || echo "missing sound: $wav.wav" >&2
  done
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
    # 連打は1秒に1回まで。暴走loopにスピーカーを占領させない
    now=$SECONDS
    if [ -n "$last_play" ] && (( now - last_play < 1 )); then
      continue
    fi
    last_play=$now
    # 起動後に消された音源はその場で知らせる
    if [ ! -f "$HOME/.local/share/cplt-notify/$wav" ]; then
      echo "missing sound: $wav" >&2
      continue
    fi
    # 直前の音が残っていたら止める。PID使い回し対策は stop_prev 内
    stop_prev
    paplay "$HOME/.local/share/cplt-notify/$wav" & prev=$!
  done
  wait "$INOTIFY_PID" 2>/dev/null || true
  exec {infd}<&-
  reap_prev
  sleep 1
done
