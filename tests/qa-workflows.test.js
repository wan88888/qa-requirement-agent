import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { QaFeishu, parseResourceUrl, normalizeCases, normalizeBugReport, generateBugReport, bugStats, writeCaseMindnote, nodeText, workflowMarkdown } from '../src/qa-workflows.js';
import { parseSource } from '../src/review.js';
import { configuration } from '../src/integrations.js';
import { createApp } from '../src/server.js';
import { FeishuAuth, TokenVault, oauthConfiguration, FEISHU_SCOPES, FEISHU_VISUAL_SCOPES } from '../src/feishu-auth.js';

const source = () => parseSource('# 登录需求\n用户输入正确手机号与验证码后登录，错误验证码应当显示错误信息，并保留手机号便于重试。', '登录');
const rawCases = () => ({ summary: '登录测试', limitations: ['未包含执行结果'], cases: [{ module: '登录', title: '错误验证码', priority: 'P1', category: '异常', preconditions: '打开登录页', steps: [{ action: '输入错误验证码', expected: '显示错误信息' }], quote: '错误验证码应当显示错误信息', assumptions: [] }] });
const bugInput = { url: 'https://team.feishu.cn/base/base123?table=tbl123', tableId: 'tbl123', version: 'v1', mapping: { version: '版本', title: '标题', status: '状态', severity: '严重程度', module: '', description: '' }, closedStatuses: ['已关闭'] };
const fields = [{ field_name: '版本', type: 4 }, ...['标题', '状态', '严重程度'].map(field_name => ({ field_name, type: 1 }))];
const records = [
  { record_id: 'rec1', fields: { 版本: ['v1', 'v2'], 标题: [{ text: '支付失败' }], 状态: '已关闭', 严重程度: 'P0' } },
  { record_id: 'rec2', fields: { 版本: ['v10'], 标题: [{ text: '不应包含' }], 状态: '已关闭', 严重程度: 'P1' } },
  { record_id: 'rec3', fields: { 版本: ['v1'], 标题: [{ text: '状态刷新失败' }], 状态: '已解决', 严重程度: 'P1' } },
];
const modelBugs = { summary: '存在状态同步风险', risks: [{ title: '状态风险', analysis: '需要复测', recordIds: ['rec3'], recommendation: '回归验证' }], limitations: [] };

