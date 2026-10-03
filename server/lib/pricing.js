// Pricing registry + cost calculator. No prices are hard-coded in code: everything comes from
// data/pricing-snapshot.json (generated) plus an optional per-project override file.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
export const KNOWN_PROVIDERS = ['openai', 'anthropic', 'google', 'mistral', 'groq', 'openrouter', 'deepseek', 'xai'];
const PROVIDER_ALIASES = { gemini: 'google', vertex: 'google', 'vertex_ai': 'google' };
const OVERRIDE_REL = path.join('.ai-cost-optimizer', 'pricing.json');
const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

export function loadTiers() {
  return JSON.parse(readFileSync(path.join(DATA_DIR, 'tiers.json'), 'utf8'));
}

function validEntry(e) {
  return e && typeof e.provider === 'string' && typeof e.model === 'string'
    && Number.isFinite(e.input) && e.input >= 0 && Number.isFinite(e.output) && e.output >= 0;
}

/**
 * @param {{snapshotPath?: string, projectRoot?: string}} opts
 */
export function loadPricing(opts = {}) {
  const snapshotPath = opts.snapshotPath ?? path.join(DATA_DIR, 'pricing-snapshot.json');
  const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const byId = new Map();
  for (const m of snap.models) if (validEntry(m)) byId.set(m.id, m);

  const status = { override_file: null, override_entries: 0, override_error: null };
  if (opts.projectRoot) {
    const p = path.join(opts.projectRoot, OVERRIDE_REL);
    if (existsSync(p)) {
      status.override_file = OVERRIDE_REL;
      try {
        const o = JSON.parse(readFileSync(p, 'utf8'));
        const list = Array.isArray(o) ? o : o.models;
        for (const m of list ?? []) {
          if (!validEntry(m)) continue;
          const id = `${m.provider}/${m.model}`;
          byId.set(id, { mode: 'chat', currency: 'USD', cache_read: null, cache_write: null, batch: null,
            long_context: null, reasoning: false, ...m, id, source: 'project-override' });
          status.override_entries++;
        }
      } catch (e) { status.override_error = String(e.message).slice(0, 200); }
    }
  }
  const ageDays = (Date.now() - Date.parse(snap.meta.generated_at)) / 86_400_000;
  return {
    meta: { ...snap.meta, age_days: Math.floor(ageDays), stale: ageDays > 45, ...status },
    byId,
    all: () => [...byId.values()],
    resolve: (model, provider) => resolveModel(byId, model, provider),
  };
}

export function normalizeProvider(p) {
  if (!p) return null;
  const k = String(p).toLowerCase();
  return PROVIDER_ALIASES[k] ?? k;
}

function resolveModel(byId, rawModel, providerHint) {
  if (typeof rawModel !== 'string' || !rawModel) return null;
  let model = rawModel.trim().toLowerCase().replace(/^models\//, '');
  let provider = normalizeProvider(providerHint);
  // "anthropic/claude-x" style: only treat the prefix as a provider when it is one we know
  const slash = model.indexOf('/');
  if (slash > 0 && provider !== 'openrouter' && provider !== 'groq') {
    const pre = normalizeProvider(model.slice(0, slash));
    if (KNOWN_PROVIDERS.includes(pre)) { provider = pre; model = model.slice(slash + 1); }
  }
  const variants = [model];
  if (DATE_SUFFIX.test(model)) variants.push(model.replace(DATE_SUFFIX, ''));
  if (model.endsWith('-latest')) variants.push(model.slice(0, -7));
  const providers = provider ? [provider] : KNOWN_PROVIDERS;
  for (const v of variants) {
    for (const p of providers) {
      const hit = byId.get(`${p}/${v}`);
      if (hit) return { entry: hit, matched_as: v === model ? 'exact' : 'normalized', provider: p };
    }
  }
  // provider hint may be wrong (e.g. OpenAI SDK pointed at another vendor): try every provider
  if (provider) for (const v of variants) for (const p of KNOWN_PROVIDERS) {
    const hit = byId.get(`${p}/${v}`);
    if (hit) return { entry: hit, matched_as: 'cross-provider', provider: p };
  }
  return null;
}

const M = 1_000_000;

/**
 * Cost of `requests` identical requests. All token counts are PER REQUEST.
 * cached_input_tokens / cache_write_tokens are subsets of input_tokens.
 */
export function calculateCost(entry, { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0,
  cache_write_tokens = 0, requests = 1, batch = false } = {}) {
  for (const [k, v] of Object.entries({ input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, requests })) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${k} must be a non-negative number`);
  }
  if (cached_input_tokens + cache_write_tokens > input_tokens) {
    throw new RangeError('cached_input_tokens + cache_write_tokens cannot exceed input_tokens');
  }
  let rIn = entry.input, rOut = entry.output, rRead = entry.cache_read, rWrite = entry.cache_write;
  const notes = [];
  const lc = entry.long_context;
  if (lc && lc.input != null && lc.output != null && input_tokens > lc.threshold_tokens) {
    rIn = lc.input; rOut = lc.output; rRead = lc.cache_read ?? rRead;
    notes.push(`long-context pricing applied (input > ${lc.threshold_tokens} tokens)`);
  }
  if (batch) {
    if (entry.batch) { rIn = entry.batch.input; rOut = entry.batch.output; notes.push('batch pricing applied; cache rates unchanged'); }
    else notes.push('no batch price known for this model; standard price used');
  }
  if (cached_input_tokens > 0 && rRead == null) notes.push('no cached-input price known; cached tokens billed at full input price');
  if (cache_write_tokens > 0 && rWrite == null) notes.push('no cache-write price known; billed at full input price');
  const uncached = input_tokens - cached_input_tokens - cache_write_tokens;
  const perRequest = (uncached * rIn + cached_input_tokens * (rRead ?? rIn)
    + cache_write_tokens * (rWrite ?? rIn) + output_tokens * rOut) / M;
  return {
    per_request_usd: perRequest,
    total_usd: perRequest * requests,
    breakdown_per_request_usd: {
      input: (uncached * rIn) / M, cached_input: (cached_input_tokens * (rRead ?? rIn)) / M,
      cache_write: (cache_write_tokens * (rWrite ?? rIn)) / M, output: (output_tokens * rOut) / M,
    },
    notes,
  };
}

export function tierOf(tiers, provider, model) {
  const t = tiers[provider];
  if (t) for (const name of ['premium', 'standard', 'economy']) if (t[name]?.includes(model)) return name;
  if (/(^|[-/])(opus|fable|mythos|pro)([-./]|$)/.test(model)) return 'premium';
  if (/(haiku|mini|nano|lite|small|luna|instant)/.test(model)) return 'economy';
  if (/(sonnet|flash|terra)/.test(model)) return 'standard';
  return null;
}
