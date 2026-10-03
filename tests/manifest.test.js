import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const j = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));

test('plugin.json is valid and versions agree', () => {
  const m = j('.claude-plugin/plugin.json');
  assert.match(m.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description.length > 20);
  assert.equal(m.version, j('package.json').version);
});
test('.mcp.json uses ${CLAUDE_PLUGIN_ROOT} and points at a real file', () => {
  const s = j('.mcp.json').mcpServers['ai-cost-optimizer'];
  assert.equal(s.command, 'node');
  assert.ok(s.args[0].startsWith('${CLAUDE_PLUGIN_ROOT}/'));
  assert.ok(existsSync(path.join(ROOT, s.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', ''))));
});
test('every skill has front-matter with name matching its folder and a description', () => {
  const dirs = readdirSync(path.join(ROOT, 'skills'));
  assert.deepEqual(dirs.sort(), ['cost-audit', 'cost-compare', 'cost-optimize']);
  for (const d of dirs) {
    const t = readFileSync(path.join(ROOT, 'skills', d, 'SKILL.md'), 'utf8');
    const fm = t.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, d);
    assert.match(fm[1], new RegExp(`^name: ${d}$`, 'm'));
    assert.match(fm[1], /^description: .{40,}/m);
  }
});
test('marketplace.json lists this plugin with a relative source', () => {
  const mk = j('.claude-plugin/marketplace.json');
  assert.ok(mk.name && mk.owner?.name);
  assert.equal(mk.plugins[0].name, j('.claude-plugin/plugin.json').name);
  assert.ok(mk.plugins[0].source.startsWith('./'));
});
test('the plugin has zero runtime dependencies (nothing to npm install)', () => {
  const p = j('package.json');
  assert.ok(!p.dependencies || Object.keys(p.dependencies).length === 0);
});
