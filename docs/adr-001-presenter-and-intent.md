# ADR-001：渲染层可替换 —— presenter 档位 + 事件意图

状态：**已实现**（阶段一 `279dced` intent 契约+宿主；阶段二 `28b52a6` toast 层+渲染分支、`4f84df4` 设置页档位 UI） · 日期：2026-10-23 · 影响包：dsh-pet 0.4.0（已随 0.4.0 发布）

## 1. 背景与动机

用户诉求三条：

1. **桌宠隐藏，只留透明弹窗提醒**——不想看到宠物本体时，事件仍要到达。
2. **更换桌宠款式**——不同形象/皮肤。
3. **其他插件接入 = 转发投递 or 打开一个全新对话页**——不想让每个插件都长一套桌宠逻辑。

结论先行：**契约层（openapi.yaml）天然渲染无关，架构已经是多渲染端的**（web 宠物、桌面宠物、通知 toast 是三个并存的消费者）。缺的不是"可替换性"，而是①一个显式的渲染档位开关，②事件带上"点击之后去哪"的意图位。

## 2. 现状（证据）

```
契约层   openapi.yaml：/dsh-pet-7340/* + 固定桥 127.0.0.1:7340（state/badge/broadcast）
数据面   src/host/index.ts（路由）+ 各域模块 → 写 S 的叶子
渲染面   ① web：pet.ts（PetMulti→PetCard，注册进 shell.overlay 插槽，app.ts:171）
         ② 桌面：Electron Helper（dsh-pet-bridge:// 管道 → 同一 handlePetRoute）
         ③ 通知：notify.ts（sections.notify → Web Notification 系统级 toast，
            点击可 openSession 唤起 DSH 会话，app.ts:96）
外部     油猴 → 桥 /badge；seeed-ts pet-bridge → 桥 /broadcast（v1.2.0，已上线）
```

关键事实：

- **换款式今天已支持，零代码**：宠物=数据（`animations` 池 / `assetRoot` / 文件宠物独立素材包）。本 ADR 不再动它。
- **渲染端可插拔今天已合法**：`shell.overlay` 是 DSH 公开插槽，任何第三方插件都能注册自己的浮层、自己轮询 `/state` 渲染——dsh-pet 核心一行不改。
- **坑：surface 契约拒绝 `display:none`**（src/host/surface.ts:48，`any` 也拒，理由是"指令必然落空"）。因此"藏宠物"**不能**走 `display=none`，那会饿死全部投喂。必须做成**渲染层开关**：`display` 保持 `web`，只是宠物 DOM 不挂载、事件改走 toast。
- **通知引擎现状**：notify.ts 走 **Web Notification API**（Windows 右下角系统原生通知）——系统样式、几秒自动消失、不可定制透明度；它是 DSH 事件的通道（sections.notify），不是 say/badge 的通道。
- **SayCue 形状**（src/shared/state.ts:148）：`{ kind:'say', text, image?, url?, duration?, anim? }`——加法扩展对老消费者零影响。

## 3. 目标 / 非目标

**目标**

- G1 一份配置在「宠物形态 / 透明弹窗形态」间切换，事件投喂链路（桥、/broadcast、/badge）零改动。
- G2 外部插件投事件时可带**意图**（开某会话 / 开某 URL），点击弹窗即深链。
- G3 换款式继续走素材包，不在本 ADR 范围内新增机制。

**非目标**

- N1 不重构 pet.ts（135KB 单体）——presenter 档位走"并列新增"，不动存量宠物渲染。
- N2 不改 surface 契约与锁语义。
- N3 桌面半侧（Electron）不做 toast 形态——桌面窗口本身就是"只留提醒"的天然载体（display 切 none/desktop 即可）；toast 是 **web 渲染端**的档位。
- N4 不做"新建会话"能力——openSession 只能唤起**已存在**的 DSH 会话；"全新对话页"需要 DSH 应用层 API，列为开放问题。

## 4. 决策

### 4.1 presenter 档位（渲染层开关）

配置：main 条目新增 `presenter: 'pet' | 'toast' | 'both'`（缺省 `pet`，老配置零迁移）。

| 档位    | 宠物 DOM   | 事件去向                                                          |
| ------- | ---------- | ----------------------------------------------------------------- |
| `pet`   | 挂载       | 气泡/徽标/动作（现状，不动）                                      |
| `toast` | **不挂载** | `say` → 页内 toast；`badge` → 角落计数片                          |
| `both`  | 挂载       | 双通道都走（toast 只在页面失焦时弹，复用 notify.ts 的聚焦门哲学） |

