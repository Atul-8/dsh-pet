# ADR-002：数据源统一架构 —— source 注册表 + 新鲜度看门狗

状态：**三阶段全部已实现**（阶段一 `7cd75b2` 注册表+看门狗+灰化、阶段二 `e7a34a3` 设置页数据源卡、阶段三 `0c1c47c` builtin-webview 会话看门人；API 学习与油猴复用留 v1.1，见 §4 尾注） · 日期：2026-10-23 · 影响包：dsh-pet 0.4.0（已随 0.4.0 发布）（与 ADR-001 同期）
关联：[ADR-001](adr-001-presenter-and-intent.md)（消费端：presenter 档位 + 事件意图）——两份合成完整故事：
**任何来源 → 统一投递 → 任意呈现**。

## 1. 背景与动机

- 现有数据源全是「外部推送」：油猴（→桥 `/badge`）、seeed-ts pet-bridge（→桥 `/broadcast`）。
  能工作，但对插件**不可见**：不知道有哪些源、不知道死活、不知道是谁在喂。
- 断链的真实痛点不是技术是**静默**：Zoho 标签被浏览器内存节省丢弃后，徽标继续挂着 5 分钟前的
  旧数字，没有任何提示（已实测到的 4 个机理：丢标 / 关标 / 登录过期 / 浏览器关闭，全在插件视野外）。
- 未来不止 Zoho，也不止一种接法（油猴 / 自研扩展 / 内建抓取 / 邮件 / CI…）。
  **要求：新增需求 = 新增一个 source 类型 + 一个适配器模块（或仅一行配置），核心零重构。**

## 2. 现状证据

- 桥 `/badge` `/broadcast` 已是渲染无关的通用契约（openapi 0.3.9）；
  徽标数据自带 `ts`（契约要求）但**没有任何消费者**。
- 外部推送是 fire-and-forget：POST 完就走，宿主不留痕。

## 3. 决策

### 3.1 source 分类学（两类，统一接口）

| 类                         | 代码在哪                   | 宿主职责                             | 例子                                                         |
| -------------------------- | -------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| **declared**（外部推送型） | 外部（油猴/扩展/其他插件） | 只登记「期待」：心跳间隔、喂哪个叶子 | zoho-tm、seeed-files                                         |
| **active**（内建驱动型）   | 插件内，宿主跑循环         | 生命周期 + 参数 + 自报健康           | builtin-webview（会话看门人）、未来 http-api/imap 模板适配器 |

**active 适配器走桥自我环回**（POST `127.0.0.1:7340`），不直调内部函数——校验、心跳、
状态写入天然复用**同一条路径**，适配器与外部推送者在宿主眼里不可区分。这是「加类型不重构」
的结构保证：宿主永远只认一种东西=「往桥上 POST 的调用方」。

### 3.2 注册表（配置驱动）

`main-config.jsonc` 新增 `sources: [...]`：

```jsonc
{ type: 'external-push', id: 'zoho-tm',     feed: 'badge',     expectIntervalMs: 90000 },
{ type: 'external-push', id: 'seeed-files', feed: 'broadcast' },                          // 事件型：无 interval 期待
{ type: 'builtin-webview', id: 'zoho-direct', intervalMs: 60000 /* …登录与 API 学习参数 */ }
```

- 新增**外部**源 = 加一行配置（+外部脚本自己 POST）。
- 新增**内建**源 = 加一行配置 + 一个适配器模块（registry 注册 type → factory）。
- 非法条目丢弃并 warn，不炸配置加载（与宠物条目同一口径）。

### 3.3 契约扩展（加法，老版本零破坏）

`/badge`、`/broadcast` body 新增可选 **`source?: string`**（声明自己是谁，≤64 字符；
非法/超长**静默丢弃字段**——与 `tone`/`items` 同一既有约定）：

- POST 命中已声明的 id → 刷新 `sources.<id>.lastSeen`（心跳）。
- 未声明 / 不带 source → 照常投喂，心跳记 `anonymous`（不参与按源健康判定）。
- 油猴 v0.7、seeed-ts pet-bridge v1.3 各加一行 `source` 字段即接入。

### 3.4 新鲜度看门狗（用户已定：并入主路线）

宿主每 30s 一拍，写新叶子 **`sections.sources`**：

