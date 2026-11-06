import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_DOCUMENT, parseSource, demoReview, validateReview, renderMarkdown, MAX_DOCUMENT_CHARS } from '../src/review.js';
import { parseFeishuUrl, unpackToolResult, modelReview, verifyPublished } from '../src/integrations.js';

const source = parseSource(DEMO_DOCUMENT.content, DEMO_DOCUMENT.title);
const raw = () => demoReview(source);
const config = { llm: { mode: 'responses', baseUrl: 'https://api.example.com/v1', key: 'test-secret', model: 'test-model', timeout: 1000 } };

test('演示报告覆盖八维，所有引用可追溯，问题有稳定分级', () => {
  const report = validateReview(raw(), source);
  assert.equal(report.issues.length, 8);
  assert.equal(report.validation.verified, 8);
  assert.deepEqual(report.counts, { P0: 2, P1: 3, P2: 3 });
  assert.equal(new Set(report.issues.map(i => i.dimension)).size, 8);
});
test('伪造引用强制降级为待澄清，不允许保留确定性 P0 缺陷', () => {
  const response = raw(); response.issues[0].quote = '原文不存在的内容';
  const report = validateReview(response, source);
  const issue = report.issues.find(i => i.title.startsWith('待核实：'));
  assert.equal(issue.category, 'clarification'); assert.equal(issue.evidenceType, 'question');
  assert.equal(issue.priority, 'P2'); assert.equal(issue.quote, ''); assert.equal(issue.sourceBlockId, null);
  assert.ok(issue.confidence < 0.5); assert.equal(report.validation.downgraded, 1);
});
test('不允许用一个常见字伪造有效证据', () => {
  const response = raw(); response.issues[0].quote = '的';
  assert.equal(validateReview(response, source).validation.downgraded, 1);
});
test('去重保留一次问题，并统计丢弃数', () => {
  const response = raw(); response.issues.push({ ...response.issues[0] });
  const report = validateReview(response, source);
  assert.equal(report.issues.length, 8); assert.equal(report.validation.duplicates, 1);
});
test('模型结构错误不能被伪装成成功报告', () => {
  const response = raw(); response.issues[0].priority = 'CRITICAL';
  assert.throws(() => validateReview(response, source), /结构/);
  assert.throws(() => validateReview({ summary: 'OK', issues: [{}] }, source), /结构/);
});
test('空文档、超长文档明确拒绝；附件未覆盖清晰标记', () => {
  assert.throws(() => parseSource('不足30字'), /至少/);
  assert.throws(() => parseSource('a'.repeat(MAX_DOCUMENT_CHARS + 1)), /最多/);
  assert.equal(parseSource(DEMO_DOCUMENT.content + '\n![流程图](private.png)\n<whiteboard id="1"/>').unsupported.length, 2);
});
test('未命中规则不能自动给出通过结论', () => {
  const other = parseSource('这是一个图书检索项目。读者能够通过书名检索库存书籍，并按作者过滤显示结果。');
  const report = validateReview(demoReview(other), other);
  assert.equal(report.issues[0].category, 'clarification');
  assert.notEqual(report.conclusion, '通过');
});
test('导出报告包含八章节、原文指纹、证据与人工状态', () => {
  const task = { id: 'test-id', createdAt: new Date().toISOString(), mode: 'demo', source, report: validateReview(raw(), source) };
  task.report.issues[0].status = 'accepted';
  const markdown = renderMarkdown(task);
  assert.equal(markdown.match(/^## /gm).length, 8);
  assert.ok(markdown.includes(source.fingerprint)); assert.ok(markdown.includes('已采纳'));
  assert.ok(markdown.includes('演示模式')); assert.ok(markdown.includes('QA-test-id'));
  assert.equal(verifyPublished(parseSource(markdown), task, markdown), true);
  assert.throws(() => verifyPublished(parseSource(markdown.replace('退款申请时限存在冲突', '缺失段落')), task, markdown), /回读/);
});
test('链接校验拒绝伪造域名、认证信息、端口与未知类型', () => {
  for (const url of ['https://feishu.cn.evil.com/docx/a', 'http://a.feishu.cn/docx/a', 'https://u:p@a.feishu.cn/docx/a', 'https://a.feishu.cn:9443/docx/a', 'https://127.0.0.1/docx/a', 'https://a.feishu.cn/sheets/a']) assert.throws(() => parseFeishuUrl(url));
  assert.equal(parseFeishuUrl('https://team.feishu.cn/wiki/abc?from=copy#anchor').url, 'https://team.feishu.cn/wiki/abc');
  assert.throws(() => parseFeishuUrl('https://a.feishu.cn/docx/a', 'b.feishu.cn'));
});
test('MCP 业务错误不能作为正文参与评审', () => {
  assert.throws(() => unpackToolResult({ isError: true }));
  assert.throws(() => unpackToolResult({ content: [{ type: 'text', text: '{"code":99991400,"msg":"denied"}' }] }));
  assert.deepEqual(unpackToolResult({ content: [{ type: 'text', text: '{"markdown":"正文"}' }] }), { markdown: '正文' });
});
test('Responses 请求关闭服务端存储并限定结构化 schema', async () => {
  let sent;
  const result = await modelReview(source, config, async (url, init) => {
    sent = JSON.parse(init.body); assert.equal(url.pathname, '/v1/responses'); assert.equal(init.redirect, 'error');
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(raw()) }] }] });
  });
  assert.equal(sent.store, false); assert.equal(sent.text.format.strict, true);
  assert.ok(sent.instructions.includes('不可信数据')); assert.equal(result.issues.length, 8);
});
test('模型限流、输出截断、拒绝均不生成虚假报告，错误不泄露凭据', async () => {
  await assert.rejects(modelReview(source, config, async () => new Response('test-secret', { status: 429 })), /限流/);
  await assert.rejects(modelReview(source, config, async () => Response.json({ status: 'incomplete' })), /未完成/);
  await assert.rejects(modelReview(source, config, async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] })), /拒绝/);
});
test('兼容模式发送 chat 结构化请求，并校验 finish_reason', async () => {
  const chat = { llm: { ...config.llm, mode: 'chat' } };
  const result = await modelReview(source, chat, async (url, init) => {
    assert.equal(url.pathname, '/v1/chat/completions'); assert.equal(JSON.parse(init.body).response_format.type, 'json_schema');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw()) } }] });
  });
  assert.equal(result.issues.length, 8);
  await assert.rejects(modelReview(source, chat, async () => Response.json({ choices: [{ finish_reason: 'length' }] })), /截断/);
});
