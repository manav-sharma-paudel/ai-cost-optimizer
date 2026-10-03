# AI Cost Optimizer — Claude Code plugin

Statically audits a codebase for LLM cost leaks and estimates savings **with every assumption printed**.
Local, read-only, zero network, zero runtime dependencies (Node ≥ 20).

> **Honesty first.** This plugin reads source code. It does **not** know your real traffic, real prompts, or real bill.
> Every dollar figure is an *estimate from stated assumptions*. Use it to find where to look and what to try,
> then confirm with your provider's usage dashboard.

## What it finds (MVP)

| Rule | Type | What it means |
|---|---|---|
| `no-prompt-cache` | mechanical | Anthropic call with a large static prompt and no `cache_control` |
| `model-overkill` | needs eval | Premium-tier model on a short / classification-style / background call |
| `batch-api-candidate` | needs eval | Looped call in a job/worker path that could use a Batch API |
| `embedding-model-size` | needs eval | `text-embedding-3-large` where `-small` may do (requires re-embedding) |
| `high-max-tokens`, `llm-call-in-loop`, `duplicate-static-prompt`, `unresolved-model`, `unknown-model-pricing` | info | No dollar claim; things worth a look |

Detected SDKs: OpenAI, Anthropic, Google GenAI, Mistral, Groq, OpenRouter (via OpenAI-compatible clients), Vercel AI SDK, LiteLLM — in JS/TS and Python.

## Install

```bash
# from a Git repo that contains this plugin (marketplace.json is at .claude-plugin/)
/plugin marketplace add manav-sharma-paudel/ai-cost-optimizer
/plugin install ai-cost-optimizer@ai-cost-optimizer-marketplace

# local development
claude --plugin-dir /path/to/ai-cost-optimizer
```

Validate before publishing: `claude plugin validate .`

## Use

| Command | What it does |
|---|---|
| `/ai-cost-optimizer:cost-audit` | Scan, estimate, report. Never edits code. |
| `/ai-cost-optimizer:cost-optimize` | Apply approved fixes, run your tests, re-estimate. |
| `/ai-cost-optimizer:cost-compare` | Price a token profile across models. Price only — not quality. |

## Give it real numbers

Create `.ai-cost-optimizer.json` in your project root (otherwise 10,000 calls/month per call site is assumed):

```json
{
  "assumptions": { "calls_per_month": 20000, "avg_output_tokens": 300, "cache_hit_rate": 0.8 },
  "overrides": { "src/lib/classify.ts": { "calls_per_month": 200000 } }
}
```

Custom or fine-tuned models: add `.ai-cost-optimizer/pricing.json` (`[{"provider":"openai","model":"my-ft","input":3,"output":6}]`, USD per million tokens).

## Pricing data

Prices live in `data/pricing-snapshot.json`, generated from the community-maintained LiteLLM price table.
Nothing is hard-coded in source. Refresh: `node scripts/update-pricing.mjs` (the only networked code; run by you, never by the server).
Always verify against the provider's pricing page before budgeting.

## Security & privacy

- The MCP server opens **no network connections** and **writes nothing** (enforced by a test).
- Reads only `.js .jsx .ts .tsx .mjs .cjs .py` plus `package.json`, `requirements.txt`, `pyproject.toml`. Never `.env*`, keys, or certs. Skips symlinks, binaries, files > 1 MB, `node_modules`, VCS and build dirs.
- Scan output contains file paths, line numbers, model names and counts — **never prompt text or string literals** (tested with planted secrets). Model strings that look like secrets are dropped.
- `path` arguments are confined to the project directory.
- Fixes are made by Claude through normal edit tools, only after you approve a change list.

## Limitations (read these)

- Regex + balanced-paren parsing, not a full AST. It will miss calls hidden behind wrappers/factories and models chosen at runtime (reported as `unresolved-model`, excluded from totals). It can misjudge "background" paths from file names.
- Token counts are ~4 chars/token on static strings; dynamic content is a flat assumption.
- Reasoning ("thinking") tokens, tool-call loops, retries, images/audio and OpenAI/Gemini implicit caching are **not modelled**.
- Cannot detect duplicate *runtime* requests, real cache hit rates, or actual spend. That needs runtime telemetry or billing exports.
- Tier lists (`data/tiers.json`) are a heuristic starting point, not a quality ranking.

## Develop

```bash
npm test                      # 51 tests, no dependencies
node server/index.js          # speaks MCP (JSON-RPC, newline-delimited) on stdio
```

## License

MIT
