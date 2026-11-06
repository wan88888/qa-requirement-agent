import { WorkspaceLogin, LOGIN_COOKIE, LOGIN_SECONDS } from './workspace-login.js';
import { withMetering, usageSummary } from './usage.js';
import { qualityOf, qualitySummary, mutateQuality, createRun, normalizeResults, applyResults, executionSummary, attachExecution, parseImport, qualityMarkdown, executionMarkdown, revision } from './quality.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { AppError, DEMO_DOCUMENT, DIMENSIONS, demoReview, parseSource, validateReview, renderMarkdown, MAX_DOCUMENT_CHARS } from './review.js';
import { configuration, isModelReady, publicModelConfig, MODEL_PROVIDERS, isFeishuReady, parseFeishuUrl, modelReview, FeishuClient, verifyPublished } from './integrations.js';
import { FeishuAuth, oauthConfiguration, CALLBACK_PATH, AUTH_COOKIE } from './feishu-auth.js';
import { enrichVisuals } from './visual.js';
import { QaFeishu, parseResourceUrl, generateCases, normalizeCases, generateBugReport, normalizeBugReport, workflowMarkdown, writeCaseMindnote } from './qa-workflows.js';
const renderTask = task => (task.kind && task.kind !== 'review' ? workflowMarkdown(task) : renderMarkdown(task)) + qualityMarkdown(task);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE = ['queued', 'reading', 'reviewing', 'validating', 'publishing'];

function publicTask(task, full = false) {
  if (full) return { ...task, quality: qualityOf(task), qualitySummary: qualitySummary(task), usageSummary: usageSummary(task), executionSummary: task.execution ? executionSummary(task.execution) : null };
  const { source, report, events, ...rest } = task;
  return { ...rest, usageSummary: usageSummary(task), qualitySummary: qualitySummary(task), issueCount: report?.issues?.length ?? 0, caseCount: report?.cases?.length ?? 0, bugCount: report?.stats?.total ?? 0, counts: report?.counts ?? null, conclusion: report?.conclusion ?? null };
}

function validateInput(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('请求格式错误。');
  if (body.kind && !['review', 'cases', 'bugs'].includes(body.kind)) throw new AppError('任务类型无效。');
  if (['cases', 'bugs'].includes(body.kind)) return validateWorkflow(body, config);
  if (!['demo', 'live'].includes(body.mode)) throw new AppError('请选择演示模式或真实评审。');
  if (!['sample', 'text', 'feishu'].includes(body.sourceType)) throw new AppError('请选择需求来源。');
  if (body.includeVisuals !== undefined && typeof body.includeVisuals !== 'boolean') throw new AppError('图片评审选项必须为布尔值。');
  if (body.mode === 'demo' && body.sourceType === 'feishu') throw new AppError('演示模式不读取飞书文档，请使用样例或粘贴文本。');
  if (body.mode === 'live' && !isModelReady(config)) throw new AppError('真实模型尚未配置，请先配置 .env。', 409, 'MODEL_NOT_CONFIGURED');
  if (body.sourceType === 'feishu' && !isFeishuReady(config)) throw new AppError('飞书尚未配置，请先配置 .env。', 409, 'FEISHU_NOT_CONFIGURED');
  if (body.autoPublish && (body.mode !== 'live' || !isFeishuReady(config))) throw new AppError('自动生成飞书报告需要真实评审模式和有效的飞书连接。');
  if (body.title != null && (typeof body.title !== 'string' || body.title.length > 150)) throw new AppError('标题不能超过 150 个字符。');
  const result = { mode: body.mode, sourceType: body.sourceType, title: body.title?.trim() || '未命名需求', autoPublish: body.autoPublish === true, includeVisuals: body.includeVisuals !== false };
  if (body.sourceType === 'sample') result.title = DEMO_DOCUMENT.title;
  if (body.sourceType === 'text') { parseSource(body.content, result.title); result.content = body.content; }
  if (body.sourceType === 'feishu') result.url = parseFeishuUrl(body.url, config.feishu.allowedHosts).url;
  return result;
}

