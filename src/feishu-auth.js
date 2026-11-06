import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './review.js';

export const CALLBACK_PATH = '/api/auth/feishu/callback';
export const AUTH_COOKIE = 'clarity_feishu_login';
export const FEISHU_QA_SCOPES = ['mindnote:node:read', 'mindnote:node:create', 'bitable:app:readonly'];
export const FEISHU_VISUAL_SCOPES = ['docs:document.media:download', 'board:whiteboard:node:read'];
export const FEISHU_SCOPES = [
  'offline_access', 'docx:document:create', 'docx:document:readonly', 'docx:document:write_only',
  'wiki:node:read', 'wiki:node:create', 'docs:document.media:upload', 'board:whiteboard:node:create',
  'task:task:read', 'im:chat:read',
];
// The v1 authorization page currently documents PKCE compatibility with v2 only.
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const digest = value => createHash('sha256').update(value).digest();
const opaque = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));
const positive = value => Number.isFinite(value) && value > 0;
const fail = (message, code = 'FEISHU_AUTH_REQUIRED', status = 409) => new AppError(message, status, code);

export function oauthConfiguration(env = process.env) {
  return {
    ownerOpenId: env.FEISHU_WORKSPACE_OWNER_OPEN_ID?.trim() || '', allowedTenants: (env.FEISHU_ALLOWED_TENANT_KEYS || '').split(/[\s,]+/).filter(Boolean),
    appId: env.FEISHU_APP_ID || '', appSecret: env.FEISHU_APP_SECRET || '',
    redirectUri: env.FEISHU_REDIRECT_URI || `http://127.0.0.1:${Number(env.PORT) || 3210}${CALLBACK_PATH}`,
    scopes: [...new Set((env.FEISHU_OAUTH_SCOPES || [...FEISHU_SCOPES, ...FEISHU_VISUAL_SCOPES, ...FEISHU_QA_SCOPES].join(' ')).split(/[\s,]+/).filter(Boolean))],
  };
}

