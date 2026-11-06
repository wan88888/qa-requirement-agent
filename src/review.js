import { createHash } from 'node:crypto';
import Ajv from 'ajv';

export const DIMENSIONS = ['需求完整性', '需求合理性', '逻辑一致性', '边界与异常', '隐性需求', '技术风险', '测试与验收', '非功能性要求'];
export const CATEGORIES = { unreasonable: '不合理需求', missing: '缺失需求', risk: '潜在风险', implicit: '隐性需求', clarification: '待澄清' };
export const MAX_DOCUMENT_CHARS = 48000;
export const hash = value => createHash('sha256').update(value).digest('hex');

export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}

export const DEMO_DOCUMENT = {
  title: '订单退款功能 · PRD v1.2',
  content: `# 订单退款功能

## 1. 项目背景与目标
为减少客服处理订单退款的工作量，在商城订单详情页提供自助退款入口。本期面向已登录的个人消费者，支持在线支付订单，线下支付暂不在范围内。

## 2. 退款申请
用户可对已支付且未发货的订单申请退款。用户点击“申请退款”，填写退款原因并提交。
用户申请退款后，系统自动退还订单金额。
申请成功后订单进入“退款处理中”，第三方支付平台确认退款后更新为“退款成功”。

## 3. 业务规则
订单支付后 7 天内允许退款。
优惠券与积分可用于支付订单，订单可能包含多件商品及运费。
退款审核通过后原路退回用户支付账户。

## 4. 客服后台
客服可以查看全部退款申请，修改退款金额并手动触发退款。
后台规定：订单支付后 3 天内允许退款，超过 3 天拒绝申请。

## 5. 通知与交互
退款成功后及时通知用户。
退款页面需要操作流畅，支持移动端和桌面端。

## 6. 验收说明
提交退款后，可以在订单详情页查看退款状态。
客服能够在后台查询并处理退款申请。`,
};

