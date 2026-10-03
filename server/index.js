#!/usr/bin/env node
// Minimal, dependency-free MCP server (JSON-RPC 2.0 over newline-delimited stdio).
// All tools are read-only. The server never opens network connections and never writes to disk.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { audit, resolveRoot } from './lib/analyze.js';
import { loadPricing, calculateCost, KNOWN_PROVIDERS, normalizeProvider } from './lib/pricing.js';
import { renderMarkdown } from './lib/report.js';

const VERSION = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const num = (v, name, { min = 0, max = 1e12, req = false } = {}) => {
  if (v === undefined || v === null) { if (req) throw new Error(`${name} is required`); return undefined; }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return v;
};

const TOOLS = [
  {
    name: 'audit_project',
    description: 'Statically scan the project for LLM API calls (OpenAI, Anthropic, Google, Mistral, Groq, OpenRouter, Vercel AI SDK, LiteLLM), estimate monthly cost from explicit assumptions, and list cost-saving findings with non-overlapping savings. Read-only. Returns ESTIMATES, not measured spend.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', description: 'Directory inside the project to scan (default: project root).' },
      format: { type: 'string', enum: ['markdown', 'json'], description: 'markdown (default) is a ready-to-show report; json is the full structured result.' },
      include_tests: { type: 'boolean', description: 'Also scan test/spec/fixture files (default false).' },
      assumptions: { type: 'object', additionalProperties: false, description: 'Override default volume/token assumptions for this run.', properties: {
        calls_per_month: { type: 'number' }, avg_dynamic_input_tokens: { type: 'number' }, avg_output_tokens: { type: 'number' },
        avg_embedding_tokens: { type: 'number' }, loop_multiplier: { type: 'number' }, cache_hit_rate: { type: 'number', minimum: 0, maximum: 1 } } },
    } },
    annotations: { title: 'Audit project for LLM cost leaks', ...RO },
    run(args) {
      const root = resolveRoot(args.path);
      const result = audit(root, { assumptions: args.assumptions, includeTests: args.include_tests === true });
      return args.format === 'json' ? JSON.stringify(result) : renderMarkdown(result);
    },
  },
  {
    name: 'calculate_cost',
    description: 'Exact cost arithmetic for a given model and token counts using the bundled price table (supports cached input, cache writes, batch pricing and long-context tiers). Use for what-if questions.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['model', 'input_tokens', 'output_tokens'], properties: {
      model: { type: 'string' }, provider: { type: 'string', description: 'openai | anthropic | google | mistral | groq | openrouter | deepseek | xai' },
      input_tokens: { type: 'number', description: 'Total input tokens PER REQUEST (including cached ones).' },
      output_tokens: { type: 'number' }, cached_input_tokens: { type: 'number', description: 'Subset of input_tokens read from cache.' },
      cache_write_tokens: { type: 'number', description: 'Subset of input_tokens written to cache.' },
      requests: { type: 'number', description: 'Number of requests (default 1).' }, batch: { type: 'boolean' } } },
    annotations: { title: 'Calculate LLM cost', ...RO },
    run(args) {
      if (typeof args.model !== 'string' || !args.model) throw new Error('model is required');
      const pricing = loadPricing({ projectRoot: safeRoot() });
      const hit = pricing.resolve(args.model, args.provider);
      if (!hit) throw new Error(`No pricing for model "${args.model.slice(0, 80)}". Add it to .ai-cost-optimizer/pricing.json.`);
      const c = calculateCost(hit.entry, {
        input_tokens: num(args.input_tokens, 'input_tokens', { req: true }), output_tokens: num(args.output_tokens, 'output_tokens', { req: true }),
        cached_input_tokens: num(args.cached_input_tokens, 'cached_input_tokens') ?? 0, cache_write_tokens: num(args.cache_write_tokens, 'cache_write_tokens') ?? 0,
        requests: num(args.requests, 'requests') ?? 1, batch: args.batch === true });
      return JSON.stringify({ model: hit.entry.id, matched_as: hit.matched_as, price_per_mtok: { input: hit.entry.input, output: hit.entry.output, cache_read: hit.entry.cache_read, cache_write: hit.entry.cache_write, batch: hit.entry.batch },
        ...c, pricing_snapshot: pricing.meta.generated_at.slice(0, 10) });
    },
  },
  {
    name: 'compare_models',
    description: 'Rank models by price for a given token profile. Compares PRICE ONLY — it says nothing about quality; evaluate candidates on your own data.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['input_tokens', 'output_tokens'], properties: {
      input_tokens: { type: 'number' }, output_tokens: { type: 'number' }, cached_input_tokens: { type: 'number' },
      requests_per_month: { type: 'number' }, providers: { type: 'array', items: { type: 'string' } },
      models: { type: 'array', items: { type: 'string' }, description: 'Explicit models to compare; if omitted, the cheapest chat models are listed.' },
      limit: { type: 'number' } } },
    annotations: { title: 'Compare model prices', ...RO },
    run(args) {
      const pricing = loadPricing({ projectRoot: safeRoot() });
      const base = { input_tokens: num(args.input_tokens, 'input_tokens', { req: true }), output_tokens: num(args.output_tokens, 'output_tokens', { req: true }),
        cached_input_tokens: num(args.cached_input_tokens, 'cached_input_tokens') ?? 0 };
      const reqs = num(args.requests_per_month, 'requests_per_month') ?? 1;
      const limit = Math.min(num(args.limit, 'limit') ?? 15, 50);
      let entries;
      if (Array.isArray(args.models) && args.models.length) {
        entries = args.models.slice(0, 50).map((m) => pricing.resolve(String(m), undefined)?.entry).filter(Boolean);
      } else {
        const provs = (args.providers ?? KNOWN_PROVIDERS.filter((p) => p !== 'openrouter')).map(normalizeProvider);
        entries = pricing.all().filter((e) => e.mode === 'chat' && provs.includes(e.provider) && !e.deprecation_date);
      }
      const rows = entries.map((e) => {
        const cached = e.cache_read != null ? base.cached_input_tokens : 0;
        const c = calculateCost(e, { ...base, cached_input_tokens: Math.min(cached, base.input_tokens), requests: reqs });
        return { model: e.id, per_request_usd: c.per_request_usd, monthly_usd: c.total_usd, input_per_mtok: e.input, output_per_mtok: e.output };
      }).sort((a, b) => a.monthly_usd - b.monthly_usd).slice(0, limit);
      return JSON.stringify({ note: 'Price only. Quality, latency and context limits are not compared.', pricing_snapshot: pricing.meta.generated_at.slice(0, 10), rows });
    },
  },
  {
    name: 'pricing_status',
    description: 'Report the age and coverage of the bundled price table and any project-level pricing overrides.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { title: 'Pricing data status', ...RO },
    run() {
      const p = loadPricing({ projectRoot: safeRoot() });
      const counts = {};
      for (const e of p.all()) counts[e.provider] = (counts[e.provider] ?? 0) + 1;
      return JSON.stringify({ ...p.meta, models_by_provider: counts,
        advice: p.meta.stale ? 'Snapshot is old: run `node scripts/update-pricing.mjs` in the plugin directory.' : 'Snapshot is fresh enough. Always confirm against provider pricing pages before budgeting.' });
    },
  },
];

function safeRoot() { try { return resolveRoot('.'); } catch { return undefined; } }

function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  if (method === 'initialize') {
    const want = params?.protocolVersion;
    return { jsonrpc: '2.0', id, result: { protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ai-cost-optimizer', version: VERSION },
      instructions: 'Read-only LLM cost analysis. All dollar figures are static estimates unless built from user-supplied usage data.' } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } };
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(params?.name).slice(0, 60)}` } };
    try {
      const text = tool.run(params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Error: ${String(e.message).slice(0, 300)}` }] } };
    }
  }
  if (isNotification) return null; // e.g. notifications/initialized
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method).slice(0, 60)}` } };
}

export function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) + '\n');
      return;
    }
    let res;
    try { res = handle(msg); } catch (e) { res = { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'Internal error' } }; console.error(e); }
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
