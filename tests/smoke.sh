#!/bin/bash
# watcher の回帰テスト。依存なし。使い方: bash tests/smoke.sh
set -u

T=$(mktemp -d)
W=""
cleanup() { pkill -P "$W" 2>/dev/null; [ -n "$W" ] && kill "$W" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

export HOME="$T"
mkdir -p "$T/.local/share/cplt-notify" "$T/bin"
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

: > "$T/.cache/cplt/notify/done"; sleep 1
check "$(grep -c success-soft "$T/paplay.log" 2>/dev/null || true)" 1 "done plays exactly once"

echo x > "$T/.cache/cplt/notify/tmpf" && mv "$T/.cache/cplt/notify/tmpf" "$T/.cache/cplt/notify/question"; sleep 1
check "$(grep -c message-in-clear "$T/paplay.log" 2>/dev/null || true)" 1 "rename (moved_to) plays"

echo hi > "$T/.cache/cplt/notify/notes.txt"; sleep 1
check "$(wc -l < "$T/paplay.log")" 2 "stray file plays nothing"

touch "$T/paplay-fail"
: > "$T/.cache/cplt/notify/error"; sleep 1
if kill -0 "$W" 2>/dev/null; then got=yes; else got=no; fi
check "$got" yes "watcher survives failing paplay"
check "$(grep -c error-soft "$T/paplay.log" 2>/dev/null || true)" 1 "error attempted before failure"

exit "$fail"
