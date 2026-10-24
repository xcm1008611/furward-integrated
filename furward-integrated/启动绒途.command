#!/bin/zsh
cd "${0:A:h}"
export PATH="$HOME/.local/share/mise/installs/node/lts/bin:$HOME/.local/share/mise/installs/python/3.13.13/bin:$PATH"
node scripts/start.mjs
printf '\n按回车关闭此窗口。'
read
