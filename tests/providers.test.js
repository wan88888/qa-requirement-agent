import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, modelReview, modelConfigError, publicModelConfig, MODEL_PROVIDERS } from '../src/integrations.js';
import { parseSource, DEMO_DOCUMENT, demoReview, validateReview } from '../src/review.js';

const source = parseSource(DEMO_DOCUMENT.content, DEMO_DOCUMENT.title);
const env = { LLM_API_KEY: 'fake-secret', LLM_MODEL: 'account-model' };
for (const provider of ['openai', 'gemini', 'deepseek', 'agnes']) {
  test(`${provider} 预设请求正确地址、协议与输出格式`, async () => {
    const config = configuration({ ...env, LLM_PROVIDER: provider });
    const preset = MODEL_PROVIDERS[provider];
    assert.equal(modelConfigError(config), null);
    const result = await modelReview(source, config, async (url, init) => {
      assert.equal(String(url), `${preset.baseUrl}/${preset.mode === 'responses' ? 'responses' : 'chat/completions'}`);
      assert.equal(init.headers.Authorization, 'Bearer fake-secret');
      const body = JSON.parse(init.body);
      assert.equal(body.model, env.LLM_MODEL);
      if (provider === 'openai') assert.equal(body.text.format.type, 'json_schema');
      else if (provider === 'agnes') assert.equal(Object.hasOwn(body, 'response_format'), false);
      else assert.equal(body.response_format.type, preset.outputFormat);
      if (provider === 'openai') {
        const fields = body.text.format.schema.properties.issues.items.properties;
        for (const field of ['category', 'dimension', 'priority', 'evidenceType']) assert.equal(fields[field].type, 'string');
      }
      if (preset.outputFormat !== 'json_schema') {
        assert.ok(body.messages[0].content.includes('JSON Schema'));
        assert.ok(body.messages[0].content.includes('evidenceType'));
      }
      return Response.json(preset.mode === 'responses'
        ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(demoReview(source)) }] }] }
        : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(demoReview(source)) } }] });
    });
    assert.equal(validateReview(result, source).issues.length, 8);
  });
}

test('自定义服务支持明确覆盖，旧配置继续可用', () => {
  assert.equal(configuration(env).llm.mode, 'responses');
  const config = configuration({ ...env, LLM_PROVIDER: 'custom', LLM_BASE_URL: 'http://127.0.0.1:1234/v1', LLM_API_MODE: 'responses', LLM_OUTPUT_FORMAT: 'text' });
  assert.equal(modelConfigError(config), null);
  assert.equal(config.llm.outputFormat, 'text');
  assert.equal(config.llm.mode, 'responses');
});

test('错误服务商、格式、地址与遗留覆盖在发送密钥前被拒绝', async () => {
  for (const overrides of [
    { LLM_PROVIDER: 'unknown' }, { LLM_OUTPUT_FORMAT: 'invalid' }, { LLM_API_MODE: 'invalid' },
    { LLM_PROVIDER: 'custom' }, { LLM_BASE_URL: 'https://api.openai.com/v1?key=fake-secret' },
    { LLM_PROVIDER: 'gemini', LLM_BASE_URL: 'https://api.openai.com/v1' },
    { LLM_BASE_URL: 'https://user:fake-secret@api.openai.com/v1' },
  ]) {
    const config = configuration({ ...env, ...overrides });
    await assert.rejects(modelReview(source, config, () => assert.fail('不得发送网络请求')));
    const publicConfig = JSON.stringify(publicModelConfig(config));
    assert.equal(publicConfig.includes('fake-secret'), false);
    assert.equal(publicModelConfig(config).configured, false);
  }
});

test('Agnes 的普通文本、围栏 JSON 和不合规结构不能生成有效报告', async () => {
  const config = configuration({ ...env, LLM_PROVIDER: 'agnes' });
  for (const content of ['不是 JSON', '```json\n{}\n```']) {
    await assert.rejects(modelReview(source, config, async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })), /JSON/);
  }
  const invalid = await modelReview(source, config, async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"bad"}' } }] }));
  assert.throws(() => validateReview(invalid, source), /结构/);
});