function baseApi(versionType = 4) {
  const calls = [];
  const api = new QaFeishu({ config: { token: 'secret', fetchImpl: async (url, init) => {
    calls.push({ url, body: init.body && JSON.parse(init.body) });
    assert.equal(new URL(url).origin, 'https://open.feishu.cn'); assert.equal(init.redirect, 'error');
    let data;
    if (url.includes('/fields')) data = { items: [{ ...fields[0], type: versionType }, ...fields.slice(1)], has_more: false };
    else if (url.includes('/records/search')) data = url.includes('page_token=next') ? { items: [records[2]], has_more: false } : { items: records.slice(0, 2), has_more: true, page_token: 'next' };
    else data = { items: [{ table_id: 'tbl123', name: 'BugList' }], has_more: false };
    return Response.json({ code: 0, data });
  } } });
  return { api, calls };
}
test('多维表格完整分页、精确匹配多选版本，不把已解决计为已关闭', async () => {
  const { api, calls } = baseApi(); const s = await api.bugs(bugInput);
  assert.equal(s.scanned, 3); assert.deepEqual(s.records.map(r => r.id), ['rec1', 'rec3']);
  const stats = bugStats(s, ['已关闭']); assert.equal(stats.closed, 1); assert.equal(stats.unclosed, 1); assert.equal(stats.total, 2);
  assert.equal(calls.filter(c => c.body).length, 2); assert.equal(calls.at(-1).body.view_id, undefined);
  const report = normalizeBugReport(modelBugs, s, ['已关闭']); assert.equal(report.stats.total, 2);
  assert.ok(report.limitations.includes('仅分析映射字段，未分析多维表格中的附件、截图和评论。'));
  assert.throws(() => normalizeBugReport({ ...modelBugs, risks: [{ ...modelBugs.risks[0], recordIds: ['fake'] }] }, s, []), /不存在/);
});
test('缺陷描述保留超过3000字的全文，总模型输入超限时拒绝而非截断', async () => {
  let description = '详细复现步骤'.repeat(700) + '尾部关键预期';
  const api = new QaFeishu({ config: {} });
  api.base = async () => ({ token: 'base123', tableId: 'tbl123', title: 'BugList', url: bugInput.url, fields: [...fields, { field_name: '备注', type: 1 }] });
  api.pages = async () => [{ ...records[0], fields: { ...records[0].fields, 备注: [{ text: description }] } }];
  const input = { ...bugInput, mapping: { ...bugInput.mapping, description: '备注' } };
  const source = await api.bugs(input);
  assert.equal(source.records[0].description, description);
  assert.ok(source.records[0].description.endsWith('尾部关键预期'));
  description = '长'.repeat(100001);
  const oversized = await api.bugs(input);
  assert.equal(oversized.records[0].description.length, 100001);
  await assert.rejects(generateBugReport(oversized, {}, ['已关闭']), /模型输入上限/);
  assert.equal(oversized.records[0].description.length, 100001);
});
test('分页循环、超过上限、无可见版本记录时不能生成零缺陷报告', async () => {
  const api = new QaFeishu({ config: {} }); api.request = async () => ({ items: [{}], has_more: true, page_token: 'repeat' });
  await assert.rejects(api.pages('path'), /分页未完整/); await assert.rejects(api.pages('path', undefined, 0), /上限/);
  const real = baseApi().api; await assert.rejects(real.bugs({ ...bugInput, version: 'absent' }), /不能据此判定零缺陷/);
});
test('拒绝未知字段类型和外部、带凭据、仪表盘链接', async () => {
  await assert.rejects(baseApi(18).api.bugs(bugInput), /类型不支持/);
  for (const url of ['https://evil.test/base/abc', 'https://user:pass@team.feishu.cn/base/abc', 'http://team.feishu.cn/base/abc', 'https://team.feishu.cn/dashboard/abc']) assert.throws(() => parseResourceUrl(url, ['base', 'wiki']));
  assert.equal(parseResourceUrl('https://team.feishu.cn/base/abc?table=tbl123&view=vew1', ['base']).url, 'https://team.feishu.cn/base/abc?table=tbl123');
});
test('失效原文证据与视觉证据均标记待确认；无效模型结构不能发布', () => {
  const raw = rawCases(), s = source();
  assert.equal(normalizeCases(raw, s).cases[0].needsConfirmation, false);
  raw.cases[0].quote = '不存在'; assert.equal(normalizeCases(raw, s).cases[0].needsConfirmation, true);
  s.blocks.push({ text: '[V001] 登录按钮', kind: 'visual', line: 3 }); raw.cases[0].quote = '[V001] 登录按钮';
  assert.equal(normalizeCases(raw, s).cases[0].evidence, 'visual'); assert.equal(normalizeCases(raw, s).cases[0].needsConfirmation, true);
  assert.throws(() => normalizeCases({ cases: [] }, s), /结构/);
});
function fakeMindnote(empty = false) {
  let nodes = empty ? [] : [{ node_id: 'root', texts: [] }], calls = 0;
  const api = { nodes: async () => structuredClone(nodes), addNodes: async (_token, body) => { calls++; const ids = body.map(n => { const id = `node${nodes.length}`; nodes.push({ ...n, node_id: id }); return id; }); return { ids }; } };
  return { api, count: () => calls, nodes: () => nodes };
}
test('思维笔记按模块与用例创建并核验备注；重复发布不重复写入', async () => {
  const f = fakeMindnote(); const task = { id: 'task1', source: { ...source(), url: 'https://team.feishu.cn/docx/source' }, report: normalizeCases(rawCases(), source()), publish: { token: 'mindnote' } };
  let checkpoints = 0; await writeCaseMindnote(f.api, task, () => checkpoints++);
  assert.equal(f.count(), 3); assert.equal(checkpoints, 3);
  await writeCaseMindnote(f.api, task, () => checkpoints++); assert.equal(f.count(), 3);
  const leaf = f.nodes().find(n => nodeText(n).startsWith('TC001')); assert.match(leaf.notes[0].text.content, /预期 1：显示错误信息/);
  leaf.notes[0].text.content = 'wrong'; await assert.rejects(writeCaseMindnote(f.api, task, () => {}), /回读核验/);
});
test('节点请求结果未知时重试使用持久化的原始正文与幂等标识', async () => {
  const f = fakeMindnote(), original = f.api.addNodes; let first = true, before;
  f.api.addNodes = async (token, body, key) => { if (first) { first = false; before = { body: structuredClone(body), key }; throw new Error('network'); } assert.equal(key, before.key); assert.deepEqual(body, before.body); f.api.addNodes = original; return original(token, body); };
  const task = { id: 'task1', source: source(), report: normalizeCases(rawCases(), source()), publish: { token: 'mindnote' } };
  await assert.rejects(writeCaseMindnote(f.api, task, () => {}), /network/);
  await writeCaseMindnote(f.api, task, () => {}); assert.equal(f.count(), 3);
});
test('空白笔记创建本任务根节点，响应丢失后从持久化状态恢复不会增加一层', async () => {
  const f = fakeMindnote(true), add = f.api.addNodes; let first = true, persisted;
  let task = { id: 'blank-task', source: source(), report: normalizeCases(rawCases(), source()), publish: { token: 'mind123' } };
  f.api.addNodes = async (...args) => {
    if (first) {
      first = false;
      assert.ok(persisted.batches['document-root']);
      assert.equal(Object.hasOwn(args[1][0], 'parent_id'), false);
      await add(...args);
      throw new Error('root committed but response lost');
    }
    return add(...args);
  };
  const checkpoint = state => { persisted = structuredClone(state); };
  await assert.rejects(writeCaseMindnote(f.api, task, checkpoint), /response lost/);
  task = { ...task, publish: structuredClone(persisted) };
  await writeCaseMindnote(f.api, task, checkpoint);
  assert.equal(f.count(), 3); assert.equal(f.nodes().length, 3);
  const root = f.nodes().find(n => !n.parent_id);
  assert.equal(nodeText(root), '测试用例 · blank-task');
  assert.equal(f.nodes().find(n => nodeText(n) === '登录').parent_id, root.node_id);
  await writeCaseMindnote(f.api, task, checkpoint); assert.equal(f.count(), 3);
  root.notes[0].text.content = 'changed';
  await assert.rejects(writeCaseMindnote(f.api, task, checkpoint), /回读核验/);
  assert.equal(f.count(), 3);
});
test('飞书上游鉴权错误不泄露原始响应和凭据', async () => {
  const api = new QaFeishu({ config: { token: 'secret', fetchImpl: async () => Response.json({ code: 99991672, msg: 'secret private' }, { status: 403 }) } });
  await assert.rejects(api.nodes('a'), e => /99991672/.test(e.message) && !/secret|private/.test(e.message) && e.code === 'FEISHU_PERMISSION_DENIED' && e.confirmedNotCreated === true);
});
test('只有有效业务错误码的明确鉴权拒绝可确认未写入', async () => {
  for (const [status, code, rejected] of [[400, 131006, true], [401, 99991663, true], [403, 99991672, true], [403, undefined, false], [403, 0, false], [400, 131007, false], [500, 131007, false]]) {
    const api = new QaFeishu({ config: { token: 'secret', fetchImpl: async () => Response.json({ code }, { status }) } });
    await assert.rejects(api.request('wiki/v2/spaces/space1/nodes', { obj_type: 'mindnote' }), error => {
      assert.equal(error.confirmedNotCreated === true, rejected, `HTTP ${status}, code ${code}`);
      assert.equal(error.code, rejected ? 'FEISHU_PERMISSION_DENIED' : 'FEISHU_API_ERROR');
      if (rejected) assert.match(error.message, /父节点.*容器编辑.*wiki:node:create.*重试/);
      return true;
    });
  }
});
test('知识库创建思维笔记使用 mindnote 类型、父节点和真实 token', async () => {
  const api = new QaFeishu({ config: {} }); const calls = [];
  api.request = async (path, body) => { calls.push({ path, body }); return body ? { node: { obj_type: 'mindnote', obj_token: 'mind123', node_token: 'wiki456' } } : { node: { obj_token: 'doc123', space_id: 'space1' } }; };
  assert.deepEqual(await api.createMindnote('https://team.feishu.cn/wiki/wiki123', '用例'), { token: 'mind123', url: 'https://team.feishu.cn/wiki/wiki456' });
  assert.equal(calls[1].body.obj_type, 'mindnote'); assert.equal(calls[1].body.parent_node_token, 'wiki123');
});
test('已有原生思维笔记解析支持两种直接路径，Wiki 必须验证底层类型', async () => {
  const api = new QaFeishu({ config: {} }); let lookups = 0;
  api.wiki = async token => { lookups++; assert.equal(token, 'wiki123'); return { obj_type: 'mindnote', obj_token: 'mind123' }; };
  for (const path of ['mindnotes', 'mindnote']) assert.deepEqual(await api.resolveMindnote(`https://team.feishu.cn/${path}/mind123`), { url: `https://team.feishu.cn/${path}/mind123`, token: 'mind123' });
  assert.equal(lookups, 0);
  assert.deepEqual(await api.resolveMindnote('https://team.feishu.cn/wiki/wiki123'), { url: 'https://team.feishu.cn/wiki/wiki123', token: 'mind123' });
  assert.equal(lookups, 1);
  api.wiki = async () => ({ obj_type: 'docx', obj_token: 'doc123' });
  await assert.rejects(api.resolveMindnote('https://team.feishu.cn/wiki/wiki123'), /不是原生思维笔记/);
  for (const url of ['https://team.feishu.cn/docx/doc123', 'https://evil.test/mindnotes/mind123', 'https://user:pass@team.feishu.cn/mindnotes/mind123']) await assert.rejects(api.resolveMindnote(url));
});

