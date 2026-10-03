// Turns scanner output + pricing into costs and findings. Every dollar figure produced here is an
// ESTIMATE derived from explicit assumptions; the assumptions are returned alongside the numbers.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { scanProject } from './scanner.js';
import { calculateCost, loadPricing, loadTiers, tierOf } from './pricing.js';

export const DEFAULT_ASSUMPTIONS = Object.freeze({
  calls_per_month: 10_000,        // per call site; PLACEHOLDER until the user supplies real volume
  avg_dynamic_input_tokens: 500,  // user/context tokens on top of the static prompt found in source
  avg_output_tokens: 300,
  avg_embedding_tokens: 400,
  loop_multiplier: 10,            // applied only to DEFAULT volume of call sites inside loops
  cache_hit_rate: 0.8,            // share of static-prefix tokens served from cache when caching is used
});
const CONFIG_FILE = '.ai-cost-optimizer.json';
const NUM_KEYS = Object.keys(DEFAULT_ASSUMPTIONS);
const TOKEN_CHARS = 4; // rough English chars-per-token; code/CJK differ

const clean = (o) => {
  const out = {};
  for (const k of NUM_KEYS) {
    const v = o?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12) out[k] = k === 'cache_hit_rate' ? Math.min(v, 1) : v;
  }
  return out;
};

export function loadConfig(root, inline = {}) {
  let file = {};
  let error = null;
  const p = path.join(root, CONFIG_FILE);
  if (existsSync(p)) {
    try { file = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { error = `${CONFIG_FILE}: ${String(e.message).slice(0, 120)}`; }
  }
  const overrides = {};
  for (const [k, v] of Object.entries(file.overrides ?? {})) overrides[k.replace(/\\/g, '/')] = clean(v);
  return {
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...clean(file.assumptions), ...clean(inline) },
    overrides, config_file: existsSync(p) ? CONFIG_FILE : null, config_error: error,
  };
}

function siteAssumptions(site, cfg) {
  const base = cfg.assumptions;
  const o = cfg.overrides[site.file] ?? {};
  const volumeConfigured = o.calls_per_month !== undefined
    || (cfg.config_file && cfg.assumptions.calls_per_month !== DEFAULT_ASSUMPTIONS.calls_per_month);
  const a = { ...base, ...o };
  let calls = a.calls_per_month;
  if (!volumeConfigured && site.in_loop) calls *= base.loop_multiplier;
  return { ...a, calls, volume_source: volumeConfigured ? 'configured' : 'assumed-default' };
}

function profile(entry, site, a, { cache, batch }) {
  if (site.kind === 'embedding') {
    return calculateCost(entry, { input_tokens: a.avg_embedding_tokens, output_tokens: 0, requests: a.calls, batch }).total_usd;
  }
  const staticTok = Math.ceil(site.static_prompt_chars / TOKEN_CHARS);
  const input = staticTok + a.avg_dynamic_input_tokens;
  const output = site.max_tokens != null ? Math.min(a.avg_output_tokens, site.max_tokens) : a.avg_output_tokens;
  let cached = 0, write = 0;
  if (cache && entry.cache_read != null) {
    cached = Math.floor(staticTok * a.cache_hit_rate);
    write = entry.cache_write != null ? Math.ceil(staticTok * (1 - a.cache_hit_rate)) : 0;
  }
  return calculateCost(entry, { input_tokens: input, output_tokens: output, cached_input_tokens: cached,
    cache_write_tokens: write, requests: a.calls, batch }).total_usd;
}

const sev = (usd) => (usd >= 500 ? 'high' : usd >= 50 ? 'medium' : 'low');
const siteId = (s) => `${s.file}:${s.line}`;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {string} root absolute, validated project root
 */
