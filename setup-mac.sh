#!/usr/bin/env bash
# 在另一台 Mac 上部署 Cursor Remote，并连到同一台中继（39）。
# 用法：./setup-mac.sh "办公室的 Mac"
# 跑之前：这台 Mac 要能 ssh pre-server（和现在这台一样的 SSH 配置和私钥）。
set -euo pipefail

NAME="${1:-}"
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="$HOME/.cursor-remote-lite"
PUBLIC_URL="https://pre.ailearningbar.top/cursor-remote"
REPO="ZhengQiushi/cursor-remote-app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "这个脚本只给 Mac 用。"
  exit 1
fi

node_ok() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; }
find_node() {
  local c
  if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
    command -v node
    return
  fi
  c="$(ls -d "$HOME"/.nvm/versions/node/v22.*/bin/node 2>/dev/null | tail -1 || true)"
  if [[ -n "$c" && -x "$c" ]]; then echo "$c"; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$c" ]] && node_ok "$c"; then echo "$c"; return; fi
  done
  return 1
}

NODE="$(find_node || true)"
if [[ -z "$NODE" ]]; then
  echo "需要 Node.js 22 或更新。可以先安装：brew install node"
  exit 1
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 pre-server 'echo ok' >/dev/null; then
  cat <<'EOF'
这台 Mac 还连不上 39。先在 ~/.ssh/config 加上（私钥从已经部署好的那台 Mac 拷过来，不要发到网上）：

Host pre-server
  HostName 39.106.182.143
  User root
  IdentityFile ~/.ssh/pre_server_ed25519

然后重新运行 ./setup-mac.sh "这台电脑的名字"
EOF
  exit 1
fi

if [[ -z "$NAME" ]]; then
  NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
fi

echo "安装依赖…"
(cd "$DIR" && npm install --omit=dev)

mkdir -p "$DATA" "$HOME/Library/LaunchAgents"
chmod 700 "$DATA"
ID="$("$NODE" --input-type=commonjs -e '
const fs = require("fs");
const os = require("os");
const p = process.env.HOME + "/.cursor-remote-lite/config.json";
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
if (!/^[A-Za-z0-9_-]{6,64}$/.test(cfg.computerId || "")) cfg.computerId = require("crypto").randomBytes(8).toString("hex");
cfg.computerName = process.argv[1];
cfg.publicUrl = process.argv[2];
cfg.publishRepo = cfg.publishRepo || process.argv[3];
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
process.stdout.write(cfg.computerId);
' "$NAME" "$PUBLIC_URL" "$REPO")"

UID_N="$(id -u)"
RELAY_LABEL="com.cursor-remote-lite.relay"
TUNNEL_LABEL="com.cursor-remote-lite.tunnel"
RELAY_PLIST="$HOME/Library/LaunchAgents/$RELAY_LABEL.plist"
TUNNEL_PLIST="$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist"
NODE_DIR="$(dirname "$NODE")"

cat > "$RELAY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$RELAY_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$DATA/server.log</string>
  <key>StandardErrorPath</key><string>$DATA/server.log</string>
</dict>
</plist>
EOF

cat > "$TUNNEL_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$TUNNEL_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$DIR/bridge/tunnel-mux.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$DATA/tunnel.log</string>
  <key>StandardErrorPath</key><string>$DATA/tunnel.log</string>
</dict>
</plist>
EOF

boot() {
  local label="$1" plist="$2"
  launchctl bootout "gui/$UID_N/$label" 2>/dev/null || true
  launchctl enable "gui/$UID_N/$label" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    launchctl print "gui/$UID_N/$label" >/dev/null 2>&1 || break
    sleep 0.3
  done
  launchctl bootstrap "gui/$UID_N" "$plist"
}

boot "$RELAY_LABEL" "$RELAY_PLIST"
boot "$TUNNEL_LABEL" "$TUNNEL_PLIST"

echo
echo "已经启动：「$NAME」（id $ID）"
echo "手机上点「切换电脑」，等这台出现后点它。"
echo "第一次要用这台，在这台 Mac 上运行：npm run pair"
echo "把打出来的链接粘贴到手机里。配过一次之后，手机上点名字就能切过来。"
