import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverVisuals, prepareImage, enrichVisuals, analyzeImage, boardNodeContext } from '../src/visual.js';
import { parseSource, validateReview, renderMarkdown, DEMO_DOCUMENT } from '../src/review.js';
import { FeishuClient, configuration, requestModel } from '../src/integrations.js';

const png = () => sharp({ create: { width: 80, height: 60, channels: 3, background: '#fff' } }).png().toBuffer();
const doc = () => parseSource('# 原型与流程\n请评审以下原型和流程，关注成功失败分支与正文的冲突。\n<image token="imageToken12345"/>\n<whiteboard token="boardToken12345"/>\n<image token="imageToken12345"/>');
const observation = { summary: '订阅页', readability: 'clear', observations: [{ location: '确认弹窗', text: '只有确认按钮，未显示取消入口' }], uncertainties: [] };
const config = configuration({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'vision-model', LLM_API_KEY: 'secret' });
const fields = { title: '取消路径需核对', category: 'risk', dimension: '边界与异常', priority: 'P1', description: '确认弹窗需核对取消路径', impact: '可能无法退出', suggestion: '确认取消交互', evidenceType: 'fact', confidence: 0.99 };

test('资源发现按 token 去重并保留每次出现位置，外部链接只记录不请求', () => {
  const source = doc(); source.blocks.push({ id: 'external', line: 10, section: '外部图', text: '![外部图](http://127.0.0.1/secret)' });
  const assets = discoverVisuals(source);
  assert.equal(assets.length, 3); assert.equal(assets[0].references.length, 2);
  assert.equal(assets[1].kind, 'whiteboard'); assert.equal(assets[2].token, null);
});
test('长图保留全图及所有细节分片，拒绝 SVG 与伪装位图', async () => {
  const input = await sharp({ create: { width: 800, height: 3400, channels: 3, background: '#fff' } }).png().toBuffer();
  const prepared = await prepareImage(input, 'image/png');
  assert.equal(prepared.images.length, 4); assert.equal(prepared.tilesComplete, true);
  assert.equal(prepared.height, 3400); assert.match(prepared.images[0], /^data:image\/jpeg;base64,/);
  await assert.rejects(prepareImage(Buffer.from('<svg/>'), 'image/svg+xml'), /格式不支持/);
  await assert.rejects(prepareImage(Buffer.from('<html>secret</html>'), 'image/png'), /损坏/);
});
test('真实视觉格式发送图片，Chat 与 Responses 不丢弃多模态输入', async () => {
  for (const mode of ['chat', 'responses']) {
    let body;
    const schema = { type: 'object', properties: { observation: { type: 'string' } } };
    const result = await requestModel({ system: 'read image', input: 'prototype', schema, name: 'test', images: ['data:image/png;base64,AA=='] }, { ...config, llm: { ...config.llm, mode, outputFormat: 'json_schema' } }, async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json(mode === 'chat' ? { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] } : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] });
    });
    assert.deepEqual(result, {});
    if (mode === 'chat') { assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,AA=='); assert.deepEqual(body.response_format.json_schema.schema, schema); }
    else { assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,AA=='); assert.equal(body.store, false); assert.deepEqual(body.text.format.schema, schema); }
  }
});
test('视觉输出不合规不能被当成已识别内容', async () => {
  await assert.rejects(analyzeImage(discoverVisuals(doc())[0], { regions: ['全图'], images: ['data:image/png;base64,AA=='] }, null, config, async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"漏字段"}' } }] })), /格式不合规/);
});
test('视觉证据只定位到识别记录，不能冒充原文核验或事实；未知引用降级', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qa-visual-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await enrichVisuals(doc(), { directory, taskId: 'task', config, client: { visualRequest: async (_asset, nodes) => nodes ? [] : { buffer: await png(), mime: 'image/png' } }, analyzer: async () => observation });
  const quote = source.blocks.find(b => b.kind === 'visual').text;
  const report = validateReview({ summary: '图文评审', issues: [{ ...fields, quote }, { ...fields, title: '伪造图', quote: '[V999] 不存在的画板' }] }, source);
  assert.equal(report.validation.visual, 1); assert.equal(report.validation.verified, 0); assert.equal(report.validation.downgraded, 1);
  assert.equal(report.issues[0].evidenceType, 'inference'); assert.equal(report.issues[0].visualLocated, true);
  assert.equal(source.fingerprint, doc().fingerprint); assert.equal(source.visualCoverage.analyzed, 2);
  const markdown = renderMarkdown({ source, report, id: 'test', mode: 'live', createdAt: new Date().toISOString() });
  assert.ok(markdown.includes('视觉观察（需人工复核）')); assert.ok(markdown.includes('附录：图片与画板识别记录'));
  assert.ok(!JSON.stringify(source).includes('base64'));
});
test('单资源失败保留其他图片结果；关闭或文本模型不下载资源', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qa-visual-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const client = { visualRequest: async asset => { if (asset.kind === 'whiteboard') throw new Error('private details'); return { buffer: await png(), mime: 'image/png' }; } };
  const result = await enrichVisuals(doc(), { directory, taskId: 'task', client, config, analyzer: async () => ({ ...observation, readability: 'partial', uncertainties: ['小字模糊'] }) });
  assert.deepEqual([result.visualCoverage.total, result.visualCoverage.analyzed, result.visualCoverage.partial, result.visualCoverage.omitted], [2, 1, 1, 1]);
  assert.ok(!JSON.stringify(result).includes('private details'));
  for (const [enabled, vision] of [[false, true], [true, false]]) {
    const skipped = await enrichVisuals(doc(), { enabled, config: { llm: { ...config.llm, vision } }, client: { visualRequest: () => assert.fail('must not download') } });
    assert.equal(skipped.visualCoverage.analyzed, 0); assert.equal(skipped.visualCoverage.omitted, 2);
  }
});
test('资源下载只访问官方路径、使用当前用户凭据；403 可尝试官方预览且标记来源', async () => {
  const calls = [];
  const client = new FeishuClient({ getToken: async () => 'fresh-token', fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(new URL(url).origin, 'https://open.feishu.cn'); assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer fresh-token');
    return calls.length === 1 ? new Response('', { status: 403 }) : new Response(await png(), { headers: { 'content-type': 'image/png' } });
  } });
  const r = await client.visualRequest({ token: 'imageToken12345', kind: 'image' });
  assert.equal(r.rendition, 'preview'); assert.ok(calls[1].endsWith('/preview_download?preview_type=16'));
  await assert.rejects(client.visualRequest({ token: '../../secret', kind: 'image' }), /标识无效/);
  assert.equal(calls.length, 2);
});
test('资源下载限制流大小且不泄露上游错误中的凭据', async () => {
  const client = new FeishuClient({ token: 'secret', fetchImpl: async () => new Response('secret', { headers: { 'content-length': '20000000' } }) });
  await assert.rejects(client.visualRequest({ token: 'boardToken12345', kind: 'whiteboard' }), /大小上限/);
  client.config.fetchImpl = async () => Response.json({ code: 99991672, msg: 'private-token-secret' }, { status: 403 });
  await assert.rejects(client.visualRequest({ token: 'boardToken12345', kind: 'whiteboard' }), error => !error.message.includes('private-token-secret') && error.message.includes('99991672'));
});
test('画板结构仅提供必要文字和连线，不传用户标识；过大节点清单明确降级', () => {
  const result = boardNodeContext([{ id: 'n1', type: 'text_shape', text: { text: '确认' }, user_id: 'private-user', url: 'https://private.test' }]);
  assert.ok(result.text.includes('确认')); assert.ok(!result.text.includes('private'));
  assert.equal(boardNodeContext(Array.from({ length: 801 }, (_, i) => ({ id: `n${i}` }))).complete, false);
});

