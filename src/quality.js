import { randomUUID } from 'node:crypto';
import { AppError, hash } from './review.js';
export const decisions = ['pending', 'accepted', 'modified', 'dismissed'];
export const executionStatuses = ['not_run', 'passed', 'failed', 'blocked', 'skipped'];
const now = () => new Date().toISOString();
export function text(value, label, max = 2400, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new AppError(`${label}不能为空且最多 ${max} 字符。`);
  return value.trim();
}
export function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('请求必须是对象。'); return value; }
export function revision(actual, expected) { if (!Number.isInteger(expected) || actual !== expected) throw new AppError('内容已更新，请刷新后重试，避免覆盖其他修改。', 409, 'REVISION_CONFLICT'); }
export function targets(task) {
  if (!task.report) return [];
  return [{ id: 'summary', title: '总体摘要', value: task.report, fields: ['summary'] }, ...(task.report.issues || []).map(i => ({ id: i.id, title: i.title, value: i, fields: ['title', 'description', 'impact', 'suggestion'] })), ...(task.report.cases || []).map(c => ({ id: c.id, title: c.title, value: c, fields: ['title', 'preconditions', 'steps'] })), ...(task.report.risks || []).map((r,i) => ({ id: `RISK-${i+1}`, title: r.title, value: r, fields: ['title', 'analysis', 'recommendation'] }))];
}
export function qualityOf(task) {
  if (task.quality) return task.quality;
  const quotes = [...new Set([...(task.report?.cases || []), ...(task.report?.issues || [])].map(c => c.quote).filter(Boolean))];
  return { revision: 0, baselineComplete: false, requirements: quotes.flatMap(quote => {
    const b = task.source?.blocks?.find(b => b.text.includes(quote));
    return b ? [{ id: `R-${hash(quote).slice(0,10)}`, title: quote.slice(0,100), quote, blockId: b.id, status: 'pending', note: '' }] : [];
  }), links: {}, feedback: Object.fromEntries((task.report?.issues || []).filter(i => ['accepted','dismissed'].includes(i.status)).map(i => [i.id, { status: i.status, actor: '历史审核记录', note: '旧版本未记录审核人及理由，请按需补充。' }])), audit: [] };
}
const adopted = f => ['accepted', 'modified'].includes(f?.status);
export function qualitySummary(task) {
  const q = qualityOf(task), all = targets(task);
  const confirmed = q.requirements.filter(r => r.status === 'confirmed');
  const cases = task.report?.cases || [];
  const covered = confirmed.filter(r => cases.some(c => adopted(q.feedback[c.id]) && q.links[c.id]?.includes(r.id)));
  return { total: all.length, reviewed: all.filter(t => q.feedback[t.id] && q.feedback[t.id].status !== 'pending').length, adopted: all.filter(t => adopted(q.feedback[t.id])).length, rejected: all.filter(t => q.feedback[t.id]?.status === 'dismissed').length, confirmedRequirements: confirmed.length, coveredRequirements: covered.length, coverage: confirmed.length && q.baselineComplete ? covered.length / confirmed.length : null, baselineComplete: q.baselineComplete, unlinkedCases: cases.filter(c => !q.links[c.id]?.length).length };
}
export function mutateQuality(task, input, otherTask) {
  object(input);
  if (!task.report || task.status !== 'completed') throw new AppError('请等待任务完成再审核。', 409);
  if (['creating', 'uncertain', 'verifying', 'verify_failed'].includes(task.publish.status)) throw new AppError('请先完成已有飞书快照的写入与核验，再修改内容。', 409);
  const q = structuredClone(qualityOf(task)); revision(q.revision, input.revision);
  const actor = text(input.actor, '审核人', 100);
  const note = text(input.note ?? '', '说明', 2400, false);
  if (input.action === 'feedback') {
    const target = targets(task).find(t => t.id === input.targetId);
    if (!target || !decisions.includes(input.status)) throw new AppError('审核对象或状态无效。');
    if (input.status !== 'pending' && !note) throw new AppError('请填写采纳依据、澄清结论或驳回原因。');
    let patch;
    if (input.status === 'modified') {
      patch = object(input.patch);
      if (!Object.keys(patch).length || Object.keys(patch).some(k => !target.fields.includes(k))) throw new AppError('修订字段无效。');
      for (const [k,v] of Object.entries(patch)) {
        if (k === 'steps') {
          if (!Array.isArray(v) || !v.length || v.length > 15) throw new AppError('用例步骤需要 1–15 条。');
          patch.steps = v.map(s => ({ action: text(s.action, '步骤'), expected: text(s.expected, '预期') }));
        } else patch[k] = text(v, '修订内容', k === 'title' ? 180 : 2400);
      }
      if (Object.keys(patch).every(k => JSON.stringify(patch[k]) === JSON.stringify(target.value[k]))) throw new AppError('修改后采纳需要实际修订内容。');
      task.generatedReport ||= structuredClone(task.report);
      Object.assign(target.value, patch);
    } else if (input.patch && Object.keys(input.patch).length) throw new AppError('仅“修改后采纳”支持修订内容。');
    q.feedback[target.id] = { status: input.status, actor, note, updatedAt: now() };
    if (task.report.issues?.includes(target.value)) target.value.status = input.status === 'modified' ? 'accepted' : input.status;
  } else if (input.action === 'requirement') {
    if (task.kind === 'bugs') throw new AppError('缺陷报告请关联执行计划。');
    if (!['pending', 'confirmed', 'excluded'].includes(input.status)) throw new AppError('需求状态无效。');
    const quote = text(input.quote, '需求依据', 5000);
    const block = task.source.blocks.find(b => b.text.includes(quote));
    if (!block) throw new AppError('需求依据必须能在本次文档快照中定位。');
    if (input.status !== 'pending' && !note) throw new AppError('确认或排除需求时请填写说明。');
    const id = input.requirementId || `R-${randomUUID().slice(0,8)}`;
    const old = q.requirements.find(r => r.id === id);
    if (input.requirementId && !old) throw new AppError('需求点不存在。', 404);
    const value = { id, title: text(input.title, '需求点名称', 180), quote, blockId: block.id, status: input.status, note, actor };
    if (old) Object.assign(old, value); else q.requirements.push(value);
    q.baselineComplete = false;
  } else if (input.action === 'baseline') {
    if (typeof input.complete !== 'boolean' || !q.requirements.some(r => r.status === 'confirmed')) throw new AppError('请先确认至少一个需求点。');
    if (input.complete && q.requirements.some(r => r.status === 'pending')) throw new AppError('请逐条确认或排除候选需求点后，再确认范围。');
    if (!note) throw new AppError('请说明此次基线包含的业务范围。');
    q.baselineComplete = input.complete; q.baseline = { actor, note, updatedAt: now() };
  } else if (input.action === 'import-baseline') {
    if (!otherTask?.source?.fingerprint || otherTask.source.fingerprint !== task.source?.fingerprint || otherTask.source?.url !== task.source?.url || otherTask.id === task.id) throw new AppError('只能复用同一文档、相同正文快照的其他任务基线。');
    if (q.requirements.some(r => r.status !== 'pending') || Object.keys(q.links).length) throw new AppError('当前基线已有人工修改或关联，不能覆盖。');
    const other = qualityOf(otherTask);
    q.requirements = structuredClone(other.requirements); q.baselineComplete = false;
    q.importedFrom = otherTask.id;
  } else if (input.action === 'suggest-links') {
    if (!task.report.cases) throw new AppError('仅测试用例可以匹配关联。');
    for (const c of task.report.cases) {
      const matched = q.requirements.filter(r => r.status === 'confirmed' && c.quote?.length >= 4 && (r.quote.includes(c.quote) || c.quote.includes(r.quote))).map(r => r.id);
      if (matched.length) q.links[c.id] = [...new Set([...(q.links[c.id] || []), ...matched])];
    }
  } else if (input.action === 'links') {
    if (!task.report.cases?.some(c => c.id === input.caseId)) throw new AppError('用例不存在。');
    if (!Array.isArray(input.requirementIds) || input.requirementIds.some(id => !q.requirements.some(r => r.id === id && r.status === 'confirmed'))) throw new AppError('只能关联本任务已确认的需求点。');
    q.links[input.caseId] = [...new Set(input.requirementIds)];
  } else throw new AppError('审核操作无效。');
  q.audit.push({ change: { requirement: input.action === 'requirement' ? structuredClone(q.requirements.find(r => r.id === input.requirementId) || q.requirements.at(-1)) : undefined, links: ['links','suggest-links'].includes(input.action) ? structuredClone(q.links) : undefined, baselineComplete: q.baselineComplete, importedFrom: input.action === 'import-baseline' ? q.importedFrom : undefined }, time: now(), actor, note, action: input.action, target: input.targetId || input.caseId || input.requirementId || null, status: input.status || null, beforeRevision: q.revision, patch: input.status === 'modified' ? structuredClone(input.patch) : undefined });
  q.revision++; task.quality = q;
  if (task.publish.url) task.publish.outOfDate = true;
  return task;
}
export function createRun(task, input) {
  object(input);
  if (task.kind !== 'cases' || task.status !== 'completed' || !task.report?.cases?.length) throw new AppError('请选择已完成的测试用例任务。');
  const q = qualityOf(task);
  const cases = task.report.cases.filter(c => adopted(q.feedback[c.id]));
  if (!cases.length) throw new AppError('请先审核并采纳要执行的用例。执行计划只包含已采纳用例。');
  return { id: randomUUID(), kind: 'execution', revision: 0, taskId: task.id, title: task.title, version: text(input.version, '版本', 150), environment: text(input.environment, '环境', 150), build: text(input.build, '构建号', 150), owner: text(input.owner, '负责人', 100), createdAt: now(), updatedAt: now(), sourceFingerprint: task.source.fingerprint, sourceUrl: task.source.url, qualityRevision: q.revision, requirements: structuredClone(q.requirements.filter(r => r.status === 'confirmed')), baselineComplete: q.baselineComplete, cases: structuredClone(cases), feedback: structuredClone(q.feedback), links: structuredClone(q.links), results: {}, history: [] };
}
export function normalizeResults(run, rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 80) throw new AppError('每次导入需要 1–80 条执行结果。');
  const seen = new Set();
  return rows.map((row, index) => {
    object(row); const caseId = text(row.caseId, `第 ${index+1} 行用例 ID`, 100);
    if (seen.has(caseId) || !run.cases.some(c => c.id === caseId)) throw new AppError(`第 ${index+1} 行用例 ${caseId} 重复或不属于该执行计划。`);
    seen.add(caseId);
    if (!executionStatuses.includes(row.status)) throw new AppError(`第 ${index+1} 行状态无效。`);
    const actual = text(row.actual ?? '', '实际结果', 4000, row.status !== 'not_run');
    const evidence = text(row.evidence ?? '', '执行证据', 2000, false);
    const tester = text(row.tester ?? '', '执行人', 100, row.status !== 'not_run');
    const bugIds = typeof row.bugIds === 'string' ? row.bugIds.split(/[，,]/).map(s=>s.trim()).filter(Boolean) : row.bugIds || [];
    if (!Array.isArray(bugIds) || bugIds.length > 30 || bugIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) throw new AppError('缺陷 ID 需使用记录 ID 或工单编号，多个以逗号分隔。');
    return { caseId, status: row.status, actual, evidence, tester, bugIds: [...new Set(bugIds)] };
  });
}
export function applyResults(run, input) {
  object(input); revision(run.revision, input.revision);
  const rows = normalizeResults(run, input.rows);
  const time = now();
  for (const row of rows) { run.history.push({ caseId: row.caseId, before: run.results[row.caseId] || null, after: row, time }); run.results[row.caseId] = { ...row, recordedAt: time }; }
  run.revision++; run.updatedAt = time; return run;
}
export function executionSummary(run) {
  const counts = Object.fromEntries(executionStatuses.map(s => [s,0]));
  for (const c of run.cases) counts[run.results[c.id]?.status || 'not_run']++;
  const executed = counts.passed + counts.failed;
  const covered = run.requirements.filter(r => run.cases.some(c => run.links[c.id]?.includes(r.id)));
  const verified = run.requirements.filter(r => { const linked = run.cases.filter(c => run.links[c.id]?.includes(r.id)); return linked.length && linked.every(c => run.results[c.id]?.status === 'passed'); });
  return { planned: run.cases.length, ...counts, executed, passRate: executed ? counts.passed / executed : null, requirements: run.requirements.length, linkedRequirements: covered.length, passedRequirements: verified.length, coverage: run.baselineComplete && run.requirements.length ? covered.length / run.requirements.length : null };
}
export function attachExecution(task, run, input) {
  if (task.kind !== 'bugs' || task.status !== 'completed') throw new AppError('只有已完成的版本报告可以关联执行快照。');
  if (['creating', 'uncertain', 'verifying', 'verify_failed'].includes(task.publish.status)) throw new AppError('请先完成已有飞书快照核验，再关联执行结果。', 409);
  revision(qualityOf(task).revision, input.revision);
  if (task.source.version !== run.version) throw new AppError('执行计划版本必须与报告版本精确一致。');
  if (input.confirmScope !== true) throw new AppError('请确认执行计划与 BugList 属于同一项目和测试范围。');
  const actor = text(input.actor, '确认人', 100);
  task.execution = structuredClone(run);
  const q = structuredClone(qualityOf(task)); q.revision++; q.audit.push({ time: now(), actor, action: 'attach-execution', target: run.id, runRevision: run.revision }); task.quality = q;
  if (task.publish.url) task.publish.outOfDate = true;
  return task;
}
export function parseImport(content, format) {
  text(content, '导入内容', 200000);
  if (format === 'json') { let data; try { data = JSON.parse(content); } catch { throw new AppError('JSON 格式不正确。'); } return Array.isArray(data) ? data : data.rows; }
  if (format !== 'csv') throw new AppError('仅支持 JSON 或 CSV。');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ''; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(s => s.length)) rows.push(row); row = []; };
  for (let i=0; i<content.length; i++) {
    const c = content[i];
    if (quoted) { if (c === '"') { if (content[i+1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === ',' ) pushCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && content[i+1] === '\n') i++; pushRow(); }
    else if (c === '"' && !cell && !closed) quoted = true;
    else { if (closed || c === '"') throw new AppError('CSV 引号格式不正确。'); cell += c; }
  }
  if (quoted) throw new AppError('CSV 引号未闭合。'); pushRow();
  const headers = rows.shift()?.map(s => s.replace(/^\uFEFF/, '').trim());
  const allowed = ['caseId','status','actual','evidence','tester','bugIds'];
  if (!headers || new Set(headers).size !== headers.length || headers.some(h=>!allowed.includes(h)) || !['caseId','status','actual','tester'].every(h=>headers.includes(h))) throw new AppError('CSV 表头需包含 caseId,status,actual,tester；可选 evidence,bugIds。');
  return rows.map(r => { if (r.length !== headers.length) throw new AppError('CSV 列数与表头不一致。'); return Object.fromEntries(headers.map((h,i)=>[h,r[i]])); });
}
const safe = s => String(s ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]);
const decisionNames = { pending:'待审核', accepted:'已采纳', modified:'修改后采纳', dismissed:'不采纳' };
export function qualityMarkdown(task) {
  if (!task.quality && !task.execution) return '';
  const q = qualityOf(task), lines = ['## 人工审核与需求追溯', '此节记录人工决定，不代表自动正确性认证。'];
  for (const t of targets(task)) { const f=q.feedback[t.id]; if(f) lines.push(`- ${safe(t.id)} · ${decisionNames[f.status]} · ${safe(f.actor)}：${safe(f.note)}`); }
  if(q.requirements.length) {
    lines.push(`需求范围：${q.baselineComplete ? '人工确认完整' : '尚未确认完整，不能据此宣称需求全覆盖'}`);
    for(const r of q.requirements) lines.push(`- ${r.id} · ${safe(r.title)} · ${r.status}；依据：${safe(r.quote)}；说明：${safe(r.note)}`);
    for(const [id,ids] of Object.entries(q.links)) lines.push(`- ${id} → ${ids.join('、') || '未关联需求'}`);
  }
  if(task.execution) lines.push(executionMarkdown(task.execution, task.source?.records));
  return '\n\n' + lines.join('\n\n');
}
export function executionMarkdown(run, records) {
  const s = executionSummary(run);
  const lines = ['## 测试执行快照', `计划：${run.id}；版本：${safe(run.version)}；环境：${safe(run.environment)}；构建：${safe(run.build)}；负责人：${safe(run.owner)}`, `快照修订：${run.revision}；最后记录：${run.updatedAt}`, `计划用例：${s.planned}；通过：${s.passed}；失败：${s.failed}；阻塞：${s.blocked}；跳过：${s.skipped}；未执行：${s.not_run}`, `通过率（通过 / [通过+失败]）：${s.passRate === null ? '暂无可计算数据' : (s.passRate*100).toFixed(1)+'%'}。阻塞、跳过和未执行不计入此分母。`, `已确认需求点：${s.requirements}；有关联用例：${s.linkedRequirements}；关联用例全部通过：${s.passedRequirements}。${run.baselineComplete ? '基线范围已人工确认。' : '基线范围未确认完整，不计算需求覆盖率。'}`, '执行结果来自人工填写或导入，系统未独立运行测试；通过率不等于可上线。'];
  for(const c of run.cases) { const r=run.results[c.id]; lines.push(`- ${c.id} · ${safe(c.title)} · ${r?.status || 'not_run'}；实际：${safe(r?.actual)}；证据：${safe(r?.evidence)}；执行人：${safe(r?.tester)}；缺陷：${(r?.bugIds || []).map(id => `${safe(id)}${records ? records.some(b=>b.id===id) ? '（已匹配本报告）' : '（未匹配本报告）' : ''}`).join('、')}`); }
  return lines.join('\n\n');
}
