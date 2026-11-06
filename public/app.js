import { createWorkspace } from './workspace.js';
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icons = {
  check: '<path d="m5 12 4 4L19 6"/>', grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/>', rules: '<path d="M8 3h8v4H8zM8 5H5v16h14V5h-3M8 12h8M8 16h5"/>', settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 4a4 4 0 0 1 6 0l-5 5a4 4 0 0 1-6 0" transform="translate(2 1)"/>',
  file: '<path d="M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 12h8M8 16h6"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3ZM20 2v4m-2-2h4"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>',
  external: '<path d="M14 3h7v7M10 14 21 3M10 3H3v18h18v-7"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>', plus: '<path d="M12 5v14M5 12h14"/>', alert: '<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01"/>', layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
};
const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
const date = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const categoryNames = { unreasonable: '不合理需求', missing: '缺失需求', risk: '潜在风险', implicit: '隐性需求', clarification: '待澄清' };
const statusNames = { queued: '排队中', reading: '读取中', reviewing: '评审中', validating: '校验中', publishing: '写入中', completed: '已完成', failed: '未完成' };
const state = { login: null, config: null, tasks: [], selected: null, draft: { url: '', autoPublish: false, includeVisuals: true }, priority: 'all', category: 'all', query: '', historyQuery: '', evidence: null, busy: false, error: '', poll: null };

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (response.status === 401 && data.code === 'WORKSPACE_LOGIN_REQUIRED' && state.login?.authenticated) location.reload();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}
function route() { return location.hash.slice(1) || 'home'; }
function navigate(to) { if (route() === to) render(); else location.hash = to; }

function destination(value) {
  return /^(home|cases|bugs|history|runs|costs|standards|settings|(review|run)\/[a-f0-9-]{36})$/.test(value) ? value : 'home';
}
function loginPage() {
  const { configured, error, redirectOrigin } = state.login;
  const wrongOrigin = configured && redirectOrigin && location.origin !== redirectOrigin;
  return `<main class="login-page"><section class="login-card" aria-labelledby="login-title">
    <div class="brand"><span class="brand-icon">${icon('check', 25)}</span><span>清晰<span class="brand-en">CLARITY</span></span></div>
    <h1 id="login-title">登录 QA 工作台</h1>
    <p>使用飞书账号登录，即可评审需求、生成测试用例和版本测试报告。</p>
    ${error ? `<p class="auth-error" role="alert">${escape(error)}</p>` : ''}
    ${wrongOrigin ? `<a class="button primary" href="${escape(redirectOrigin)}/">在已配置的回调地址登录 ${icon('arrow', 16)}</a>` : `<button class="button primary" data-action="login-feishu" ${configured ? '' : 'disabled'}>使用飞书登录 ${icon('arrow', 16)}</button>`}
    <small>${configured ? '请使用自己的飞书账号。首次登录会将本地工作台绑定到该账号。' : '请先在本地 .env 配置飞书 App ID、App Secret 和回调地址，重启服务后刷新此页。'}</small>
  </section></main>`;
}
function shell(content) {
  const page = route().split('/')[0];
  return `<aside class="sidebar">
    <a href="#home" class="brand"><span class="brand-icon">${icon('check', 25)}</span><span>清晰<span class="brand-en">CLARITY</span></span></a>
    <div class="workspace"><span class="workspace-avatar">Q</span><span>QA 工作空间<small>本地 MVP</small></span><span class="workspace-dot"></span></div>
    <div class="nav-label">工作空间</div>
    <nav aria-label="主导航">${[['home', 'grid', '评审工作台'], ['cases', 'layers', '生成测试用例'], ['bugs', 'file', '版本测试报告'], ['history', 'history', '任务记录'], ['runs', 'check', '测试执行'], ['costs', 'clock', '成本台账'], ['standards', 'rules', '评审标准'], ['settings', 'settings', '连接设置']].map(([id, glyph, label]) => `<a href="#${id}" class="nav-item ${page === id || page === 'review' && id === 'history' ? 'active' : ''}">${icon(glyph)}<span>${label}</span>${id === 'history' ? `<span class="nav-count">${state.tasks.length}</span>` : ''}</a>`).join('')}</nav>
    <div class="sidebar-bottom"><div class="sidebar-note">${icon('shield', 22)}<strong>先有证据，再下结论</strong><p>每一条评审意见，都应该<br>有据可依、值得讨论。</p></div><div class="profile"><div class="avatar">QA</div><div>${escape(state.login?.user?.name)}<small><span class="tiny-dot"></span> 飞书已登录</small></div><span class="version">v0.1</span></div></div>
  </aside>
  <div class="app-body"><header class="topbar"><div class="breadcrumb">工作空间 ${icon('chevron', 13)} <span>${({ home: '评审工作台', cases: '生成测试用例', bugs: '版本测试报告', history: '评审记录', runs: '测试执行', run: '执行计划', costs: '成本台账', review: '评审报告', standards: '评审标准', settings: '连接设置' })[page] || '工作台'}</span></div><div class="topbar-right"><span class="local-badge"><span class="tiny-dot"></span> 本地运行</span><span class="header-divider"></span><a href="#settings" class="connection-link">${icon('settings', 16)} 连接设置</a><button class="connection-link" data-action="logout-feishu">退出登录</button></div></header><main id="main">${content}</main><footer>清晰 · 需求评审 Agent <span>让问题更早被发现，让讨论更有依据。</span></footer></div>`;
}

function metrics() {
  const complete = state.tasks.filter(t => t.status === 'completed' && (!t.kind || t.kind === 'review'));
  const total = complete.reduce((sum, t) => sum + t.issueCount, 0);
  const high = complete.reduce((sum, t) => sum + (t.counts?.P0 || 0), 0);
  return `<div class="metrics">${[['file', '已完成评审', complete.length, '份需求'], ['layers', '发现评审意见', total, '条意见'], ['alert', '关键优先级', high, '条 P0'], ['shield', '评审维度', '08', '个视角']].map(([glyph, label, number, suffix]) => `<div class="metric"><span class="metric-icon ${glyph}">${icon(glyph, 20)}</span><div><span class="metric-label">${label}</span><div class="metric-number">${number}<small>${suffix}</small></div></div></div>`).join('')}</div>`;
}

function formSource() {
  return `<label class="field-label" for="document-url">飞书需求文档链接</label><div class="input-icon">${icon('link', 18)}<input id="document-url" name="url" type="url" placeholder="https://your-team.feishu.cn/docx/… 或 /wiki/…" value="${escape(state.draft.url)}" required></div><p class="field-help">支持新版云文档和 Wiki 知识库链接。仅访问当前授权身份有权读取的文档。</p>`;
}

