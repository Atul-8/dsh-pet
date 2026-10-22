#!/usr/bin/env node
/**
 * dsh-pet —— Zoho Desk 只读探针
 *
 * 目的：在改动任何桌宠代码之前，先验证「能否通过官方只读 API 读到
 *       部门 "ae" + 客服 "陈土泽" 名下状态为 New/Open/On hold 的待处理工单」。
 *
 * 只读保证：OAuth scope 只用 Desk.tickets.READ；本脚本对 Zoho 只发 GET，
 *           不调用任何 创建/更新/关闭/回复/删除 工单的接口。
 *
 * 用法：
 *   # 方式一：用 api-console Self Client「Generate Code」得到的授权码（首次）
 *   node scripts/desk-probe.mjs --client-id <ID> --client-secret <SECRET> --code <CODE>
 *
 *   # 方式二：之前已经换出 refresh token，直接复用
 *   node scripts/desk-probe.mjs --client-id <ID> --client-secret <SECRET> --refresh-token <RT>
 *
 * 可选参数：
 *   --region com|com.cn|eu|in|au|jp   数据中心（默认 com；中国区用 com.cn）
 *   --department-id <id>             跳过自动匹配，直接指定部门
 *   --assignee-id <id>               跳过自动匹配，直接指定客服
 *   --status "New,Open,On hold"      自定义"待处理"状态集
 */

const REGIONS = {
  com: { accounts: 'https://accounts.zoho.com', desk: 'https://desk.zoho.com' },
  'com.cn': { accounts: 'https://accounts.zoho.com.cn', desk: 'https://desk.zoho.com.cn' },
  eu: { accounts: 'https://accounts.zoho.eu', desk: 'https://desk.zoho.eu' },
  in: { accounts: 'https://accounts.zoho.in', desk: 'https://desk.zoho.in' },
  au: { accounts: 'https://accounts.zoho.com.au', desk: 'https://desk.zoho.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', desk: 'https://desk.zoho.jp' },
};

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(msg) {
  console.error('\n❌ ' + msg);
  process.exit(1);
}

