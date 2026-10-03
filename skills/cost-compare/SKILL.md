---
name: cost-compare
description: Compare LLM prices across models/providers for a given token profile and request volume, or calculate exact cost for specific token counts. Use for "how much would X cost on Y" or "what's cheaper than model Z".
---

# Cost compare

1. Collect the token profile: input tokens, output tokens (per request), cached-input tokens if any, and requests/month. If the user doesn't know, derive input/output sizes from a representative call in their code (read it; do not guess from the file name) and say it is an approximation.
2. Use `calculate_cost` for specific models and `compare_models` to rank candidates. Prefer passing an explicit `models` list when the user names models.
3. Present a compact table (model, $/request, $/month, price per million input/output).
4. **State the limits:** `compare_models` compares price only. It says nothing about quality, latency, rate limits, context windows, or tool-calling reliability. Recommend running a small evaluation on real data before switching, and mention batch/caching discounts only if the tool output shows them.
5. If a model isn't found, call `pricing_status`; the user may need to refresh the snapshot or add a project override in `.ai-cost-optimizer/pricing.json`.
