#!/usr/bin/env sh
# codex CLI → 桌宠桥适配器（exec 包装器样例，macOS/Linux）。
# 用法：codex-pet.sh "你的指令"  —— 其余参数原样透传给 codex。
# 开始：工作状态 working；结束：气泡播报 + 工作状态回空闲；退出码透传。
BRIDGE='http://127.0.0.1:7340/dsh-pet-7340'
SOURCE='codex-cli'
PET='main'

task="$*"
brief=$(printf '%s' "$task" | cut -c1-40)

post() { # path json
  curl -s --noproxy '*' --max-time 3 -X POST -H 'content-type: application/json' -d "$2" "$BRIDGE$1" >/dev/null 2>&1 || true
}
clear_status() {
  curl -s --noproxy '*' --max-time 3 -X DELETE "$BRIDGE/work-status" >/dev/null 2>&1 || true
}

if [ -n "$task" ]; then
  post /work-status "{\"state\":\"working\",\"task\":\"$brief\",\"source\":\"$SOURCE\"}"
fi

codex "$@"
code=$?

if [ "$code" -eq 0 ]; then
  post /broadcast "{\"text\":\"codex 完成：$brief\",\"pet\":\"$PET\",\"surface\":\"any\",\"duration\":6000,\"source\":\"$SOURCE\"}"
else
  post /broadcast "{\"text\":\"codex 退出码 $code：$brief\",\"pet\":\"$PET\",\"surface\":\"any\",\"duration\":6000,\"source\":\"$SOURCE\"}"
fi
clear_status
exit $code