const qaDraft = { cases: { url: '', parentUrl: '', targetMindnoteUrl: '', destinationMode: 'wiki', includeVisuals: true, autoPublish: false }, bugs: { url: '', version: '', tableId: '', mapping: {}, closed: '', autoPublish: false }, schema: null };
const kindLabel = kind => ({ cases: '生成测试用例', bugs: '版本测试报告', review: '需求评审' })[kind] || '需求评审';
function qaForm(kind) {
  const d = qaDraft[kind];
  const input = (name, label, placeholder, type = 'text') => `<label class="field-label" for="qa-${name}">${label}</label><input id="qa-${name}" name="${name}" type="${type}" placeholder="${placeholder}" value="${escape(d[name])}" required>`;
  const fields = qaDraft.schema?.fields || [];
  const mappings = [['version', '版本字段', true], ['title', '缺陷标题', true], ['status', '缺陷状态', true], ['severity', '严重程度', true], ['module', '所属模块', false], ['description', '缺陷描述', false]];
  return `<div class="page-heading"><div><div class="eyebrow">QA WORKFLOWS</div><h1>${kindLabel(kind)}</h1><p>${kind === 'cases' ? '从需求正文、原型图和流程图生成用例，发布为原生飞书思维笔记。' : '按指定版本分析 BugList，生成可追溯的飞书云文档报告。'}</p></div></div><section class="panel qa-form-panel"><form id="qa-form" data-kind="${kind}">
  ${input('url', kind === 'cases' ? '飞书需求文档链接' : 'BugList 多维表格链接', kind === 'cases' ? 'https://…/wiki/… 或 /docx/…' : 'https://…/base/…?table=tbl…', 'url')}
  ${kind === 'cases' ? `<label class="field-label" for="qa-destinationMode">发布方式</label><select id="qa-destinationMode" name="destinationMode"><option value="wiki" ${d.destinationMode !== 'existing' ? 'selected' : ''}>在知识库节点下新建思维笔记</option><option value="existing" ${d.destinationMode === 'existing' ? 'selected' : ''}>写入已有原生思维笔记</option></select>${d.destinationMode === 'existing' ? input('targetMindnoteUrl', '原生思维笔记链接', 'https://…/mindnotes/… 或 /wiki/…', 'url') : input('parentUrl', '知识库父节点链接', 'https://…/wiki/…', 'url')}<p class="field-help">${d.destinationMode === 'existing' ? '可先在飞书所需位置新建空白原生思维笔记，再粘贴链接。用例作为独立任务分支写入，保留原有内容。' : '在此节点下创建独立的原生思维笔记，需要该节点的子节点创建权限。'}步骤、预期和证据放在用例节点备注中。</p><label class="checkbox-label"><input name="includeVisuals" type="checkbox" ${d.includeVisuals ? 'checked' : ''}> 分析图片和画板（增加模型调用时间）</label>` : `<p class="field-help">使用数据表链接；统计整个数据表中当前用户可见记录，忽略视图筛选，版本采用精确匹配。</p><button class="button secondary" type="button" data-action="base-schema" ${state.busy ? 'disabled' : ''}>${state.busy ? '正在读取…' : '读取数据表和字段'}</button>${qaDraft.schema ? `<label class="field-label" for="qa-table">BugList 数据表</label><select name="tableId" id="qa-table"><option value="">请选择数据表</option>${qaDraft.schema.tables.map(t => `<option value="${escape(t.table_id)}" ${t.table_id === d.tableId ? 'selected' : ''}>${escape(t.name)}</option>`).join('')}</select>` : ''}${fields.length ? `<h2>确认字段映射</h2><div class="qa-field-grid">${mappings.map(([key, label, required]) => `<div><label class="field-label" for="map-${key}">${label}${required ? '' : '（可选）'}</label><select id="map-${key}" data-map="${key}" ${required ? 'required' : ''}><option value="">请选择字段</option>${fields.filter(f => key === 'version' ? [1, 3, 4].includes(f.type) : [1, 3].includes(f.type)).map(f => `<option value="${escape(f.field_name)}" ${d.mapping[key] === f.field_name ? 'selected' : ''}>${escape(f.field_name)}</option>`).join('')}</select></div>`).join('')}</div>${input('version', '要分析的版本（精确值）', '例如：v2.1.0')}${input('closed', '代表已关闭的状态（多个值用中文逗号分隔）', '例如：已关闭，Closed')}<p class="field-help">状态选项：${(fields.find(f => f.field_name === d.mapping.status)?.property?.options || []).map(o => escape(o.name)).join('、') || '请按表内实际状态填写'}。已解决不自动等于已关闭；只提供 BugList 时不会计算测试通过率。</p>` : ''}`}
  <label class="checkbox-label"><input name="autoPublish" type="checkbox" ${d.autoPublish ? 'checked' : ''}> 生成后自动发布到飞书${kind === 'cases' ? '思维笔记' : '云文档'}</label>
  <p class="field-help">内容会发送到当前配置模型：${escape(state.config.model.name || '尚未配置')}。生成结果需人工确认。</p>
  ${state.config.feishu.oauth.missingQaScopes?.length ? `<div class="inline-notice"><span>新功能需要补充飞书用户权限：${state.config.feishu.oauth.missingQaScopes.map(escape).join('、')}。在后台发布后前往<a href="#settings">连接设置重新授权</a>。</span></div>` : ''}
  ${state.error ? `<div class="error-box" role="alert">${escape(state.error)}</div>` : ''}<div class="form-bottom"><a class="text-button" href="#history">任务记录</a><button class="button primary" type="submit" ${state.busy || kind === 'bugs' && !fields.length ? 'disabled' : ''}>${state.busy ? '处理中…' : kind === 'cases' ? '生成测试用例' : '生成版本报告'}</button></div></form></section>`;
}
async function loadBaseSchema(tableId = '') {
  if (state.busy) return;
  state.busy = true; state.error = ''; render();
  try {
    const data = await api('/qa/base-schema', { method: 'POST', body: JSON.stringify({ url: qaDraft.bugs.url, tableId }) });
    qaDraft.schema = data; qaDraft.bugs.tableId = data.tableId; qaDraft.bugs.mapping = {};
    for (const [key, names] of Object.entries({ version: ['版本', '版本号', '影响版本', '发现版本'], title: ['标题', '缺陷标题', 'Bug标题', '问题描述'], status: ['状态', '缺陷状态', '当前状态'], severity: ['严重程度', '严重级别', '优先级'], module: ['模块', '所属模块'], description: ['描述', '缺陷描述', '备注'] })) {
      qaDraft.bugs.mapping[key] = data.fields.find(f => names.includes(f.field_name))?.field_name || '';
    }
  } catch (e) { qaDraft.schema = null; qaDraft.bugs.tableId = ''; state.error = e.message; }
  finally { state.busy = false; render(); }
}
function qaReport(task) {
  const r = { ...task.report, limitations: task.report.limitations.filter(l => !task.execution || !l.startsWith('没有测试执行数据，无法计算')) }, cases = task.kind === 'cases';
  return `<a class="back-link" href="#history">← 返回任务记录</a><div class="page-heading"><div><div class="eyebrow">${kindLabel(task.kind)}</div><h1>${escape(task.title)}</h1><p>${escape(r.conclusion)}</p></div><div class="report-buttons"><a class="button secondary" href="/api/tasks/${task.id}/export?format=markdown">导出 Markdown</a><a class="button secondary" href="/api/tasks/${task.id}/export?format=json">JSON</a>${task.publish.status !== 'published' ? `<button class="button primary" data-action="publish" ${task.status === 'publishing' || ['uncertain', 'creating'].includes(task.publish.status) ? 'disabled' : ''}>${task.publish.url ? '继续写入与核验' : cases ? '发布原生思维笔记' : '创建飞书云文档'}</button>` : ''}</div></div>${publishStatus(task)}
  ${cases && !task.publish.url ? `<section class="panel qa-summary"><label class="field-label" for="publish-mode">思维笔记发布方式</label><select id="publish-mode"><option value="wiki" ${!task.options?.targetMindnoteUrl ? 'selected' : ''}>在知识库节点下新建</option><option value="existing" ${task.options?.targetMindnoteUrl ? 'selected' : ''}>写入已有原生思维笔记</option></select><div id="publish-wiki-fields" ${task.options?.targetMindnoteUrl ? 'hidden' : ''}><label class="field-label" for="publish-parent">知识库父节点链接</label><input id="publish-parent" type="url" value="${escape(task.options?.parentUrl || '')}" style="width:100%"></div><div id="publish-existing-fields" ${!task.options?.targetMindnoteUrl ? 'hidden' : ''}><label class="field-label" for="publish-target">原生思维笔记链接</label><input id="publish-target" type="url" value="${escape(task.options?.targetMindnoteUrl || '')}" placeholder="https://…/mindnotes/… 或 /wiki/…" style="width:100%"></div><p class="field-help">已有笔记会新增独立用例分支，保留原有内容；新建笔记需要知识库父节点的创建子节点权限。</p></section>` : ''}
  <section class="panel qa-summary"><h2>${cases ? `${r.cases.length} 条测试用例 · ${r.cases.filter(c => c.needsConfirmation).length} 条需澄清` : `版本 ${escape(task.source.version)} · ${r.stats.total} 条缺陷`}</h2><p>${escape(r.summary)}</p>${cases ? '' : `<p>已关闭 ${r.stats.closed} · 其他状态 ${r.stats.unclosed} · 关闭定义：${r.stats.closedStatuses.map(escape).join('、')}</p><p class="field-help">读取时间：${date(task.source.fetchedAt)} · 可见记录扫描 ${task.source.scanned} 条 · 版本字段 ${escape(task.source.mapping.version)}</p>`}<details><summary>数据范围与局限</summary>${r.limitations.map(l => `<p>${escape(l)}</p>`).join('')}</details></section>
  ${cases ? `<details class="panel qa-summary"><summary>${escape(coverageText(task.source))}</summary>${visualResources(task)}</details><section class="panel qa-summary"><h2>用例树预览</h2><p class="field-help">发布后在飞书原生思维笔记中展开模块，点击用例备注查看步骤与预期。以下用例尚未执行。</p>${[...new Set(r.cases.map(c => c.module))].map(module => `<details open class="qa-module"><summary>${escape(module)}</summary>${r.cases.filter(c => c.module === module).map(c => `<details class="qa-case"><summary><span class="priority ${c.priority.toLowerCase()}">${c.priority}</span> ${c.id} · ${escape(c.title)} ${c.needsConfirmation ? '<span class="tag">待确认</span>' : ''}</summary><p>类型：${escape(c.category)}</p><p>前置：${escape(c.preconditions)}</p><ol>${c.steps.map(s => `<li><strong>${escape(s.action)}</strong><p>预期：${escape(s.expected)}</p></li>`).join('')}</ol><p class="field-help">依据：${escape(c.quote)} · ${escape(c.location)} · ${c.evidence === 'text' ? '正文引用已定位' : '待复核'}</p>${c.assumptions.map(a => `<p class="visual-warning">待确认：${escape(a)}</p>`).join('')}</details>`).join('')}</details>`).join('')}</section>` : `<div class="qa-field-grid">${[['byStatus', '状态分布'], ['bySeverity', '严重程度'], ['byModule', '模块分布']].map(([key, label]) => `<section class="panel qa-summary"><h2>${label}</h2>${Object.entries(r.stats[key]).map(([k, v]) => `<p>${escape(k)} <strong>${v}</strong></p>`).join('')}</section>`).join('')}</div><section class="panel qa-summary"><h2>AI 风险分析 · 待人工确认</h2>${r.risks.map(risk => `<article class="qa-case"><h3>${escape(risk.title)}</h3><p>${escape(risk.analysis)}</p><p>建议：${escape(risk.recommendation)}</p><p class="field-help">缺陷依据：${risk.recordIds.map(escape).join('、')}</p></article>`).join('') || '<p>模型未提出额外风险，不代表版本可发布。</p>'}<details><summary>缺陷快照明细</summary>${task.source.records.map(b => `<p>${escape(b.id)} · ${escape(b.title)} · ${escape(b.status)} · ${escape(b.severity)}</p>`).join('')}</details></section>`}`;
}

