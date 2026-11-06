import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { FeishuClient, verifyPublished } from '../src/integrations.js';
import { DEMO_DOCUMENT } from '../src/review.js';

test('回读容忍飞书重排有序列表编号，但不忽略金额变化或缺失内容', () => {
  const markdown = '# 评审\n1. 首项\n2. 续费金额 $9.99\n3. 退款后回收号码';
  const content = '# 评审\n1. 首项\n1. 续费金额 $9.99\n1. 退款后回收号码';
  assert.equal(verifyPublished({ content }, {}, markdown), true);
  assert.throws(() => verifyPublished({ content: content.replace('$9.99', '$99.99') }, {}, markdown), /未通过回读/);
  assert.throws(() => verifyPublished({ content: content.replace('退款后回收号码', '') }, {}, markdown), /未通过回读/);
  assert.equal(verifyPublished({ content: '- 按钮：Continue ->，返回 <' }, {}, '- 按钮：Continue -&gt;，返回 &lt;'), true);
});
test('回读统计按完整行匹配，不接受数字前缀、分析段落引用或遗漏重复行', () => {
  const markdown = '## 版本统计\n- P0：1\n- 已关闭：2';
  assert.equal(verifyPublished({ content: '## 版本统计\n  1. **P0**：1\n  1. 已关闭：2' }, {}, markdown), true);
  for (const content of [
    markdown.replace('P0：1', 'P0：10'),
    markdown.replace('已关闭：2', '已关闭：20'),
    markdown.replace('- P0：1', '分析中曾提到 P0：1，实际值尚待确认'),
    markdown.replace('- P0：1\n- 已关闭：2', '- P0：1 已关闭：2'),
  ]) assert.throws(() => verifyPublished({ content }, {}, markdown), /未通过回读/);
  assert.throws(() => verifyPublished({ content: '- P0：1' }, {}, '- P0：1\n- P0：1'), /未通过回读/);
});
test('回读允许列表项和普通段落的软换行合并，仍严格保留内容与块边界', () => {
  const markdown = '# 图文评审\n\n- 观察：按钮显示 A &amp; B。\n局限：图片右侧部分模糊。\n\n说明第一行。\n说明第二行。\n\n## 统计\n- P0：1\n- P1：2';
  const content = '# 图文评审\n- 观察：按钮显示 A & B。局限：图片右侧部分模糊。\n\n说明第一行。说明第二行。\n\n## 统计\n- P0：1\n- P1：2';
  assert.equal(verifyPublished({ content }, {}, markdown), true);
  assert.equal(verifyPublished({ content: '## 说明\n独立段落一。\n独立段落二。' }, {}, '## 说明\n\n独立段落一。\n\n独立段落二。'), true);
  assert.equal(verifyPublished({ content: '- 首项。\n普通续行。' }, {}, '- 首项。普通续行。'), true);
  assert.throws(() => verifyPublished({ content: content.replace('图片右侧部分模糊', '图片全部清晰') }, {}, markdown), /未通过回读/);
  assert.throws(() => verifyPublished({ content: content.replace('P0：1', 'P0：10') }, {}, markdown), /未通过回读/);
  assert.throws(() => verifyPublished({ content: '- 首项。续行。' }, {}, '- 首项。\n\n续行。'), /未通过回读/);
  assert.throws(() => verifyPublished({ content: '- 首项。续行。' }, {}, '- 首项。  \n续行。'), /未通过回读/);
  assert.throws(() => verifyPublished({ content: '- 首项。续行。' }, {}, '- 首项。\n续行。\n\n- 首项。\n续行。'), /未通过回读/);
});
test('仅开头首个H1可由完全匹配的文档标题替代，正文已匹配时不重复补计', () => {
  const title = '版本报告 1.6.2', content = '生成时间：测试时间\n\n- P0：1';
  const markdown = `# ${title}\n\n${content}`;
  assert.equal(verifyPublished({ title, content }, {}, markdown), true);
  assert.equal(verifyPublished({ title, content }, {}, `\n${markdown}`), true);
  for (const wrongTitle of [undefined, '', '版本报告 1.6.20', '其他报告']) assert.throws(() => verifyPublished({ title: wrongTitle, content }, {}, markdown), /未通过回读/);
  assert.throws(() => verifyPublished({ title, content: content.replace('P0：1', 'P0：10') }, {}, markdown), /未通过回读/);
  assert.throws(() => verifyPublished({ title, content }, {}, `## ${title}\n\n${content}`), /未通过回读/);
  assert.throws(() => verifyPublished({ title, content }, {}, `${content}\n\n# ${title}`), /未通过回读/);
  const repeated = `# ${title}\n\n# ${title}\n\n${content}`;
  assert.throws(() => verifyPublished({ title, content: markdown }, {}, repeated), /未通过回读/);
  assert.throws(() => verifyPublished({ title, content }, {}, repeated), /未通过回读/);
});

