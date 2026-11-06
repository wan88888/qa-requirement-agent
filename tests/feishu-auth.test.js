import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { FeishuAuth, oauthConfiguration, CALLBACK_PATH, AUTH_COOKIE, FEISHU_VISUAL_SCOPES } from '../src/feishu-auth.js';
import { WorkspaceLogin, LOGIN_COOKIE, LOGIN_SECONDS } from '../src/workspace-login.js';
import { createApp } from '../src/server.js';
import { configuration } from '../src/integrations.js';

const base = 'http://127.0.0.1:3210';
const config = oauthConfiguration({ FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'secret-app-value' });
const token = (overrides = {}) => ({ code: 0, access_token: 'secret-access-value', expires_in: 7200, refresh_token: 'secret-refresh-value', refresh_token_expires_in: 604800, scope: config.scopes.join(' '), token_type: 'Bearer', ...overrides });

test('缺少新增视觉权限不影响已有正文授权，状态单独提示待补充权限', async t => {
  const { auth } = setup(t, async () => Response.json(token({ scope: config.scopes.filter(s => !FEISHU_VISUAL_SCOPES.includes(s)).join(' ') })));
  await login(auth);
  assert.equal(auth.ready(), true); assert.deepEqual(auth.status().missingScopes, []);
  assert.deepEqual(auth.status().missingVisualScopes, FEISHU_VISUAL_SCOPES);
  assert.equal(await auth.accessToken(), token().access_token);
});
function setup(t, fetchImpl = async () => Response.json(token())) {
  const directory = mkdtempSync(join(tmpdir(), 'qa-oauth-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_790_000_000_000;
  const auth = new FeishuAuth({ directory, config: { ...config }, fetchImpl, now: () => now });
  return { directory, auth, advance(ms) { now += ms; }, now: () => now };
}
async function login(auth) {
  const start = auth.start(base), url = new URL(start.authorizationUrl);
  const params = new URLSearchParams({ state: url.searchParams.get('state'), code: 'one-time-code' });
  await auth.complete(params, start.cookie, base); return { start, params, url };
}

test('OAuth 使用官方 v1 授权 + v2 Token、PKCE、最小工具权限，凭据加密保存且不暴露到状态', async t => {
  let request;
  const { auth, directory } = setup(t, async (url, init) => { request = { url, init }; return Response.json(token()); });
  const { start, url } = await login(auth);
  assert.equal(url.origin, 'https://accounts.feishu.cn');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!start.authorizationUrl.includes(config.appSecret));
  const body = new URLSearchParams(JSON.parse(request.init.body));
  assert.equal(request.url, 'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(body.get('client_secret'), config.appSecret);
  assert.equal(body.get('redirect_uri'), config.redirectUri);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(auth.ready(), true); assert.equal(auth.status().autoRefresh, true);
  const ciphertext = readFileSync(auth.vault.file, 'utf8');
  for (const secret of [config.appSecret, token().access_token, token().refresh_token]) {
    assert.ok(!ciphertext.includes(secret)); assert.ok(!JSON.stringify(auth.status()).includes(secret));
  }
  assert.equal(statSync(auth.vault.file).mode & 0o777, 0o600);
  assert.equal(statSync(auth.vault.keyFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'auth')).mode & 0o777, 0o700);
  const reopened = new FeishuAuth({ config, directory, now: auth.now });
  assert.equal(await reopened.accessToken(), token().access_token);
});

test('伪造 state、其他浏览器、回调重放、过期与跨 origin 均拒绝', async t => {
  let calls = 0; const ctx = setup(t, async () => { calls++; return Response.json(token()); }); const { auth } = ctx;
  const start = auth.start(base), state = new URL(start.authorizationUrl).searchParams.get('state');
  await assert.rejects(auth.complete(new URLSearchParams({ state: 'forged', code: 'a' }), start.cookie, base), /过期或浏览器/);
  const params = new URLSearchParams({ state, code: 'a' });
  await assert.rejects(auth.complete(params, 'other-browser', base));
  await assert.rejects(auth.complete(params, start.cookie, 'http://localhost:3210'));
  assert.equal(calls, 0);
  await auth.complete(params, start.cookie, base); assert.equal(calls, 1);
  await assert.rejects(auth.complete(params, start.cookie, base)); assert.equal(calls, 1);
  const expired = auth.start(base); ctx.advance(300001);
  await assert.rejects(auth.complete(new URLSearchParams({ state: new URL(expired.authorizationUrl).searchParams.get('state'), code: 'a' }), expired.cookie, base));
  assert.equal(calls, 1);
});

test('拒绝授权和部分授权有明确状态，不伪造完整登录', async t => {
  let calls = 0; const { auth } = setup(t, async () => { calls++; return Response.json(token({ scope: 'offline_access' })); });
  const start = auth.start(base);
  await auth.complete(new URLSearchParams({ state: new URL(start.authorizationUrl).searchParams.get('state'), error: 'access_denied' }), start.cookie, base);
  assert.equal(calls, 0); assert.match(auth.status().error, /取消/); assert.equal(auth.ready(), false);
  await login(auth); assert.equal(auth.status().authorized, true); assert.equal(auth.ready(), false);
  assert.ok(auth.status().missingScopes.includes('docx:document:readonly'));
  await assert.rejects(auth.accessToken(), /缺少必要权限/);
});

test('并发操作只刷新一次并原子替换一次性 refresh_token，重启后使用新凭据', async t => {
  let calls = 0; const ctx = setup(t, async (_url, init) => {
    calls++;
    if (calls === 1) return Response.json(token({ expires_in: 1 }));
    assert.equal(JSON.parse(init.body).refresh_token, 'secret-refresh-value');
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json(token({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }));
  });
  await login(ctx.auth); ctx.advance(2000);
  const values = await Promise.all([ctx.auth.accessToken(), ctx.auth.accessToken(), ctx.auth.accessToken()]);
  assert.deepEqual(values, ['rotated-access', 'rotated-access', 'rotated-access']); assert.equal(calls, 2);
  const reopened = new FeishuAuth({ config, directory: ctx.directory, now: ctx.now });
  assert.equal(reopened.session.refreshToken, 'rotated-refresh'); assert.equal(await reopened.accessToken(), 'rotated-access');
});

test('刷新凭据被撤销后要求重新扫码，不回退到其他身份', async t => {
  let calls = 0; const ctx = setup(t, async () => ++calls === 1 ? Response.json(token({ expires_in: 1 })) : Response.json({ code: 20064, error: 'invalid_grant', error_description: 'secret-refresh-value' }, { status: 400 }));
  await login(ctx.auth); ctx.advance(2000);
  await assert.rejects(ctx.auth.accessToken(), /授权未完成或已失效/);
  assert.equal(ctx.auth.ready(), false); assert.equal(ctx.auth.status().needsReauth, true);
  assert.ok(!JSON.stringify(ctx.auth.status()).includes('secret-refresh-value'));
  await assert.rejects(ctx.auth.accessToken()); assert.equal(calls, 2);
});

test('上游临时失败保留会话，缺刷新凭据时到期必须重新登录', async t => {
  let calls = 0; const ctx = setup(t, async () => ++calls === 1 ? Response.json(token({ expires_in: 1 })) : new Response('{}', { status: 503 }));
  await login(ctx.auth); ctx.advance(2000); await assert.rejects(ctx.auth.accessToken(), /暂时不可用/);
  assert.equal(ctx.auth.session.invalid, false);
  const other = setup(t, async () => Response.json(token({ expires_in: 1, refresh_token: undefined, refresh_token_expires_in: undefined })));
  await login(other.auth); assert.equal(other.auth.status().autoRefresh, false);
  other.advance(2000); assert.equal(other.auth.ready(), false); await assert.rejects(other.auth.accessToken(), /过期/);
});

test('退出与授权交换竞态不能恢复已退出的账户，旧回调不能复用', async t => {
  let release;
  const { auth } = setup(t, async () => new Promise(resolve => { release = () => resolve(Response.json(token())); }));
  const start = auth.start(base), params = new URLSearchParams({ state: new URL(start.authorizationUrl).searchParams.get('state'), code: 'a' });
  const pending = auth.complete(params, start.cookie, base);
  auth.logout(); release(); await pending;
  assert.equal(auth.session, null); assert.equal(existsSync(auth.vault.file), false);
  await assert.rejects(auth.complete(params, start.cookie, base));
});

test('退出与刷新竞态不复活会话、不返回旧身份凭据', async t => {
  let release, calls = 0;
  const ctx = setup(t, async () => ++calls === 1 ? Response.json(token({ expires_in: 1 })) : new Promise(resolve => { release = () => resolve(Response.json(token())); }));
  await login(ctx.auth); ctx.advance(2000); const pending = ctx.auth.accessToken();
  ctx.auth.logout(); release(); await assert.rejects(pending, /状态已变更/);
  assert.equal(ctx.auth.session, null); assert.equal(existsSync(ctx.auth.vault.file), false);
});

test('错误或缺失配置不会生成伪二维码；更换 App ID 不复用旧账户', async t => {
  const { auth, directory } = setup(t); await login(auth);
  const different = new FeishuAuth({ config: { ...config, appId: 'cli_other' }, directory });
  assert.equal(different.session, null);
  for (const bad of [oauthConfiguration({}), { ...config, redirectUri: 'https://evil.test/callback?key=secret' }]) {
    const invalid = new FeishuAuth({ config: bad, directory });
    assert.throws(() => invalid.start(base)); assert.equal(invalid.configured(), false);
    assert.ok(!JSON.stringify(invalid.status()).includes('evil.test'));
  }
});

test('不完整 Token 响应不会持久化或显示为已登录', async t => {
  for (const response of [{ code: 0 }, token({ expires_in: -1 }), token({ scope: undefined })]) {
    const { auth } = setup(t, async () => Response.json(response)); await login(auth);
    assert.equal(auth.ready(), false); assert.equal(existsSync(auth.vault.file), false); assert.match(auth.status().error, /不完整/);
  }
});

test('HTTP OAuth 回调仅豁免正确路径，Cookie 绑定、URL 清理、配置保密、退出均可用', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-oauth-http-'));
  const c = configuration({ FEISHU_APP_ID: config.appId, FEISHU_APP_SECRET: config.appSecret, FEISHU_USER_ACCESS_TOKEN: 'old-static-secret' });
  let openId = 'ou_owner';
  const app = createApp({ directory, config: c, authFetch: async (url, options) => {
    if (!url.endsWith('/user_info')) return Response.json(token());
    assert.equal(options.headers.Authorization, 'Bearer ' + token().access_token);
    return Response.json({ code: 0, data: { open_id: openId, tenant_key: 'tenant', name: '验收用户' } });
  } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  app.auth.config.redirectUri = `${origin}${CALLBACK_PATH}`;
  t.after(async () => { await app.idle(); await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (path, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await post('/api/auth/feishu/start', { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await fetch(origin + '/api/config', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const start = await post('/api/auth/feishu/start'); assert.equal(start.status, 200);
  const cookieHeader = start.headers.get('set-cookie'); assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Lax/);
  const cookie = cookieHeader.split(';')[0], info = await start.json(); assert.ok(!info.cookie);
  const state = new URL(info.authorizationUrl).searchParams.get('state');
  const callback = `${origin}${CALLBACK_PATH}?code=one-code&state=${state}`;
  assert.equal((await fetch(callback, { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 400);
  assert.equal((await post('/api/tasks')).status, 401);
  const result = await fetch(callback, { redirect: 'manual', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(result.status, 303); assert.equal(result.headers.get('location'), '/#welcome'); assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  const ticket = result.headers.getSetCookie().find(s => s.startsWith(LOGIN_COOKIE + '='));
  assert.match(ticket, /HttpOnly/); assert.match(ticket, /Path=\/api;/); assert.match(ticket, /SameSite=Lax/);
  const headers = { Cookie: ticket.split(';')[0] };
  const session = await (await fetch(origin + '/api/auth/session', { headers })).json();
  assert.equal(session.authenticated, true); assert.deepEqual(session.user, { name: '验收用户' });
  for (const path of ['/api/tasks', '/api/config', '/api/runs', '/api/tasks/' + 'a'.repeat(36) + '/export']) {
    assert.equal((await fetch(origin + path)).status, 401);
  }
  assert.equal((await fetch(origin + '/api/tasks', { headers })).status, 200);
  assert.equal((await post('/api/auth/feishu/logout')).status, 401);
  const publicResponse = await (await fetch(origin + '/api/config', { headers })).text();
  for (const secret of [config.appSecret, token().access_token, token().refresh_token, 'old-static-secret']) assert.ok(!publicResponse.includes(secret));
  assert.equal(JSON.parse(publicResponse).feishu.configured, true);
  assert.equal((await fetch(callback, { redirect: 'manual', headers: { Cookie: cookie } })).status, 400);
  assert.equal((await fetch(origin + '/data/auth/feishu-session.enc')).status, 404);
  openId = 'ou_other';
  const other = await post('/api/auth/feishu/start'), otherInfo = await other.json();
  const denied = await fetch(origin + CALLBACK_PATH + '?code=new&state=' + new URL(otherInfo.authorizationUrl).searchParams.get('state'), {
    redirect: 'manual', headers: { Cookie: other.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(denied.headers.get('location'), '/#login');
  assert.ok(!denied.headers.get('set-cookie').includes(LOGIN_COOKIE));
  assert.equal((await fetch(origin + '/api/tasks', { headers })).status, 200);
  assert.equal((await post('/api/auth/feishu/logout', headers)).status, 200);
  assert.equal((await fetch(origin + '/api/config', { headers })).status, 401);
  assert.equal((await (await fetch(origin + '/api/auth/session', { headers })).json()).authenticated, false);
  assert.equal(existsSync(app.auth.vault.file), false);
});

test('本地工作台绑定、历史数据迁移、租户限制和浏览器会话到期', async t => {
  const ctx = setup(t);
  const settings = { ...config, allowedTenants: ['tenant'] };
  let tenant = 'other', id = 'ou_owner';
  const options = { directory: ctx.directory, config: settings, now: ctx.now, hasRecords: () => true,
    fetchImpl: async () => Response.json({ code: 0, data: { open_id: id, tenant_key: tenant, name: '用户' } }) };
  const service = new WorkspaceLogin(options);
  await assert.rejects(service.identify('fake'), /企业/);
  tenant = 'tenant'; const profile = await service.identify('fake');
  assert.throws(() => service.issue(profile), /FEISHU_WORKSPACE_OWNER_OPEN_ID/);
  settings.ownerOpenId = 'ou_owner';
  const { browser, ticket } = service.issue(await service.identify('fake'));
  const restored = new WorkspaceLogin(options);
  assert.deepEqual(restored.user({ browser }, ticket), { name: '用户' });
  assert.equal(restored.user({ browser }, 'fake'), null);
  assert.equal(restored.user({}, ticket), null);
  id = 'ou_other'; await assert.rejects(service.identify('fake'), /绑定/);
  id = ''; await assert.rejects(service.identify('fake'), /核验/);
  ctx.advance(LOGIN_SECONDS * 1000);
  assert.equal(restored.user({ browser }, ticket), null);
});
