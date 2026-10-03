---
name: cost-audit
description: Audit the current project for LLM/AI API cost leaks and estimate monthly savings. Use when the user asks about AI/LLM costs, token spend, model choice, prompt caching, or "why is our OpenAI/Anthropic bill high".
---

# Cost audit

Goal: give the user an honest, assumption-labelled picture of where their LLM spend comes from and what could be cut. **Never present estimates as measured spend.**

## Steps

1. **Check for usage assumptions.** Look for `.ai-cost-optimizer.json` in the project root. If it does not exist, the audit will use placeholder volumes (10,000 calls/month per call site). Ask the user — in one short question — for rough monthly request volumes of their main LLM features (or for a real number from their provider dashboard). If they don't know, proceed with defaults and say so clearly. Offer to create the config file for them.
2. **Run the audit.** Call the `audit_project` tool from the `ai-cost-optimizer` MCP server (default `format: "markdown"`). Pass `assumptions` only if the user gave numbers that aren't in the config file.
3. **Present the result.** Show the summary table and the top findings. Keep the assumptions and "what this analysis cannot know" sections visible; do not drop them.
4. **Separate the two kinds of savings.**
   - *Mechanical* (e.g. adding prompt caching): same outputs, safe to apply.
   - *Needs evaluation* (e.g. cheaper model, Batch API): changes quality or latency; recommend testing on real inputs first.
5. **Sanity-check findings against the code** before repeating them. Open the flagged file/line. Static scanning can be wrong (e.g. a "background job" that is actually latency-sensitive, a model chosen via a wrapper). Drop or caveat any finding that doesn't hold up, and say you did.
6. **Offer next steps** — do not edit code in this skill. Offer: (a) `/ai-cost-optimizer:cost-optimize` to apply the mechanical fixes with approval, (b) `/ai-cost-optimizer:cost-compare` to price alternatives, (c) writing the report to `ai-cost-report.md` if the user wants to keep it.

## Rules

- Never print or request API keys. Never read `.env` files. The scanner doesn't, and neither should you.
- If the tool reports `unresolved-model` sites, tell the user those are excluded from the totals.
- If the pricing snapshot is stale (the report says so), recommend `pricing_status` and refreshing prices before they use the numbers for budgeting.
- Real spend lives in provider billing dashboards or usage exports; say so when the user wants actuals.
