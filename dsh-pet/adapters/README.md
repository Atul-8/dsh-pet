# 外部程序投喂桌宠（桥适配器样例）

桥地址**永远不变**：`http://127.0.0.1:7340/dsh-pet-7340/`。
装在 DSH 里跑、还是独立跑（`dsh-pet-standalone`），对投喂方完全同形——零配置切换宿主形态。

三个公开投喂门（本机直连即可，无需 token）：

| 端点                | 语义                   | 请求体                                               |
| ------------------- | ---------------------- | ---------------------------------------------------- |
| `POST /badge`       | 常驻徽标数字           | `{ count, label?, href?, tone?, items?, source? }`   |
| `POST /broadcast`   | 事件气泡（宠物说一句） | `{ text, pet, surface?, duration?, anim?, source? }` |
| `POST /work-status` | 工作状态档位           | `{ state, task? }`                                   |

**source 字段**（可选）：声明投喂方身份。需在用户配置 `sources[]` 里声明同名条目
（见下），之后断链时徽标自动灰化、设置页「数据源」卡显示「已断链」。
不带 source 的投喂照常受理（匿名兼容，永不拒收）。

## 声明你的源（一次性）

在 `$DSH_HOME/dsh-pet/main-config.jsonc`（Windows 默认 `~/.dsh/dsh-pet/main-config.jsonc`）顶层加：

```jsonc
{
  "sources": [
    { "type": "external-push", "id": "claude-code", "feed": "broadcast" },
    { "type": "external-push", "id": "codex-cli", "feed": "broadcast" },
    { "type": "external-push", "id": "zoho-tm", "feed": "badge", "expectIntervalMs": 90000 },
  ],
  "pets": [/* ... */],
}
```

- `feed: "badge"` = 周期性数字（配 `expectIntervalMs` 才会判 stale——超过 max(2×interval, 5min) 无心跳就灰化）
- `feed: "broadcast"` = 事件流（突发性，**永不判 stale**——只显示最后心跳时刻）
- 改完保存即生效（看门狗 30s 内重读声明表，无需重启）

## 内建源（不需要外部脚本）

`builtin-webview` 类型（阶段三起）：**宿主自己跑的会话看门人**——cookie 落在
Chromium persist 分区（宿主全程不碰密码），每 `intervalMs` 无窗口探活一次，
活着就环回投喂；登录失效自动开登录窗（重新登录即恢复，不用重启）。

```jsonc
{
  "type": "builtin-webview",
  "id": "zoho-direct",
  "feed": "badge",
  "intervalMs": 60000,
  "url": "https://desk.zoho.com/",
}
```

- 需要**桌面模式开着**（Electron Helper 在跑才有会话能力；纯 web 用户配了会一直显示 unknown——环境事实，不是故障）
- 徽标数字：**v1.1 起 API 学习可用**——登录窗里打开目标页面后，宿主经学习会话抓到
  待办 API（同源 XHR 的 method+url+countPath，落 `~/.dsh/dsh-pet/source-api-<id>.json`，
  绝不含凭证），看门人每拍按学到的 API 取**真实待办数**；没学过 / 取失败则回落哨兵值 1
  （看门人在岗）。学习文件可手查可删，坏了自动回落。详见 ADR-002 Q2。
- `intervalMs` 需 ≥5000（防打爆目标站点），缺省 60s

---

## ① claude-code（hooks）

把 hook 脚本 [claude-code-hooks.mjs](./claude-code-hooks.mjs) 放到任意目录（如 `~/.dsh/pet-hooks/`），
然后在 claude code 的 settings 里挂载（`~/.claude/settings.json`）：

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node ~/.dsh/pet-hooks/claude-code-hooks.mjs" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node ~/.dsh/pet-hooks/claude-code-hooks.mjs" }] }]
  }
}
```

效果：

- **Stop**（回合结束）→ 宠物气泡「claude 完成一回合」+ 工作状态回空闲
- **Notification**（等权限 / 等输入）→ 宠物气泡播通知内容 + 工作状态 `waiting`
- 声明了 `claude-code` 源 → 设置页数据源卡可见其心跳

脚本对所有 hook 事件统一处理（stdin JSON → 按事件名分发），以后想挂别的事件
（PreToolUse / PostToolUse）直接往 settings 的 `hooks` 里加同名条目即可，脚本不用改。

## ② codex CLI（exec 包装器）

codex 没有等价的 hooks 系统，用「包一层」的思路（[codex-pet.ps1](./codex-pet.ps1) /
[codex-pet.sh](./codex-pet.sh)）：

```sh
# 用法不变，只是前面多了个前缀：
codex-pet "帮我修这个 bug"
```

包装器做三件事：开始时 `POST /work-status {state:"working", task:<你的指令摘要>}`、
codex 结束时广播一句 + 工作状态回空闲、退出码透传。

## ③ pi / 任意程序

桥就是 HTTP——任何能发 POST 的东西都能接。最小示例（curl）：

```sh
# 事件气泡
curl -X POST http://127.0.0.1:7340/dsh-pet-7340/broadcast \
  -H 'content-type: application/json' \
  -d '{"text":"pi: 任务完成","pet":"main","surface":"any","source":"pi-agent"}' \
  --noproxy '*'

# 徽标数字（如 pi 的待办数）
curl -X POST http://127.0.0.1:7340/dsh-pet-7340/badge \
  -H 'content-type: application/json' \
  -d '{"count":3,"label":"pi 待办","source":"pi-agent"}' --noproxy '*'
```

**注意 `--noproxy '*'`**：本机回环流量别过系统代理（最常见的「投喂不生效」原因）。

---

## 调试

- 投喂后 `curl --noproxy '*' http://127.0.0.1:7340/dsh-pet-7340/state | jq '.sections.sources'`
  看心跳是否刷上（`list[].lastSeen` / `anonymousLastSeen`）
- 400 = JSON 坏 / count 非法；404 = 端口上没有桌宠（桥没起）
- 设置页「桌宠配置 → 数据源」卡：所有已声明源的健康度一目了然
