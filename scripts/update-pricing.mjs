#!/usr/bin/env node
// Regenerates data/pricing-snapshot.json from LiteLLM's community-maintained price table.
// This is the ONLY place in the project that touches the network, and it is run by a human,
// never by the MCP server.  Usage:
//   node scripts/update-pricing.mjs                  # fetch from GitHub
//   node scripts/update-pricing.mjs --from file.json # use a local copy
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pricing-snapshot.json');

// litellm_provider -> [our provider id, key prefix to strip]
const PROVIDERS = {
  openai: ['openai', ''], anthropic: ['anthropic', ''], gemini: ['google', 'gemini/'],
  mistral: ['mistral', 'mistral/'], groq: ['groq', 'groq/'], openrouter: ['openrouter', 'openrouter/'],
  deepseek: ['deepseek', 'deepseek/'], xai: ['xai', 'xai/'],
};
const MODES = new Set(['chat', 'responses', 'embedding']);
const perM = (v) => (typeof v === 'number' && v > 0 ? Number((v * 1e6).toPrecision(10)) : null);

export function transform(raw, sourceUrl = SOURCE_URL, now = new Date()) {
  const models = [];
  const seen = new Set();
  for (const [key, v] of Object.entries(raw)) {
    if (key === 'sample_spec' || !v || typeof v !== 'object') continue;
    const map = PROVIDERS[v.litellm_provider];
    if (!map || !MODES.has(v.mode)) continue;
    if (typeof v.input_cost_per_token !== 'number') continue;
    const [provider, prefix] = map;
    const model = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
    if (model.startsWith('ft:')) continue;
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const bIn = perM(v.input_cost_per_token_batches);
    const bOut = perM(v.output_cost_per_token_batches);
    const th = v.input_cost_per_token_above_272k_tokens ? 272000
      : v.input_cost_per_token_above_200k_tokens ? 200000 : null;
    const suffix = th === 272000 ? '_above_272k_tokens' : '_above_200k_tokens';
    models.push({
      id, provider, model, mode: v.mode === 'embedding' ? 'embedding' : 'chat', currency: 'USD',
      input: perM(v.input_cost_per_token) ?? 0,
      output: perM(v.output_cost_per_token) ?? 0,
      cache_read: perM(v.cache_read_input_token_cost),
      cache_write: perM(v.cache_creation_input_token_cost),
      batch: bIn !== null && bOut !== null ? { input: bIn, output: bOut } : null,
      long_context: th ? {
        threshold_tokens: th,
        input: perM(v['input_cost_per_token' + suffix]),
        output: perM(v['output_cost_per_token' + suffix]),
        cache_read: perM(v['cache_read_input_token_cost' + suffix]),
      } : null,
      max_input_tokens: v.max_input_tokens ?? null,
      max_output_tokens: v.max_output_tokens ?? null,
      cache_min_tokens: v.prompt_cache_min_tokens ?? null,
      reasoning: v.supports_reasoning === true,
      deprecation_date: v.deprecation_date ?? null,
      source: 'litellm',
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return {
    meta: { schema_version: 1, generated_at: now.toISOString(), source_url: sourceUrl,
      unit: 'USD per 1,000,000 tokens', entry_count: models.length },
    models,
  };
}

async function main() {
  const i = process.argv.indexOf('--from');
  const raw = i > -1 ? JSON.parse(readFileSync(process.argv[i + 1], 'utf8'))
    : await (async () => { const r = await fetch(SOURCE_URL); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })();
  const out = transform(raw, i > -1 ? 'local:' + path.basename(process.argv[i + 1]) + ' (LiteLLM format)' : SOURCE_URL);
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${out.models.length} models to ${OUT}`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
