import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, cost, pricing, withMetering } from '../src/usage.js';
import { configuration, requestModel } from '../src/integrations.js';
const config=configuration({LLM_PROVIDER:'gemini',LLM_MODEL:'gemini-3.8-flash',LLM_API_KEY:'private-key',LLM_INPUT_USD_PER_MILLION:'1',LLM_OUTPUT_USD_PER_MILLION:'4',LLM_CACHED_USD_PER_MILLION:'.1'});
const request={system:'system',input:'input',schema:{type:'object'},name:'test'};
test('兼容接口输出已含思考不重复累加，原生 Gemini 分项则累加',()=>{
 assert.deepEqual(normalizeUsage({usage:{prompt_tokens:100,completion_tokens:50,prompt_tokens_details:{cached_tokens:20},completion_tokens_details:{reasoning_tokens:30}}}),{input:100,output:50,cached:20,reasoning:30});
 assert.equal(normalizeUsage({usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:30}}).output,50);
 assert.equal(cost({input:100,output:50,cached:20}, {input:1,output:4,cached:.1}),.000282);
 assert.equal(cost(normalizeUsage({}),pricing(config.llm)),null);
 assert.equal(pricing({...config.llm,pricing:null},'2027-01-01'),null);
 assert.equal(pricing({...config.llm,pricing:null,model:'unknown'}),null);
});
test('成功、JSON解析失败、截断和网络失败均记账，秘密不入账',async()=>{
 for(const mode of ['success','invalid','truncated','network']) {
   const entries=[];
   const run=()=>withMetering(e=>entries.push(structuredClone(e)),()=>requestModel(request,config,async()=>{
     if(mode==='network')throw new Error('private-key');
     return Response.json({choices:[{finish_reason:mode==='truncated'?'length':'stop',message:{content:mode==='invalid'?'bad':'{}'}}],usage:{prompt_tokens:100,completion_tokens:50}});
   }));
   if(mode==='success')await run();else await assert.rejects(run());
   assert.equal(entries.length,2);assert.equal(entries[0].status,'started');assert.equal(entries[1].status,mode==='success'?'completed':'failed');
   assert.equal(entries[1].estimatedUsd,mode==='network'?null:.0003);
   assert.ok(!JSON.stringify(entries).includes('private-key'));
 }
});
test('并发任务用量不会串账',async()=>{
 const a=[],b=[];
 await Promise.all([withMetering(e=>a.push(structuredClone(e)),()=>requestModel({...request,name:'A'},config,async()=>{await new Promise(r=>setTimeout(r,10));return Response.json({choices:[{finish_reason:'stop',message:{content:'{}'}}]});})),withMetering(e=>b.push(structuredClone(e)),()=>requestModel({...request,name:'B'},config,async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'{}'}}]})))]);
 assert.ok(a.every(e=>e.operation==='A'));assert.ok(b.every(e=>e.operation==='B'));
});
test('空单价不当作零价格，部分或无效配置保持未知',()=>{
 const empty=configuration({LLM_PROVIDER:'gemini',LLM_MODEL:'gemini-3.8-flash',LLM_INPUT_USD_PER_MILLION:'',LLM_OUTPUT_USD_PER_MILLION:''});
 assert.equal(pricing(empty.llm,'2026-10-16').input,.75);
 const partial=configuration({LLM_PROVIDER:'gemini',LLM_MODEL:'gemini-3.8-flash',LLM_INPUT_USD_PER_MILLION:'1',LLM_OUTPUT_USD_PER_MILLION:''});assert.equal(pricing(partial.llm,'2026-10-16'),null);
});