// Separate from reports/exports. The key is local too: this protects accidental file disclosure,
// not a compromised OS account. File access remains restricted to this local user.
export class TokenVault {
  constructor(directory) { this.directory = join(directory, 'auth'); this.file = join(this.directory, 'feishu-session.enc'); this.keyFile = join(this.directory, 'session.key'); }
  key(create = false) {
    if (create) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
      try { writeFileSync(this.keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    const key = readFileSync(this.keyFile);
    if (key.length !== 32) throw new Error('Invalid local vault key');
    chmodSync(this.keyFile, 0o600); return key;
  }
  load() {
    if (!existsSync(this.file)) return null;
    const envelope = JSON.parse(readFileSync(this.file, 'utf8'));
    if (envelope.version !== 1) throw new Error('Invalid vault version');
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
  }
  save(session) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(true), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    const temp = `${this.file}.${opaque()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.file);
    } finally { try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  clear() { try { unlinkSync(this.file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

export class FeishuAuth {
  constructor({ config, directory, fetchImpl = fetch, now = Date.now }) {
    this.config = config; this.fetch = fetchImpl; this.now = now;
    this.vault = new TokenVault(directory); this.session = null; this.pending = null;
    this.refreshing = null; this.completing = false; this.generation = 0; this.lastError = null;
    try {
      const saved = this.vault.load();
      if (saved && saved.appId === config.appId && typeof saved.accessToken === 'string' && positive(saved.expiresAt) && Array.isArray(saved.scopes)) this.session = saved;
    } catch { this.lastError = '本地登录状态无法读取，请重新扫码授权。'; }
  }
  configured() { return Boolean(this.config.appId && this.config.appSecret && !this.configError()); }
  enabled() { return Boolean(this.config.appId || this.config.appSecret || this.session || this.lastError); }
  redirectUrl() {
    let url;
    try { url = new URL(this.config.redirectUri); } catch { return null; }
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === CALLBACK_PATH ? url : null;
  }
  configError() {
    if (!this.config.appId || !this.config.appSecret) return '请先在 .env 配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET，重启后即可扫码。';
    if (!this.redirectUrl()) return '本地版回调地址必须为 http://127.0.0.1:端口/api/auth/feishu/callback（也支持 localhost）。';
    if (!this.config.scopes.length || this.config.scopes.length > 200 || this.config.scopes.some(s => !/^[A-Za-z0-9_:.-]+$/.test(s))) return '飞书 OAuth 权限范围配置无效。';
    return null;
  }
  isAuthorizing() {
    if (this.pending && this.pending.expiresAt <= this.now()) this.pending = null;
    return Boolean(this.pending || this.completing);
  }
  canRefresh() { return Boolean(this.session?.refreshToken && this.session.refreshExpiresAt > this.now()); }
  missingScopes() { return this.session ? this.config.scopes.filter(s => !FEISHU_VISUAL_SCOPES.includes(s) && !FEISHU_QA_SCOPES.includes(s) && !this.session.scopes.includes(s)) : []; }
  ready() { return Boolean(this.configured() && this.session && !this.session.invalid && !this.missingScopes().some(s => s !== 'offline_access') && (this.session.expiresAt > this.now() || this.canRefresh())); }
  status() {
    const pending = this.isAuthorizing();
    return {
      configured: this.configured(), enabled: this.enabled(), authorized: Boolean(this.session), ready: this.ready(), pending,
      expiresAt: this.session ? new Date(this.session.expiresAt).toISOString() : null,
      autoRefresh: Boolean(this.configured() && this.canRefresh() && !this.session?.invalid),
      needsReauth: Boolean(this.session && (!this.ready() || this.missingScopes().length)),
      requestedScopes: this.config.scopes, missingScopes: this.missingScopes(),
      missingQaScopes: FEISHU_QA_SCOPES.filter(s => !this.session?.scopes.includes(s)),
      missingVisualScopes: FEISHU_VISUAL_SCOPES.filter(s => !this.session?.scopes.includes(s)),
      redirectUri: this.redirectUrl()?.href || null,
      error: this.lastError, setupError: this.configError(),
    };
  }
  start(origin) {
    const error = this.configError(); if (error) throw fail(error, 'FEISHU_OAUTH_NOT_CONFIGURED');
    if (origin !== new URL(this.config.redirectUri).origin) throw fail('请从与回调地址相同的本地地址打开工作台后扫码，localhost 与 127.0.0.1 不能混用。');
    if (this.completing) throw fail('正在完成飞书授权，请稍候。');
    const state = opaque(), cookie = opaque(), verifier = opaque();
    this.generation++; this.lastError = null;
    this.pending = { state, cookieHash: digest(cookie), verifier, expiresAt: this.now() + 5 * 60_000, generation: this.generation };
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({ client_id: this.config.appId, response_type: 'code', redirect_uri: this.config.redirectUri, scope: this.config.scopes.join(' '), state, code_challenge: digest(verifier).toString('base64url'), code_challenge_method: 'S256', prompt: 'consent' }).toString();
    return { authorizationUrl: url.href, cookie, expiresIn: 300 };
  }
  async tokenRequest(body) {
    let response, data;
    try {
      response = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ client_id: this.config.appId, client_secret: this.config.appSecret, ...body }), redirect: 'error', signal: AbortSignal.timeout(20000) });
      data = await response.json();
    } catch { throw fail('飞书授权服务连接失败或响应异常，请稍后重试；若登录未完成，请重新扫码。', 'FEISHU_OAUTH_CONNECTION', 502); }
    if (!response.ok || data.error || (data.code !== undefined && data.code !== 0)) {
      const errorCode = Number.isInteger(data.code) ? data.code : null;
      const message = errorCode === 20002 ? '飞书应用凭据不正确，请检查 App ID 和 App Secret。'
        : errorCode === 20010 ? '当前飞书用户无权使用该应用，请检查应用可用范围。'
        : errorCode === 20074 ? '请在飞书应用安全设置中开启刷新用户 Token，并发布生效。'
        : response.status >= 500 ? '飞书授权服务暂时不可用，请稍后重试。'
        : '飞书授权未完成或已失效，请检查应用权限、回调地址后重新扫码。';
      const error = fail(`${message}（${errorCode !== null ? `飞书错误码 ${errorCode}` : `HTTP ${response.status}`}）`, 'FEISHU_OAUTH_REJECTED', 502);
      error.invalidGrant = data.error === 'invalid_grant' || [20008, 20010, 20024, 20026, 20037, 20064, 20066, 20073].includes(errorCode);
      throw error;
    }
    if (typeof data.access_token !== 'string' || !data.access_token || !positive(data.expires_in) || typeof data.scope !== 'string' || (data.token_type && data.token_type.toLowerCase() !== 'bearer')) throw fail('飞书返回的登录凭据不完整，请重新授权。', 'FEISHU_OAUTH_RESPONSE', 502);
    return {
      appId: this.config.appId, accessToken: data.access_token, expiresAt: this.now() + data.expires_in * 1000,
      refreshToken: typeof data.refresh_token === 'string' && positive(data.refresh_token_expires_in) ? data.refresh_token : null,
      refreshExpiresAt: positive(data.refresh_token_expires_in) ? this.now() + data.refresh_token_expires_in * 1000 : null,
      scopes: [...new Set(data.scope.split(/\s+/).filter(Boolean))], invalid: false,
    };
  }
  async complete(params, cookie, origin, login) {
    this.isAuthorizing(); const pending = this.pending;
    if (origin !== new URL(this.config.redirectUri).origin || !pending || !equal(params.get('state'), pending.state) || typeof cookie !== 'string' || !timingSafeEqual(digest(cookie), pending.cookieHash)) throw fail('登录请求已过期或浏览器不匹配，请回到工作台重新扫码。', 'FEISHU_OAUTH_STATE', 400);
    this.pending = null; // Consume before any network request; an authorization code is single use.
    if (params.has('error')) { this.lastError = '你取消了飞书授权，可以随时重新扫码。'; return; }
    const code = params.get('code');
    if (!code || !/^[A-Za-z0-9_-]{1,2048}$/.test(code)) { this.lastError = '飞书未返回有效授权码，请重新扫码。'; return; }
    this.completing = true;
    try {
      const session = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: pending.verifier });
      const profile = login ? await login.identify(session.accessToken) : null;
      if (pending.generation !== this.generation) return;
      const issued = profile ? login.issue(profile) : null;
      if (issued) session.browser = issued.browser;
      this.vault.save(session); this.session = session; this.lastError = null;
      return issued?.ticket;
    } catch (e) {
      if (pending.generation === this.generation) this.lastError = e instanceof AppError ? e.message : '无法保存飞书登录状态，请检查本地数据目录权限后重新扫码。';
    } finally { this.completing = false; }
  }
  async accessToken() {
    if (!this.configured() || !this.session || this.session.invalid) throw fail('请先在连接设置中完成飞书扫码授权。');
    if (this.missingScopes().some(s => s !== 'offline_access')) throw fail('飞书授权缺少必要权限，请到连接设置补充授权。', 'FEISHU_SCOPE_MISSING');
    if (this.session.expiresAt > this.now() + 60_000) return this.session.accessToken;
    if (!this.canRefresh()) {
      if (this.session.expiresAt > this.now()) return this.session.accessToken;
      throw fail('飞书登录已过期，请重新扫码授权。');
    }
    if (!this.refreshing) {
      const generation = this.generation, previous = this.session;
      this.refreshing = (async () => {
        try {
          const next = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: previous.refreshToken });
          if (generation !== this.generation || this.session !== previous) throw fail('飞书登录状态已变更，请重试。');
          if (previous.browser) next.browser = previous.browser;
          this.vault.save(next); this.session = next; this.lastError = null;
          if (this.missingScopes().some(s => s !== 'offline_access')) throw fail('刷新后缺少必要权限，请重新扫码授权。', 'FEISHU_SCOPE_MISSING');
          return next.accessToken;
        } catch (e) {
          if (generation === this.generation && this.session === previous) {
            if (e.invalidGrant) { this.session = { ...previous, invalid: true }; this.vault.save(this.session); }
            this.lastError = e instanceof AppError ? e.message : '飞书登录状态保存失败，请重新扫码。';
          }
          throw e instanceof AppError ? e : fail('飞书登录状态保存失败，请重新扫码。');
        }
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  logout() { this.generation++; this.pending = null; this.vault.clear(); this.session = null; this.lastError = null; }
  cancel() { this.generation++; this.pending = null; this.lastError = null; }
}
