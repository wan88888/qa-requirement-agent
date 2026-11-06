import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const context = new AsyncLocalStorage();
export const withMetering = (sink, fn) => context.run(sink, fn);
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
export function normalizeUsage(data) {
  const u = data?.usage, g = data?.usageMetadata;
  if (g) return { input: number(g.promptTokenCount), output: number(g.candidatesTokenCount) === null ? null : g.candidatesTokenCount + (number(g.thoughtsTokenCount) || 0), cached: number(g.cachedContentTokenCount) || 0, reasoning: number(g.thoughtsTokenCount) || 0 };
  return { input: number(u?.input_tokens ?? u?.prompt_tokens), output: number(u?.output_tokens ?? u?.completion_tokens), cached: number(u?.input_tokens_details?.cached_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens) || 0, reasoning: number(u?.output_tokens_details?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens) || 0 };
}
export function pricing(llm, time = new Date().toISOString()) {
  const custom = llm.pricing;
  if (custom && number(custom.input) !== null && number(custom.output) !== null) return { ...custom, cached: number(custom.cached) ?? custom.input, currency: 'USD', basis: '本地配置单价', asOf: time.slice(0, 10) };
  if (custom) return null;
  // Only this verified official endpoint/model has a built-in tariff. Unknown is never zero.
  if (llm.provider === 'gemini' && llm.model === 'gemini-3.8-flash' && llm.baseUrl.replace(/\/+$/, '') === 'https://generativelanguage.googleapis.com/v1beta/openai' && time >= '2026-10-16' && time < '2027-01-01') return { input: .75, output: 3.75, cached: .075, currency: 'USD', basis: 'Google 标准付费价；非实际账单', asOf: '2026-10-16', source: 'https://ai.google.dev/gemini-api/docs/pricing' };
  return null;
}
export function cost(usage, rate) {
  if (!rate || usage.input === null || usage.output === null || usage.cached > usage.input) return null;
  return ((usage.input - usage.cached) * rate.input + usage.cached * rate.cached + usage.output * rate.output) / 1e6;
}
export function startCall(config, operation, images) {
  const sink = context.getStore();
  const entry = { id: randomUUID(), operation, provider: config.llm.provider, model: config.llm.model, startedAt: new Date().toISOString(), imageCount: images.length, status: 'started', usage: normalizeUsage(null), estimatedUsd: null };
  entry.pricing = pricing(config.llm, entry.startedAt);
  sink?.(entry);
  return (data, error) => {
    entry.usage = normalizeUsage(data); entry.estimatedUsd = cost(entry.usage, entry.pricing);
    entry.status = error ? 'failed' : 'completed'; entry.errorCode = error?.code || (error ? 'MODEL_FAILED' : null);
    entry.durationMs = Date.now() - Date.parse(entry.startedAt); entry.finishedAt = new Date().toISOString(); sink?.(entry);
  };
}
export function usageSummary(task) {
  const calls = task.usage?.calls || [];
  return { recorded: Boolean(task.usage), calls: calls.length, unknown: calls.filter(c => c.estimatedUsd === null).length, input: calls.reduce((s,c) => s + (c.usage.input || 0), 0), output: calls.reduce((s,c) => s + (c.usage.output || 0), 0), estimatedUsd: calls.reduce((s,c) => s + (c.estimatedUsd || 0), 0), failed: calls.filter(c => c.status !== 'completed').length };
}