export function audit(root, opts = {}) {
  const pricing = opts.pricing ?? loadPricing({ projectRoot: root });
  const tiers = opts.tiers ?? loadTiers();
  const cfg = loadConfig(root, opts.assumptions);
  const scan = scanProject(root, { includeTests: opts.includeTests });
  const findings = [];
  const sites = [];
  let current = 0, afterMechanical = 0, afterAll = 0, priced = 0;

  for (const s of scan.sites) {
    const a = siteAssumptions(s, cfg);
    const out = { id: siteId(s), file: s.file, line: s.line, provider: s.provider, api: s.api, kind: s.kind,
      model: s.model, model_source: s.model_source, max_tokens: s.max_tokens, in_loop: s.in_loop,
      static_prompt_tokens_est: Math.ceil(s.static_prompt_chars / TOKEN_CHARS), has_cache_control: s.has_cache_control,
      calls_per_month: a.calls, volume_source: a.volume_source, pricing_match: null, monthly_usd: null };

    if (!s.model) {
      out.pricing_match = 'unresolved-model';
      findings.push({ rule: 'unresolved-model', site: out.id, severity: 'low', confidence: 'high', class: 'info', saving_monthly_usd: null,
        title: s.model_source === 'missing' ? 'No model argument found at call site' : 'Model chosen dynamically; cost not estimated',
        evidence: [`model source: ${s.model_source}`],
        recommendation: 'Set the model via a named constant or config so it can be audited, or add runtime telemetry to price it.' });
      sites.push(out); continue;
    }
    const hit = pricing.resolve(s.model, s.provider);
    if (!hit) {
      out.pricing_match = 'unknown-model';
      findings.push({ rule: 'unknown-model-pricing', site: out.id, severity: 'low', confidence: 'high', class: 'info', saving_monthly_usd: null,
        title: `No pricing found for model "${s.model}"`, evidence: [`provider guess: ${s.provider}`],
        recommendation: 'Add the model to .ai-cost-optimizer/pricing.json or run scripts/update-pricing.mjs.' });
      sites.push(out); continue;
    }
    const entry = hit.entry;
    out.pricing_match = `${entry.id} (${hit.matched_as})${entry.source === 'project-override' ? ' [override]' : ''}`;
    if (entry.deprecation_date && Date.parse(entry.deprecation_date) < Date.now() + 90 * 86_400_000) {
      findings.push({ rule: 'deprecated-model', site: out.id, severity: 'medium', confidence: 'high', class: 'info', saving_monthly_usd: null,
        title: `Model ${entry.model} is deprecated/retiring (${entry.deprecation_date})`, evidence: [],
        recommendation: 'Plan migration; verify against the provider deprecation page.' });
    }

    const cost0 = profile(entry, s, a, { cache: s.has_cache_control, batch: false });
    out.monthly_usd = round2(cost0);
    priced++; current += cost0;
    let running = cost0, mechanical = 0;

    // 1) prompt caching (mechanical: no output/quality change)
    const staticTok = out.static_prompt_tokens_est;
    const minTok = Math.max(1024, entry.cache_min_tokens ?? 1024);
    let cacheOn = s.has_cache_control;
    if (s.kind === 'chat' && s.provider === 'anthropic' && !s.has_cache_control && staticTok >= minTok && entry.cache_read != null) {
      const c1 = profile(entry, s, a, { cache: true, batch: false });
      const save = running - c1;
      if (save > 0) {
        findings.push({ rule: 'no-prompt-cache', site: out.id, severity: sev(save), confidence: 'high', class: 'mechanical',
          saving_monthly_usd: round2(save),
          title: 'Large static prompt without cache_control',
          evidence: [`~${staticTok} static prompt tokens (min cacheable ~${minTok})`, `${Math.round(a.cache_hit_rate * 100)}% cache hit rate assumed`, `${a.calls.toLocaleString('en-US')} calls/month (${a.volume_source})`],
          recommendation: 'Mark the stable prefix (system prompt/tools) with cache_control; keep volatile content after it.' });
        mechanical += save; running = c1; cacheOn = true;
      }
    }

    // 2) model downgrade (needs eval)
    const tier = tierOf(tiers, entry.provider, entry.model);
    const t = tiers[entry.provider];
    let target = null, targetTier = null;
    if (s.kind === 'chat' && t && tier && tier !== 'economy') {
      const simple = staticTok < 300 && s.max_tokens != null && s.max_tokens <= 500;
      const shortPrompt = s.static_prompt_chars < 2500;
      const bg = s.background_path && !s.request_path;
      const wantEconomy = simple && (s.task_hint || tier === 'premium');
      if (tier === 'premium' && (shortPrompt || bg)) { targetTier = wantEconomy ? 'economy' : 'standard'; }
      else if (tier === 'standard' && wantEconomy && s.task_hint) targetTier = 'economy';
      if (targetTier) target = pricing.byId.get(`${entry.provider}/${t.targets?.[targetTier]}`) ?? null;
    }
    let needsEval = 0;
    if (target && target.id !== entry.id) {
      const c2 = profile(target, s, a, { cache: cacheOn, batch: false });
      const save = running - c2;
      if (save > 0) {
        findings.push({ rule: 'model-overkill', site: out.id, severity: sev(save), confidence: s.task_hint ? 'medium' : 'low', class: 'needs_eval',
          saving_monthly_usd: round2(save),
          title: `${tier}-tier model (${entry.model}) on a ${s.task_hint ? `"${s.task_hint}"-style` : 'short/background'} call`,
          evidence: [`static prompt ~${staticTok} tokens`, s.max_tokens != null ? `max_tokens=${s.max_tokens}` : 'no max_tokens',
            s.background_path && !s.request_path ? 'lives in background-job path' : 'prompt is short'],
          recommendation: `Evaluate ${target.model} on a sample of real inputs; switch (or route by difficulty) if quality holds.`,
          alternative: { model: target.id, input_per_mtok: target.input, output_per_mtok: target.output } });
        needsEval += save; running = c2; out.suggested_model = target.id;
      }
    }

    // 3) Batch API (needs eval: changes latency contract)
    const tgtEntry = out.suggested_model ? target : entry;
    if (s.kind !== 'embedding' || tgtEntry.batch) {
      if (s.in_loop && s.background_path && !s.request_path && !s.stream && tgtEntry.batch) {
        const c3 = profile(tgtEntry, s, a, { cache: cacheOn, batch: true });
        const save = running - c3;
        if (save > 0) {
          findings.push({ rule: 'batch-api-candidate', site: out.id, severity: sev(save), confidence: 'medium', class: 'needs_eval',
            saving_monthly_usd: round2(save),
            title: 'Looped call in a background path could use the provider Batch API',
            evidence: ['call inside loop', 'file path looks like a job/worker/script', `batch price known for ${tgtEntry.id}`],
            recommendation: 'If results are not needed immediately (batches complete asynchronously, typically within 24h), submit via the Batch API.' });
          needsEval += save; running = c3;
        }
      }
    }

    // 4) informational rules (no $ claim)
    if (s.max_tokens != null && s.max_tokens >= 8000) {
      findings.push({ rule: 'high-max-tokens', site: out.id, severity: 'low', confidence: 'medium', class: 'info', saving_monthly_usd: null,
        title: `max_tokens=${s.max_tokens}`, evidence: [],
        recommendation: 'max_tokens is a ceiling, not a charge: it only costs money if the model actually generates that much. Lower it to guard against runaway output, not to "save" a fixed amount.' });
    }
    if (s.in_loop) {
      findings.push({ rule: 'llm-call-in-loop', site: out.id, severity: 'low', confidence: 'medium', class: 'info', saving_monthly_usd: null,
        title: 'LLM call inside a loop', evidence: [],
        recommendation: 'Check for duplicate inputs (dedupe/cache results), batchable inputs, and unbounded iteration counts.' });
    }
    if (s.kind === 'embedding' && entry.provider === 'openai' && tiers.embeddings?.openai?.[entry.model]) {
      const alt = pricing.byId.get(`openai/${tiers.embeddings.openai[entry.model]}`);
      if (alt) {
        const c = profile(alt, s, a, { cache: false, batch: false });
        const save = cost0 - c;
        if (save > 0) {
          findings.push({ rule: 'embedding-model-size', site: out.id, severity: sev(save), confidence: 'low', class: 'needs_eval',
            saving_monthly_usd: round2(save), title: `Embedding model ${entry.model} → ${alt.model}`,
            evidence: [`${a.avg_embedding_tokens} tokens/call assumed`],
            recommendation: 'Changing embedding models requires re-embedding the whole corpus and re-evaluating retrieval quality. Only worthwhile if recall holds.' });
          needsEval += save; running = Math.min(running, c);
        }
      }
    }
    afterMechanical += cost0 - mechanical;
    afterAll += cost0 - mechanical - needsEval;
    out.optimized_monthly_usd = round2(cost0 - mechanical - needsEval);
    sites.push(out);
  }

  // cross-site: identical large static prompts
  const byHash = new Map();
  for (const s of scan.sites) for (const h of s.prompt_hashes) if (s.static_prompt_chars >= 1000) {
    if (!byHash.has(h)) byHash.set(h, new Set());
    byHash.get(h).add(siteId(s));
  }
  for (const [h, set] of byHash) if (set.size >= 2) {
    findings.push({ rule: 'duplicate-static-prompt', site: [...set][0], severity: 'low', confidence: 'high', class: 'info', saving_monthly_usd: null,
      title: `Same large static prompt text used at ${set.size} call sites`, evidence: [...set].slice(0, 6),
      recommendation: 'Share one prompt constant and make sure every site benefits from the same cache prefix.' });
  }

  // aggregate (mechanical + needs-eval savings come from the same non-overlapping per-site pass)
  const q = findings.filter((f) => f.saving_monthly_usd != null);
  const mech = q.filter((f) => f.class === 'mechanical').reduce((x, f) => x + f.saving_monthly_usd, 0);
  const ev = q.filter((f) => f.class === 'needs_eval').reduce((x, f) => x + f.saving_monthly_usd, 0);
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((x, y) => (order[x.severity] - order[y.severity]) || ((y.saving_monthly_usd ?? 0) - (x.saving_monthly_usd ?? 0)));

  const caveats = [
    'ESTIMATE ONLY: derived from source code plus the assumptions listed. Real spend needs provider billing/usage data.',
    'Token counts use ~4 characters/token on static strings found in source; dynamic content uses a flat assumption.',
    'Reasoning-model "thinking" tokens are billed as output but are NOT modelled; real cost for reasoning models is likely higher.',
    'OpenAI/Gemini implicit prompt caching may already be lowering your real bill; this estimate assumes no caching unless cache_control is present.',
    'Call sites with dynamic/unknown models are excluded from totals.',
  ];
  if (pricing.meta.stale) caveats.push(`Pricing snapshot is ${pricing.meta.age_days} days old; run scripts/update-pricing.mjs.`);

  return {
    summary: {
      project: scan.root_name, priced_sites: priced, total_sites: scan.sites.length, unpriced_sites: scan.sites.length - priced,
      estimated_monthly_usd: round2(current), estimated_yearly_usd: round2(current * 12),
      after_mechanical_usd: round2(afterMechanical), after_all_usd: round2(afterAll),
      mechanical_savings_monthly_usd: round2(mech), needs_eval_savings_monthly_usd: round2(ev),
      total_potential_savings_monthly_usd: round2(mech + ev),
    },
    inventory: {
      providers: [...new Set(scan.sites.map((s) => s.provider))].sort(),
      models: [...new Set(scan.sites.map((s) => s.model).filter(Boolean))].sort(),
      dependencies: scan.dependencies, files_scanned: scan.files_scanned, files_with_calls: scan.files_with_calls,
      skipped: scan.skipped, truncated: scan.truncated, parse_errors: scan.parse_errors,
    },
    assumptions: { ...cfg.assumptions, config_file: cfg.config_file, config_error: cfg.config_error, per_file_overrides: Object.keys(cfg.overrides) },
    pricing: { generated_at: pricing.meta.generated_at, age_days: pricing.meta.age_days, source: pricing.meta.source_url,
      override_file: pricing.meta.override_file, override_entries: pricing.meta.override_entries },
    sites, findings, caveats,
  };
}

export function resolveRoot(requested) {
  const base = realpathSync(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const target = realpathSync(path.resolve(base, requested || '.'));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path must be inside the project directory');
  return target;
}
