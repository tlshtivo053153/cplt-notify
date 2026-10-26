#!/bin/bash
# watcher と plugin 対応表の回帰テスト。依存: inotifywait のみ。使い方: bash tests/smoke.sh
set -u

command -v inotifywait >/dev/null || { echo "SKIP: missing inotifywait"; exit 0; }

T=$(mktemp -d) || exit 1
W=""
T2=""
cleanup() { pkill -P "$W" 2>/dev/null; [ -n "$W" ] && kill "$W" 2>/dev/null; rm -rf "$T"; [ -n "$T2" ] && rm -rf "$T2"; }
trap cleanup EXIT

export HOME="$T"
mkdir -p "$T/.local/share/cplt-notify" "$T/bin"
for f in notification-success-soft notification-attention-clear notification-message-in-clear notification-error-soft; do
  : > "$T/.local/share/cplt-notify/$f.wav"
done
cat > "$T/bin/paplay" <<'EOF'
#!/bin/bash
echo "$1" >> "$HOME/paplay.log"
[ -f "$HOME/paplay-fail" ] && exit 1
exit 0
EOF
chmod +x "$T/bin/paplay"
export PATH="$T/bin:$PATH"

rm -rf "$T/.cache/cplt/notify"
bash "$(dirname "$0")/../.local/bin/cplt-notify-watcher.sh" &
W=$!
sleep 1

fail=0
check() { # check <got> <want> <label>
  if [ "$1" = "$2" ]; then echo "ok: $3"; else echo "FAIL: $3 (got [$1] want [$2])"; fail=1; fi
}

[ -d "$T/.cache/cplt/notify" ] && got=yes || got=no
check "$got" yes "spool dir auto-created"

PLUGIN="$(dirname "$0")/../.config/opencode/plugins/cplt-notify.js"
WATCHER="$(dirname "$0")/../.local/bin/cplt-notify-watcher.sh"
ev_ok=1
for ev in session.execution.succeeded permission.asked form.created session.execution.failed; do
  grep -q "$ev" "$PLUGIN" || { echo "FAIL: plugin missing event $ev"; ev_ok=0; fail=1; }
done
[ "$ev_ok" = 1 ] && echo "ok: plugin maps 4 events"
grep -q "parentID" "$PLUGIN" || { echo "FAIL: plugin missing subagent (parentID) filter"; fail=1; }
grep -q 'kind === "done" || kind === "error"' "$PLUGIN" || { echo "FAIL: plugin missing done/error-only guard"; fail=1; }
spool_ok=1
for k in done permission question error; do
  grep -q "$k)" "$WATCHER" || { echo "FAIL: watcher missing spool $k"; spool_ok=0; fail=1; }
done
[ "$spool_ok" = 1 ] && echo "ok: watcher handles 4 spool names"

: > "$T/.cache/cplt/notify/done"; sleep 1
check "$(grep -c success-soft "$T/paplay.log" 2>/dev/null || true)" 1 "done plays exactly once"

echo x > "$T/.cache/cplt/notify/tmpf" && mv "$T/.cache/cplt/notify/tmpf" "$T/.cache/cplt/notify/question"; sleep 1
check "$(grep -c message-in-clear "$T/paplay.log" 2>/dev/null || true)" 1 "rename (moved_to) plays"

: > "$T/.cache/cplt/notify/permission"; sleep 1
check "$(grep -c attention-clear "$T/paplay.log" 2>/dev/null || true)" 1 "permission plays"

: > "$T/.cache/cplt/notify/.done.$$.tmp"; sleep 1
check "$(wc -l < "$T/paplay.log")" 3 "tmp file plays nothing"

echo hi > "$T/.cache/cplt/notify/notes.txt"; sleep 1
check "$(wc -l < "$T/paplay.log")" 3 "stray file plays nothing"

rm -rf "$T/.cache/cplt/notify"; sleep 2
: > "$T/.cache/cplt/notify/done"; sleep 1
check "$(grep -c success-soft "$T/paplay.log" 2>/dev/null || true)" 2 "plays again after spool dir deleted"

before=$(grep -c success-soft "$T/paplay.log" 2>/dev/null || true)
for _ in 1 2 3 4 5; do : > "$T/.cache/cplt/notify/done"; done
sleep 1
after=$(grep -c success-soft "$T/paplay.log" 2>/dev/null || true)
added=$((after - before))
if [ "$added" -ge 1 ] && [ "$added" -le 2 ]; then echo "ok: rapid repeat collapsed ($added plays for 5 writes)"; else echo "FAIL: rapid repeat collapsed (added [$added], want 1-2)"; fail=1; fi

touch "$T/paplay-fail"
: > "$T/.cache/cplt/notify/error"; sleep 1
if kill -0 "$W" 2>/dev/null; then got=yes; else got=no; fi
check "$got" yes "watcher survives failing paplay"
check "$(grep -c error-soft "$T/paplay.log" 2>/dev/null || true)" 1 "error attempted before failure"

T2=$(mktemp -d) || exit 1
mkdir -p "$T2/.cache/cplt"
ln -s /tmp "$T2/.cache/cplt/notify"
if HOME="$T2" bash "$(dirname "$0")/../.local/bin/cplt-notify-watcher.sh" >/dev/null 2>&1; then
  echo "FAIL: symlink spool dir refused (exited 0)"
  fail=1
else
  check "$?" 1 "symlink spool dir refused"
fi

rm "$T/.local/share/cplt-notify/notification-attention-clear.wav"
if kill -0 "$W" 2>/dev/null; then got=yes; else got=no; fi
check "$got" yes "watcher alive before missing-wav test"
pl_before=$(wc -l < "$T/paplay.log")
: > "$T/.cache/cplt/notify/permission"; sleep 1
check "$(wc -l < "$T/paplay.log")" "$pl_before" "missing wav plays nothing"

rm -rf "$T/.cache/cplt/notify"
ln -s /tmp "$T/.cache/cplt/notify"
for _ in $(seq 1 30); do kill -0 "$W" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$W" 2>/dev/null; then echo "FAIL: watcher follows swapped symlink (still alive)"; fail=1; else echo "ok: watcher exits on swapped symlink"; fi

exit "$fail"
