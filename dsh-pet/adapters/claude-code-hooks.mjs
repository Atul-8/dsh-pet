#!/usr/bin/env node
/**
 * claude-code hooks → 桌宠桥适配器（ADR-002 source 注册表接入样例）。
 *
 * 挂载（~/.claude/settings.json，把路径换成你放本文件的地方）：
 * {
 *   "hooks": {
 *     "Stop":        [{ "hooks": [{ "type": "command", "command": "node ~/.dsh/pet-hooks/claude-code-hooks.mjs" }] }],
 *     "Notification": [{ "hooks": [{ "type": "command", "command": "node ~/.dsh/pet-hooks/claude-code-hooks.mjs" }] }]
 *   }
 * }
 *
 * claude-code 的 hook 契约：事件发生时把一份 JSON 从 **stdin** 喂给命令
 * （字段含 session_id / hook_event_name / tool_name / tool_input / cwd / message 等），
 * 命令的 stdout 只用于 Stop/SessionEnd 类事件的续指令（本适配器不产输出，纯投喂）。
 * 退出码 0 = 不干预 claude 的流程——本适配器**只观察、不阻断**。
 *
 * 投喂语义：
 *   - Notification（等权限/等输入）→ 工作状态 waiting + 气泡播通知摘要
 *   - Stop（回合结束）→ 工作状态回空闲（DELETE）+ 气泡「完成一回合」
 *   - 其余事件（PreToolUse 等，用户想挂就挂）→ 只刷心跳（badge 不投，别刷屏）
 *
 * source: 'claude-code' —— 需在用户配置 sources[] 里声明（见 adapters/README.md）。
 * 未声明也照常投喂（匿名兼容），只是设置页数据源卡里看不到它。
 */
const BRIDGE = 'http://127.0.0.1:7340/dsh-pet-7340';
const SOURCE = 'claude-code';
const PET = 'main'; // 没改过配置就是 main

/** 读 stdin（hook 的 JSON 在这里，不在 argv） */
function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
    // claude-code 超时保护：1s 内没给完就当空处理（绝不挂住宿主流程）
    setTimeout(() => resolve(raw), 1000);
  });
}

/** 本机回环直连（绕系统代理——环境代理劫持 127.0.0.1 是最常见的投喂失效原因） */
async function post(path, body) {
  try {
    const r = await fetch(BRIDGE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Node 的 fetch 没有 curl 的 --noproxy；显式给空 agent 直连
      dispatcher: undefined,
      signal: AbortSignal.timeout(3000),
    });
    return r.ok || r.status === 200;
  } catch {
    return false; // 桥不在（DSH 没开 / 独立模式没跑）：静默失败，绝不让 hook 报错
  }
}

async function del(path) {
  try {
    const r = await fetch(BRIDGE + path, { method: 'DELETE', signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** 摘要：通知消息取前 80 字符（气泡别太长） */
const brief = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').slice(0, 80) : '');

async function main() {
  const raw = await readStdin();
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch {
    return 0; // 坏输入不报错（hook 崩溃会污染 claude 的会话）
  }
  const name = ev.hook_event_name;

  if (name === 'Notification') {
    // 等权限/等输入：宠物切 waiting 档（用户一眼看到该回去点确认了）
    await post('/work-status', { state: 'waiting', task: 'claude 等待确认', source: SOURCE });
    await post('/broadcast', {
      text: 'claude：' + (brief(ev.message) || '等你确认'),
      pet: PET,
      surface: 'any',
      duration: 8000,
      source: SOURCE,
    });
  } else if (name === 'Stop') {
    // 回合结束：清工作状态（回空闲）+ 轻气泡
    await del('/work-status');
    await post('/broadcast', {
      text: 'claude 完成一回合 ' + (ev.cwd ? '· ' + String(ev.cwd).split(/[\\/]/).pop() : ''),
      pet: PET,
      surface: 'any',
      duration: 5000,
      source: SOURCE,
    });
  } else {
    // 其它事件（PreToolUse/PostToolUse/用户自己挂的）：只刷心跳不弹气泡（防刷屏）。
    // 空文本 broadcast 会被宿主拒（bad-request），但**心跳在拒之前已记**——
    // 这正是「source 字段在所有校验之前生效」的设计（活着但发坏数据 ≠ 死了）。
    await post('/broadcast', { text: '·', pet: PET, surface: 'any', duration: 0, anim: false, source: SOURCE });
  }
  return 0;
}

main().then((c) => process.exit(c));
