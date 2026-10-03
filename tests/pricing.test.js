import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPricing, calculateCost, loadTiers, tierOf } from '../server/lib/pricing.js';
import { PRICING_FIXTURE, tmpProject } from './helpers.js';

const P = loadPricing({ snapshotPath: PRICING_FIXTURE });
const E = (id) => P.byId.get(id);
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test('basic input/output arithmetic (hand-computed)', () => {
  close(calculateCost(E('openai/test-big'), { input_tokens: 1000, output_tokens: 500 }).per_request_usd, 0.03);
});
test('cached input is billed at the cache-read rate', () => {
  // 2000*3 + 8000*0.3 + 500*15 = 15900 -> $0.0159
  close(calculateCost(E('anthropic/test-sonnet'), { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 500 }).per_request_usd, 0.0159);
});
test('cache writes are billed at the cache-write rate', () => {
  // 2000*3 + 6000*0.3 + 2000*3.75 + 500*15 = 22800 -> $0.0228
  close(calculateCost(E('anthropic/test-sonnet'), { input_tokens: 10000, cached_input_tokens: 6000, cache_write_tokens: 2000, output_tokens: 500 }).per_request_usd, 0.0228);
});
test('batch pricing halves cost for the fixture model', () => {
  const std = calculateCost(E('openai/test-big'), { input_tokens: 1e5, output_tokens: 1e5 }).total_usd;
  const bat = calculateCost(E('openai/test-big'), { input_tokens: 1e5, output_tokens: 1e5, batch: true }).total_usd;
  close(std, 5); close(bat, 2.5);
});
test('model without batch price falls back to standard and says so', () => {
  const c = calculateCost(E('anthropic/test-haiku'), { input_tokens: 1e6, output_tokens: 0, batch: true });
  close(c.total_usd, 1);
  assert.match(c.notes.join(' '), /no batch price/);
});
test('long-context tier applies above the threshold, not at it', () => {
  const at = calculateCost(E('openai/test-big'), { input_tokens: 200000, output_tokens: 1000 }).total_usd;
  const above = calculateCost(E('openai/test-big'), { input_tokens: 300000, output_tokens: 1000 });
  close(at, 200000 * 10 / 1e6 + 1000 * 40 / 1e6);
  close(above.total_usd, 6.06);
  assert.match(above.notes.join(' '), /long-context/);
});
test('requests multiply linearly', () => {
  close(calculateCost(E('openai/test-big'), { input_tokens: 1000, output_tokens: 500, requests: 1000 }).total_usd, 30);
});
test('missing cache price falls back to full input price with a note', () => {
  const c = calculateCost(E('openai/test-embed'), { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 0 });
  close(c.per_request_usd, 1000 * 0.1 / 1e6);
  assert.match(c.notes.join(' '), /cached-input price/);
});
test('invalid token counts are rejected', () => {
  assert.throws(() => calculateCost(E('openai/test-big'), { input_tokens: -1, output_tokens: 0 }), RangeError);
  assert.throws(() => calculateCost(E('openai/test-big'), { input_tokens: NaN, output_tokens: 0 }), RangeError);
  assert.throws(() => calculateCost(E('openai/test-big'), { input_tokens: 10, cached_input_tokens: 11, output_tokens: 0 }), RangeError);
});
test('model resolution: exact, provider prefix, date suffix, unknown', () => {
  assert.equal(P.resolve('test-big').entry.id, 'openai/test-big');
  assert.equal(P.resolve('openai/test-big').matched_as, 'exact');
  assert.equal(P.resolve('test-big-2026-01-02').entry.id, 'openai/test-big');
  assert.equal(P.resolve('test-sonnet', 'anthropic').entry.id, 'anthropic/test-sonnet');
  assert.equal(P.resolve('test-sonnet', 'openai').matched_as, 'cross-provider');
  assert.equal(P.resolve('does-not-exist'), null);
  assert.equal(P.resolve(''), null);
  assert.equal(P.resolve(undefined), null);
});
test('project override file adds/overrides models; bad entries are ignored; bad JSON is reported', () => {
  const dir = tmpProject({ '.ai-cost-optimizer/pricing.json': JSON.stringify({ models: [
    { provider: 'openai', model: 'in-house', input: 1, output: 2 }, { provider: 'openai', model: 'bad', input: -5, output: 1 }] }) });
  const p = loadPricing({ snapshotPath: PRICING_FIXTURE, projectRoot: dir });
  assert.equal(p.resolve('in-house').entry.source, 'project-override');
  assert.equal(p.resolve('bad'), null);
  const dir2 = tmpProject({ '.ai-cost-optimizer/pricing.json': '{nope' });
  assert.ok(loadPricing({ snapshotPath: PRICING_FIXTURE, projectRoot: dir2 }).meta.override_error);
});
test('REAL snapshot: schema is sane and tier targets exist', () => {
  const real = loadPricing();
  assert.ok(real.all().length > 300);
  for (const e of real.all()) {
    assert.ok(Number.isFinite(e.input) && e.input >= 0, e.id);
    assert.ok(Number.isFinite(e.output) && e.output >= 0, e.id);
    assert.equal(e.currency, 'USD');
  }
  const tiers = loadTiers();
  for (const [prov, t] of Object.entries(tiers)) {
    if (!t.targets) continue;
    for (const [tier, model] of Object.entries(t.targets)) assert.ok(real.byId.has(`${prov}/${model}`), `tier target missing: ${prov}/${model} (${tier})`);
  }
  for (const [m, alt] of Object.entries(tiers.embeddings.openai)) { assert.ok(real.byId.has(`openai/${m}`)); assert.ok(real.byId.has(`openai/${alt}`)); }
});
test('tierOf uses the curated list first, regex second', () => {
  const t = loadTiers();
  assert.equal(tierOf(t, 'anthropic', 'claude-opus-5-5'), 'premium');
  assert.equal(tierOf(t, 'anthropic', 'claude-haiku-4-5'), 'economy');
  assert.equal(tierOf(t, 'anthropic', 'claude-sonnet-9-9'), 'standard');
  assert.equal(tierOf(t, 'mistral', 'totally-unknown'), null);
});