function home() {
  return `<div class="page-heading"><div><div class="eyebrow">REQUIREMENT REVIEW</div><h1>需求评审工作台</h1><p>在开发之前，发现值得讨论的问题。</p></div><span class="page-tag">${icon('spark', 15)} Evidence first</span></div>
  ${metrics()}
  <div class="start-grid"><section class="panel start-panel"><div class="panel-heading"><div><h2>开始一次新的评审</h2><p>从一份需求开始，让遗漏、冲突和风险浮出水面。</p></div><span class="step-label">01 — 03</span></div>
  <form id="review-form"><div class="source-body">${formSource()}
  <p class="field-help">正文及所选图片、画板将发送到当前模型：${escape(state.config.model.name || '尚未配置')}。</p>
  ${!state.config.model.configured || !state.config.feishu.configured ? `<div class="inline-notice">${icon('info', 17)}<span>${!state.config.model.configured ? '请先配置 AI 模型。' : ''}${!state.config.feishu.configured ? '请先完成飞书授权。' : ''}<a href="#settings">前往连接设置</a></span></div>` : ''}
  <label class="checkbox-label"><input type="checkbox" name="includeVisuals" ${state.draft.includeVisuals !== false ? 'checked' : ''}> 分析图片、原型图与画板流程图</label><p class="field-help">每份最多识别 24 个资源；长图分片，视觉观察需人工复核。${!state.config.model.vision ? '当前模型未启用视觉输入，图片会标为未覆盖，请查看连接设置。' : '将增加模型调用次数与评审时间。'}</p>
  <label class="checkbox-label"><input type="checkbox" name="autoPublish" ${state.draft.autoPublish ? 'checked' : ''} ${!state.config.feishu.configured ? 'disabled' : ''}> 评审完成后创建独立飞书报告</label>
  </div>${state.error ? `<div class="error-box" role="alert">${icon('alert', 18)} ${escape(state.error)}</div>` : ''}
  <div class="form-bottom"><span>${icon('shield', 15)} 保留原始需求，生成独立报告</span><button type="submit" class="button primary" ${state.busy || !state.config.model.configured || !state.config.feishu.configured || state.config.feishu.oauth.pending ? 'disabled' : ''}>${icon('spark', 17)} ${state.busy ? '正在创建…' : '开始评审'} ${icon('arrow', 17)}</button></div></form></section>
  <aside class="review-guide"><div class="guide-orbit">${icon('layers', 29)}<span class="orbit-point"></span></div><span class="guide-eyebrow">A SECOND PAIR OF EYES</span><h2>一份需求，<br>八个评审视角。</h2><p>从业务目标到验收标准，<br>把隐含的假设，变成明确的问题。</p><div class="dimension-grid">${state.config.dimensions.map(d => `<span>${icon('check', 13)}${d}</span>`).join('')}</div><div class="guide-footer"><span>原文依据</span><span>问题分级</span><span>修改建议</span></div></aside></div>
  <section class="panel recent-panel"><div class="panel-heading"><div class="heading-inline"><h2>最近评审</h2><span class="count-tag">${state.tasks.length}</span></div><a href="#history" class="text-button">全部记录 ${icon('arrow', 16)}</a></div>${taskTable(state.tasks.slice(0, 4))}</section>
  <div class="workflow"><span>你的评审流程</span>${[['01', '读取需求'], ['02', '多维分析'], ['03', '证据核验'], ['04', '生成报告']].map(([n, t], i) => `<div><b>${n}</b>${t}</div>${i < 3 ? icon('chevron', 13) : ''}`).join('')}</div>`;
}