test('真实 SDK 通过本地 MCP 协议桩发现工具、读取 wiki、创建报告并回读', async t => {
  let created = 0, report = '';
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    assert.equal(req.headers['x-lark-mcp-uat'], 'test-user-token');
    assert.equal(req.headers['x-lark-mcp-allowed-tools'], 'fetch-doc,create-doc');
    const chunks = []; for await (const c of req) chunks.push(c);
    const message = JSON.parse(Buffer.concat(chunks));
    if (message.id === undefined) { res.writeHead(202); return res.end(); }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-test-mcp', version: '1.0' } };
    else if (message.method === 'tools/list') result = { tools: [
      { name: 'fetch-doc', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' } }, required: ['doc_id'], additionalProperties: false } },
      { name: 'create-doc', inputSchema: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } }, required: ['title', 'markdown'], additionalProperties: false } },
    ] };
    else if (message.method === 'tools/call') {
      calls.push(message.params);
      const { name, arguments: args } = message.params;
      let data;
      if (name === 'fetch-doc') data = { title: DEMO_DOCUMENT.title, markdown: args.doc_id.includes('report123') ? report : DEMO_DOCUMENT.content };
      if (name === 'create-doc') { created++; report = args.markdown; data = { doc_url: 'https://team.feishu.cn/docx/report123' }; }
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new FeishuClient({ url: `http://127.0.0.1:${server.address().port}/mcp`, token: 'test-user-token', allowedHosts: '' });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); });
  const source = await client.fetchDocument('https://team.feishu.cn/wiki/node123');
  assert.equal(source.content, DEMO_DOCUMENT.content);
  assert.equal(calls[0].arguments.doc_id, 'https://team.feishu.cn/wiki/node123');
  const url = await client.createReport('测试报告', '# 评审报告\n' + DEMO_DOCUMENT.content);
  const back = await client.fetchDocument(url);
  assert.ok(back.content.startsWith('# 评审报告')); assert.equal(created, 1);
  await assert.rejects(client.call('create-doc', { title: '没有正文' }), /schema/);
  assert.equal(created, 1);
});

test('MCP 截断内容不支持分页时明确拒绝，不进行部分评审', async () => {
  const client = new FeishuClient({ allowedHosts: '' });
  client.connect = async () => {}; client.schema = () => ({ properties: { doc_id: {} } });
  client.call = async () => ({ markdown: DEMO_DOCUMENT.content, has_more: true });
  await assert.rejects(client.fetchDocument('https://team.feishu.cn/docx/abc'), /截断/);
});

test('MCP 有 offset schema 时合并分页，继续核验完整长度', async () => {
  const client = new FeishuClient({ allowedHosts: '' });
  client.connect = async () => {}; client.schema = () => ({ properties: { doc_id: {}, offset: {} } });
  client.call = async (_name, args) => args.offset === 0 ? { markdown: DEMO_DOCUMENT.content.slice(0, 100), next_offset: 100, total_length: DEMO_DOCUMENT.content.length } : { markdown: DEMO_DOCUMENT.content.slice(100), total_length: DEMO_DOCUMENT.content.length };
  const source = await client.fetchDocument('https://team.feishu.cn/docx/abc');
  assert.equal(source.content, DEMO_DOCUMENT.content);
});

test('OAuth MCP 每次请求读取最新 Token，刷新后不会继续发送旧凭据', async t => {
  let current = 'oauth-token-one', tokenReads = 0;
  const seen = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    seen.push(req.headers['x-lark-mcp-uat']);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['x-lark-mcp-uat'], current);
    const chunks = []; for await (const c of req) chunks.push(c);
    const message = JSON.parse(Buffer.concat(chunks));
    if (message.id === undefined) { res.writeHead(202); return res.end(); }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'oauth-test-mcp', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'fetch-doc', inputSchema: { type: 'object', properties: { doc_id: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: JSON.stringify({ markdown: DEMO_DOCUMENT.content }) }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new FeishuClient({ url: `http://127.0.0.1:${server.address().port}/mcp`, token: 'old-static', bearer: 'old-bearer', allowedHosts: '', getToken: async () => { tokenReads++; return current; } });
  t.after(async () => { await client.close(); await new Promise(resolve => server.close(resolve)); });
  await client.connect(); current = 'oauth-token-two';
  const source = await client.fetchDocument('https://team.feishu.cn/docx/abc');
  assert.equal(source.content, DEMO_DOCUMENT.content);
  assert.equal(seen.at(-1), 'oauth-token-two'); assert.ok(tokenReads >= 3);
});
