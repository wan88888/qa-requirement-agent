import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { configuration } from '../src/integrations.js';
import { DEMO_DOCUMENT, demoReview, parseSource } from '../src/review.js';

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qa-mvp-test-'));
  const app = createApp({ requireLogin: false, directory, config: configuration({}), ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  t.after(async () => { await app.idle(); await new Promise(resolve => app.server.close(resolve)); app.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...app, request, directory };
}
const liveConfig = configuration({ LLM_API_KEY: 'fake-key', LLM_MODEL: 'fake-model', FEISHU_USER_ACCESS_TOKEN: 'fake-user-token' });

test('演示主流程、刷新持久化、确认与导出均可用，重复请求只建一条', async t => {
  const app = await setup(t);
  const response = await app.request('/api/tasks', 'POST', { mode: 'demo', sourceType: 'sample' }, { 'Idempotency-Key': 'same-request-123' });
  assert.equal(response.status, 202); const task = await response.json(); await app.idle();
  const duplicate = await app.request('/api/tasks', 'POST', { mode: 'demo', sourceType: 'sample' }, { 'Idempotency-Key': 'same-request-123' });
  assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).id, task.id);
  const final = await (await app.request(`/api/tasks/${task.id}`)).json();
  assert.equal(final.status, 'completed'); assert.equal(final.report.issues.length, 8); assert.equal(final.publish.url, null);
  const confirmed = await app.request(`/api/tasks/${task.id}/issues`, 'PATCH', { issueId: 'REQ-001', status: 'accepted' });
  assert.equal(confirmed.status, 200);
  const md = await (await app.request(`/api/tasks/${task.id}/export`)).text(); assert.ok(md.includes('已采纳'));
  const json = await (await app.request(`/api/tasks/${task.id}/export?format=json`)).json(); assert.equal(json.report.issues[0].status, 'accepted');
  const secondStore = new Store(app.directory); assert.equal(secondStore.get(task.id).report.issues[0].status, 'accepted'); secondStore.close();
  assert.equal((await (await app.request('/api/tasks')).json()).length, 1);
});
test('空内容、超长内容和同 key 不同内容均拒绝', async t => {
  const app = await setup(t);
  for (const content of ['', 'a'.repeat(48001)]) { const r = await app.request('/api/tasks', 'POST', { mode: 'demo', sourceType: 'text', content }); assert.ok(r.status >= 400); }
  await app.request('/api/tasks', 'POST', { mode: 'demo', sourceType: 'sample' }, { 'Idempotency-Key': 'conflict-key-123' });
  const r = await app.request('/api/tasks', 'POST', { mode: 'demo', sourceType: 'text', content: DEMO_DOCUMENT.content }, { 'Idempotency-Key': 'conflict-key-123' });
  assert.equal(r.status, 409);
});
test('无配置的真实评审不会落为 demo，演示报告不能发布飞书', async t => {
  const app = await setup(t);
  assert.equal((await app.request('/api/tasks', 'POST', { mode: 'live', sourceType: 'sample' })).status, 409);
  const task = await (await app.request('/api/tasks', 'POST', { mode: 'demo', sourceType: 'sample' })).json();
  await app.idle(); assert.equal((await app.request(`/api/tasks/${task.id}/publish`, 'POST', {})).status, 409);
  assert.equal((await (await app.request('/api/tasks')).json()).length, 1);
});
test('跨站请求被拦截，配置响应不包含凭据，静态文件白名单隔离源码', async t => {
  const app = await setup(t, { config: liveConfig });
  assert.equal((await app.request('/api/tasks', 'GET', undefined, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await app.request('/api/tasks', 'POST', { mode: 'demo', sourceType: 'sample' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const text = await (await app.request('/api/config')).text(); assert.ok(!text.includes('fake-key')); assert.ok(!text.includes('fake-user-token'));
  assert.equal((await app.request('/.env')).status, 404); assert.equal((await app.request('/src/server.js')).status, 404);
});
test('真实评审错误保留失败状态，不返回伪造成功报告', async t => {
  const app = await setup(t, { config: liveConfig, reviewer: async () => { throw new Error('private upstream secret'); } });
  const task = await (await app.request('/api/tasks', 'POST', { mode: 'live', sourceType: 'sample' })).json(); await app.idle();
  const final = app.store.get(task.id); assert.equal(final.status, 'failed'); assert.equal(final.report, null); assert.ok(!final.error.includes('private'));
});
test('飞书权限拒绝时不调用模型，不保存原文或创建报告', async t => {
  let called = 0;
  const app = await setup(t, { config: liveConfig, reviewer: async () => { called++; }, clientFactory: () => ({ fetchDocument: async () => { throw new Error('denied'); }, close: async () => {} }) });
  const task = await (await app.request('/api/tasks', 'POST', { mode: 'live', sourceType: 'feishu', url: 'https://team.feishu.cn/wiki/node123', autoPublish: true })).json(); await app.idle();
  assert.equal(called, 0); assert.equal(app.store.get(task.id).source, null); assert.equal(app.store.get(task.id).status, 'failed');
});
test('飞书写入后回读成功；重复发布不会重复建文档', async t => {
  let created = 0, markdown;
  const client = { connect: async () => {}, schema: () => ({}), createReport: async (_title, value) => { markdown = value; created++; return 'https://team.feishu.cn/docx/report123'; }, fetchDocument: async () => parseSource(markdown), close: async () => {} };
  const app = await setup(t, { config: liveConfig, reviewer: async source => demoReview(source), clientFactory: () => client });
  const task = await (await app.request('/api/tasks', 'POST', { mode: 'live', sourceType: 'sample', autoPublish: true })).json(); await app.idle();
  assert.equal(app.store.get(task.id).publish.status, 'published');
  await app.request(`/api/tasks/${task.id}/publish`, 'POST', {}); await app.idle(); assert.equal(created, 1);
});
test('飞书创建超时标记未知，不盲目重试产生重复文档', async t => {
  let created = 0;
  const app = await setup(t, { config: liveConfig, reviewer: async source => demoReview(source), clientFactory: () => ({ connect: async () => {}, schema: () => ({}), createReport: async () => { created++; throw new Error('timeout'); }, close: async () => {} }) });
  const task = await (await app.request('/api/tasks', 'POST', { mode: 'live', sourceType: 'sample', autoPublish: true })).json(); await app.idle();
  assert.equal(app.store.get(task.id).publish.status, 'uncertain'); assert.equal(app.store.get(task.id).status, 'completed');
  assert.equal((await app.request(`/api/tasks/${task.id}/publish`, 'POST', {})).status, 409); assert.equal(created, 1);
});
test('回读失败只重试已知报告的核验，不再次创建', async t => {
  let created = 0, reads = 0, markdown;
  const app = await setup(t, { config: liveConfig, reviewer: async source => demoReview(source), clientFactory: () => ({ connect: async () => {}, schema: () => ({}), createReport: async (_title, value) => { markdown = value; created++; return 'https://team.feishu.cn/docx/report123'; }, fetchDocument: async () => { if (++reads === 1) throw new Error('timeout'); return parseSource(markdown); }, close: async () => {} }) });
  const task = await (await app.request('/api/tasks', 'POST', { mode: 'live', sourceType: 'sample', autoPublish: true })).json(); await app.idle();
  assert.equal(app.store.get(task.id).publish.status, 'verify_failed');
  await app.request(`/api/tasks/${task.id}/publish`, 'POST', {}); await app.idle();
  assert.equal(app.store.get(task.id).publish.status, 'published'); assert.equal(created, 1); assert.equal(reads, 2);
});
test('重启将执行中任务恢复为可解释失败，并保护创建状态', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-recovery-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { task } = store.create({ mode: 'live', sourceType: 'sample' }, 'interrupted-task');
  store.change(task.id, current => { current.status = 'publishing'; current.publish.status = 'creating'; });
  store.recover(); const recovered = store.get(task.id);
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.publish.status, 'uncertain');
});

test('OAuth 返回时允许跨站顶层主页导航，API、iframe 与 fetch 仍拒绝', async t => {
  const app = await setup(t);
  // fetch overrides Sec-Fetch-Mode; raw HTTP preserves browser navigation metadata.
  const status = (path, headers) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: app.server.address().port, path, headers }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal(await status('/', navigation), 200);
  assert.equal(await status('/api/config', navigation), 403);
  assert.equal(await status('/', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }), 403);
  assert.equal(await status('/', { ...navigation, 'Sec-Fetch-Mode': 'cors' }), 403);
});

test('图文评审端到端保留视觉证据和私有预览，跨站与未知资源均不可读', async t => {
  const image = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
  const app = await setup(t, {
    config: { ...liveConfig, llm: { ...liveConfig.llm, vision: true } },
    clientFactory: () => ({ fetchDocument: async () => parseSource(`${DEMO_DOCUMENT.content}\n<image token="testImage12345"/>`), visualRequest: async () => ({ buffer: image, mime: 'image/png', rendition: 'original' }), close: async () => {} }),
    visualAnalyzer: async () => ({ summary: '退款页面', readability: 'clear', observations: [{ location: '底部', text: '存在确认退款按钮' }], uncertainties: [] }),
    reviewer: async source => { assert.ok(source.blocks.some(b => b.kind === 'visual')); return demoReview(source); },
  });
  const task = await (await app.request('/api/tasks', 'POST', { mode: 'live', sourceType: 'feishu', url: 'https://team.feishu.cn/docx/realDoc123', includeVisuals: true })).json();
  await app.idle();
  const final = await (await app.request(`/api/tasks/${task.id}`)).json();
  assert.equal(final.source.visualCoverage.analyzed, 1); assert.equal(final.source.visuals[0].preview, true);
  assert.ok(!JSON.stringify(final).includes('base64'));
  const path = `/api/tasks/${task.id}/visuals/V001.png`;
  const preview = await app.request(path); assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal((await app.request(path, 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await app.request(`/api/tasks/${task.id}/visuals/V999.png`)).status, 404);
});

test('审核、基线、执行导入、快照报告完整 API 链路与持久化', async t => {
  const app=await setup(t);
  const source=parseSource(DEMO_DOCUMENT.content, '验收夹具');
  const {task}=app.store.create({kind:'cases',mode:'live',sourceType:'feishu'},'qa-extension-cases');
  Object.assign(task,{status:'completed',source,report:{summary:'用例摘要',limitations:[],cases:[{id:'TC001',title:'退款',module:'订单',priority:'P0',category:'正常',quote:'订单支付后 7 天内允许退款。',preconditions:'已支付',steps:[{action:'退款',expected:'进入处理中'}],assumptions:[]} ]}});app.store.save(task);
  const patch=async input=>{const current=await(await app.request(`/api/tasks/${task.id}`)).json();return app.request(`/api/tasks/${task.id}/quality`,'PATCH',{revision:current.quality.revision,actor:'QA',note:'已核对规则',...input});};
  const first=await(await app.request(`/api/tasks/${task.id}`)).json();assert.equal(first.usageSummary.recorded,false);
  assert.equal((await patch({action:'feedback',targetId:'TC001',status:'accepted'})).status,200);
  const r=first.quality.requirements[0];assert.equal((await patch({action:'requirement',requirementId:r.id,title:r.title,quote:r.quote,status:'confirmed'})).status,200);
  await patch({action:'baseline',complete:true});await patch({action:'suggest-links'});
  const runResponse=await app.request('/api/runs','POST',{taskId:task.id,version:'1.6.2',environment:'test',build:'42',owner:'QA'});assert.equal(runResponse.status,201);const run=await runResponse.json();
  const content=JSON.stringify([{caseId:'TC001',status:'passed',actual:'符合预期',tester:'QA',bugIds:['rec1']}]);
  const preview=await(await app.request(`/api/runs/${run.id}/import`,'POST',{revision:0,format:'json',content})).json();assert.equal(preview.count,1);assert.deepEqual(app.store.entity(run.id).results,{});
  const result=await app.request(`/api/runs/${run.id}/results`,'POST',{revision:0,rows:preview.rows});assert.equal(result.status,200);assert.equal((await result.json()).summary.passRate,1);
  assert.equal((await app.request(`/api/runs/${run.id}/results`,'POST',{revision:0,rows:preview.rows})).status,409);
  const db=new Store(app.directory);assert.equal(db.entity(run.id).results.TC001.status,'passed');db.close();
  const markdown=await(await app.request(`/api/runs/${run.id}/export?format=markdown`)).text();assert.match(markdown,/通过：1/);
  const {task:report}=app.store.create({kind:'bugs',mode:'live',sourceType:'base'},'qa-extension-bugs');
  Object.assign(report,{status:'completed',source:{version:'1.6.2',records:[{id:'rec1'}]},report:{summary:'缺陷摘要',risks:[]}});app.store.save(report);
  const attached=await app.request(`/api/tasks/${report.id}/execution`,'POST',{revision:0,runId:run.id,actor:'QA',confirmScope:true});assert.equal(attached.status,200);assert.equal((await attached.json()).executionSummary.passed,1);
  assert.equal((await app.request(`/api/runs/${run.id}`,'GET',undefined,{Origin:'https://evil.test'})).status,403);
});

test('已发布报告修订版独立发布且重试幂等，原报告保持原快照',async t=>{
 let creates=0;const docs=new Map();
 const client={connect:async()=>{},schema:()=>({}),createReport:async(_title,md)=>{const url=`https://team.feishu.cn/docx/revision${++creates}`;docs.set(url,md);return url;},fetchDocument:async url=>parseSource(docs.get(url)),close:async()=>{}};
 const app=await setup(t,{config:liveConfig,reviewer:async source=>demoReview(source),clientFactory:()=>client});
 const original=await(await app.request('/api/tasks','POST',{mode:'live',sourceType:'sample',autoPublish:true})).json();await app.idle();
 const edited=await app.request(`/api/tasks/${original.id}/quality`,'PATCH',{revision:0,actor:'QA',note:'按业务核实',action:'feedback',targetId:'summary',status:'modified',patch:{summary:'已经人工修订的摘要'}});assert.equal(edited.status,200);
 const copy=await(await app.request(`/api/tasks/${original.id}/republish`,'POST',{revision:1})).json();await app.idle();
 assert.equal(app.store.get(copy.id).publish.status,'published');assert.equal(creates,2);
 assert.equal((await(await app.request(`/api/tasks/${original.id}/republish`,'POST',{revision:1})).json()).id,copy.id);await app.idle();assert.equal(creates,2);
 assert.ok(!docs.get('https://team.feishu.cn/docx/revision1').includes('已经人工修订的摘要'));assert.ok(docs.get('https://team.feishu.cn/docx/revision2').includes('已经人工修订的摘要'));
});