function caseDestination(body, config) {
  for (const key of ['parentUrl', 'targetMindnoteUrl']) if (body[key] != null && typeof body[key] !== 'string') throw new AppError('思维笔记存放位置必须是飞书链接。');
  const parentUrl = body.parentUrl?.trim(), targetMindnoteUrl = body.targetMindnoteUrl?.trim();
  if (Boolean(parentUrl) === Boolean(targetMindnoteUrl)) throw new AppError('请选择一个存放方式：提供已有思维笔记链接，或提供新建思维笔记的知识库父节点链接。');
  return targetMindnoteUrl
    ? { targetMindnoteUrl: parseResourceUrl(targetMindnoteUrl, ['mindnotes', 'mindnote', 'wiki'], config.feishu.allowedHosts).url }
    : { parentUrl: parseResourceUrl(parentUrl, ['wiki'], config.feishu.allowedHosts).url };
}

function validateWorkflow(body, config) {
  if (body.mode !== 'live' || !isModelReady(config) || !isFeishuReady(config)) throw new AppError('新功能需要已配置模型和飞书用户授权。', 409);
  if (body.includeVisuals !== undefined && typeof body.includeVisuals !== 'boolean') throw new AppError('图片选项必须为布尔值。');
  const input = { kind: body.kind, mode: 'live', sourceType: body.kind === 'bugs' ? 'base' : 'feishu', autoPublish: body.autoPublish === true, includeVisuals: body.includeVisuals !== false };
  if (body.kind === 'cases') {
    input.url = parseFeishuUrl(body.url, config.feishu.allowedHosts).url;
    Object.assign(input, caseDestination(body, config));
    input.title = '测试用例';
  } else {
    input.url = parseResourceUrl(body.url, ['base', 'wiki'], config.feishu.allowedHosts).url;
    if (typeof body.tableId !== 'string' || !/^tbl[A-Za-z0-9]+$/.test(body.tableId)) throw new AppError('请先读取并选择数据表。');
    if (typeof body.version !== 'string' || !body.version.trim() || body.version.length > 150) throw new AppError('请填写版本精确值（最多150字符）。');
    input.version = body.version.trim(); input.tableId = body.tableId; input.mapping = {};
    for (const key of ['version', 'title', 'status', 'severity', 'module', 'description']) {
      const value = body.mapping?.[key];
      if (value != null && (typeof value !== 'string' || value.length > 1000)) throw new AppError('字段映射无效。');
      if (['version', 'title', 'status', 'severity'].includes(key) && !value) throw new AppError('请完整映射版本、标题、状态和严重程度字段。');
      input.mapping[key] = value || '';
    }
    if (!Array.isArray(body.closedStatuses) || !body.closedStatuses.length || body.closedStatuses.length > 30 || body.closedStatuses.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) throw new AppError('请填写至少一个代表已关闭的状态精确值。');
    input.closedStatuses = [...new Set(body.closedStatuses.map(s => s.trim()))]; input.title = `版本测试报告 · ${input.version}`;
  }
  return input;
}

async function readJson(req) {
  if (!req.headers['content-type']?.includes('application/json')) throw new AppError('请求必须使用 application/json。', 415);
  const buffers = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 256000) throw new AppError('请求过大，请拆分文档。', 413);
    buffers.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new AppError('请求 JSON 格式错误。'); }
}

