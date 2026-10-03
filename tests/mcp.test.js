import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, FIXTURE } from './helpers.js';

function session(env = {}) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: FIXTURE, env: { ...process.env, CLAUDE_PROJECT_DIR: FIXTURE, ...env } });
  let buf = ''; const waiters = []; const lines = [];
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(JSON.parse(l)); waiters.splice(0).forEach((w) => w()); } });
  const next = async (pred) => { for (;;) { const i = lines.findIndex(pred); if (i >= 0) return lines.splice(i, 1)[0]; await new Promise((r) => waiters.push(r)); } };
  return {
    send: (o) => p.stdin.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n'),
    reply: (id) => next((m) => m.id === id),
    close: () => p.kill(),
    proc: p,
  };
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

test('initialize negotiates protocol version and advertises tools', async () => {
  const s = session(); s.send(init);
  const r = await s.reply(1);
  assert.equal(r.result.protocolVersion, '2025-06-18'); assert.ok(r.result.capabilities.tools); assert.equal(r.result.serverInfo.name, 'ai-cost-optimizer');
  s.send({ ...init, id: 2, params: { ...init.params, protocolVersion: '1999-01-01' } });
  assert.equal((await s.reply(2)).result.protocolVersion, '2025-06-18');
  s.close();
});
test('tools/list: 4 tools, all annotated read-only, valid object schemas', async () => {
  const s = session(); s.send(init); await s.reply(1);
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const { tools } = (await s.reply(2)).result;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['audit_project', 'calculate_cost', 'compare_models', 'pricing_status']);
  for (const t of tools) { assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false); assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 20); }
  s.close();
});
test('audit_project returns a markdown report; json format parses', async () => {
  const s = session(); s.send(init); await s.reply(1);
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'audit_project', arguments: {} } });
  const md = (await s.reply(2)).result.content[0].text;
  assert.match(md, /# AI Cost Audit — nextjs-saas/); assert.match(md, /Potential savings/);
  s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'audit_project', arguments: { format: 'json', assumptions: { calls_per_month: 1 } } } });
  const j = JSON.parse((await s.reply(3)).result.content[0].text);
  assert.equal(j.summary.total_sites, 8);
  s.close();
});
test('calculate_cost: known arithmetic through the wire', async () => {
  const s = session(); s.send(init); await s.reply(1);
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'calculate_cost', arguments: { model: 'claude-sonnet-5-5', input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 500, requests: 1000 } } });
  const r = JSON.parse((await s.reply(2)).result.content[0].text);
  // 2000*2 + 8000*0.2 + 500*10 = 10600 per-mtok-units => $0.0106/request
  assert.ok(Math.abs(r.per_request_usd - 0.0106) < 1e-9); assert.ok(Math.abs(r.total_usd - 10.6) < 1e-6);
  s.close();
});
test('compare_models ranks ascending by price and labels itself price-only', async () => {
  const s = session(); s.send(init); await s.reply(1);
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'compare_models', arguments: { input_tokens: 1000, output_tokens: 200, requests_per_month: 1000, models: ['gpt-5.6', 'gpt-5.6-luna', 'claude-haiku-4-5'] } } });
  const r = JSON.parse((await s.reply(2)).result.content[0].text);
  assert.match(r.note, /Price only/);
  assert.deepEqual(r.rows.map((x) => x.model), ['openai/gpt-5.6-luna', 'anthropic/claude-haiku-4-5', 'openai/gpt-5.6']);
  s.close();
});
test('pricing_status works', async () => {
  const s = session(); s.send(init); await s.reply(1);
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pricing_status', arguments: {} } });
  const r = JSON.parse((await s.reply(2)).result.content[0].text);
  assert.ok(r.entry_count > 300); assert.ok(r.models_by_provider.openai > 10);
  s.close();
});
test('errors: bad input, traversal, unknown tool/method, malformed JSON; server stays alive', async () => {
  const s = session(); s.send(init); await s.reply(1);
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'audit_project', arguments: { path: '../../..' } } });
  const t = (await s.reply(2)).result; assert.equal(t.isError, true); assert.match(t.content[0].text, /inside the project/);
  s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'calculate_cost', arguments: { model: 'gpt-5.6', input_tokens: -1, output_tokens: 1 } } });
  assert.equal((await s.reply(3)).result.isError, true);
  s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });
  assert.equal((await s.reply(4)).error.code, -32602);
  s.send({ jsonrpc: '2.0', id: 5, method: 'nope/nope' });
  assert.equal((await s.reply(5)).error.code, -32601);
  s.send('{{{not json'); assert.equal((await s.reply(null)).error.code, -32700);
  s.send('[1,2]'); assert.equal((await s.reply(null)).error.code, -32600);
  s.send({ jsonrpc: '2.0', id: 6, method: 'ping' });
  assert.deepEqual((await s.reply(6)).result, {});
  assert.equal(s.proc.exitCode, null);
  s.close();
});
test('server never writes non-JSON to stdout and makes no network access (no net/http imports)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = path.join(ROOT, 'server');
  const files = [path.join(dir, 'index.js'), ...readdirSync(path.join(dir, 'lib')).map((f) => path.join(dir, 'lib', f))];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/from ['"]node:(https?|net|dgram|tls|dns|child_process)['"]/.test(src), `${f} imports a network/process module`);
    assert.ok(!/\bfetch\s*\(/.test(src), `${f} calls fetch`);
    assert.ok(!/writeFileSync|appendFileSync|createWriteStream|unlinkSync|rmSync/.test(src), `${f} writes to disk`);
  }
});
