---
name: cost-optimize
description: Apply LLM cost optimizations from a cost audit to the codebase, with explicit user approval, tests, and a before/after estimate. Use after /ai-cost-optimizer:cost-audit or when the user asks to "fix" or "apply" AI cost savings.
disable-model-invocation: true
---

# Cost optimize

Apply findings from the audit **only with explicit approval**, smallest safe change first.

## Steps

1. **Get findings.** If an audit was not run in this conversation, call `audit_project` (format `json`) first.
2. **Propose a change list**, one line per change: file:line, what changes, estimated monthly saving, type (`mechanical` or `needs_eval`). Default selection = `mechanical` only. Wait for the user to approve the list or edit it. Do not edit before approval.
3. **Check the working tree.** Run `git status`. If there are uncommitted changes, suggest committing or stashing so the diff is reviewable. Do not commit on the user's behalf unless asked.
4. **Apply approved changes**, one finding at a time, using normal edit tools:
   - `no-prompt-cache` (Anthropic): add `cache_control: { type: "ephemeral" }` to the last block of the stable prefix (system prompt / tool definitions). Keep volatile content after it. Do not reorder semantics.
   - `model-overkill` / `batch-api-candidate` / `embedding-model-size` (`needs_eval`): **do not just swap the model.** Add the change behind a config/env switch, or write a small evaluation script that runs both models on ~20–50 real examples and compares outputs. Only make the swap the default if the user approves based on those results. Embedding-model changes require re-embedding the corpus: explain this and do not apply automatically.
   - `high-max-tokens`: lower only if you can see the expected response size from the code or tests; otherwise leave and explain.
5. **Run the project's tests/typecheck/lint** (look at package.json scripts, Makefile, pyproject). Report failures honestly; revert the specific change if it breaks tests and you can't fix it.
6. **Re-run `audit_project`** and show before/after estimates. State again that they are estimates.
7. **Summarize** what changed, what was skipped and why, and what to monitor in the provider dashboard after deploying (cache hit rate, error rate, output quality).

## Rules

- Never change prompts' meaning, model behavior, or public API contracts without approval.
- Never touch `.env`, secrets, or billing configuration.
- If a finding looks like a false positive on inspection, skip it and say so.
