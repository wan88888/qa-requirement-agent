import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityOf, mutateQuality, qualitySummary, createRun, applyResults, executionSummary, attachExecution, parseImport, qualityMarkdown } from '../src/quality.js';
import { parseSource, DEMO_DOCUMENT } from '../src/review.js';
const source = parseSource(DEMO_DOCUMENT.content, '需求', 'https://test.feishu.cn/docx/abc');
const quote = '订单支付后 7 天内允许退款。';
const makeTask = () => ({ id:'task1', kind:'cases', status:'completed', title:'测试用例', source, publish:{status:'idle'}, report:{summary:'摘要', cases:[{id:'TC001',title:'退款',priority:'P0',quote,assumptions:[],preconditions:'已支付',steps:[{action:'退款',expected:'退款成功'}]},{id:'TC002',title:'边界',quote,assumptions:[],preconditions:'已支付',steps:[{action:'退款',expected:'拒绝'}]}]} });
const edit=(t,input)=>mutateQuality(t,{revision:qualityOf(t).revision,actor:'测试人',note:'依据需求确认',...input});
const approve = t => { edit(t,{action:'feedback',targetId:'TC001',status:'accepted'}); return t; };
const plan = t => createRun(t,{version:'1.6.2',environment:'test',build:'123',owner:'QA'});
test('审核修订保留原始稿和前后历史，拒绝无依据及过期写入',()=>{
 const t=makeTask();
 assert.throws(()=>edit(t,{action:'feedback',targetId:'TC001',status:'accepted',note:''}),/依据/);
 edit(t,{action:'feedback',targetId:'TC001',status:'modified',patch:{steps:[{action:'提交退款',expected:'进入退款处理中'}]}});
 assert.equal(t.generatedReport.cases[0].steps[0].expected,'退款成功');
 assert.equal(t.report.cases[0].steps[0].expected,'进入退款处理中');
 assert.equal(t.quality.audit[0].patch.steps[0].expected,'进入退款处理中');
 assert.throws(()=>mutateQuality(t,{revision:0,actor:'QA',action:'feedback'}),/刷新/);
 assert.throws(()=>edit(t,{action:'feedback',targetId:'TC001',status:'modified',patch:{quote:'编造来源'}}),/字段/);
});
test('覆盖率只计算人工确认基线、明确关联且采纳的用例',()=>{
 const t=makeTask(), r=qualityOf(t).requirements[0];
 assert.equal(qualitySummary(t).coverage,null);
 edit(t,{action:'requirement',requirementId:r.id,title:r.title,quote:r.quote,status:'confirmed'});
 edit(t,{action:'baseline',complete:true});
 edit(t,{action:'links',caseId:'TC001',requirementIds:[r.id]});
 assert.equal(qualitySummary(t).coverage,0);
 approve(t); assert.equal(qualitySummary(t).coverage,1);
 edit(t,{action:'feedback',targetId:'TC001',status:'dismissed'});assert.equal(qualitySummary(t).coverage,0);
 edit(t,{action:'requirement',title:'新增',quote,status:'pending'}); assert.equal(qualitySummary(t).coverage,null);
 assert.throws(()=>edit(t,{action:'baseline',complete:true}),/逐条/);
 assert.throws(()=>edit(t,{action:'requirement',title:'伪造',quote:'原文没有',status:'confirmed'}),/定位/);
});
test('不能跨文档导入基线，导入后范围需要重新确认',()=>{
 const t=makeTask(), other={...makeTask(),id:'task2'};
 assert.throws(()=>mutateQuality(t,{action:'import-baseline',revision:0,actor:'QA'},{...other,source:{...source,fingerprint:'changed'}}),/相同正文/);
 mutateQuality(t,{action:'import-baseline',revision:0,actor:'QA'},other);
 assert.equal(t.quality.importedFrom,'task2');assert.equal(t.quality.baselineComplete,false);
});
test('执行计划只冻结采纳用例，后续修改不能污染执行快照',()=>{
 const t=makeTask();assert.throws(()=>plan(t),/先审核/);approve(t);
 const r=plan(t);assert.equal(r.cases.length,1);
 t.report.cases[0].title='后改';assert.equal(r.cases[0].title,'退款');
 applyResults(r,{revision:0,rows:[{caseId:'TC001',status:'passed',actual:'退款成功',tester:'QA'}]});
 assert.equal(executionSummary(r).passRate,1);assert.equal(r.history.length,1);
 assert.throws(()=>applyResults(r,{revision:0,rows:[]}),/刷新/);
 applyResults(r,{revision:1,rows:[{caseId:'TC001',status:'blocked',actual:'环境异常',tester:'QA'}]});
 assert.equal(executionSummary(r).passRate,null);assert.equal(r.history[1].before.status,'passed');
});
test('导入原子校验，未知用例、重复、非法状态、缺少实际结果均拒绝',()=>{
 const r=plan(approve(makeTask()));
 const good={caseId:'TC001',status:'passed',actual:'预期一致',tester:'QA'};
 for(const rows of [[good,{...good,caseId:'bad'}],[good,good],[{...good,status:'PASS'}],[{...good,actual:''}]]) assert.throws(()=>applyResults(r,{revision:0,rows}));
 assert.deepEqual(r.results,{});assert.equal(r.revision,0);
 const csv='\uFEFFcaseId,status,actual,tester,evidence,bugIds\r\nTC001,passed,"含逗号,和\n换行",QA,"引用""双引号",recABC';
 const rows=parseImport(csv,'csv');assert.equal(rows[0].actual,'含逗号,和\n换行');assert.equal(rows[0].evidence,'引用"双引号');
 applyResults(r,{revision:0,rows});assert.deepEqual(r.results.TC001.bugIds,['recABC']);
 for(const csv of ['caseId,status,actual,tester\na,passed,"abc,QA','caseId,status,actual,tester\na,passed,x,QA,extra']) assert.throws(()=>parseImport(csv,'csv'));
});
test('报告执行快照要求版本和项目确认，关联后不受计划后续更新影响',()=>{
 const r=plan(approve(makeTask()));
 const report={kind:'bugs',status:'completed',source:{version:'1.6.3',records:[]},report:{summary:'缺陷摘要',risks:[]},publish:{url:'https://test.feishu.cn/docx/abc'}};
 assert.throws(()=>attachExecution(report,r,{revision:0,actor:'QA',confirmScope:true}),/版本/);
 report.source.version='1.6.2';assert.throws(()=>attachExecution(report,r,{revision:0,actor:'QA'}),/同一项目/);
 attachExecution(report,r,{revision:0,actor:'QA',confirmScope:true});
 applyResults(r,{revision:0,rows:[{caseId:'TC001',status:'passed',actual:'通过',tester:'QA'}]});
 assert.deepEqual(report.execution.results,{});assert.equal(report.publish.outOfDate,true);assert.match(qualityMarkdown(report),/暂无可计算数据/);
});
