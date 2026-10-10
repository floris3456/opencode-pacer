#!/bin/sh
# Real opencode 1.x TUI: /connect → CLIProxyAPI → URL and key → CPA's models.
# Run inside the opencode-pacer-host image: sh test/hosts/v1-connect.sh <opencode binary>
set -eu
bin=$1; repo=$(cd "$(dirname "$0")/../.." && pwd)
key=sk-host-test-0123456789
H=$(mktemp -d); export HOME=$H XDG_CONFIG_HOME=$H/config XDG_DATA_HOME=$H/data XDG_CACHE_HOME=$H/cache XDG_STATE_HOME=$H/state OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1
mkdir -p $XDG_CONFIG_HOME/opencode $XDG_DATA_HOME/opencode $H/project
bun "$repo/test/hosts/fake-server.ts" $key > $H/url.txt &
fake=$!
sleep 1; url=$(head -1 $H/url.txt)
echo "{\"autoupdate\":false,\"share\":\"disabled\",\"plugin\":[\"$repo/src/v1/server.ts\"]}" > $XDG_CONFIG_HOME/opencode/opencode.json
echo "{\"plugin\":[\"$repo/src/v1/tui.tsx\"]}" > $XDG_CONFIG_HOME/opencode/tui.json
cd $H/project
tmux new-session -d -s oc -x 170 -y 48 "$bin"
wait_for() { i=0; until tmux capture-pane -p -t oc | grep -q "$1"; do i=$((i+1)); [ $i -gt ${2:-60} ] && return 1; sleep 1; done; }
wait_for "ctrl+p" 90
tmux send-keys -t oc "/connect"; sleep 1; tmux send-keys -t oc Enter
wait_for "Connect a provider" 20
tmux send-keys -t oc "CLIProxyAPI"; sleep 1
tmux capture-pane -p -t oc > $H/list.txt
tmux send-keys -t oc Enter
wait_for "CLIProxyAPI URL" 20 || true
tmux capture-pane -p -t oc > $H/url-prompt.txt
tmux send-keys -t oc "$url/v1"; sleep 1; tmux send-keys -t oc Enter
sleep 2
tmux capture-pane -p -t oc > $H/key-prompt.txt
tmux send-keys -t oc "$key"; sleep 1; tmux send-keys -t oc Enter
sleep 8
tmux capture-pane -p -t oc > $H/models.txt
tmux kill-session -t oc || true
kill $fake 2>/dev/null || true
for f in list url-prompt key-prompt models; do echo "=== $f"; grep -v "^\s*$" $H/$f.txt | cut -c1-150 | head -40; done
ok=1
grep -q "CLIProxyAPI" $H/list.txt || ok=0
grep -q "CLIProxyAPI URL" $H/url-prompt.txt || ok=0
grep -q "gpt-6-sol\|Claude Opus 5.5" $H/models.txt || ok=0
grep -q '"baseURL"' $XDG_DATA_HOME/opencode/auth.json && grep -q "$url/v1" $XDG_DATA_HOME/opencode/auth.json || ok=0
echo "RESULT ok=$ok"