async function setup(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'qa-workflows-'));
  const app = createApp({ requireLogin: false, directory, config: configuration({ LLM_API_KEY: 'fake', LLM_MODEL: 'fake', FEISHU_USER_ACCESS_TOKEN: 'fake' }), ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const req = (path, body) => fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  t.after(async () => { await app.idle(); await new Promise(r => app.server.close(r)); app.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...app, req };
}
test('测试用例全流程生成、发布原生笔记、列表与导出', async t => {
  const f = fakeMindnote(); let created = 0;
  const app = await setup(t, { caseGenerator: async () => rawCases(), clientFactory: () => ({ fetchDocument: async () => source(), close: async () => {} }), qaFactory: () => ({ ...f.api, wiki: async () => ({}), createMindnote: async () => { created++; return { token: 'mind123', url: 'https://team.feishu.cn/wiki/wiki123' }; } }) });
  const input = { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/doc123', parentUrl: 'https://team.feishu.cn/wiki/wiki123', autoPublish: true, includeVisuals: false };
  const response = await app.req('/api/tasks', input); assert.equal(response.status, 202); const { id } = await response.json(); await app.idle();
  const task = app.store.get(id); assert.equal(task.publish.status, 'published'); assert.equal(task.report.cases.length, 1); assert.equal(created, 1);
  assert.equal((await (await app.req('/api/tasks')).json())[0].caseCount, 1);
  assert.match(await (await app.req(`/api/tasks/${id}/export`)).text(), /错误验证码/);
  await app.req(`/api/tasks/${id}/publish`, {}); await app.idle(); assert.equal(created, 1);
});
test('节点已写入但响应丢失后，发布重试回读已有节点且不重复创建', async t => {
  const f = fakeMindnote(), add = f.api.addNodes; let loseResponse = true, created = 0;
  f.api.addNodes = async (...args) => {
    const result = await add(...args);
    if (loseResponse) { loseResponse = false; throw new Error('response lost after commit'); }
    return result;
  };
  const app = await setup(t, { caseGenerator: async () => rawCases(), clientFactory: () => ({ fetchDocument: async () => source(), close: async () => {} }), qaFactory: () => ({ ...f.api, wiki: async () => ({}), createMindnote: async () => { created++; return { token: 'mind123', url: 'https://team.feishu.cn/wiki/wiki123' }; } }) });
  const response = await app.req('/api/tasks', { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/doc123', parentUrl: 'https://team.feishu.cn/wiki/wiki123', autoPublish: true, includeVisuals: false });
  const { id } = await response.json(); await app.idle();
  const failed = app.store.get(id);
  assert.equal(failed.publish.status, 'verify_failed'); assert.equal(created, 1); assert.equal(f.count(), 1);
  assert.equal(failed.publish.batches.root.nodes.length, 1);
  assert.equal((await app.req(`/api/tasks/${id}/publish`, {})).status, 202); await app.idle();
  assert.equal(app.store.get(id).publish.status, 'published'); assert.equal(created, 1); assert.equal(f.count(), 3);
  assert.equal(f.nodes().filter(n => nodeText(n) === `测试用例 · ${id}`).length, 1);
  assert.equal(f.nodes().filter(n => nodeText(n).startsWith('TC001')).length, 1);
});
test('复用已有思维笔记，节点响应丢失后重试不新建且保留用户原有内容', async t => {
  const f = fakeMindnote(), add = f.api.addNodes; let created = 0, loseResponse = true;
  const originalNode = { node_id: 'original-user-node', parent_id: 'root', texts: [{ element_type: 'text', text: { content: '用户原有内容' } }] };
  f.nodes().push(structuredClone(originalNode));
  const api = new QaFeishu({ config: {} }); api.nodes = f.api.nodes;
  api.addNodes = async (...args) => { const result = await add(...args); if (loseResponse) { loseResponse = false; throw new Error('response lost after commit'); } return result; };
  api.createMindnote = async () => { created++; throw new Error('must never create'); };
  const app = await setup(t, { caseGenerator: async () => rawCases(), clientFactory: () => ({ fetchDocument: async () => source(), close: async () => {} }), qaFactory: () => api });
  const targetMindnoteUrl = 'https://team.feishu.cn/mindnotes/mind123';
  const response = await app.req('/api/tasks', { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/doc123', targetMindnoteUrl, autoPublish: true, includeVisuals: false });
  assert.equal(response.status, 202); const { id } = await response.json(); await app.idle();
  const failed = app.store.get(id);
  assert.equal(failed.publish.status, 'verify_failed'); assert.equal(failed.publish.url, targetMindnoteUrl); assert.equal(failed.publish.token, 'mind123'); assert.equal(created, 0);
  assert.equal((await app.req(`/api/tasks/${id}/publish`, { targetMindnoteUrl: 'https://team.feishu.cn/mindnotes/other' })).status, 409);
  assert.equal((await app.req(`/api/tasks/${id}/publish`, {})).status, 202); await app.idle();
  assert.equal(app.store.get(id).publish.status, 'published'); assert.equal(created, 0); assert.equal(f.count(), 3);
  assert.deepEqual(f.nodes().find(n => n.node_id === originalNode.node_id), originalNode);
  assert.equal(f.nodes().filter(n => nodeText(n).startsWith('TC001')).length, 1);
});
test('已有笔记预读失败时不记录发布目标或创建替代，发布参数可替换旧父节点', async t => {
  const f = fakeMindnote(); let readable = false, created = 0;
  const api = new QaFeishu({ config: {} });
  api.nodes = async token => { assert.equal(token, 'mind123'); if (!readable) throw new Error('read denied'); return f.api.nodes(); };
  api.addNodes = f.api.addNodes; api.createMindnote = async () => { created++; throw new Error('must never create'); };
  const app = await setup(t, { caseGenerator: async () => rawCases(), clientFactory: () => ({ fetchDocument: async () => source(), close: async () => {} }), qaFactory: () => api });
  const response = await app.req('/api/tasks', { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/doc123', parentUrl: 'https://team.feishu.cn/wiki/oldParent', autoPublish: false, includeVisuals: false });
  const { id } = await response.json(); await app.idle();
  const targetMindnoteUrl = 'https://team.feishu.cn/mindnote/mind123';
  assert.equal((await app.req(`/api/tasks/${id}/publish`, { targetMindnoteUrl })).status, 202); await app.idle();
  const failed = app.store.get(id);
  assert.equal(failed.options.parentUrl, undefined); assert.equal(failed.options.targetMindnoteUrl, targetMindnoteUrl);
  assert.equal(failed.publish.status, 'failed'); assert.equal(failed.publish.url, null); assert.equal(failed.publish.token, undefined); assert.equal(created, 0); assert.equal(f.count(), 0);
  readable = true;
  assert.equal((await app.req(`/api/tasks/${id}/publish`, {})).status, 202); await app.idle();
  assert.equal(app.store.get(id).publish.status, 'published'); assert.equal(created, 0); assert.equal(f.count(), 3);
});
test('目标 Wiki 底层不是思维笔记时终止发布，不写入或创建替代', async t => {
  let created = 0, reads = 0, writes = 0;
  const api = new QaFeishu({ config: {} });
  api.wiki = async () => ({ obj_type: 'docx', obj_token: 'doc123' });
  api.nodes = async () => { reads++; return []; };
  api.addNodes = async () => { writes++; };
  api.createMindnote = async () => { created++; };
  const app = await setup(t, { caseGenerator: async () => rawCases(), clientFactory: () => ({ fetchDocument: async () => source(), close: async () => {} }), qaFactory: () => api });
  const response = await app.req('/api/tasks', { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/doc123', targetMindnoteUrl: 'https://team.feishu.cn/wiki/notMindnote', autoPublish: true, includeVisuals: false });
  const { id } = await response.json(); await app.idle(); const task = app.store.get(id);
  assert.equal(task.publish.status, 'failed'); assert.match(task.publish.error, /不是原生思维笔记/);
  assert.equal(task.publish.url, null); assert.equal(created, 0); assert.equal(reads, 0); assert.equal(writes, 0);
});
test('知识库创建明确拒绝时标为失败，修复权限后可重试同一任务', async t => {
  const f = fakeMindnote(); let denied = true, attempts = 0, created = 0;
  const api = new QaFeishu({ config: { token: 'secret', fetchImpl: async (_url, init) => {
    if (init.method === 'GET') return Response.json({ code: 0, data: { node: { obj_token: 'doc123', space_id: 'space1' } } });
    attempts++;
    if (denied) return Response.json({ code: 131006, msg: 'private permission details' }, { status: 400 });
    created++;
    return Response.json({ code: 0, data: { node: { obj_type: 'mindnote', obj_token: 'mind123', node_token: 'wiki456' } } });
  } } });
  api.nodes = f.api.nodes; api.addNodes = f.api.addNodes;
  const app = await setup(t, { caseGenerator: async () => rawCases(), clientFactory: () => ({ fetchDocument: async () => source(), close: async () => {} }), qaFactory: () => api });
  const response = await app.req('/api/tasks', { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/doc123', parentUrl: 'https://team.feishu.cn/wiki/wiki123', autoPublish: true, includeVisuals: false });
  const { id } = await response.json(); await app.idle();
  const failed = app.store.get(id);
  assert.equal(failed.publish.status, 'failed'); assert.equal(created, 0); assert.equal(attempts, 1);
  assert.match(failed.publish.error, /131006.*父节点.*容器编辑/); assert.ok(!failed.publish.error.includes('private'));
  denied = false;
  assert.equal((await app.req(`/api/tasks/${id}/publish`, {})).status, 202); await app.idle();
  assert.equal(app.store.get(id).publish.status, 'published'); assert.equal(created, 1); assert.equal(attempts, 2);
});
test('BugList 报告端到端统计、Markdown 发布核验和导出', async t => {
  const s = await baseApi().api.bugs(bugInput); let markdown, created = 0;
  const app = await setup(t, { bugGenerator: async () => modelBugs, qaFactory: () => ({ bugs: async () => s }), clientFactory: () => ({ connect: async () => {}, schema: () => ({}), close: async () => {}, createReport: async (_title, value) => { markdown = value; created++; return 'https://team.feishu.cn/docx/report123'; }, fetchDocument: async () => parseSource(markdown) }) });
  const response = await app.req('/api/tasks', { ...bugInput, kind: 'bugs', mode: 'live', autoPublish: true }); assert.equal(response.status, 202);
  const { id } = await response.json(); await app.idle(); const task = app.store.get(id);
  assert.equal(task.publish.status, 'published'); assert.equal(task.report.stats.total, 2); assert.equal(created, 1);
  assert.match(workflowMarkdown(task), /无法计算用例通过率/); assert.equal((await (await app.req('/api/tasks')).json())[0].bugCount, 2);
});
test('新增权限缺失不阻断既有评审授权，状态明确列出新增权限', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-scopes-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = oauthConfiguration({ FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret' });
  new TokenVault(directory).save({ appId: 'app', accessToken: 'secret', expiresAt: Date.now() + 100000, scopes: [...FEISHU_SCOPES, ...FEISHU_VISUAL_SCOPES] });
  const auth = new FeishuAuth({ directory, config }); assert.equal(auth.ready(), true); assert.equal(auth.status().missingQaScopes.length, 3);
});

test('思维笔记新文档创建超时标为未知，后续发布不能再次创建', async t => {
  let created = 0;
  const app = await setup(t, { caseGenerator: async () => rawCases(), clientFactory: () => ({ fetchDocument: async () => source(), close: async () => {} }), qaFactory: () => ({ wiki: async () => ({}), createMindnote: async () => { created++; throw new Error('timeout secret'); } }) });
  const response = await app.req('/api/tasks', { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/doc123', parentUrl: 'https://team.feishu.cn/wiki/wiki123', autoPublish: true, includeVisuals: false });
  const { id } = await response.json(); await app.idle(); const task = app.store.get(id);
  assert.equal(task.publish.status, 'uncertain'); assert.equal(task.status, 'completed'); assert.equal(created, 1);
  assert.equal((await app.req(`/api/tasks/${id}/publish`, {})).status, 409); assert.equal(created, 1); assert.ok(!task.publish.error.includes('secret'));
});
test('输入不完整不会调用模型，新功能不接受演示伪装为真实结果', async t => {
  let calls = 0;
  const app = await setup(t, { caseGenerator: async () => { calls++; }, bugGenerator: async () => { calls++; } });
  for (const input of [
    { kind: 'cases', mode: 'demo' },
    { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/source', parentUrl: 'https://evil.test/wiki/a' },
    { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/source' },
    { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/source', parentUrl: 'https://team.feishu.cn/wiki/a', targetMindnoteUrl: 'https://team.feishu.cn/mindnotes/mind123' },
    { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/source', targetMindnoteUrl: 'https://team.feishu.cn/docx/notMindnote' },
    { kind: 'cases', mode: 'live', url: 'https://team.feishu.cn/docx/source', targetMindnoteUrl: 'https://evil.test/mindnotes/mind123' },
    { ...bugInput, kind: 'bugs', mode: 'live', closedStatuses: [] },
    { ...bugInput, kind: 'bugs', mode: 'live', mapping: {} },
  ]) assert.ok((await app.req('/api/tasks', input)).status >= 400);
  assert.equal(calls, 0); assert.equal(app.store.list().length, 0);
});
