#!/usr/bin/env pwsh
# codex CLI → 桌宠桥适配器（exec 包装器样例，Windows）。
# 用法：codex-pet.ps1 "你的指令"  —— 其余参数原样透传给 codex。
# 开始：工作状态 working；结束：气泡播报 + 工作状态回空闲；退出码透传。
$BRIDGE = 'http://127.0.0.1:7340/dsh-pet-7340'
$SOURCE = 'codex-cli'
$PET = 'main'

$task = ($args -join ' ')
$brief = if ($task.Length -gt 40) { $task.Substring(0, 40) } else { $task }

function Post-Bridge([string]$path, [string]$json) {
  try { curl.exe -s --noproxy '*' --max-time 3 -X POST -H 'content-type: application/json' -d $json ($BRIDGE + $path) | Out-Null } catch {}
}
function Clear-WorkStatus() {
  try { curl.exe -s --noproxy '*' --max-time 3 -X DELETE ($BRIDGE + '/work-status') | Out-Null } catch {}
}

if ($task) {
  $j = @{ state = 'working'; task = $brief; source = $SOURCE } | ConvertTo-Json -Compress
  Post-Bridge '/work-status' $j
}

codex @args
$code = $LASTEXITCODE

if ($code -eq 0) {
  $j = @{ text = "codex 完成：$brief"; pet = $PET; surface = 'any'; duration = 6000; source = $SOURCE } | ConvertTo-Json -Compress
  Post-Bridge '/broadcast' $j
} else {
  $j = @{ text = "codex 退出码 $code：$brief"; pet = $PET; surface = 'any'; duration = 6000; source = $SOURCE } | ConvertTo-Json -Compress
  Post-Bridge '/broadcast' $j
}
Clear-WorkStatus
exit $code
