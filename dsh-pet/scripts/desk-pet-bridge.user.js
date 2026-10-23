// ==UserScript==
// @name         dsh-pet Zoho Desk → 桌宠待处理徽标
// @namespace    dsh-pet
// @version      0.6.1
// @description  只读抓取 Zoho Desk 工单视图的待处理数，投喂本地桌宠徽标；固定端口桥(7340) + 应答体验证（防哑服务冒认端口）+ 自动学习页面真实 API
// @match        *://*.sensecapmx.com/*
// @match        *://*.zoho.com/*
// @match        *://*.zoho.com.cn/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

// ⚠️ 只读：本脚本对工单系统只发 GET（同源 fetch，复用页面自己的请求参数与头），对本地桌宠只 POST 一个数字。
// 不做任何写操作（不回复/不关闭/不指派/不修改工单）。
(function () {
  'use strict';

  // ---- 配置 ----
  const LIST_URL = 'https://support.sensecapmx.com/agent/seeed/technical-support/tickets/list/ae-陈土泽?view=classic';
  // 端口候选：**固定桥优先**（127.0.0.1:7340~7344，桌宠宿主 v0.3.8+ 常驻监听，不随 DSH 重启漂移）。
  // 记忆端口排在桥后面（经形状校验，被污染自动纠正）；旧 DSH 端口仅兜底。
  const PORT_CANDIDATES = [7340, 7341, 7342, 7343, 7344];
  const LEGACY_PORTS = [62056, 57925, 59772];
  // 兜底默认 API（学习成功前使用；学习后完全被页面真实请求取代）
  const DEFAULT_API = {
    url:
      '/supportapi/zd/seeed/api/v1/tickets?include=contacts,products,assignee,team,isRead&departmentId=630254000037747420&viewId=630254000129591195&limit=50&sortBy=-recentThread&filters=' +
      encodeURIComponent(JSON.stringify({ criteria: { fieldConditions: [] } })),
    headers: {},
  };
  const PENDING = new Set(['new', 'open', 'on hold']); // 哪些状态算「待处理」（大小写不敏感）
  const REFRESH_MS = 60 * 1000;
  const SHOW_INDICATOR = true;

  function log(...m) {
    console.log('[dsh-pet-desk]', ...m);
  }

  // ================= 1. 页面请求学习（fetch / XHR 挂钩） =================
  // 思路：工单列表页自己会发一条「加载工单」的请求（org 上下文、请求头全部正确）。
  // 挂钩截获 GET 型 ticket 请求 → 自测（重放一次验证返回 data 数组）→ 通过即存为学习结果。
  let candidates = []; // {url, headers}，页面真实请求的候选
  let learned = null; // 学习成功的 API：{url, headers}
  function loadLearned() {
    try {
      const v = GM_getValue('deskApi', null);
      if (v && v.url) learned = v;
    } catch {}
  }
  function saveLearned(c) {
    learned = { url: c.url, headers: c.headers || {} };
    GM_setValue('deskApi', learned);
    log('✅ 已学习页面真实 API：', learned.url, 'headers:', learned.headers);
  }
  loadLearned();

  /** 提取 fetch init.headers（Headers 对象 / 数组 / 普通对象统一成小写键对象） */
  function extractHeaders(h) {
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        for (const [k, v] of h.entries()) out[k.toLowerCase()] = String(v);
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
      } else if (typeof h === 'object') {
        for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
      }
    } catch {}
    return out;
  }

  /** 浏览器禁止脚本设置的请求头一律剔除（Cookie/Host/Origin/Referer 等由浏览器自己带） */
  function safeHeaders(headers) {
    const forbidden = new Set([
      'cookie',
      'host',
      'origin',
      'referer',
      'user-agent',
      'content-length',
      'connection',
      'accept-encoding',
      'keep-alive',
      'upgrade',
      'te',
      'trailer',
      'transfer-encoding',
      'proxy-authorization',
      'proxy-connection',
    ]);
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (!forbidden.has(k)) out[k] = v;
    }
    return out;
  }

  /** 判断 URL 是否像「工单列表 API」请求 */
  function looksLikeTicketApi(urlStr) {
    try {
      const u = new URL(urlStr, location.origin);
      if (u.origin !== location.origin) return false; // 只学同源（重放需要带 cookie）
      if (!/tickets/.test(u.pathname) || !/api/.test(u.pathname)) return false;
      const has = u.searchParams.has('departmentId') || u.searchParams.has('viewId') || u.searchParams.has('assignee');
      return has;
    } catch {
      return false;
    }
  }

  function pushCandidate(urlStr, headers) {
    try {
      if (!looksLikeTicketApi(urlStr)) return;
      const u = new URL(urlStr, location.origin);
      u.searchParams.delete('from'); // 分页位置由我们自己控制
      if (!u.searchParams.get('limit')) u.searchParams.set('limit', '50');
      const c = { url: u.toString(), headers: safeHeaders(headers) };
      const key = c.url + '|' + JSON.stringify(c.headers);
      if (candidates.some((x) => x.url + '|' + JSON.stringify(x.headers) === key)) return;
      candidates.push(c);
      if (candidates.length > 20) candidates = candidates.slice(-20);
      log('捕获页面工单请求候选：', c.url);
    } catch {}
  }

  function hook() {
    try {
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
          const method = (
            (init && init.method) ||
            (typeof Request !== 'undefined' && input instanceof Request && input.method) ||
            'GET'
          ).toUpperCase();
          if (method === 'GET') pushCandidate(url, extractHeaders(init && init.headers));
        } catch {}
        return nativeFetch.apply(this, arguments);
      };
    } catch {}
    try {
      const nativeOpen = XMLHttpRequest.prototype.open;
      const nativeSet = XMLHttpRequest.prototype.setRequestHeader;
      const nativeSend = XMLHttpRequest.prototype.send;
      const meta = new WeakMap();
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          meta.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {} });
        } catch {}
        return nativeOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
          const m = meta.get(this);
          if (m) m.headers[String(name).toLowerCase()] = String(value);
        } catch {}
        return nativeSet.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          const m = meta.get(this);
          if (m && m.method === 'GET') pushCandidate(m.url, m.headers);
        } catch {}
        return nativeSend.apply(this, arguments);
      };
    } catch {}
  }
  hook();

  /** 重放一次候选请求，验证是否真能拿到工单数组 */
  async function validateCandidate(c) {
    try {
      const r = await fetch(c.url, { credentials: 'same-origin', headers: c.headers });
      if (!r.ok) return { ok: false, status: r.status };
      const j = await r.json().catch(() => null);
      if (j && Array.isArray(j.data)) return { ok: true };
      return { ok: false, status: 200, shape: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // ================= 2. 桌宠宿主端口发现 =================
  let liveBase = null;
  let baseNote = '未探测';
  function gmFetch(url, { method = 'GET', data, timeout = 3000 } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: data ? { 'Content-Type': 'application/json' } : undefined,
        data,
        timeout,
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: () => reject(new Error('网络错误（桌宠宿主没开？）')),
        ontimeout: () => reject(new Error('超时')),
      });
    });
  }
  /** 端点验活：不只看 200——**必须**是桌宠的 /state 形状（JSON 且含 sections 对象）。
   *  教训：本机其它哑 HTTP 服务会对任何请求回 200（实测 QQ 的 4310 端口回 200+二进制垃圾），
   *  只看状态码就会把徽标喂进别人的端口，还把错误端口写进记忆。 */
  async function probePort(port) {
    const base = 'http://127.0.0.1:' + port;
    try {
      const r = await gmFetch(base + '/dsh-pet-7340/state', { timeout: 2500 });
      if (r.status !== 200) return false;
      let j = null;
      try {
        j = JSON.parse(r.text);
      } catch {}
      return Boolean(j && typeof j === 'object' && j.sections && typeof j.sections === 'object');
    } catch {
      return false;
    }
  }
  async function findBase() {
    // 候选顺序：**固定桥优先**（7340~7344，不随 DSH 重启漂移，是基准事实）→ 记忆端口（会经验活
    // 校验，被污染也能自动纠正）→ 旧 DSH 端口兜底。
    const memo = GM_getValue('dshPetPort', null);
    const cands = [...new Set([...PORT_CANDIDATES, ...(memo ? [memo] : []), ...LEGACY_PORTS].filter(Boolean))];
    for (const port of cands) {
      if (await probePort(port)) {
        GM_setValue('dshPetPort', port);
        liveBase = 'http://127.0.0.1:' + port;
        baseNote = '端口 ' + port + ' ✓';
        return liveBase;
      }
    }
    // no-cors 兜底探测已删除：它读不到应答体、无法验形状，正是「哑服务 200 误认」的温床
    //（响应 opaque 时连 200 都看不到）。桥验活失败 = 宿主真没开，报未找到更诚实。
    liveBase = null;
    baseNote = '桌宠宿主未找到（桥 7340~7344 无应答；宿主开了吗？）';
    return null;
  }

  // ================= 3. 抓取（用学习到的或默认的 API） =================
  async function fetchPage(api, from) {
    const u = new URL(api.url, location.origin);
    u.searchParams.set('from', String(from));
    const r = await fetch(u.toString(), { credentials: 'same-origin', headers: api.headers });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { ok: r.ok, status: r.status, json, text };
  }

  /** 翻页拉全工单（0/1 基自适应 + 去重） */
  async function collect(api) {
    let first = await fetchPage(api, 1);
    if (!first.ok || !Array.isArray(first.json?.data) || first.json.data.length === 0) {
      const zero = await fetchPage(api, 0);
      if (zero.ok && Array.isArray(zero.json?.data) && zero.json.data.length > 0) first = zero;
    }
    if (!first.ok)
      return { error: 'HTTP ' + first.status + '（登录态失效？接口变了？）', detail: first.text.slice(0, 200) };
    if (!Array.isArray(first.json?.data)) return { error: 'HTTP 200 但响应形状异常', detail: first.text.slice(0, 200) };
    const all = [];
    const seen = new Set();
    let fromBase = 1;
    if (first.json.data.length > 0 && (await fetchPage(api, 0)).json?.data?.[0]?.id === first.json.data[0]?.id) {
      fromBase = 1; // 1 基与 0 基返回同一条 → 1 基即可
    }
    for (let from = fromBase; from < 10000; from += 50) {
      const j = from === fromBase ? first.json : (await fetchPage(api, from)).json;
      if (!j || !Array.isArray(j.data) || j.data.length === 0) break;
      let fresh = 0;
      for (const t of j.data) {
        const key = String(t.id ?? t.ticketNumber ?? t.subject ?? Math.random());
        if (!seen.has(key)) {
          seen.add(key);
          all.push(t);
          fresh += 1;
        }
      }
      if (j.data.length < 50 || fresh === 0) break;
    }
    return { all };
  }

  function summarize(all) {
    const statusCount = {};
    for (const t of all) {
      const s = String(t.status || t.statusType || '(无状态)');
      statusCount[s] = (statusCount[s] || 0) + 1;
    }
    const pending = all.filter((t) => PENDING.has(String(t.status || t.statusType || '').toLowerCase()));
    const subjects = pending.slice(0, 10).map((t) => String(t.subject || '(无主题)'));
    return { count: pending.length, subjects, ts: Date.now(), total: all.length, statusCount };
  }

  async function report(payload) {
    if (!liveBase && !(await findBase())) return { ok: false, note: baseNote };
    const base = liveBase;
    const body = JSON.stringify(payload);
    // 通道 1：GM 特权请求（绕 CORS，可读状态码 + 应答体）。
    // **200 不算成功**——必须带回桌宠的 {"ok":true} 回执：本机哑服务对什么请求都回 200
    // （实测 QQ 的 4310），只认状态码会把徽标喂进别人的端口还显示「已投喂」。
    try {
      const r = await gmFetch(base + '/dsh-pet-7340/badge', { method: 'POST', data: body, timeout: 8000 });
      if (r.status === 200) {
        let j = null;
        try {
          j = JSON.parse(r.text);
        } catch {}
        if (j && j.ok === true) return { ok: true, note: '已上报(GM) ' + base };
        // 200 但不是桌宠回执 → 端口被哑服务冒认：作废记忆，下一拍重探（桥在前，能自愈）
        GM_setValue('dshPetPort', null);
        liveBase = null;
        return { ok: false, note: '端口应答非桌宠回执（' + base + '），已重置端口记忆' };
      }
      if (r.status === 404) {
        GM_setValue('dshPetPort', null);
        liveBase = null;
        return { ok: false, note: '上报 404（端口失效，将重试探测）' };
      }
      return { ok: false, note: '上报 HTTP ' + r.status };
    } catch (e) {
      // GM 网络层失败（连不上/超时/@connect 未放行）→ 试通道 2，别急着判死
      log('GM 通道失败，尝试页面级直连通道：', e.message);
    }
    // 通道 2：页面级 no-cors POST —— text/plain 是「简单请求」，无 CORS 预检；
    // 桌宠服务端解析 JSON 不看 Content-Type，所以照样送达。响应不可读（opaque），只保证投喂。
    // （本通道仅在 GM 网络层整体失效时使用；端口已经过验活校验，不会喂错人家。）
    try {
      await fetch(base + '/dsh-pet-7340/badge', {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body,
        credentials: 'omit',
      });
      return { ok: true, note: '已上报(直连) ' + base };
    } catch (e2) {
      GM_setValue('dshPetPort', null);
      liveBase = null;
      return { ok: false, note: '两条通道都连不上：' + (e2 && e2.message ? e2.message : e2) };
    }
  }

  // ================= 4. 指示器 =================
  let indicator;
  function updateIndicator(lines) {
    if (!SHOW_INDICATOR) return;
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(17,17,17,.85);color:#7fe87f;' +
        'font:12px/1.5 monospace;padding:6px 10px;border-radius:6px;pointer-events:none;white-space:pre;max-width:420px;overflow:hidden';
      (document.body || document.documentElement).appendChild(indicator);
    }
    indicator.textContent = lines.join('\n');
  }

  // ================= 5. 主循环 =================
  let lastLines = ['启动中…（等待页面请求学习）'];
  let apiSource = learned ? '已学习' : '默认(未学习)';

  async function tick() {
    if (!liveBase) await findBase();
    // 5a) 若尚未学习 API 且捕获到候选 → 逐个验证，通过即采用
    if (!learned && candidates.length > 0) {
      // 优先带 viewId 的候选（视图级请求，正是我们想盯的）
      const ordered = [...candidates].sort(
        (a, b) => (b.url.includes('viewId=') ? 1 : 0) - (a.url.includes('viewId=') ? 1 : 0),
      );
      for (const c of ordered) {
        const v = await validateCandidate(c);
        if (v.ok) {
          saveLearned(c);
          apiSource = '已学习 ✓';
          break;
        }
        log('候选未通过验证：', c.url.slice(0, 120), v.status || v.error || '');
      }
    }
    const api = learned || DEFAULT_API;
    if (!learned) apiSource = '默认(未学习)';
    try {
      const c = await collect(api);
      if (c.error) {
        lastLines = [
          'API(' + apiSource + ') 抓取失败：' + c.error,
          String(c.detail || '').slice(0, 180),
          learned ? '（菜单可重学/粘贴接口）' : '（打开工单列表页一次即可自动学习真实接口）',
        ];
        updateIndicator(lastLines);
        console.warn('[dsh-pet-desk]', c.error, c.detail);
        return;
      }
      const s = summarize(c.all);
      const rep = await report({ count: s.count, label: '待处理', ts: s.ts, href: LIST_URL, items: s.subjects });
      lastLines = [
        'API ' + apiSource + ' · ' + baseNote + (rep.ok ? '' : ' ⚠ ' + rep.note),
        '视图 ' + s.total + ' 封 · 分布 ' + JSON.stringify(s.statusCount),
        '待处理 ' + s.count + ' · ' + (rep.ok ? '已投喂桌宠' : '未投喂'),
      ];
      updateIndicator(lastLines);
      log('待处理 =', s.count, '视图共', s.total, '分布:', JSON.stringify(s.statusCount), rep.note);
    } catch (e) {
      lastLines = ['脚本异常：' + (e && e.message ? e.message : e)];
      updateIndicator(lastLines);
      console.warn('[dsh-pet-desk] tick 失败', e);
    }
  }

  // ================= 6. 菜单 =================
  GM_registerMenuCommand('dsh-pet: 立即刷新', () => tick());
  GM_registerMenuCommand('dsh-pet: 重新学习接口（先打开工单列表页）', () => {
    learned = null;
    GM_setValue('deskApi', null);
    apiSource = '重新学习中';
    log('已清除学习结果，等待页面新的工单请求…请刷新/打开工单列表页');
    tick();
  });
  GM_registerMenuCommand('dsh-pet: 手动粘贴接口 URL…', () => {
    const v = prompt(
      '粘贴工单列表页自己的请求 URL（DevTools→Network→过滤 tickets→右键请求→Copy→Copy link）：',
      learned ? learned.url : '',
    );
    if (v === null) return;
    try {
      const u = new URL(v.trim(), location.origin);
      if (!looksLikeTicketApi(u.toString())) {
        alert('这个 URL 不像工单列表 API（需要同源、路径含 tickets/api、参数含 departmentId 或 viewId）。');
        return;
      }
      u.searchParams.delete('from');
      saveLearned({ url: u.toString(), headers: {} });
      apiSource = '手动 ✓';
      tick();
    } catch (e) {
      alert('URL 无效：' + e.message);
    }
  });
  GM_registerMenuCommand('dsh-pet: 设置桌宠端口…', () => {
    const v = prompt('桌宠宿主端口（DSH Web GUI 地址栏冒号后的数字）：', String(GM_getValue('dshPetPort', 57925)));
    if (v === null) return;
    const port = Number(String(v).trim());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      alert('端口无效：' + v);
      return;
    }
    GM_setValue('dshPetPort', port);
    liveBase = null;
    tick();
  });
  GM_registerMenuCommand('dsh-pet: 查看诊断', () => {
    alert(
      lastLines.join('\n') +
        '\n\nAPI: ' +
        ((learned && learned.url) || '默认(未学习)') +
        '\n（详细日志在控制台，过滤 [dsh-pet-desk]）',
    );
  });

  // 启动：稍等页面安顿，再开始轮询（页面自身的工单请求会被挂钩捕获用于学习）
  setTimeout(tick, 4000);
  setInterval(tick, REFRESH_MS);
})();