function taskTable(tasks) {
  if (!tasks.length) return `<div class="empty-state">${icon('file', 32)}<div><strong>${state.historyQuery ? '没有找到匹配的评审' : '第一份评审，从这里开始'}</strong><p>${state.historyQuery ? '试试其他关键词，或清空搜索条件。' : '完成评审后，报告会保存在这里，随时回看与导出。'}</p></div>${!state.historyQuery ? '<a class="text-button" href="#home">开始新评审 →</a>' : ''}</div>`;
  return `<div class="table-scroll"><table><thead><tr><th>任务名称</th><th>任务类型</th><th>生成结果</th><th>状态</th><th>创建时间</th><th><span class="sr-only">查看</span></th></tr></thead><tbody>${tasks.map(t => `<tr><td><a href="#review/${t.id}" class="task-title"><span class="doc-icon">${icon('file', 18)}</span>${escape(t.title)}</a></td><td><span class="tag ${t.mode === 'demo' ? 'demo' : ''}">${t.mode === 'demo' ? '演示模式' : kindLabel(t.kind)}</span></td><td>${t.kind === 'cases' ? `${t.caseCount} 条用例` : t.kind === 'bugs' ? `${t.bugCount} 条缺陷` : t.counts ? `<span class="mini-priority p0">${t.counts.P0}</span><span class="mini-priority p1">${t.counts.P1}</span><span class="mini-priority p2">${t.counts.P2}</span>` : '<span class="muted">—</span>'}</td><td><span class="status ${t.status}"><i></i>${statusNames[t.status]}</span></td><td class="date-cell">${date(t.createdAt)}</td><td><a href="#review/${t.id}" class="icon-link" aria-label="查看${escape(t.title)}">${icon('chevron', 17)}</a></td></tr>`).join('')}</tbody></table></div>`;
}

function historyPage() {
  const tasks = state.tasks.filter(t => `${t.title} ${t.id}`.toLowerCase().includes(state.historyQuery.toLowerCase()));
  return `<div class="page-heading"><div><div class="eyebrow">REVIEW LIBRARY</div><h1>评审记录</h1><p>每一次发现，都有迹可循。</p></div><a class="button primary" href="#home">${icon('plus', 17)} 新建评审</a></div><section class="panel"><div class="panel-heading"><h2>全部评审 <span class="count-tag">${state.tasks.length}</span></h2><div class="input-icon search-input">${icon('search', 17)}<input id="history-search" aria-label="搜索评审" placeholder="搜索需求名称…" value="${escape(state.historyQuery)}"></div></div><div id="history-table">${taskTable(tasks)}</div></section>`;
}

function progress(task) {
  const steps = [['reading', task.kind === 'bugs' ? '读取 BugList' : '读取需求', '获取数据与覆盖范围'], ['reviewing', task.kind === 'cases' ? '生成用例' : task.kind === 'bugs' ? '分析缺陷' : '多维评审', task.mode === 'demo' ? '本地规则检查' : 'AI 分析来源内容'], ['validating', '校验证据', '来源引用与数据核验'], ['completed', '生成结果', '可预览、导出或发布到飞书']];
  const index = ['queued', 'reading', 'reviewing', 'validating', 'publishing', 'completed'].indexOf(task.status);
  return `<div class="page-heading"><div><div class="eyebrow">REVIEW IN PROGRESS</div><h1>${escape(task.title)}</h1><p>${escape(task.stage)}</p></div><a href="#home" class="text-button">返回工作台</a></div><section class="panel progress-panel"><div class="progress-symbol ${task.status === 'failed' ? 'failed' : ''}">${icon(task.status === 'failed' ? 'alert' : 'spark', 32)}</div><h2>${task.status === 'failed' ? '这次任务未能完成' : task.kind === 'bugs' ? '正在分析版本缺陷' : '正在认真阅读你的需求'}</h2><p>${task.status === 'failed' ? escape(task.error) : '你可以离开此页面，任务会继续在后台运行。'}</p><div class="progress-steps">${steps.map(([s, title, subtitle], i) => `<div class="progress-step ${index > i + 1 ? 'done' : ''}"><span>${index > i + 1 ? icon('check', 18) : i + 1}</span><strong>${title}</strong><small>${subtitle}</small></div>`).join('')}</div>${task.status === 'failed' ? '<button class="button primary" data-action="retry-task">重新发起评审</button>' : ''}<details class="task-log"><summary>任务执行记录</summary>${task.events.map(e => `<p><time>${date(e.time)}</time>${escape(e.text)}</p>`).join('')}</details></section>`;
}

