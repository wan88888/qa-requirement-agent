import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './review.js';

export const LOGIN_COOKIE = 'clarity_workspace';
export const LOGIN_SECONDS = 7 * 86400;
const digest = value => createHash('sha256').update(value).digest('hex');
const validId = s => typeof s === 'string' && s.length > 0 && s.length <= 128;
const identityKey = (app, tenant, id) => digest(JSON.stringify([app, tenant, id]));
const denied = message => new AppError(message, 403, 'WORKSPACE_IDENTITY_DENIED');

export class WorkspaceLogin {
  constructor({ directory, config, fetchImpl, now, hasRecords }) {
    this.folder = join(directory, 'auth');
    this.file = join(this.folder, 'workspace-owner.json');
    Object.assign(this, { config, fetchImpl, now, hasRecords });
    try {
      this.owner = JSON.parse(readFileSync(this.file, 'utf8')).key;
      if (!/^[0-9a-f]{64}$/.test(this.owner)) throw new Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('工作台账号绑定文件无法读取，未开放访问。');
    }
  }
  async identify(token) {
    let profile;
    try {
      const res = await this.fetchImpl('https://open.feishu.cn/open-apis/authen/v1/user_info', { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      const body = await res.json();
      if (res.ok && body.code === 0) profile = body.data;
    } catch { /* Provider response and credentials must not be reflected to the browser. */ }
    if (!validId(profile?.open_id) || !validId(profile?.tenant_key)) throw denied('未能核验飞书用户与企业身份，请重新登录。');
    const tenants = this.config.allowedTenants || [];
    if (tenants.length && !tenants.includes(profile.tenant_key)) throw denied('当前企业不在工作台允许登录的范围内。');
    if (this.config.ownerOpenId && this.config.ownerOpenId !== profile.open_id) throw denied('请使用本工作台绑定的飞书账号登录。');
    return { key: identityKey(this.config.appId, profile.tenant_key, profile.open_id), tenant: profile.tenant_key, name: typeof profile.name === 'string' ? profile.name.slice(0, 150) : '飞书用户' };
  }
  issue(profile) {
    // Single-user database: never hand existing records to the next account to scan.
    if (!this.owner) {
      if (this.hasRecords() && !this.config.ownerOpenId) throw denied('旧工作台已有业务记录。请在本机 .env 设置原账号的 FEISHU_WORKSPACE_OWNER_OPEN_ID 并重启，以确认历史记录归属。');
      mkdirSync(this.folder, { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify({ key: profile.key }), { flag: 'wx', mode: 0o600 });
      this.owner = profile.key;
    }
    if (profile.key !== this.owner) throw denied('该本地工作台已绑定其他飞书账号，请使用原账号登录。');
    const ticket = randomBytes(32).toString('base64url');
    return { ticket, browser: { hash: digest(ticket), profile, expiresAt: this.now() + LOGIN_SECONDS * 1000 } };
  }
  user(session, ticket) {
    const browser = session?.browser;
    if (!browser || !ticket || session.invalid || !(browser.expiresAt > this.now())) return null;
    if (!this.owner || browser.profile?.key !== this.owner || !/^[0-9a-f]{64}$/.test(browser.hash)) return null;
    if (!timingSafeEqual(Buffer.from(digest(ticket), 'hex'), Buffer.from(browser.hash, 'hex'))) return null;
    const { tenant, name } = browser.profile;
    if (this.config.allowedTenants?.length && !this.config.allowedTenants.includes(tenant)) return null;
    if (this.config.ownerOpenId && identityKey(this.config.appId, tenant, this.config.ownerOpenId) !== this.owner) return null;
    return { name: name || '飞书用户' };
  }
}
