const usd = (n) => (n == null ? '—' : n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '0%');

export function renderMarkdown(r, { maxFindings = 15 } = {}) {
  const s = r.summary;
  const L = [];
  L.push(`# AI Cost Audit — ${s.project}`, '');
  L.push('> **These are static ESTIMATES, not measured spend.** They assume the volumes and token sizes listed under *Assumptions*. Percentages are more trustworthy than absolute dollars.', '');
  L.push('## Summary', '');
  L.push('| | Monthly | Yearly |', '|---|---:|---:|');
  L.push(`| Estimated current cost (${s.priced_sites} priced call sites) | ${usd(s.estimated_monthly_usd)} | ${usd(s.estimated_yearly_usd)} |`);
  L.push(`| After mechanical fixes (no behaviour change) | ${usd(s.after_mechanical_usd)} | ${usd(s.after_mechanical_usd * 12)} |`);
  L.push(`| After all suggestions (needs evaluation) | ${usd(s.after_all_usd)} | ${usd(s.after_all_usd * 12)} |`);
  L.push(`| **Potential savings** | **${usd(s.total_potential_savings_monthly_usd)}** (${pct(s.total_potential_savings_monthly_usd, s.estimated_monthly_usd)}) | ${usd(s.total_potential_savings_monthly_usd * 12)} |`, '');
  L.push(`- Mechanical (safe, same outputs): ${usd(s.mechanical_savings_monthly_usd)}/mo`);
  L.push(`- Needs evaluation (quality/latency trade-off): ${usd(s.needs_eval_savings_monthly_usd)}/mo`);
  if (s.unpriced_sites) L.push(`- ${s.unpriced_sites} call site(s) could not be priced (dynamic/unknown model) and are excluded from totals.`);
  L.push('', '## Inventory', '');
  L.push(`- Providers: ${r.inventory.providers.join(', ') || 'none detected'}`);
  L.push(`- Models: ${r.inventory.models.join(', ') || 'none resolved'}`);
  const d = r.inventory.dependencies;
  if (d.sdks.length || d.vector_dbs.length) L.push(`- Dependencies: SDKs [${d.sdks.join(', ')}]; vector DBs [${d.vector_dbs.join(', ') || 'none'}]; frameworks [${d.frameworks.join(', ') || 'none'}]`);
  L.push(`- Files scanned: ${r.inventory.files_scanned}; with LLM calls: ${r.inventory.files_with_calls}`);
  if (r.inventory.truncated) L.push('- ⚠ Scan truncated at the file limit.');
  if (r.inventory.parse_errors.length) L.push(`- ⚠ ${r.inventory.parse_errors.length} file(s) could not be fully parsed (first: ${r.inventory.parse_errors[0]})`);
  L.push('', '## Call sites', '', '| Site | Model | Calls/mo | Est. $/mo | If optimized | Volume |', '|---|---|---:|---:|---:|---|');
  for (const x of r.sites) {
    L.push(`| \`${x.id}\` | ${x.model ?? `_${x.model_source}_`} | ${Math.round(x.calls_per_month).toLocaleString('en-US')} | ${usd(x.monthly_usd)} | ${usd(x.optimized_monthly_usd)} | ${x.volume_source} |`);
  }
  L.push('', '## Findings', '');
  const shown = r.findings.slice(0, maxFindings);
  shown.forEach((f, i) => {
    L.push(`### ${i + 1}. ${f.title}  \`${f.rule}\``);
    L.push(`- Where: \`${f.site}\` · severity **${f.severity}** · confidence ${f.confidence} · type ${f.class}`);
    if (f.saving_monthly_usd != null) L.push(`- Est. saving: **${usd(f.saving_monthly_usd)}/mo** (non-overlapping)`);
    for (const e of f.evidence) L.push(`- Evidence: ${e}`);
    L.push(`- Fix: ${f.recommendation}`, '');
  });
  if (r.findings.length > shown.length) L.push(`_…and ${r.findings.length - shown.length} more (use format=json)._`, '');
  L.push('## Assumptions', '');
  const a = r.assumptions;
  L.push(`- Default calls/month per site: ${a.calls_per_month.toLocaleString('en-US')} (×${a.loop_multiplier} for looped sites if not configured)`);
  L.push(`- Dynamic input tokens/call: ${a.avg_dynamic_input_tokens}; output tokens/call: ${a.avg_output_tokens}; embedding tokens/call: ${a.avg_embedding_tokens}; cache hit rate: ${Math.round(a.cache_hit_rate * 100)}%`);
  L.push(`- Config: ${a.config_file ?? 'none (defaults only — create .ai-cost-optimizer.json with your real volumes)'}${a.config_error ? ` ⚠ ${a.config_error}` : ''}`);
  L.push(`- Pricing: snapshot ${r.pricing.generated_at.slice(0, 10)} (${r.pricing.age_days}d old)${r.pricing.override_file ? `; project overrides: ${r.pricing.override_entries}` : ''}`, '');
  L.push('## What this analysis cannot know', '');
  for (const c of r.caveats) L.push(`- ${c}`);
  return L.join('\n');
}