实现落点：PetMulti 的渲染分支（同一份 /state 轮询，换 sink），不是新插件。理由：轮询循环、叶子分发、任务/会话状态机都在 PetMulti 里现成，另起插件要复制整套；而"独立第三方 presenter"路线（4.5）已由插槽机制兜底，不必本包代办。

**surface 规避**：toast 档位下宠物 `display` 仍为 `web`——surface/锁/anim 端点全部照常受理；只是渲染端选择不画宠物。指令"落空"的判定权从宿主移到渲染端，这正是 display:none 契约想要的语义且不动它。

### 4.2 toast 形态选型：页内浮层（弃 Web Notification）

|             | 页内浮层（选它）        | Web Notification                         |
| ----------- | ----------------------- | ---------------------------------------- |
| 透明度/样式 | 完全可控（毛玻璃 rgba） | 系统样式                                 |
| 存续        | 8s 自动收起 + 手动关    | ~5s 系统决定                             |
| 点击意图    | DOM 事件，精确路由      | 回调受限                                 |
| 页面聚焦时  | 照常显示                | notify.ts 的聚焦门会**跳过**（设计矛盾） |

新组件 `src/client/toast.ts`：右下角堆叠（自底向上），一条 = 文本（+可选配图缩略）+ 关闭钮；计数片 = 常驻角落小徽标（呼吸动画同 badge.ts 的 keyframes，同 tone 变量）。

### 4.3 intent 字段（/broadcast 契约扩展，加法）

```yaml
# /broadcast body 追加（openapi 0.4.0）
intent:
  type: object
  properties:
    type: { enum: [open-session, open-url] }
    sessionId: { type: string } # open-session 必填
    url: { type: string } # open-url 必填，http/https（与 badge href 同口径）
```

- 校验：形状非法 → **静默丢弃 intent，事件照投**（与 /badge 富字段同一约定）；`open-session` 的 sessionId 只做非空字符串校验（DSH 会话 id 语法不属于本包契约）。
- 落盘：`intent` 子对象随 say 叶子透传（readSay 加一个可选字段，老消费者忽略）。
- 消费：toast 点击 → `open-session` 调 `uiWorkspace.openSession(sessionId)`（app.ts 装配层已注入该服务，取不到则降级为把 DSH 窗口叫回前台——与 notify.ts 同一降级）；`open-url` 走 `window.open`。
- **宠物形态（pet 档位）v1 不消费 intent**：气泡保持非交互（现有 pointer-events 语义），避免动气泡的命中区逻辑。intent 的消费者是 toast 与徽标（徽标已有 href 语义，与 intent-open-url 等价，不合并——badge 是常驻计数、intent 是瞬时事件，两回事）。

### 4.4 seeed-ts 参考实现升级（转发投递 → 带意图）

pet-bridge.mjs 的 broadcast 调用追加可选 intent：新客诉事件带 `open-url`（Zoho 工单链接）或（将来）`open-session`（该客诉的 DSH 会话 id，若团队把会话按 case 建）。适配器只加一个参数，零结构改动。

### 4.5 第三方独立 presenter（备选路线，不本包实现）

外部插件可注册 `shell.overlay` 浮层 + 自行轮询 `/state`：本 ADR 的 intent 字段落进 say 叶子后，**任何**第三方 presenter 都能拿到"点击去哪"的信息——这是把"整个交互层可替换"最终交还给生态的那一步，契约先行即可。

## 5. 实施计划（两个阶段，每阶段独立可回滚）

**阶段一（intent，纯契约+宿主）**：openapi + /broadcast 校验/透传 + say 叶子 intent + 冒烟 3 项（合法/非法丢弃/透传读回）。
**阶段二（presenter 档位）**：配置字段 + toast.ts + PetMulti 分支 + 计数片 + 设置页档位 UI + 冒烟（toast 模式下 say → 页内 DOM、badge → 计数片、宠物 DOM 不挂载）。

门禁沿用：typecheck / eslint / prettier / bundle / 全量冒烟 / check-openapi。

## 6. 风险

- R1 toast 档位下 `anim`/`position` 等端点仍受理但无视觉效果——可接受（语义="渲染端选择不画"），README 明示。
- R2 say 叶子加字段需要 host+client 同步发布；老 host + 新 client 读不到 intent 只是点击降级为关 toast，无破坏。
- R3 页内 toast 与 DSH 页面 UI 重叠：右下角定位 + `z-index` 低于菜单层；both 档位聚焦门防打扰。

## 7. 开放问题

- Q1 "全新对话页"（新建 DSH 会话）需要 DSH 应用层 API——待调研 `uiWorkspace` 是否有 createSession/openNew 能力。
- Q2 toast 档位下桌面端是否需要镜像（桌面 Helper 显示一个无边框小气泡窗）——等 web 档位用出反馈再议。
