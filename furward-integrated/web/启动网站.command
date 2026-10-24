#!/bin/zsh
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/share/mise/installs/node/lts/bin:$PATH"
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  printf '请先安装 Node.js 24 或更新版本，再双击这个文件。\n下载地址：https://nodejs.org/\n'
  read '?按回车关闭…'
  exit 1
fi
if curl --silent --fail http://127.0.0.1:3000/api/content >/dev/null; then
  open http://localhost:3000/admin
  printf '网站已经启动。可以关闭这个窗口。\n'
  exit 0
fi
if [ ! -d node_modules ]; then
  printf '第一次启动，正在安装网站依赖…\n'
  npm ci
fi
if [ ! -f .env.production ]; then
  printf '第一次启动，先设置你自己的后台密码。\n'
  npm run setup:admin
fi
printf '正在启动独立网站，不需要 GPT 登录。\n看到 Ready 后，打开 http://localhost:3000/admin\n保持此窗口打开，关闭窗口会停止本地网站。\n'
npm run dev:selfhost
