#!/bin/sh
# Real opencode 1.x TUI with this plugin in tmux, against the fake CPA with Pacer.
# Run inside the opencode-pacer-host image: sh test/hosts/v1-tui.sh <opencode binary>
set -eu
bin=$1; repo=$(cd "$(dirname "$0")/../.." && pwd)
key=sk-host-test-0123456789
H=$(mktemp -d); export HOME=$H XDG_CONFIG_HOME=$H/config XDG_DATA_HOME=$H/data XDG_CACHE_HOME=$H/cache XDG_STATE_HOME=$H/state OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1
mkdir -p $XDG_CONFIG_HOME/opencode $XDG_DATA_HOME/opencode $H/project
bun "$repo/test/hosts/fake-server.ts" $key > $H/url.txt &
fake=$!
sleep 1; url=$(head -1 $H/url.txt)
cat > $XDG_CONFIG_HOME/opencode/opencode.json <<JSON
{"autoupdate":false,"share":"disabled","model":"cliproxyapi/gpt-6-sol","plugin":["$repo/src/v1/server.ts"]}
JSON
cat > $XDG_CONFIG_HOME/opencode/tui.json <<JSON
{"plugin":["$repo/src/v1/tui.tsx"]}
JSON
printf '{"cliproxyapi":{"type":"api","key":"%s","metadata":{"baseURL":"%s/v1"}}}' $key $url > $XDG_DATA_HOME/opencode/auth.json
cd $H/project
tmux new-session -d -s oc -x 170 -y 48 "$bin"
shot() { tmux capture-pane -p -t oc > "$H/$1.txt"; }
i=0; until tmux capture-pane -p -t oc | grep -q "gpt-6-sol\|Ask anything\|build"; do i=$((i+1)); [ $i -gt 90 ] && break; sleep 1; done
shot start
tmux send-keys -t oc "Say pong" Enter
i=0; until tmux capture-pane -p -t oc | grep -q "pong"; do i=$((i+1)); [ $i -gt 60 ] && break; sleep 1; done
sleep 4
shot after
tmux send-keys -t oc "/usage"
sleep 1
tmux send-keys -t oc Enter
sleep 1
tmux send-keys -t oc Enter
sleep 3
shot all
tmux kill-session -t oc || true
kill $fake 2>/dev/null || true
echo "=== after reply"; cat $H/after.txt
echo "=== after /usage"; cat $H/all.txt
ok=1
grep -q "Usage" $H/after.txt || ok=0
grep -q "Codex A" $H/after.txt || ok=0
grep -q "81%" $H/after.txt || ok=0
grep -q "64%" $H/after.txt || ok=0
grep -q "LAST USED" $H/after.txt || ok=0
grep -q "all accounts" $H/all.txt || ok=0
grep -q "70%" $H/all.txt || ok=0
echo "RESULT ok=$ok"
