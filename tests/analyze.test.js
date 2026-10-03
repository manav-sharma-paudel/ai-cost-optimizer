import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, loadConfig, resolveRoot, DEFAULT_ASSUMPTIONS } from '../server/lib/analyze.js';
import { renderMarkdown } from '../server/lib/report.js';
import { loadPricing } from '../server/lib/pricing.js';
import { FIXTURE, PRICING_FIXTURE, tmpProject } from './helpers.js';

const R = audit(FIXTURE);
const rules = (site) => R.findings.filter((f) => f.site === site).map((f) => f.rule).sort();
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('expected findings on the fixture (true positives)', () => {
  assert.deepEqual(rules('lib/classify.ts:6'), ['model-overkill']);
  assert.deepEqual(rules('jobs/nightly-summaries.ts:7'), ['batch-api-candidate', 'high-max-tokens', 'llm-call-in-loop', 'model-overkill', 'no-prompt-cache']);
  assert.ok(rules('lib/embeddings.ts:7').includes('embedding-model-size'));
  assert.ok(rules('workers/enrich.py:9').includes('batch-api-candidate'));
  assert.ok(rules('lib/router.ts:6').includes('unresolved-model'));
});
test('true negatives: user-facing premium chat route and already-cached route are NOT flagged for savings', () => {
  assert.deepEqual(rules('app/api/chat/route.ts:7'), []);
  assert.deepEqual(rules('app/api/summarize/route.ts:7').filter((r) => r !== 'duplicate-static-prompt'), []);
});
test('hand-verified classify.ts numbers', () => {
  // gpt-5.6: 524 input tok * $4/M + 20 output * $20/M = 0.002496/call * 200,000 calls
  const s = R.sites.find((x) => x.id === 'lib/classify.ts:6');
  close(s.monthly_usd, 499.2);
  assert.equal(s.volume_source, 'configured');
});
test('savings are non-overlapping and reconcile with totals', () => {
  const s = R.summary;
  const sum = R.findings.reduce((x, f) => x + (f.saving_monthly_usd ?? 0), 0);
  close(sum, s.total_potential_savings_monthly_usd, 0.05);
  close(s.estimated_monthly_usd - s.total_potential_savings_monthly_usd, s.after_all_usd, 0.05);
  close(s.estimated_monthly_usd - s.mechanical_savings_monthly_usd, s.after_mechanical_usd, 0.05);
  assert.ok(s.after_all_usd >= 0);
  for (const x of R.sites) if (x.monthly_usd != null) assert.ok(x.optimized_monthly_usd <= x.monthly_usd + 0.01 && x.optimized_monthly_usd >= 0);
});
test('mechanical vs needs-eval are separated; caching is the only mechanical rule', () => {
  const mech = R.findings.filter((f) => f.class === 'mechanical');
  assert.ok(mech.length >= 1 && mech.every((f) => f.rule === 'no-prompt-cache'));
});
test('unresolved sites are excluded from totals and counted', () => {
  assert.equal(R.summary.unpriced_sites, 2);
  assert.equal(R.summary.priced_sites, 6);
});
test('high-max-tokens makes no dollar claim', () => {
  assert.equal(R.findings.find((f) => f.rule === 'high-max-tokens').saving_monthly_usd, null);
});
test('duplicate static prompt detected across files', () => {
  assert.ok(R.findings.some((f) => f.rule === 'duplicate-static-prompt' && f.evidence.length === 2));
});
test('report states estimates, assumptions and limits', () => {
  const md = renderMarkdown(R);
  assert.match(md, /static ESTIMATES, not measured spend/);
  assert.match(md, /## Assumptions/); assert.match(md, /cannot know/);
  assert.ok(!md.includes('SUPERSECRET'));
});
test('defaults are labelled "assumed-default" and loop multiplier applies only to defaults', () => {
  const dir = tmpProject({ 'a.ts': 'import OpenAI from "openai";\nconst c = new OpenAI();\nfor (const x of y) { await c.chat.completions.create({ model: "gpt-5.6-luna", messages: [] }); }\n' });
  const r = audit(dir);
  assert.equal(r.sites[0].volume_source, 'assumed-default');
  assert.equal(r.sites[0].calls_per_month, DEFAULT_ASSUMPTIONS.calls_per_month * DEFAULT_ASSUMPTIONS.loop_multiplier);
  const r2 = audit(dir, { assumptions: { loop_multiplier: 1 } });
  assert.equal(r2.sites[0].calls_per_month, DEFAULT_ASSUMPTIONS.calls_per_month);
});
test('config: invalid values ignored, bad JSON reported, never throws', () => {
  const d1 = tmpProject({ '.ai-cost-optimizer.json': JSON.stringify({ assumptions: { calls_per_month: -5, cache_hit_rate: 7, avg_output_tokens: 'lots' } }) });
  const c = loadConfig(d1);
  assert.equal(c.assumptions.calls_per_month, DEFAULT_ASSUMPTIONS.calls_per_month);
  assert.equal(c.assumptions.cache_hit_rate, 1);
  assert.equal(c.assumptions.avg_output_tokens, DEFAULT_ASSUMPTIONS.avg_output_tokens);
  assert.ok(loadConfig(tmpProject({ '.ai-cost-optimizer.json': '{oops' })).config_error);
});
test('unknown model -> reported, not priced, not guessed', () => {
  const dir = tmpProject({ 'a.ts': 'import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ model: "my-finetune-v3", messages: [] });\n' });
  const r = audit(dir, { pricing: loadPricing({ snapshotPath: PRICING_FIXTURE }) });
  assert.equal(r.summary.priced_sites, 0);
  assert.ok(r.findings.some((f) => f.rule === 'unknown-model-pricing'));
});
test('project pricing override is honoured end to end', () => {
  const dir = tmpProject({
    '.ai-cost-optimizer/pricing.json': JSON.stringify([{ provider: 'openai', model: 'my-finetune-v3', input: 1, output: 2 }]),
    '.ai-cost-optimizer.json': JSON.stringify({ assumptions: { calls_per_month: 1000, avg_dynamic_input_tokens: 1000, avg_output_tokens: 1000 } }),
    'a.ts': 'import OpenAI from "openai";\nnew OpenAI().chat.completions.create({ model: "my-finetune-v3", messages: [] });\n',
  });
  const r = audit(dir);
  close(r.sites[0].monthly_usd, 3.0); // 1000 calls * (1000*1/M + 1000*2/M)
  assert.match(r.sites[0].pricing_match, /override/);
});
test('resolveRoot rejects traversal and absolute paths outside the project', () => {
  const old = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = FIXTURE;
  try {
    assert.ok(resolveRoot('lib'));
    assert.throws(() => resolveRoot('..'), /inside the project/);
    assert.throws(() => resolveRoot('/etc'), /inside the project/);
    assert.throws(() => resolveRoot('does-not-exist'));
  } finally { old === undefined ? delete process.env.CLAUDE_PROJECT_DIR : (process.env.CLAUDE_PROJECT_DIR = old); }
});
