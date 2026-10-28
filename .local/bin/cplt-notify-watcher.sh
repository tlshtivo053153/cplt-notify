#!/bin/bash
set -eu

command -v inotifywait >/dev/null || { echo "missing inotifywait" >&2; exit 1; }
command -v paplay >/dev/null || { echo "missing paplay" >&2; exit 1; }
command -v flock >/dev/null || { echo "missing flock" >&2; exit 1; }

# HOME 未設定ではすぐ死ぬ代わりに passwd から補う。空のまま /.cache を触らない
export HOME="${HOME:-$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)}"
[ -n "$HOME" ] || { echo "HOME is unset" >&2; exit 1; }

# 二重起動防止。常駐方法Bは外側flockなしで直接起動する
lock="$HOME/.cache/cplt/watcher.lock"
mkdir -p "${lock%/*}" 2>/dev/null || true
exec 9>"$lock" || { echo "cannot open lock: $lock" >&2; exit 1; }
flock -n 9 || { echo "already running" >&2; exit 1; }

dir="$HOME/.cache/cplt/notify"
sound_dir="$HOME/.local/share/cplt-notify"
sound_done="notification-success-soft.wav"
sound_permission="notification-attention-clear.wav"
sound_question="notification-message-in-clear.wav"
sound_error="notification-error-soft.wav"

prev=""
last_play=""
last_kind=""

# $prev がまだ自分の paplay を指している時だけ止める。
# paplay 終了後の PID は使い回されるので、素朴な kill は無関係なプロセスに当たる。
argv0_of() {
  # paplay は一瞬で終了するため /proc が既に無いことがある。open失敗の報告は外側で捨てる
  ( tr '\0' '\n' < "/proc/$1/cmdline" | sed -n '1p' ) 2>/dev/null
}

is_own_paplay() {
  [ "$(basename "$(argv0_of "$1")")" = "paplay" ]
}

stop_prev() {
  [ -n "$prev" ] || return 0
  if is_own_paplay "$prev"; then
    kill "$prev" 2>/dev/null || true
  fi
  wait "$prev" 2>/dev/null || true
  prev=""
}

# 終わった paplay の後始末。実行中なら手を付けないので待たない。
reap_prev() {
  [ -n "$prev" ] || return 0
  if kill -0 "$prev" 2>/dev/null && is_own_paplay "$prev"; then
    return 0
  fi
  wait "$prev" 2>/dev/null || true
  prev=""
}

# dirごと消されると古い場所の監視が無音のまま残るので、消えたら監視し直す
while true; do
  # 作り直し後は絞り込みをリセットする(直前の1秒以内でも新しいdirの最初は鳴らす)
  last_play=""
  last_kind=""
  # 起動時だけでなく毎回確認する。すり替わっていたら追従しない
  [ ! -L "$dir" ] || { echo "bad spool dir: $dir" >&2; exit 1; }
  mkdir -p "$dir" || { sleep 5; continue; }
  # 音源が無いと無音で失敗するだけなので先に知らせる
  for wav in "$sound_done" "$sound_permission" "$sound_question" "$sound_error"; do
    [ -f "$sound_dir/$wav" ] || echo "missing sound: $wav" >&2
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
      done)       wav="$sound_done" ;;
      permission) wav="$sound_permission" ;;
      question)   wav="$sound_question" ;;
      error)      wav="$sound_error" ;;
      *) continue ;;
    esac
    # 同じ音の連打は1秒に1回まで。暴走loopにスピーカーを占領させない(違う音は通す)
    # $SECONDS は秒単位なので境界をまたぐと10ms間隔でも通る。マイクロ秒で比べる
    now=${EPOCHREALTIME:-}
    now=${now/./}
    now=${now:-$((SECONDS * 1000000))}
    if [ -n "$last_play" ] && (( now - last_play < 1000000 )) && [ "$name" = "$last_kind" ]; then
      continue
    fi
    last_play=$now
    last_kind=$name
    # 起動後に消された音源はその場で知らせる
    if [ ! -f "$sound_dir/$wav" ]; then
      echo "missing sound: $wav" >&2
      continue
    fi
    # 直前の音が残っていたら止める。PID使い回し対策は stop_prev 内
    stop_prev
    paplay -- "$sound_dir/$wav" & prev=$!
  done
  wait "$INOTIFY_PID" 2>/dev/null || true
  exec {infd}<&-
  reap_prev
  sleep 1
done