export function parseSource(content, title = '未命名需求', url = null) {
  if (typeof content !== 'string' || content.trim().length < 30) throw new AppError('需求正文至少需要 30 个字符。');
  if (content.length > MAX_DOCUMENT_CHARS) throw new AppError(`MVP 支持最多 ${MAX_DOCUMENT_CHARS.toLocaleString()} 个字符，请按独立业务范围拆分文档后评审。`, 413, 'DOCUMENT_TOO_LARGE');
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let section = '正文';
  const blocks = lines.flatMap((text, index) => {
    if (/^#{1,6}\s/.test(text)) section = text.replace(/^#+\s*/, '').trim();
    return text.trim() ? [{ id: `line-${index + 1}`, line: index + 1, section, text: text.trim() }] : [];
  });
  const unsupported = [];
  if (/!\[|<image\b|<img\b/i.test(content)) unsupported.push('图片内容未进行视觉识别');
  if (/<(?:whiteboard|board|iframe|sheet|bitable|file|attachment)\b|```mermaid|<iframe/i.test(content)) unsupported.push('画板、附件或嵌入资源未展开分析');
  return { title: String(title).slice(0, 150), url, content, blocks, fingerprint: hash(content), characterCount: content.length, unsupported };
}

const string = { type: 'string', maxLength: 2400 };
export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'issues'],
  properties: {
    summary: string,
    issues: { type: 'array', maxItems: 40, items: {
      type: 'object', additionalProperties: false,
      required: ['title', 'category', 'dimension', 'priority', 'description', 'impact', 'suggestion', 'quote', 'evidenceType', 'confidence'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 150 }, category: { type: 'string', enum: Object.keys(CATEGORIES) },
        dimension: { type: 'string', enum: DIMENSIONS }, priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
        description: string, impact: string, suggestion: string, quote: string,
        evidenceType: { type: 'string', enum: ['fact', 'inference', 'question'] }, confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    } },
  },
};
const validate = new Ajv({ allErrors: true }).compile(REVIEW_SCHEMA);
const normalize = text => text.replace(/\s+/g, '');

export function validateReview(raw, source) {
  if (!validate(raw)) throw new AppError('模型返回的评审结构不符合约定，请重试或检查模型对结构化输出的支持。', 502, 'INVALID_MODEL_OUTPUT');
  const seen = new Set();
  let downgraded = 0, duplicates = 0;
  const issues = raw.issues.flatMap(issue => {
    const quote = issue.quote.trim();
    const block = quote.length >= 4 ? source.blocks.find(b => normalize(b.text).includes(normalize(quote))) : null;
    const visual = block?.kind === 'visual';
    const verified = Boolean(block) && !visual;
    // A fabricated citation cannot remain a definitive defect, even if the model called it a fact.
    const normalized = { ...issue, quote: block ? quote : '', evidenceSource: visual ? 'visual' : 'text', resourceId: block?.resourceId || null, visualLocated: Boolean(visual), location: block ? `${block.section} · 第 ${block.line} 行${visual ? ` · ${block.resourceId} 视觉识别（待人工复核）` : ''}` : '暂无可核验的原文引用', sourceBlockId: block?.id ?? null, evidenceVerified: verified, status: 'pending' };
    if (!block) {
      downgraded++;
      normalized.category = 'clarification'; normalized.evidenceType = 'question';
      normalized.priority = 'P2'; normalized.confidence = Math.min(0.49, issue.confidence);
      normalized.title = `待核实：${issue.title.replace(/^待核实：/, '')}`;
      normalized.description = `信息不足，以下判断尚未获原文证据支持，需人工核实：${issue.description}`;
    } else if (visual) {
      normalized.evidenceType = issue.evidenceType === 'question' ? 'question' : 'inference';
      normalized.confidence = Math.min(0.75, issue.confidence);
      if (issue.evidenceType === 'question') normalized.category = 'clarification';
    } else if (issue.evidenceType === 'question') normalized.category = 'clarification';
    const key = normalize(issue.title).toLowerCase();
    if (seen.has(key)) { duplicates++; return []; }
    seen.add(key);
    return [normalized];
  }).sort((a, b) => a.priority.localeCompare(b.priority)).map((issue, i) => ({ ...issue, id: `REQ-${String(i + 1).padStart(3, '0')}` }));
  const counts = Object.fromEntries(['P0', 'P1', 'P2'].map(p => [p, issues.filter(i => i.priority === p).length]));
  const conclusion = counts.P0 || counts.P1 ? '建议补充后复审' : issues.length ? '建议人工澄清' : '未发现明确问题，仍需人工评审';
  return { summary: raw.summary, issues, counts, conclusion, validation: { downgraded, duplicates, verified: issues.filter(i => i.evidenceVerified).length, visual: issues.filter(i => i.visualLocated).length }, dimensions: DIMENSIONS.map(name => ({ name, count: issues.filter(i => i.dimension === name).length })) };
}

export function demoReview(source) {
  const issues = [];
  const add = (match, fields) => {
    const block = source.blocks.find(b => match.test(b.text));
    if (block) issues.push({ confidence: 0.78, evidenceType: 'inference', quote: block.text, ...fields });
  };
  if (/订单支付后\s*7\s*天内允许退款/.test(source.content) && /后台规定：订单支付后\s*3\s*天内允许退款/.test(source.content)) add(/后台规定：订单支付后\s*3\s*天内允许退款/, {
    title: '退款申请时限存在冲突', category: 'unreasonable', dimension: '逻辑一致性', priority: 'P0', evidenceType: 'fact', confidence: 0.98,
    description: '业务规则规定支付后 7 天内允许退款，后台规则却使用 3 天。两个入口的判断条件不一致。',
    impact: '同一订单可能在前台可申请、后台被拒绝，造成客诉与验收争议。', suggestion: '统一退款时限，并明确起算时间、时区和截止时刻是否包含在可退款范围内。',
  });
  if (!/退款金额\s*[=＝]|实付.*减|分摊规则/.test(source.content)) add(/自动退还订单金额/, {
    title: '退款金额的计算口径不明确', category: 'missing', dimension: '需求完整性', priority: 'P0',
    description: '尚需确认“订单金额”指原价还是实际支付金额；如涉及优惠券、积分、运费或多商品退款，还需明确分摊方式。',
    impact: '可能导致退款金额偏差和支付账务不一致。', suggestion: '补充退款金额公式，列出优惠券、积分、运费、部分退款的计算示例，并由业务与财务确认。',
  });
  if (!/幂等|防重|重复提交/.test(source.content)) add(/点击.*申请退款|提交.*退款/, {
    title: '补充重复提交与支付回调的幂等设计', category: 'implicit', dimension: '隐性需求', priority: 'P1',
    description: '退款涉及资金操作，需要确认重复点击、网络重试和重复回调是否会触发多次退款。这属于建议补充的设计，尚不是已确认业务规则。',
    impact: '若缺少幂等控制，可能出现重复退款或状态重复迁移。', suggestion: '确认退款请求唯一标识、重复请求返回规则与支付回调去重机制。',
  });
  if (!/超时|退款失败|补偿/.test(source.content)) add(/第三方支付平台/, {
    title: '支付超时与退款失败缺少后续路径', category: 'risk', dimension: '边界与异常', priority: 'P1',
    description: '当前流程描述成功路径，尚需确认支付平台超时、拒绝退款或回调丢失后的状态及处理方式。',
    impact: '订单可能长期停留在退款处理中，客服无法判断资金实际状态。', suggestion: '补充失败与处理中超时状态、重试上限、对账和人工介入流程。',
  });
  if (!/权限矩阵|审批人|审计日志/.test(source.content)) add(/客服.*修改退款金额/, {
    title: '人工修改退款金额的权限需要明确', category: 'risk', dimension: '技术风险', priority: 'P1',
    description: '客服可修改金额并触发退款，尚需确认角色边界、金额校验与关键操作留痕。',
    impact: '误操作或越权操作可能造成资金损失，且难以追溯。', suggestion: '明确可操作角色、金额上限、二次审批条件及操作审计字段。',
  });
  add(/及时通知/, {
    title: '通知时效与失败处理需要量化', category: 'missing', dimension: '测试与验收', priority: 'P2',
    description: '“及时通知”没有明确可验收的时间、渠道与送达要求。', impact: '研发与测试可能对“及时”采用不同标准。', suggestion: '明确通知渠道、触发时机、送达时限与发送失败的重试或提示方式。',
  });
  add(/操作流畅/, {
    title: '交互性能缺少可测量标准', category: 'missing', dimension: '非功能性要求', priority: 'P2',
    description: '“操作流畅”无法直接转化为测试断言；需要明确适用设备、网络与性能目标。', impact: '性能验收缺乏一致依据。', suggestion: '由团队确定页面加载、提交响应的指标与并发条件，避免直接采用未经验证的阈值。',
  });
  if (!/目标.*\d+%|降低.*\d+%/.test(source.content)) add(/减少客服/, {
    title: '确认业务目标的衡量方式', category: 'clarification', dimension: '需求合理性', priority: 'P2', evidenceType: 'question',
    description: '自助退款的方向明确，但需确认如何衡量客服工作量下降，以及人工审核流程是否会抵消收益。',
    impact: '上线后可能缺少判断项目收益的数据依据。', suggestion: '确认当前人工处理基线、目标指标、统计周期与埋点口径。',
  });
  if (!issues.length) issues.push({ title: '请人工补充业务背景与验收口径', category: 'clarification', dimension: '需求完整性', priority: 'P2', description: '本地演示规则没有匹配到可判断的场景，不能据此认定需求通过评审。', impact: '演示规则覆盖有限，可能遗漏业务问题。', suggestion: '配置真实模型后重新评审，并结合人工样本验证。', quote: '', evidenceType: 'question', confidence: 0.3 });
  return { summary: source.content === DEMO_DOCUMENT.content ? '本需求提供商城自助退款与客服处理能力。初审重点是统一退款规则、明确资金计算口径，以及补齐支付异常与权限控制。' : '以下为本地规则生成的演示结果，仅用于体验评审流程；规则未命中不代表需求没有问题。', issues };
}

export function coverageDescription(source) {
  const v = source.visualCoverage;
  return v ? `正文 ${source.characterCount} 字符；图片/画板 ${v.analyzed}/${v.total} 个已识别（其中 ${v.partial} 个部分可辨认）；${v.omitted} 个未纳入。视觉观察需人工复核。` : `提取到的文本 ${source.characterCount} 字符；图片、附件和嵌入资源未做语义评审。`;
}

const clean = value => String(value ?? '').replace(/\r/g, '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function renderMarkdown(task) {
  const { report, source } = task;
  if (!report || !source) throw new AppError('评审报告尚未生成。', 409);
  const out = [`# 需求评审报告：${clean(source.title)}`, '', `> ${task.mode === 'demo' ? '演示模式 · 本地规则生成，未经真实 AI 评审。' : 'AI 辅助初审 · 所有问题均需人工确认。'}`, '', '## 1. 评审概览', '',
    `- 来源：${source.url || '本地文本 / 演示样例'}`, `- 评审时间：${new Date(task.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（Asia/Shanghai）`, `- 任务 ID：${task.id}`, `- 原文指纹：${source.fingerprint}`, `- 评审覆盖：${coverageDescription(source)}`, '', clean(report.summary), '',
    '## 2. 总体评审结论', '', report.conclusion, '', `P0：${report.counts.P0} · P1：${report.counts.P1} · P2：${report.counts.P2} · 合计：${report.issues.length}`, '', `正文引用已核验：${report.validation.verified} 条；视觉引用待人工复核：${report.validation.visual || 0} 条；证据不足降级：${report.validation.downgraded} 条；去除重复：${report.validation.duplicates} 条。`, '',
  ];
  if (source.unsupported.length) out.push(`覆盖提示：${source.unsupported.map(clean).join('；')}`, '');
  const statuses = { pending: '待确认', accepted: '已采纳', dismissed: '不采纳' };
  for (const [index, category] of ['unreasonable', 'missing', 'risk', 'implicit', 'clarification'].entries()) {
    out.push(`## ${index + 3}. ${CATEGORIES[category]}`, '');
    const issues = report.issues.filter(i => i.category === category);
    if (!issues.length) out.push('本次未识别出此类问题，不代表已验证通过。', '');
    for (const issue of issues) out.push(`### ${issue.id} · ${issue.priority} · ${clean(issue.title)}`, '',
      `- 维度：${issue.dimension}；证据类型：${({ fact: '原文事实', inference: '推断建议', question: '待澄清' })[issue.evidenceType]}；状态：${statuses[issue.status]}`, `- 定位：${clean(issue.location)}`, '',
      `**${issue.visualLocated ? '视觉观察（需人工复核）' : '原文依据'}：** ${issue.quote ? `“${clean(issue.quote)}”` : '暂无可核验引用，仅作为待澄清问题。'}`, '', `**问题：** ${clean(issue.description)}`, '', `**潜在影响：** ${clean(issue.impact)}`, '', `**修改建议：** ${clean(issue.suggestion)}`, '');
  }
  out.push('## 8. 修改建议与跟进', '');
  const actionable = report.issues.filter(i => i.status !== 'dismissed');
  actionable.forEach(i => out.push(`- [ ] ${i.priority} / ${i.id}：${clean(i.suggestion)}`));
  if (!actionable.length) out.push('暂无待跟进项，请完成常规人工评审。');
  if (source.visuals?.length) {
    out.push('', '## 附录：图片与画板识别记录', '', `视觉快照指纹：${source.visualFingerprint}`, '');
    for (const asset of source.visuals) {
      out.push(`### ${asset.id} · ${asset.kind === 'whiteboard' ? '画板/流程图' : '图片/原型图'}`, '',
        `- 定位：${asset.references.map(r => `${clean(r.section)} · 第 ${r.line} 行`).join('；')}`,
        `- 读取状态：${({analyzed:'已识别',partial:'部分可辨认',unreadable:'无法辨认',failed:'读取或识别失败',skipped:'未读取'})[asset.status] || asset.status}`,
        `- 图像来源：${asset.rendition === 'original' ? '原图' : asset.rendition ? '飞书预览版本' : '未取得'}${asset.width ? ` · ${asset.width} × ${asset.height}` : ''}`, `- 资源指纹：${asset.fingerprint || '未取得'}`, '', clean(asset.summary || asset.error || ''), '');
      asset.observations.forEach(o => out.push(`- ${clean(o.location)}：${clean(o.text)}`));
      if (asset.uncertainties.length) out.push(`识别限制：${asset.uncertainties.map(clean).join('；')}`);
      out.push('');
    }
  }
  out.push('', `报告校验标识：QA-${task.id}-${source.fingerprint.slice(0, 12)}`);
  return out.join('\n');
}