```
{ list: [{ id, type, feed, health, lastSeen }],  counter: Date.now() }
health ∈ alive | stale | unknown | expired | disabled
```

判定：

- declared + `expectIntervalMs`：`lastSeen` 超过 `max(2×interval, 5min)` → `stale`；从未见过 → `unknown`。
- declared 事件型（无 interval）：只显示 `lastSeen`，**永不 stale**（否则天天误报）。
- active：适配器自报（`error` → `expired`；webview 登录失效 → `expired` + 提示重登）。

**渲染端规则（badge.ts 小改）**：徽标 `ts` 超阈值 **或** 其 source 判 stale/expired →
渲染为 `tone: gray` + tooltip「数据源离线 N 分钟 / 点击重新登录」。gray 是既有 tone 值，
**零契约新增**。数据不清、只降色：链路恢复后下一拍自动回红。

### 3.5 管理面（设置页）

设置页新增「数据源」分区：列全部源（类型 / 健康 / 最后心跳 / 启停开关），
active 源点开配置参数。「统一管理」的落点在这里，不在代码。

### 3.6 与 ADR-001 的关系

- source 声明**谁在投**；intent（ADR-001）声明**点击去哪**。正交，组合出完整事件：
  `{ source: 'seeed-files', text: '新客诉 #101', intent: { type: 'open-url', url } }`。
- ADR-001 的 toast 档位同时消费 `sections.sources`：toast 模式下源健康直接在弹窗堆里显示。

### 3.7 多源与徽标单槽

v1 徽标仍单槽 last-write-wins；`source` 字段提供出处（tooltip 显示来源名）。
多槽徽标（每源一颗）留开放问题——等真出现两源同时喂 badge 的场景再设计。

## 4. 实施计划（每阶段独立可回滚）

1. **阶段一（框架+看门狗）**：契约 `source` 字段 + `sources` 配置 + 心跳刷新 +
   `sections.sources` 叶子 + badge 灰化规则 + 冒烟（declared 声明 / 心跳 / stale 判定 / 匿名兼容）。
2. **阶段二（管理面）**：设置页「数据源」分区。
3. **阶段三（首个 active 适配器）**：`builtin-webview`（route B 会话看门人）——可见登录窗
   （交互式登录+2FA、cookie 落 persist 分区、**不存密码**）→ 学习 API → 无窗口 cookie-jar 轮询 →
   桥环回。复用 Helper 基建（helper-process.ts / runtime/electron-helper / ensure-electron.mjs）。

阶段一完成即兑现「断链永远看得见」；阶段三之后 A（油猴）/A'（扩展）/B（内建）三路并存，
用户按环境自由选——「全兼容」的架构表达。

## 5. 风险

- **误报 stale**（源正常但间隔抖动）→ 阈值 2×interval + 5min 下限；gray 只降色不删数据。
- **老外部脚本不带 source** → 匿名路径照常工作（绝不拒收），升级时顺手加字段。
- **配置膨胀** → 每源参数进独立适配器 schema（type 判别），主配置只留登记行。

## 6. 开放问题

- Q1 多槽徽标（每源一颗）：是否做、何时做。
- Q2 `builtin-webview` 的「学习到的 API」导出给油猴复用（一处学习，多方投喂）。
  **学习本体已落地（v1.1，随 0.4.0）**：登录窗抓包会话（Electron 侧
  `source:learn-start/list/stop`，webRequest 被动观察同源 XHR）→ 学习文件
  `$DSH_HOME/dsh-pet/source-api-<id>.json`（`{version, method, url, countPath}`，
  只记 HTTP 语义层，无凭证；写入端同源双保险）→ 看门人 tick 探活成功后按学到的
  API 无窗口取数（`source:fetch-json`），`countPath` 从响应 JSON 挖出真实待办数
  投桥——挖不到/取失败回落哨兵数字 1（学习是增强件，坏了不炸轮询）。
  host 侧纯逻辑在 `src/host/learned-api.ts`（读写校验挖数一体，24 用例钉住）。
  剩余半截：**导出面**（学习文件如何交给油猴脚本）——等油猴侧真有消费方再定。
- Q3 active 适配器的并发上限（多源同时轮询时的节流策略）。