export function createApp({ requireLogin = true, directory = resolve(process.env.DATA_DIR || join(root, 'data')), config = configuration(), reviewer = modelReview, clientFactory, visualAnalyzer, caseGenerator = generateCases, bugGenerator = generateBugReport, qaFactory = client => new QaFeishu(client), authFetch = fetch, authNow = Date.now } = {}) {
  const store = new Store(directory); store.recover();
  const auth = new FeishuAuth({ config: config.feishu.oauth || oauthConfiguration({}), directory, fetchImpl: authFetch, now: authNow });
  const login = new WorkspaceLogin({ directory, config: auth.config, fetchImpl: authFetch, now: authNow, hasRecords: () => store.hasRecords() });
  const manual = Boolean(config.feishu.token || config.feishu.bearer);
  config = { ...config, feishu: { ...config.feishu, authReady: () => auth.enabled() ? auth.ready() : manual } };
  clientFactory ||= () => new FeishuClient({ ...config.feishu, ...(auth.enabled() ? { token: '', bearer: '', getToken: () => auth.accessToken() } : {}) });
  const assertIdle = () => { if (store.list().some(t => ACTIVE.includes(t.status))) throw new AppError('请等待当前评审或发布完成，再更改飞书登录状态。', 409); };
  const assertNotAuthorizing = () => { if (auth.isAuthorizing()) throw new AppError('正在进行飞书授权，请完成授权，或在连接设置中取消后再开始评审。', 409); };
  const pending = new Set(), publishing = new Set();
  const launch = fn => { const promise = fn(); pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); };

  async function publish(id) {
    if (publishing.has(id)) throw new AppError('报告正在写入或校验，请勿重复提交。', 409);
    const task = store.get(id);
    if (!task.report || task.mode !== 'live') throw new AppError('只有真实评审生成的报告可以写入飞书。', 409);
    if (!isFeishuReady(config)) throw new AppError('请先配置飞书连接。', 409);
    if (task.publish.status === 'published') return task;
    if (['uncertain', 'creating'].includes(task.publish.status)) throw new AppError('上次创建结果未知，请先在飞书确认，系统不会重复创建。', 409, 'PUBLISH_UNCERTAIN');
    publishing.add(id);
    const client = clientFactory();
    try {
      store.stage(id, 'publishing', task.publish.url ? '回读校验已有报告' : '创建独立飞书报告');
      if (task.kind === 'cases') {
        const api = qaFactory(client);
        if (!task.publish.url) {
          if (task.options.targetMindnoteUrl) {
            const existing = await api.resolveMindnote(task.options.targetMindnoteUrl);
            await api.nodes(existing.token);
            store.change(id, t => { t.publish = { status: 'verifying', ...existing }; });
          } else {
            const parent = parseResourceUrl(task.options.parentUrl, ['wiki'], config.feishu.allowedHosts);
            await api.wiki(parent.token);
            store.change(id, t => { t.publish.status = 'creating'; });
            const created = await api.createMindnote(task.options.parentUrl, `测试用例：${task.source.title}`);
            store.change(id, t => { t.publish = { status: 'verifying', ...created }; });
          }
        }
        await writeCaseMindnote(api, store.get(id), state => store.change(id, t => { t.publish = { ...state, status: 'verifying' }; }));
        store.change(id, t => { t.publish.status = 'published'; t.publish.error = null; t.publish.publishedAt = new Date().toISOString(); });
        return store.get(id);
      }
      const markdown = task.publish.markdown || renderTask(task);
      if (markdown.length > MAX_DOCUMENT_CHARS) throw new AppError('报告超过当前飞书回读校验上限，请先导出本地报告并拆分数据后重试。未创建云端文档。', 413);
      if (!task.publish.url) {
        // Connectivity/schema preflight happens before the potentially ambiguous create operation.
        await client.connect();
        client.schema('create-doc'); client.schema('fetch-doc');
        store.change(id, current => { current.publish = { status: 'creating', url: null, markdown }; });
        const url = await client.createReport(`${task.kind === 'bugs' ? '版本测试报告' : task.source.visualCoverage?.enabled && task.source.visualCoverage.total ? '图文需求评审' : '需求评审'}：${task.source.title}`, markdown);
        store.change(id, current => { current.publish = { status: 'verifying', url, markdown }; });
      } else store.change(id, current => { current.publish.status = 'verifying'; });
      const current = store.get(id);
      const source = await client.fetchDocument(current.publish.url);
      verifyPublished(source, current, markdown);
      store.change(id, current => { current.publish.status = 'published'; current.publish.error = null; current.publish.publishedAt = new Date().toISOString(); });
    } catch (error) {
      store.change(id, current => {
        const rejected = error instanceof AppError && error.code === 'FEISHU_PERMISSION_DENIED' && error.confirmedNotCreated === true;
        current.publish.status = current.publish.url ? 'verify_failed' : current.publish.status === 'creating' && !rejected ? 'uncertain' : 'failed';
        current.publish.error = error instanceof AppError ? error.message : '飞书写入失败，请检查连接后重试。';
      });
    } finally {
      await client.close(); publishing.delete(id);
      store.stage(id, 'completed', store.get(id).publish.status === 'published' ? '评审完成，飞书报告已核验' : '评审已完成，飞书报告待处理');
    }
    return store.get(id);
  }

  async function run(id, input) {
    store.change(id, task => { task.usage = { calls: [] }; });
    return withMetering(entry => store.change(id, task => { const index = task.usage.calls.findIndex(c => c.id === entry.id); if (index < 0) task.usage.calls.push(entry); else task.usage.calls[index] = entry; }), async () => {
    try {
      store.stage(id, 'reading', input.sourceType === 'feishu' ? '读取飞书需求文档' : '解析需求正文');
      let source;
      if (input.kind === 'bugs') {
        const client = clientFactory();
        try { source = await qaFactory(client).bugs(input); } finally { await client.close(); }
      } else if (input.sourceType === 'feishu') {
        const client = clientFactory();
        try {
          source = await client.fetchDocument(input.url);
          store.change(id, task => { task.source = source; task.title = source.title; });
          source = await enrichVisuals(source, { client, config, directory, taskId: id, enabled: input.includeVisuals, analyzer: visualAnalyzer, onProgress: message => store.stage(id, 'reading', message) });
        } finally { await client.close(); }
      } else source = parseSource(input.sourceType === 'sample' ? DEMO_DOCUMENT.content : input.content, input.title);
      store.change(id, task => { task.source = source; task.title = source.title; });
      store.stage(id, 'reviewing', input.kind === 'cases' ? '生成模块化测试用例' : input.kind === 'bugs' ? '计算版本统计并分析缺陷风险' : input.mode === 'demo' ? '运行本地演示规则' : '执行八个维度的 AI 评审');
      const raw = input.kind === 'cases' ? await caseGenerator(source, config) : input.kind === 'bugs' ? await bugGenerator(source, config, input.closedStatuses) : input.mode === 'demo' ? demoReview(source) : await reviewer(source, config);
      store.stage(id, 'validating', input.kind === 'bugs' ? '核验缺陷引用与程序统计' : '核验来源依据与输出结构');
      const report = input.kind === 'cases' ? normalizeCases(raw, source) : input.kind === 'bugs' ? normalizeBugReport(raw, source, input.closedStatuses) : validateReview(raw, source);
      store.change(id, task => { task.report = report; });
      if (input.autoPublish) await publish(id);
      else store.stage(id, 'completed', input.kind === 'cases' ? '用例生成完成，可预览或发布原生思维笔记' : input.kind === 'bugs' ? '版本报告生成完成，可导出或发布' : input.mode === 'demo' ? '演示评审完成' : '评审完成，报告可导出');
    } catch (error) {
      store.change(id, task => { task.error = error instanceof AppError ? error.message : '评审发生异常，请重试。'; task.errorCode = error.code || 'REVIEW_FAILED'; });
      store.stage(id, 'failed', '评审未完成');
    }
    });
  }

  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new AppError('仅允许本机访问。', 403);
      const url = new URL(req.url, `http://${host}`), path = url.pathname;
      // The OAuth GET callback is protected by state + HttpOnly cookie + PKCE.
      const oauthCallback = path === CALLBACK_PATH && req.method === 'GET';
      // A top-level homepage navigation after OAuth retains cross-site fetch metadata.
      // Allow only the static shell, never APIs, frames or cross-origin fetch requests.
      const homepageNavigation = path === '/' && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (!oauthCallback && !homepageNavigation && ((req.headers.origin && req.headers.origin !== url.origin) || req.headers['sec-fetch-site'] === 'cross-site')) throw new AppError('不允许跨站访问本地评审服务。', 403);
      const clearCookie = `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth/feishu; Max-Age=0`;
      const readCookie = name => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
      const user = login.user(auth.session, readCookie(LOGIN_COOKIE));
      const sessionCookie = (ticket, ttl) => `${LOGIN_COOKIE}=${ticket}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${ttl}`;
      if (path === '/api/auth/session' && req.method === 'GET') return json(200, { authenticated: !!user, user, configured: auth.configured(), error: auth.lastError || auth.configError(), redirectOrigin: auth.redirectUrl()?.origin });
      if (oauthCallback) {
        const cookie = readCookie(AUTH_COOKIE);
        let ticket;
        try { ticket = await auth.complete(url.searchParams, cookie, url.origin, login); }
        catch { res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>飞书授权未完成</title><p>登录请求已过期或浏览器不匹配，请使用发起登录的电脑浏览器重新授权。</p><a href="/#login">返回工作台登录</a></html>'); }
        res.writeHead(303, { Location: ticket ? '/#welcome' : '/#login', 'Set-Cookie': ticket ? [clearCookie, sessionCookie(ticket, LOGIN_SECONDS)] : clearCookie }); return res.end();
      }
      if (path === '/api/auth/feishu/start' && req.method === 'POST') {
        await readJson(req); assertIdle();
        const login = auth.start(url.origin);
        res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${login.cookie}; HttpOnly; SameSite=Lax; Path=/api/auth/feishu; Max-Age=${login.expiresIn}`);
        return json(200, { authorizationUrl: login.authorizationUrl, expiresIn: login.expiresIn });
      }
      if (requireLogin && path.startsWith('/api/') && !user) throw new AppError('请使用飞书账号登录工作台。', 401, 'WORKSPACE_LOGIN_REQUIRED');
      if (['/api/auth/feishu/logout', '/api/auth/feishu/cancel'].includes(path) && req.method === 'POST') {
        await readJson(req); assertIdle();
        if (path.endsWith('/logout')) auth.logout(); else auth.cancel();
        res.setHeader('Set-Cookie', path.endsWith('/logout') ? [clearCookie, sessionCookie('', 0)] : clearCookie); return json(200, { ok: true });
      }
      if (path === '/api/config' && req.method === 'GET') return json(200, { version: '0.1.0', model: publicModelConfig(config), providers: MODEL_PROVIDERS, feishu: { configured: isFeishuReady(config), mode: auth.enabled() ? 'oauth' : manual ? 'manual' : 'none', oauth: auth.status() }, dimensions: DIMENSIONS, maxDocumentChars: MAX_DOCUMENT_CHARS });
      if (path === '/api/sample' && req.method === 'GET') return json(200, DEMO_DOCUMENT);
      const imageMatch = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/visuals\/(V\d{3,})\.png$/);
      if (imageMatch && req.method === 'GET') {
        const [, id, assetId] = imageMatch;
        const visualTask = store.get(id);
        const asset = visualTask.source?.visuals?.find(a => a.id === assetId && a.preview);
        if (!asset) throw new AppError('资源预览不存在。', 404);
        const image = await readFile(join(directory, 'visuals', visualTask.visualOriginId || id, `${assetId}.png`));
        res.setHeader('Content-Type', 'image/png'); return res.end(image);
      }
      if (path === '/api/tasks' && req.method === 'GET') return json(200, store.list().map(t => publicTask(t)));
      if (path === '/api/tasks' && req.method === 'POST') {
        assertNotAuthorizing();
        const input = validateInput(await readJson(req), config);
        const key = req.headers['idempotency-key'] || randomUUID();
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new AppError('请求标识格式错误。');
        if (store.list().filter(t => ACTIVE.includes(t.status)).length >= 2) throw new AppError('已有两个任务正在执行，请稍后再试。', 429);
        const { task, existing } = store.create(input, key);
        if (!existing) launch(() => run(task.id, input));
        return json(existing ? 200 : 202, publicTask(store.get(task.id), true));
      }
      const match = path.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(export|publish|issues|quality|execution|republish))?$/);
      if (match) {
        const [, id, action] = match;
        const task = store.get(id);
        if (!action && req.method === 'GET') return json(200, publicTask(task, true));
        if (action === 'republish' && req.method === 'POST') {
          assertNotAuthorizing();
          const input = await readJson(req), current = store.get(id);
          revision(qualityOf(current).revision, input.revision);
          if (current.status !== 'completed' || current.mode !== 'live' || current.publish.status !== 'published' || !current.publish.outOfDate || !isFeishuReady(config)) throw new AppError('只有已发布且本地已修订的真实报告可创建独立修订版。', 409);
          if (current.revisionCopy?.revision === qualityOf(current).revision) return json(200, publicTask(store.get(current.revisionCopy.id), true));
          const { task: copy } = store.create({ mode: current.mode, sourceType: current.sourceType, title: current.title, kind: current.kind }, `revision-${id}-${qualityOf(current).revision}`);
          Object.assign(copy, { options: current.options, source: current.source, report: current.report, generatedReport: current.generatedReport, quality: current.quality, execution: current.execution, usage: { calls: [] }, derivedFrom: id, visualOriginId: current.visualOriginId || id, status: 'completed', stage: '修订快照已创建，准备发布' });
          store.save(copy); store.change(id, t => { t.revisionCopy = { id: copy.id, revision: qualityOf(current).revision }; });
          launch(async () => { try { await publish(copy.id); } catch { /* publish persists errors */ } });
          return json(202, publicTask(store.get(copy.id), true));
        }
        if (action === 'quality' && req.method === 'PATCH') {
          const input = await readJson(req);
          const current = store.get(id);
          const other = input.action === 'import-baseline' ? store.get(input.sourceTaskId) : null;
          return json(200, publicTask(store.save(mutateQuality(current, input, other)), true));
        }
        if (action === 'execution' && req.method === 'POST') {
          const input = await readJson(req), current = store.get(id), run = store.entity(input.runId);
          return json(200, publicTask(store.save(attachExecution(current, run, input)), true));
        }
        if (action === 'export' && req.method === 'GET') {
          if (!task.report) throw new AppError('报告还未生成。', 409);
          const format = url.searchParams.get('format') || 'markdown';
          if (!['markdown', 'json'].includes(format)) throw new AppError('导出格式不支持。');
          res.setHeader('Content-Disposition', `attachment; filename="review-${id}.${format === 'json' ? 'json' : 'md'}"`);
          res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
          return res.end(format === 'json' ? JSON.stringify(task, null, 2) : renderTask(task));
        }
        if (action === 'publish' && req.method === 'POST') {
          assertNotAuthorizing();
          const publishInput = await readJson(req);
          if (!publishInput || typeof publishInput !== 'object' || Array.isArray(publishInput)) throw new AppError('发布请求格式错误。');
          if (!task.report || task.mode !== 'live' || !isFeishuReady(config)) throw new AppError('飞书发布需要已完成的真实评审和已配置的飞书连接。', 409);
          if (publishing.has(id) || ['uncertain', 'creating'].includes(task.publish.status)) throw new AppError('报告创建进行中或上次结果未知，请先到飞书核实。', 409);
          if (task.kind === 'cases' && ('parentUrl' in publishInput || 'targetMindnoteUrl' in publishInput)) {
            if (task.publish.url) throw new AppError('发布目标已经确定，不能更换目标；请直接重试已有思维笔记的写入或核验。', 409);
            const destination = caseDestination(publishInput, config);
            store.change(id, t => { delete t.options.parentUrl; delete t.options.targetMindnoteUrl; Object.assign(t.options, destination); });
          }
          if (task.publish.status === 'published') return json(200, task);
          launch(async () => { try { await publish(id); } catch { /* task already holds errors from publishing */ } });
          return json(202, store.get(id));
        }
        if (action === 'issues' && req.method === 'PATCH') {
          if (!task.report?.issues || task.status !== 'completed') throw new AppError('请等待评审完成再确认问题。', 409);
          const body = await readJson(req);
          if (!['pending', 'accepted', 'dismissed'].includes(body.status)) throw new AppError('问题状态不正确。');
          const issue = task.report.issues.find(i => i.id === body.issueId);
          if (!issue) throw new AppError('问题不存在。', 404);
          const updated = mutateQuality(store.get(id), { action: 'feedback', revision: qualityOf(store.get(id)).revision, targetId: body.issueId, status: body.status, actor: '本地用户（快捷确认）', note: body.status === 'pending' ? '' : '旧版快捷确认；未填写详细理由' });
          return json(200, publicTask(store.save(updated), true));

        }
      }
      if (path === '/api/runs' && req.method === 'GET') return json(200, store.listEntities('execution').map(r => ({ id: r.id, title: r.title, taskId: r.taskId, version: r.version, environment: r.environment, build: r.build, revision: r.revision, summary: executionSummary(r) })));
      if (path === '/api/runs' && req.method === 'POST') {
        const input = await readJson(req);
        return json(201, store.saveEntity(createRun(store.get(input.taskId), input)));
      }
      const runMatch = path.match(/^\/api\/runs\/([a-f0-9-]{36})(?:\/(results|import|export))?$/);
      if (runMatch) {
        const [, id, action] = runMatch;
        if (!action && req.method === 'GET') { const r = store.entity(id); return json(200, { ...r, summary: executionSummary(r) }); }
        if (['results', 'import'].includes(action) && req.method === 'POST') {
          const input = await readJson(req), r = store.entity(id);
          revision(r.revision, input.revision);
          const rows = action === 'import' ? normalizeResults(r, parseImport(input.content, input.format)) : normalizeResults(r, input.rows);
          if (action === 'import' && input.commit !== true) return json(200, { revision: r.revision, rows, count: rows.length });
          const updated = store.saveEntity(applyResults(r, { revision: input.revision, rows }));
          return json(200, { ...updated, summary: executionSummary(updated) });
        }
        if (action === 'export' && req.method === 'GET') {
          const r = store.entity(id), format = url.searchParams.get('format') || 'json';
          if (!['json', 'markdown', 'template'].includes(format)) throw new AppError('导出格式不支持。');
          res.setHeader('Content-Type', format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="execution-${id}.${format === 'markdown' ? 'md' : 'json'}"`);
          return res.end(format === 'markdown' ? executionMarkdown(r) : JSON.stringify(format === 'template' ? { rows: r.cases.map(c => ({ caseId: c.id, status: 'not_run', actual: '', evidence: '', tester: '', bugIds: [] })) } : { ...r, summary: executionSummary(r) }, null, 2));
        }
      }
      if (path === '/api/qa/base-schema' && req.method === 'POST') {
        assertNotAuthorizing();
        const body = await readJson(req), client = clientFactory();
        if (body.tableId && (typeof body.tableId !== 'string' || !/^tbl[A-Za-z0-9]+$/.test(body.tableId))) throw new AppError('数据表 ID 无效。');
        try { const data = await qaFactory(client).base(body.url, body.tableId); return json(200, data); }
        finally { await client.close(); }
      }
      if (path === '/api/connections/check' && req.method === 'POST') {
        assertNotAuthorizing();
        await readJson(req);
        const client = clientFactory();
        try { await client.connect(); client.schema('fetch-doc'); client.schema('create-doc'); return json(200, { ok: true, message: '飞书 MCP 已连接，读取与创建工具均可用。文档权限将在实际读取时验证。' }); }
        finally { await client.close(); }
      }
      if (req.method === 'GET') {
        const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/workspace.js': ['workspace.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        if (assets[path]) { const [file, type] = assets[path]; res.setHeader('Content-Type', `${type}; charset=utf-8`); return res.end(await readFile(join(root, 'public', file))); }
      }
      throw new AppError('页面或接口不存在。', 404, 'NOT_FOUND');
    } catch (error) { if (!res.headersSent) json(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '服务发生异常，请重试。', code: error.code || 'INTERNAL_ERROR' }); else res.end(); }
  });
  return { server, store, auth, async idle() { while (pending.size) await Promise.allSettled([...pending]); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp(); const port = Number(process.env.PORT) || 3210;
  app.server.listen(port, '127.0.0.1', () => console.log(`需求评审工作台已启动：http://127.0.0.1:${port}`));
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可修改 .env 的 PORT。` : `服务启动失败（${error.code || 'UNKNOWN'}）。请检查本机监听权限。`); process.exitCode = 1; });
}