async function main() {
  const clientId = arg('client-id');
  const clientSecret = arg('client-secret');
  const code = arg('code');
  const refreshToken = arg('refresh-token');
  const region = REGIONS[arg('region') || 'com'] ?? fail('未知 --region，可选：' + Object.keys(REGIONS).join(', '));
  const statuses = (arg('status') || 'New,Open,On hold')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!clientId || !clientSecret) fail('需要 --client-id 和 --client-secret（api-console 里创建 Self Client 后可得）');
  if (!code && !refreshToken) fail('需要 --code（授权码）或 --refresh-token 之一');

  // ---- 1) 取 access token ----
  let accessToken;
  if (code) {
    const u =
      `${region.accounts}/oauth/v2/token?grant_type=authorization_code` +
      `&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}` +
      `&code=${encodeURIComponent(code)}&scope=${encodeURIComponent('Desk.tickets.READ')}`;
    const r = await fetch(u, { method: 'POST' });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.access_token) {
      fail('换 access token 失败：' + JSON.stringify(body || (await r.text().catch(() => ''))));
    }
    accessToken = body.access_token;
    if (body.refresh_token) {
      console.log('ℹ️ 换出的 refresh token（长期有效，正式接入时存进 DSH 凭证）：');
      console.log('   ' + body.refresh_token + '\n');
    }
  } else {
    const u =
      `${region.accounts}/oauth/v2/token?grant_type=refresh_token` +
      `&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}` +
      `&refresh_token=${encodeURIComponent(refreshToken)}`;
    const r = await fetch(u, { method: 'POST' });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body?.access_token) {
      fail('refresh token 换 access token 失败：' + JSON.stringify(body || (await r.text().catch(() => ''))));
    }
    accessToken = body.access_token;
  }

  const auth = { Authorization: 'Zoho-oauthtoken ' + accessToken };

  // ---- 2) 取 orgId ----
  const orgRes = await fetch(`${region.desk}/api/v1/organizations`, { headers: auth });
  const orgBody = await orgRes.json().catch(() => null);
  const orgs = Array.isArray(orgBody?.data) ? orgBody.data : [];
  if (!orgRes.ok || orgs.length === 0) {
    fail('拉组织列表失败：' + JSON.stringify(orgBody));
  }
  const orgId = String(orgs[0].id);
  console.log('✅ 组织：' + orgs.map((o) => `${o.companyName || o.name || ''} (id=${o.id})`).join('、'));
  const orgAuth = { ...auth, orgId };

  // ---- 3) 部门列表（自动匹配 "ae"） ----
  let departmentId = arg('department-id');
  const depRes = await fetch(`${region.desk}/api/v1/departments`, { headers: orgAuth });
  const depBody = await depRes.json().catch(() => null);
  const deps = Array.isArray(depBody?.data) ? depBody.data : [];
  console.log('📁 部门：');
  for (const d of deps) console.log(`   ${d.name} (id=${d.id})`);
  if (!departmentId) {
    const hit = deps.find((d) => String(d.name).toLowerCase() === 'ae' || String(d.name).toLowerCase().includes('ae'));
    if (hit) {
      departmentId = String(hit.id);
      console.log('   → 自动匹配到 "ae" = ' + hit.name + ' (id=' + hit.id + ')');
    }
  }

  // ---- 4) 客服列表（自动匹配 "陈土泽"） ----
  let assigneeId = arg('assignee-id');
  const agRes = await fetch(`${region.desk}/api/v1/agents`, { headers: orgAuth });
  const agBody = await agRes.json().catch(() => null);
  const agents = Array.isArray(agBody?.data) ? agBody.data : [];
  console.log('👤 客服：');
  for (const a of agents) console.log(`   ${a.name} <${a.emailId || ''}> (id=${a.id})`);
  if (!assigneeId) {
    const hit = agents.find((a) => String(a.name).includes('陈土泽'));
    if (hit) {
      assigneeId = String(hit.id);
      console.log('   → 自动匹配到 "陈土泽" = ' + hit.name + ' (id=' + hit.id + ')');
    }
  }

  if (!departmentId || !assigneeId) {
    fail(
      '未能自动确定部门/客服。请从上表找到对应 id，用 --department-id <id> / --assignee-id <id> 重新跑。' +
        (departmentId ? '' : '（缺部门 ae）') +
        (assigneeId ? '' : '（缺客服 陈土泽）'),
    );
  }

  // ---- 5) 按状态拉待处理工单并计数 ----
  let total = 0;
  const subjects = [];
  for (const st of statuses) {
    const qs = new URLSearchParams({
      departmentId,
      assignee: assigneeId,
      status: st,
      limit: '50',
    });
    let count = 0;
    let from = 0;
    for (let guard = 0; guard < 20; guard++) {
      qs.set('from', String(from));
      const r = await fetch(`${region.desk}/api/v1/tickets?${qs.toString()}`, { headers: orgAuth });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        console.warn(`   ⚠️ 状态 ${st} 拉取失败：${JSON.stringify(body)}`);
        break;
      }
      const data = Array.isArray(body?.data) ? body.data : [];
      for (const t of data) subjects.push(String(t.subject || '(无主题)'));
      count += data.length;
      if (data.length < 50) break;
      from += data.length;
    }
    console.log(`   ${st}: ${count} 封`);
    total += count;
  }

  console.log('\n📬 待处理工单总数：' + total);
  if (subjects.length) {
    console.log('   最近主题：');
    for (const s of subjects.slice(0, 10)) console.log('     · ' + s);
  }
  console.log('\n✅ 只读读取成功。说明可以接进桌宠做常驻计数徽标。');
}

main().catch((e) => {
  console.error('\n❌ 运行出错：' + (e?.message || e));
  process.exit(1);
});
