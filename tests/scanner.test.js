import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanProject, matchParen, readString } from '../server/lib/scanner.js';
import { FIXTURE, tmpProject } from './helpers.js';

const find = (r, f) => r.sites.find((s) => s.file === f);

test('fixture: detects exactly the real call sites', () => {
  const r = scanProject(FIXTURE);
  assert.deepEqual(r.sites.map((s) => s.file), ['app/api/chat/route.ts', 'app/api/summarize/route.ts', 'jobs/nightly-summaries.ts',
    'lib/classify.ts', 'lib/embeddings.ts', 'lib/router.ts', 'lib/secrets-trap.ts', 'workers/enrich.py']);
  assert.deepEqual(r.dependencies.sdks, ['anthropic', 'openai']);
  assert.deepEqual(r.dependencies.vector_dbs, ['@pinecone-database/pinecone']);
  assert.deepEqual(r.dependencies.frameworks, ['next']);
});
test('fixture: field extraction', () => {
  const r = scanProject(FIXTURE);
  const nightly = find(r, 'jobs/nightly-summaries.ts');
  assert.equal(nightly.model, 'claude-opus-5-5'); assert.equal(nightly.provider, 'anthropic');
  assert.equal(nightly.max_tokens, 16000); assert.equal(nightly.in_loop, true); assert.equal(nightly.has_cache_control, false);
  assert.equal(nightly.static_prompt_chars, 9000); assert.equal(nightly.background_path, true);
  assert.equal(find(r, 'app/api/summarize/route.ts').has_cache_control, true);
  assert.equal(find(r, 'app/api/chat/route.ts').stream, true);
  assert.equal(find(r, 'app/api/chat/route.ts').in_loop, false);
  assert.equal(find(r, 'lib/classify.ts').task_hint, 'classif');
  assert.equal(find(r, 'lib/classify.ts').max_tokens, 20);
  assert.equal(find(r, 'lib/embeddings.ts').kind, 'embedding');
  assert.equal(find(r, 'lib/embeddings.ts').in_loop, true);
  assert.equal(find(r, 'lib/router.ts').model, null); assert.equal(find(r, 'lib/router.ts').model_source, 'dynamic');
  const py = find(r, 'workers/enrich.py');
  assert.equal(py.model, 'gpt-5.6-terra'); assert.equal(py.model_source, 'env-fallback'); assert.equal(py.in_loop, true); assert.equal(py.language, 'python');
});
test('comments, tests, symlinks, denied files are not scanned', () => {
  const r = scanProject(FIXTURE);
  assert.ok(!r.sites.some((s) => s.file === 'lib/commented.ts'));
  assert.ok(!r.sites.some((s) => s.file.startsWith('__tests__')));
  assert.equal(r.skipped.tests, 1);
  assert.equal(r.skipped.denied, 1); // .env
  assert.equal(scanProject(FIXTURE, { includeTests: true }).sites.some((s) => s.file.startsWith('__tests__')), true);
});
test('SECURITY: no secrets or prompt text ever appear in scan output', () => {
  const json = JSON.stringify(scanProject(FIXTURE));
  for (const needle of ['SUPERSECRET', 'FAKEFAKE', 'sk-proj', 'sk-live', 'sk-ant', 'Acme Cloud', 'escalation matrix', 'Classify the support ticket']) {
    assert.ok(!json.includes(needle), `leaked: ${needle}`);
  }
});
test('malformed file is reported, does not throw', () => {
  const r = scanProject(FIXTURE);
  assert.ok(r.parse_errors.some((e) => e.startsWith('lib/broken.ts')));
});
test('binary files, oversized files and symlinks pointing outside are skipped', () => {
  const outside = tmpProject({ 'evil.py': 'from openai import OpenAI\nOpenAI().chat.completions.create(model="gpt-5.6", messages=[])\n' });
  const dir = tmpProject({
    'bin.ts': 'import OpenAI from "openai"\u0000\u0000 c.chat.completions.create({model:"gpt-5.6"})',
    'big.ts': 'import OpenAI from "openai";\n' + '// pad\n'.repeat(200_000),
    'ok.ts': 'import OpenAI from "openai";\nconst c = new OpenAI();\nc.chat.completions.create({ model: "gpt-5.6-luna", messages: [] });\n',
  });
  symlinkSync(outside, path.join(dir, 'linked'), 'dir');
  const r = scanProject(dir);
  assert.deepEqual(r.sites.map((s) => s.file), ['ok.ts']);
  assert.equal(r.skipped.binary, 1); assert.equal(r.skipped.too_large, 1); assert.equal(r.skipped.symlink, 1);
});
test('Vercel AI SDK, Google, Mistral, Groq, OpenRouter are attributed to the right provider', () => {
  const dir = tmpProject({
    'a.ts': 'import { generateText } from "ai";\nimport { openai } from "@ai-sdk/openai";\nawait generateText({ model: openai("gpt-5.6-luna"), prompt: "x" });\n',
    'b.ts': 'import { GoogleGenAI } from "@google/genai";\nconst ai = new GoogleGenAI({});\nawait ai.models.generateContent({ model: "gemini-2.5-flash", contents: "hi" });\n',
    'c.ts': 'import { Mistral } from "@mistralai/mistralai";\nconst m = new Mistral({});\nawait m.chat.complete({ model: "mistral-small-latest", messages: [] });\n',
    'd.ts': 'import Groq from "groq-sdk";\nconst g = new Groq();\nawait g.chat.completions.create({ model: "openai/gpt-oss-20b", messages: [] });\n',
    'e.ts': 'import OpenAI from "openai";\nconst o = new OpenAI({ baseURL: "https://openrouter.ai/api/v1" });\nawait o.chat.completions.create({ model: "anthropic/claude-haiku-4-5", messages: [] });\n',
    'f.py': 'import anthropic\nMODEL = "claude-haiku-4-5"\nclient = anthropic.Anthropic()\nclient.messages.create(\n    model=MODEL,\n    max_tokens=100,\n    messages=[],\n)\n',
  });
  const by = Object.fromEntries(scanProject(dir).sites.map((s) => [s.file, s]));
  assert.equal(by['a.ts'].provider, 'openai'); assert.equal(by['a.ts'].model, 'gpt-5.6-luna');
  assert.equal(by['b.ts'].provider, 'google');
  assert.equal(by['c.ts'].provider, 'mistral');
  assert.equal(by['d.ts'].provider, 'groq');
  assert.equal(by['e.ts'].provider, 'openrouter');
  assert.equal(by['f.py'].model, 'claude-haiku-4-5'); assert.equal(by['f.py'].model_source, 'constant');
});
test('false-positive guard: unrelated .create() / .messages.create without an LLM import is ignored', () => {
  const dir = tmpProject({ 'x.ts': 'const r = db.messages.create({ model: "x" });\nconst u = api.chat.completions.create({ model: "y" });\n' });
  assert.equal(scanProject(dir).sites.length, 0);
});
test('CRLF files and empty projects work', () => {
  const dir = tmpProject({ 'w.ts': 'import OpenAI from "openai";\r\nconst c = new OpenAI();\r\nfor (const x of xs) {\r\n  await c.chat.completions.create({\r\n    model: "gpt-5.6-luna",\r\n  });\r\n}\r\n' });
  const s = scanProject(dir).sites[0];
  assert.equal(s.model, 'gpt-5.6-luna'); assert.equal(s.in_loop, true);
  assert.equal(scanProject(tmpProject({ 'README.md': 'hi' })).sites.length, 0);
});
test('loop detection stops at function boundaries', () => {
  const dir = tmpProject({ 'l.ts': 'import OpenAI from "openai";\nconst c = new OpenAI();\nfor (const a of b) { foo(a); }\nasync function one() {\n  return c.chat.completions.create({ model: "gpt-5.6-luna", messages: [] });\n}\n' });
  assert.equal(scanProject(dir).sites[0].in_loop, false);
});
test('helpers: matchParen is string-aware; readString handles templates and python triple quotes', () => {
  const t = 'f({ a: ")", b: `x${(1)}` }) tail';
  assert.equal(t[matchParen(t, 1)], ')'); assert.equal(matchParen(t, 1), t.indexOf(') tail'));
  assert.equal(matchParen('f(((', 1), -1);
  const s = readString('`a${b}c`', 0); assert.equal(s.interp, true); assert.equal(s.len, 6);
  const p = readString('"""line1\nline2"""', 0, true); assert.equal(p.len, 11);
  assert.equal(readString('"unterminated', 0), null);
});