test('视觉缓存复用相同快照，但图片或模型变化、关闭缓存时重新分析，仍验证下载权限',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'qa-cache-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let buffer=await png(),downloads=0,calls=0;
 const source=parseSource('# 缓存验收\n这是用于验证视觉结果缓存的需求正文，包含一张原型图片。\n<image token="imageToken12345"/>');
 const client={visualRequest:async()=>{downloads++;return{buffer,mime:'image/png',rendition:'original'};}};
 const analyzer=async()=>{calls++;return structuredClone(observation);};
 const run=(id,c=config)=>enrichVisuals(source,{client,config:c,directory,taskId:id,analyzer});
 await run('first');const cached=await run('second');assert.equal(calls,1);assert.equal(downloads,2);assert.equal(cached.visualCoverage.cacheHits,1);
 buffer=await sharp({create:{width:80,height:60,channels:3,background:'#000'}}).png().toBuffer();await run('changed');assert.equal(calls,2);
 await run('model',{...config,llm:{...config.llm,model:'different'}});assert.equal(calls,3);
 await run('bypass',{...config,llm:{...config.llm,visualCache:false}});assert.equal(calls,4);
 const denied=await enrichVisuals(source,{client:{visualRequest:async()=>{throw new Error('denied');}},config,directory,taskId:'denied',analyzer});assert.equal(denied.visualCoverage.analyzed,0);assert.equal(calls,4);
});