function coverageText(source) {
  const v = source.visualCoverage;
  return v ? `正文 ${source.characterCount.toLocaleString()} 字符 · 图像 ${v.analyzed}/${v.total} 个已识别 · ${v.partial} 个部分可辨认 · ${v.omitted} 个未纳入` : '仅评审提取的文本；图片与附件未展开。';
}
function visualResources(task) {
  if (!task.source.visuals?.length) return '';
  const names = { analyzed: '已识别 · 待人工复核', partial: '部分可辨认', unreadable: '无法辨认', failed: '读取/识别失败', skipped: '未读取' };
  return `<section class="panel visual-resources"><h2>原型图与流程图</h2><p>${escape(coverageText(task.source))}</p><p class="field-help">图像识别不是逐字证据校验；点击资源查看快照、识别位置与不确定信息。</p><div class="visual-grid">${task.source.visuals.map(a => `<details class="visual-card"><summary><strong>${a.id} · ${a.kind === 'whiteboard' ? '画板/流程图' : '图片/原型图'}</strong><span>${names[a.status] || '处理中'}${a.cacheHit ? ' · 复用分析缓存' : ''}</span><small>${escape(a.references.map(r => `${r.section} · 第 ${r.line} 行`).join('；'))}</small></summary>${a.preview ? `<p class="field-help">${a.rendition === 'original' ? '原图' : a.kind === 'whiteboard' ? '画板预览' : '图片预览版本'} · ${a.width} × ${a.height}</p>` : ''}${a.preview ? `<a href="/api/tasks/${task.id}/visuals/${a.id}.png" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="/api/tasks/${task.id}/visuals/${a.id}.png" alt="${a.id} ${a.kind === 'whiteboard' ? '画板' : '图片'}快照"><span>打开完整图片</span></a>` : ''}<p>${escape(a.summary || a.error)}</p>${a.observations.map(o => `<p><strong>${escape(o.location)}</strong>：${escape(o.text)}</p>`).join('')}${a.uncertainties.length ? `<p class="visual-warning">识别限制：${a.uncertainties.map(escape).join('；')}</p>` : ''}</details>`).join('')}</div></section>`;
}
function sourcePane(task) {
  return `<aside class="panel source-panel"><div class="source-panel-title"><div>${icon('file', 18)} <strong>原始需求</strong></div>${task.source.url ? `<a class="icon-link" href="${escape(task.source.url)}" target="_blank" rel="noopener noreferrer" aria-label="打开原始飞书文档">${icon('external', 16)}</a>` : '<span class="tag">文本快照</span>'}</div><div class="source-meta"><strong>${escape(task.source.title)}</strong><span>${task.source.characterCount.toLocaleString()} 字符 · 指纹 ${task.source.fingerprint.slice(0, 8)}</span></div><div class="source-text" id="source-text">${task.source.blocks.map(b => /^#+\s/.test(b.text) ? `<h3 id="source-${b.id}" class="${state.evidence === b.id ? 'highlighted' : ''}">${escape(b.text.replace(/^#+\s*/, ''))}</h3>` : `<p id="source-${b.id}" class="${state.evidence === b.id ? 'highlighted' : ''}"><span class="line-number">${b.line}</span>${escape(b.text)}</p>`).join('')}</div><div class="source-footnote">${icon('info', 14)} ${escape(coverageText(task.source))}</div></aside>`;
}

function issueCards(task) {
  const issues = task.report.issues.filter(i => (state.priority === 'all' || i.priority === state.priority) && (state.category === 'all' || i.category === state.category) && `${i.title} ${i.description} ${i.suggestion}`.toLowerCase().includes(state.query.toLowerCase()));
  if (!issues.length) return '<div class="panel no-issues">当前筛选下没有评审意见。<br><small>未发现问题不代表需求已通过人工评审。</small></div>';
  return issues.map((issue, index) => `<details class="issue-card ${issue.status === 'dismissed' ? 'dismissed' : ''}" ${index < 2 ? 'open' : ''}><summary><div class="issue-heading"><span class="priority ${issue.priority.toLowerCase()}">${issue.priority}</span><span class="issue-name">${escape(issue.title)}<small>${issue.id}<span>·</span>${issue.dimension}<span>·</span>${categoryNames[issue.category]}</small></span><span class="issue-chevron">${icon('chevron', 17)}</span></div></summary><div class="issue-content"><div class="evidence-label"><span class="evidence-tag ${issue.evidenceType}">${icon(issue.evidenceVerified ? 'check' : 'info', 13)}${({ fact: '原文事实', inference: '推断建议', question: '待澄清' })[issue.evidenceType]}</span><span>${issue.visualLocated ? '视觉引用已定位 · 需人工复核' : issue.evidenceVerified ? '正文引用已校验' : '暂无可核验引用'}</span></div><p class="issue-description">${escape(issue.description)}</p>${issue.quote ? `<button class="evidence-quote" data-evidence="${escape(issue.sourceBlockId)}"><span>“${escape(issue.quote)}”</span><small>${icon('link', 12)} ${escape(issue.location)} ${icon('arrow', 13)}</small></button>` : '<div class="no-evidence">该判断缺少可核验引用，已降级为待澄清问题。</div>'}<div class="issue-impact"><strong>潜在影响</strong><p>${escape(issue.impact)}</p></div><div class="issue-suggestion"><span>${icon('spark', 17)}</span><div><strong>修改建议</strong><p>${escape(issue.suggestion)}</p></div></div><div class="issue-actions"><span>人工确认</span><label class="sr-only" for="status-${issue.id}">确认 ${escape(issue.title)}</label><span class="tag">${({pending:"待审核",accepted:"已采纳",dismissed:"不采纳"})[issue.status]}</span><button class="text-button" data-action="focus-quality">填写审核依据</button><span class="confidence">${task.mode === 'demo' ? '本地演示规则 · 非模型评估' : `模型自评 ${Math.round(issue.confidence * 100)}% · 未校准`}</span></div></div></details>`).join('');
}

function publishStatus(task) {
  if (task.mode === 'demo') return '';
  if (task.publish.status === 'published') return `<div class="publish-banner">${icon('check', 18)} ${task.kind === 'cases' ? '用例已发布到原生飞书思维笔记' : '飞书报告已创建'}并回读核验 ${task.publish.outOfDate ? '· 本地内容已更新，云端仍为旧快照；可在页面下方发布独立修订版' : ''}<a href="${escape(task.publish.url)}" target="_blank" rel="noopener noreferrer">打开报告 ${icon('external', 14)}</a></div>`;
  if (task.publish.error) return `<div class="error-box">${icon('alert', 18)}<span>${escape(task.publish.error)}</span>${task.publish.url ? `<a href="${escape(task.publish.url)}" target="_blank" rel="noopener noreferrer">打开已有报告</a>` : ''}</div>`;
  if (task.status === 'publishing') return `<div class="inline-notice">${icon('clock', 18)} ${escape(task.stage)}</div>`;
  return '';
}

function reportPage(task) {
  if (!task.report) return progress(task);
  if (['cases', 'bugs'].includes(task.kind)) return qaReport(task);
  const r = task.report;
  return `<a href="#history" class="back-link">${icon('back', 15)} 返回评审记录</a><div class="page-heading report-heading"><div><div class="report-eyebrow"><span class="tag ${task.mode === 'demo' ? 'demo' : ''}">${task.mode === 'demo' ? '演示报告' : 'AI 评审'}</span><span>${date(task.createdAt)}</span><span>·</span><span>${task.id.slice(0, 8)}</span></div><h1>${escape(task.title)}</h1><p>需求评审报告 <span class="report-subtle">/ 基于原文证据的初审意见</span></p></div><div class="report-buttons"><a class="button secondary" href="/api/tasks/${task.id}/export?format=markdown">${icon('download', 16)} 导出 Markdown</a><a class="button icon-button" href="/api/tasks/${task.id}/export?format=json" title="导出 JSON" aria-label="导出 JSON">{ }</a>${task.mode === 'live' && task.publish.status !== 'published' ? `<button class="button primary" data-action="publish" ${!state.config.feishu.configured || task.status === 'publishing' || task.publish.status === 'uncertain' ? 'disabled' : ''}>${icon('external', 16)} ${task.publish.url ? '重新核验' : '生成飞书报告'}</button>` : ''}</div></div>
  ${task.mode === 'demo' ? `<div class="demo-banner">${icon('info', 18)}<span>这是<strong>本地规则生成的演示报告</strong>，用于体验流程；未调用真实模型，也未创建飞书文档。</span><a href="#settings">配置真实评审 ${icon('arrow', 14)}</a></div>` : ''}${publishStatus(task)}
  <section class="report-summary"><div class="conclusion"><span class="summary-eyebrow">总体结论</span><h2>${r.conclusion}</h2><p>${escape(r.summary)}</p><div class="validation-line">${icon('shield', 15)} ${r.validation.verified} 条正文引用已核验 <span>·</span> ${r.validation.visual || 0} 条视觉引用待复核 <span>·</span> ${r.validation.downgraded} 条降级为待澄清 <span>·</span> 意见需人工确认</div></div><div class="report-counts">${[['P0', '关键问题'], ['P1', '重要问题'], ['P2', '优化与澄清']].map(([p, label]) => `<button class="report-count ${p.toLowerCase()} ${state.priority === p ? 'chosen' : ''}" data-priority="${p}"><span>${p} ${label}</span><strong>${r.counts[p]}</strong><small>条评审意见</small></button>`).join('')}</div></section>
  ${task.source.unsupported.length ? `<div class="inline-notice">${icon('info', 16)} ${task.source.unsupported.map(escape).join('；')}。请按下方资源清单确认实际覆盖范围。</div>` : ''}
  ${visualResources(task)}
  <div class="results-grid"><section class="issue-list"><div class="issues-heading"><h2>评审意见 <span class="count-tag">${r.issues.length}</span></h2><div class="input-icon issue-search">${icon('search', 16)}<input id="issue-search" aria-label="搜索评审意见" placeholder="搜索问题…" value="${escape(state.query)}"></div></div><div class="filter-bar"><div class="priority-tabs" aria-label="优先级筛选">${['all', 'P0', 'P1', 'P2'].map(p => `<button class="${state.priority === p ? 'selected' : ''}" data-priority="${p}">${p === 'all' ? '全部意见' : p}</button>`).join('')}</div><select id="category-filter" aria-label="问题类型筛选"><option value="all">所有类型</option>${Object.entries(categoryNames).map(([value, name]) => `<option value="${value}" ${state.category === value ? 'selected' : ''}>${name}</option>`).join('')}</select></div><div id="issue-cards">${issueCards(task)}</div><div class="report-end">${icon('shield', 16)} AI 和规则帮助发现问题，业务决策由团队确认。</div></section>${sourcePane(task)}</div>`;
}

function standards() {
  const descriptions = ['目标、用户、范围、流程和验收条件是否齐全。', '方案是否服务于业务目标，成本与收益是否相称。', '不同章节的规则、状态、时间及字段是否矛盾。', '失败、空数据、超时、重复、并发与权限边界是否明确。', '识别实现功能通常需要的配套能力，并标注为待确认建议。', '识别系统依赖、安全、跨系统状态和数据一致性风险。', '指标是否量化、流程是否可测试、结果是否可验收。', '性能、容量、可用性、可观测性与可访问性要求。'];
  return `<div class="page-heading"><div><div class="eyebrow">REVIEW FRAMEWORK</div><h1>好的评审，始于一致的标准</h1><p>MVP 内置评审规则，覆盖八个维度。业务自定义规则留待后续版本。</p></div><span class="tag">规则 v1.0</span></div><div class="standards-grid">${state.config.dimensions.map((d, i) => `<section class="panel standard-card"><span class="standard-number">0${i + 1}</span><h2>${d}</h2><p>${descriptions[i]}</p></section>`).join('')}</div><section class="panel principle-panel"><h2>${icon('shield', 22)} 三条评审原则</h2><div class="principles"><div><strong>没有证据，先澄清</strong><p>引用须在原文中找到；证据不足的判断自动降级为待澄清。</p></div><div><strong>事实、推断分别标注</strong><p>设计建议不等于已确认需求，模型自评置信度不等于准确率。</p></div><div><strong>覆盖范围明确可见</strong><p>保留原文指纹；未处理的图片、附件和嵌入资源单独提示。</p></div></div></section><section class="panel severity-panel"><h2>如何理解优先级</h2><div><span class="priority p0">P0</span><p><strong>关键问题</strong>可能影响资金、安全或核心业务流程，建议优先确认。</p></div><div><span class="priority p1">P1</span><p><strong>重要问题</strong>影响实现正确性或完整性，建议在开发前澄清。</p></div><div><span class="priority p2">P2</span><p><strong>优化与澄清</strong>改善可测试性、体验或描述质量，也包括证据不足的问题。</p></div></section>`;
}

function providerExample(provider) {
  const preset = state.config.providers[provider];
  return `LLM_PROVIDER=${provider}
LLM_API_KEY=你的 API Key
LLM_MODEL=服务商提供的模型 ID
# 留空时使用服务商预设；切换时清除旧值
LLM_API_MODE=
LLM_BASE_URL=${provider === 'custom' ? 'https://你的服务地址/v1' : ''}
LLM_OUTPUT_FORMAT=
# 预设：${preset.mode} · ${preset.outputFormat}
# 地址：${preset.baseUrl || '需自行填写'}`;
}

function feishuConnection() {
  const f = state.config.feishu, a = f.oauth;
  const status = a.pending ? '等待授权' : a.ready ? '已授权' : a.needsReauth ? '需重新授权' : f.mode === 'manual' ? '手动凭据已配置' : a.configured ? '待扫码' : '待配置应用';
  return `<section class="panel connection-card"><div class="connection-title"><span class="connection-icon feishu">${icon('link', 25)}</span><div><h2>飞书账号与权限</h2><p>当前账号 · ${escape(state.login?.user?.name)}</p></div><span class="tag ${f.configured ? 'ready' : ''}">${status}</span></div>
  <p>需求评审、测试用例和版本测试报告共用登录时取得的权限。新增权限或凭据失效时，可在这里重新授权。</p>
  ${a.ready ? `<div class="inline-notice">${icon('check', 18)}<span>飞书账户已授权。${a.autoRefresh ? '文档操作时自动续期。' : '未取得可用刷新凭据，到期后需要重新扫码。'}<br>当前访问凭据有效至 ${date(a.expiresAt)}。</span></div>` : ''}
  ${a.error ? `<div class="auth-error" role="alert">${escape(a.error)}</div>` : ''}
  ${a.authorized && a.missingVisualScopes?.length ? `<div class="auth-error">图片/画板需补充用户权限并重新扫码：${a.missingVisualScopes.map(escape).join('、')}。正文评审仍可用。</div>` : ''}
  ${a.missingScopes.length ? `<div class="auth-error" role="alert">部分权限未授权，请检查应用权限并重新扫码：<br>${a.missingScopes.map(escape).join('、')}</div>` : ''}
  <div class="auth-actions"><button class="button primary" data-action="login-feishu" ${!a.configured ? 'disabled' : ''}>${icon('link', 17)} ${a.authorized ? '重新扫码授权' : '飞书扫码授权'}</button>${a.pending ? '<button class="button secondary" data-action="cancel-feishu">取消本次登录</button>' : ''}${a.authorized ? '<button class="button secondary" data-action="logout-feishu">退出飞书登录</button>' : ''}</div>
  ${a.pending ? '<p class="field-help">等待你在飞书官方页面确认。若已返回或取消，可取消本次登录后重新发起。</p>' : ''}
  ${a.authorized ? '<p class="field-help">退出只清除本机登录状态。若需撤销飞书侧授权，请在飞书的应用授权管理中操作。</p>' : ''}
  <details class="auth-setup" ${!a.configured ? 'open' : ''}><summary>首次使用：配置一次飞书应用</summary>
  <p>在<a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开发者后台</a>创建或选择企业自建应用，将应用凭据填入本地 .env：</p>
  <pre>FEISHU_APP_ID=你的应用AppID
FEISHU_APP_SECRET=你的应用AppSecret
FEISHU_REDIRECT_URI=${escape(a.redirectUri || 'http://127.0.0.1:3210/api/auth/feishu/callback')}</pre>
  <ol><li>在应用“安全设置 → 重定向 URL”添加上述回调地址。工作台与回调地址必须使用相同域名和端口。</li><li>开通下方权限，将自己的账号加入应用可用范围；按租户要求发布或使用测试版本。</li><li>若后台显示“刷新 user_access_token”开关，请开启并发布生效。完成后重启本地服务，即可扫码。</li></ol>
  ${a.setupError ? `<p class="field-help">${escape(a.setupError)}</p>` : ''}</details>
  <details class="auth-setup"><summary>本次授权所需权限</summary><p>包含文档读取/创建及官方 MCP 依赖的知识库、附件、画板、任务和群信息权限；offline_access 用于自动续期。另通过飞书 API 下载图片、画板截图和只读节点，用于视觉评审。</p><pre>${a.requestedScopes.map(escape).join('\n')}</pre><p>权限依据<a href="https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server" target="_blank" rel="noopener noreferrer">飞书官方 MCP 接入说明</a>。登录成功后仍需有权访问具体文档。</p></details>
  <button class="button secondary" data-action="check-feishu" ${!f.configured || a.pending ? 'disabled' : ''}>检测飞书连接</button><p id="connection-result" role="status"></p></section>`;
}

function settings() {
  const c = state.config;
  const provider = Object.hasOwn(c.providers, c.model.provider) ? c.model.provider : 'custom';
  return `<div class="page-heading"><div><div class="eyebrow">CONNECTIONS</div><h1>连接你的评审工具</h1><p>配置模型与飞书授权后，即可输入需求文档链接开始评审。</p></div><button class="button secondary" data-action="refresh-config">刷新状态</button></div>
  <div class="connection-grid"><section class="panel connection-card"><div class="connection-title"><span class="connection-icon model">${icon('spark', 25)}</span><div><h2>AI 模型</h2><p>Gemini / DeepSeek / Agnes / OpenAI</p></div><span class="tag ${c.model.configured ? 'ready' : ''}">${c.model.configured ? '已配置 · 待实测' : '待配置'}</span></div>
  <p>模型密钥仅在服务端读取。正文引用逐字校验，视觉观察另行标注并需人工复核。</p>
  <div class="inline-notice"><span>当前服务商：${escape(c.model.label)}<br>模型：${escape(c.model.name || '未填写')}<br>接口：${escape(c.model.mode)} · ${escape(c.model.outputFormat)}<br>地址：${escape(c.model.baseUrl || '未填写')}</span></div>
  <p class="field-help">视觉输入：${c.model.vision ? '已启用（需模型本身支持图片）' : '未启用'}。Gemini / OpenAI 默认尝试视觉输入；其他服务须确认模型支持后，在 .env 设置 LLM_VISION_ENABLED=true。DeepSeek 文本模型不能读取图片，需切换视觉模型；配置 false 可关闭。</p>
  ${c.model.error ? `<p class="field-help">${escape(c.model.error)}</p>` : ''}
  <p><label for="provider-preset">查看服务商配置示例</label></p><select id="provider-preset">${Object.entries(c.providers).map(([id, p]) => `<option value="${id}" ${id === provider ? 'selected' : ''}>${escape(p.label)}</option>`).join('')}</select>
  <pre id="provider-example">${escape(providerExample(provider))}</pre><p class="field-help">选择仅切换示例。请将配置写入本地 .env 并重启服务；刷新状态不会重新读取文件。API 地址填写根路径，不包含 /chat/completions。</p>
  <p class="field-help">Agnes 默认通过提示词请求 JSON；若响应格式不合规会明确失败。自定义服务须兼容 Responses 或 Chat Completions；可设置 LLM_OUTPUT_FORMAT 为 json_schema、json_object 或 text。</p></section>
  ${feishuConnection()}</div>
  <section class="panel setup-panel"><h2>本地配置，三步开始</h2><ol><li><span>1</span><div><strong>准备配置文件</strong><p>仅在 .env 不存在时，将 .env.example 复制为 .env；已有配置直接编辑。</p></div></li><li><span>2</span><div><strong>填写服务商、凭据与模型名称</strong><p>在本地编辑 .env，切换服务商时同时更换对应的 Key 和模型。不要将凭据提交到 Git 或粘贴到聊天。</p></div></li><li><span>3</span><div><strong>重启并开始评审</strong><p>停止旧服务后运行 npm start，回到工作台输入飞书需求文档链接。</p></div></li></ol><div class="inline-notice">${icon('info', 18)} 本版本仅面向本机单用户。评审正文与结果保存在本地 data/reviews.sqlite；尚未提供多人登录和权限隔离。</div></section>`;
}

const workspace = createWorkspace({ api, state, escape, render, navigate, toast });

function render() {
  if (!state.login?.authenticated) { if (state.login) $('#app').innerHTML = loginPage(); return; }
  if (!state.config) return;
  const page = route();
  let content;
  if (page.startsWith('review/')) content = state.selected ? reportPage(state.selected) + workspace.taskPanel(state.selected) : '<div class="boot">正在读取报告…</div>';
  else if (page === 'cases' || page === 'bugs') content = qaForm(page);
  else content = workspace.page(page) || ({ home, history: historyPage, standards, settings })[page]?.() || home();
  const open = render.lastRoute === page ? new Map([...document.querySelectorAll('details[data-persist]')].map(el => [el.dataset.persist, el.open])) : new Map();
  $('#app').innerHTML = shell(content);
  document.querySelectorAll('details[data-persist]').forEach(el => { if (open.has(el.dataset.persist)) el.open = open.get(el.dataset.persist); });
  render.lastRoute = page;
}

async function loadRoute() {
  clearTimeout(state.poll); state.error = '';
  let path = route();
  try {
    state.login = await api('/auth/session');
    if (!state.login.authenticated) {
      state.config = null; state.tasks = []; state.selected = null;
      render(); return;
    }
    if (path === 'welcome' || path === 'login') {
      if (path === 'login' && state.login.error) toast(state.login.error);
      path = destination(sessionStorage.getItem('afterLogin'));
      sessionStorage.removeItem('afterLogin');
      window.history.replaceState(null, '', '#' + path);
    }
    if (!state.config) state.config = await api('/config');
    state.tasks = await api('/tasks');
    await workspace.load(path);
    if (path.startsWith('review/')) {
      state.selected = await api(`/tasks/${path.split('/')[1]}`);
      state.priority = 'all'; state.category = 'all'; state.query = ''; state.evidence = null;
      render(); schedulePoll();
    } else { state.selected = null; render(); }
    window.scrollTo(0, 0);
  } catch (error) { if (!state.login?.authenticated) { $('#app').innerHTML = '<div class="boot">无法连接本地服务，请刷新重试。</div>'; return; } $('#app').innerHTML = shell(`<div class="panel error-page"><h1>暂时无法打开页面</h1><p>${escape(error.message)}</p><a class="button primary" href="#home">返回工作台</a></div>`); }
}

function schedulePoll(attempt = 0) {
  clearTimeout(state.poll);
  if (!state.selected || ['completed', 'failed'].includes(state.selected.status)) return;
  const id = state.selected.id;
  state.poll = setTimeout(async () => {
    if (route() !== `review/${id}`) return;
    try { state.selected = await api(`/tasks/${id}`); state.tasks = await api('/tasks'); render(); schedulePoll(); }
    catch (error) { toast(error.message); if (attempt < 3) schedulePoll(attempt + 1); else toast('状态刷新中断，请刷新页面继续查看任务。'); }
  }, 1200);
}

async function submit(input) {
  if (state.busy) return;
  state.busy = true; state.error = ''; render();
  try {
    const task = await api('/tasks', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(input) });
    state.selected = task; state.tasks = await api('/tasks'); navigate(`review/${task.id}`);
  } catch (error) { state.error = error.message; render(); }
  finally { state.busy = false; if (['home', 'cases', 'bugs'].includes(route())) render(); }
}

document.addEventListener('submit', event => {
  if (event.target.id === 'qa-form') {
    event.preventDefault(); const kind = event.target.dataset.kind, d = qaDraft[kind];
    submit({ kind, mode: 'live', ...d, ...(kind === 'bugs' ? { closedStatuses: d.closed.split(/[，,]/).map(s => s.trim()).filter(Boolean) } : d.destinationMode === 'existing' ? { parentUrl: '' } : { targetMindnoteUrl: '' }) }); return;
  }
  if (event.target.id !== 'review-form') return;
  event.preventDefault();
  submit({ ...state.draft, mode: 'live', sourceType: 'feishu' });
});
document.addEventListener('input', event => {
  const el = event.target;
  if (el.closest('#qa-form')) {
    const kind = el.closest('#qa-form').dataset.kind;
    if (el.name && el.type !== 'checkbox') qaDraft[kind][el.name] = el.value;
    if (kind === 'bugs' && el.name === 'url') { qaDraft.schema = null; qaDraft.bugs.tableId = ''; }
    return;
  }
  if (el.closest('#review-form') && el.name === 'url') state.draft.url = el.value;
  if (el.id === 'issue-search') { state.query = el.value; $('#issue-cards').innerHTML = issueCards(state.selected); }
  if (el.id === 'history-search') { state.historyQuery = el.value; $('#history-table').innerHTML = taskTable(state.tasks.filter(t => `${t.title} ${t.id}`.toLowerCase().includes(el.value.toLowerCase()))); }
});
document.addEventListener('change', async event => {
  const el = event.target;
  if (el.closest('#qa-form')) {
    const kind = el.closest('#qa-form').dataset.kind;
    if (el.type === 'checkbox') qaDraft[kind][el.name] = el.checked;
    if (el.dataset.map) { qaDraft.bugs.mapping[el.dataset.map] = el.value; render(); }
    if (el.name === 'tableId') await loadBaseSchema(el.value);
    if (el.name === 'destinationMode') { qaDraft.cases.destinationMode = el.value; render(); }
    return;
  }
  if (el.id === 'publish-mode') { $('#publish-wiki-fields').hidden = el.value === 'existing'; $('#publish-existing-fields').hidden = el.value !== 'existing'; }
  if (el.id === 'provider-preset') $('#provider-example').textContent = providerExample(el.value);
  if (['autoPublish', 'includeVisuals'].includes(el.name)) state.draft[el.name] = el.checked;
  if (el.id === 'category-filter') { state.category = el.value; $('#issue-cards').innerHTML = issueCards(state.selected); }
  if (el.dataset.issueStatus) {
    try { state.selected = await api(`/tasks/${state.selected.id}/issues`, { method: 'PATCH', body: JSON.stringify({ issueId: el.dataset.issueStatus, status: el.value }) }); toast('确认状态已保存'); if (state.selected.publish.url) render(); }
    catch (error) { toast(error.message); render(); }
  }
});
document.addEventListener('click', async event => {
  const el = event.target.closest('[data-action], [data-priority], [data-evidence]');
  if (!el) return;
  if (el.dataset.priority) { state.priority = el.dataset.priority; render(); return; }
  if (el.dataset.evidence) {
    state.evidence = el.dataset.evidence;
    document.querySelectorAll('.highlighted').forEach(p => p.classList.remove('highlighted'));
    const target = document.getElementById(`source-${state.evidence}`);
    target?.classList.add('highlighted'); target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return;
  }
  try {
    switch (el.dataset.action) {
      case 'focus-quality': document.getElementById('quality-tools')?.scrollIntoView({ behavior: 'smooth' }); break;
      case 'base-schema': await loadBaseSchema(); break;
      case 'refresh-config': state.config = await api('/config'); render(); toast('已刷新服务端配置状态'); break;
      case 'login-feishu': {
        el.disabled = true; el.textContent = '正在打开飞书…';
        const result = await api('/auth/feishu/start', { method: 'POST', body: '{}' });
        const url = new URL(result.authorizationUrl);
        if (url.origin !== 'https://accounts.feishu.cn' || url.pathname !== '/open-apis/authen/v1/authorize') throw new Error('授权地址无效，请刷新重试。');
        if (route() !== 'login' || !sessionStorage.getItem('afterLogin')) sessionStorage.setItem('afterLogin', destination(route()));
        window.location.assign(url.href); break;
      }
      case 'cancel-feishu':
      case 'logout-feishu': {
        el.disabled = true;
        await api(`/auth/feishu/${el.dataset.action === 'logout-feishu' ? 'logout' : 'cancel'}`, { method: 'POST', body: '{}' });
        if (el.dataset.action === 'logout-feishu') {
          sessionStorage.removeItem('afterLogin'); window.history.replaceState(null, '', '#login'); location.reload(); return;
        }
        state.config = await api('/config'); render(); toast('已取消本次登录'); break;
      }
      case 'check-feishu': el.disabled = true; el.textContent = '正在检测…'; { const result = await api('/connections/check', { method: 'POST', body: '{}' }); $('#connection-result').textContent = result.message; } el.disabled = false; el.textContent = '检测飞书连接'; break;
      case 'publish': state.selected = await api(`/tasks/${state.selected.id}/publish`, { method: 'POST', body: JSON.stringify(state.selected.kind === 'cases' && $('#publish-mode') ? ($('#publish-mode').value === 'existing' ? { targetMindnoteUrl: $('#publish-target').value } : { parentUrl: $('#publish-parent').value }) : {}) }); render(); schedulePoll(); break;
      case 'retry-task': { const task = state.selected; if (['cases', 'bugs'].includes(task.kind)) { Object.assign(qaDraft[task.kind], task.options); if (task.kind === 'cases') qaDraft.cases.destinationMode = task.options?.targetMindnoteUrl ? 'existing' : 'wiki'; if (task.kind === 'bugs') qaDraft.bugs.closed = (task.options.closedStatuses || []).join('，'); navigate(task.kind); break; } state.draft = { url: task.source?.url || task.options?.url || '', includeVisuals: task.options?.includeVisuals !== false, autoPublish: false }; navigate('home'); break; }
    }
  } catch (error) { toast(error.message); if (el.dataset.action === 'check-feishu') { el.disabled = false; el.textContent = '检测飞书连接'; } if (['login-feishu', 'logout-feishu', 'cancel-feishu'].includes(el.dataset.action)) await loadRoute(); }
});
window.addEventListener('hashchange', loadRoute);
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.login?.authenticated) {
    try { if (!(await api('/auth/session')).authenticated) location.reload(); } catch { /* Retry on the next request. */ }
  }
});
await loadRoute();
