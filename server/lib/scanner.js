// Static scanner: finds LLM call sites in JS/TS/Python source using a tokenizer-light approach
// (balanced-paren argument extraction + string-literal aware), NOT a full AST. See README "Limitations".
// Security properties (enforced by tests):
//  - never reads dotfiles named .env*, key/cert files, or anything outside the project root
//  - never returns prompt text or string literals other than a validated model identifier
import { readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'venv', '.venv',
  '__pycache__', 'vendor', '.turbo', '.cache', '.nuxt', '.svelte-kit', 'site-packages', '.tox', '.mypy_cache']);
const DENY_FILE = /(^\.env)|\.(pem|key|p12|pfx|crt)$|^id_(rsa|ed25519|ecdsa)|secrets?\.(json|ya?ml)$|credentials/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|mocks?)(\/|$)|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/i;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 20_000;
const MODEL_OK = /^[A-Za-z0-9][\w./:@-]{0,99}$/;
const SECRET_LIKE = /^(?:sk|pk|rk)[-_]|^AKIA|^gh[pous]_|^xox[abp]-|^AIza|^eyJ/;

const FILE_PROVIDERS = [
  ['openai', /from\s+['"]openai['"]|require\(\s*['"]openai['"]\s*\)|@ai-sdk\/openai|^\s*(?:import openai|from openai import)|langchain_openai|@langchain\/openai/m],
  ['anthropic', /@anthropic-ai\/sdk|@ai-sdk\/anthropic|^\s*(?:import anthropic|from anthropic import)|langchain_anthropic|@langchain\/anthropic/m],
  ['google', /@google\/genai|@google\/generative-ai|@ai-sdk\/google|google\.generativeai|from google import genai|langchain_google_genai|@langchain\/google-genai/],
  ['mistral', /@mistralai\/mistralai|@ai-sdk\/mistral|^\s*(?:import mistralai|from mistralai)/m],
  ['groq', /groq-sdk|@ai-sdk\/groq|^\s*(?:import groq|from groq import)/m],
  ['openrouter', /openrouter/i],
  ['litellm', /litellm/i],
];

const CALLS = [
  { re: /\.chat\.completions\.(?:create|parse|stream)\s*\(/g, kind: 'chat', api: 'chat.completions' },
  { re: /\.responses\.(?:create|parse|stream)\s*\(/g, kind: 'chat', api: 'responses', provider: 'openai' },
  { re: /\.messages\.(?:create|stream)\s*\(/g, kind: 'chat', api: 'messages', provider: 'anthropic' },
  { re: /\.embeddings\.create\s*\(/g, kind: 'embedding', api: 'embeddings' },
  { re: /\b(?:generateText|streamText|generateObject|streamObject)\s*\(/g, kind: 'chat', api: 'vercel-ai' },
  { re: /\.models\.generate(?:Content|ContentStream)\s*\(/g, kind: 'chat', api: 'generateContent', provider: 'google' },
  { re: /\.generate_content(?:_stream)?\s*\(/g, kind: 'chat', api: 'generate_content', provider: 'google' },
  { re: /\.chat\.(?:complete|stream)\s*\(/g, kind: 'chat', api: 'mistral.chat', provider: 'mistral' },
  { re: /\blitellm\.(?:a?completion)\s*\(/g, kind: 'chat', api: 'litellm' },
];

const LOOP_LINE = /^\s*(?:async\s+)?(?:for|while)\b|\.(?:map|forEach|flatMap|reduce)\s*\(|\bPromise\.all(?:Settled)?\s*\(|\basyncio\.gather\s*\(|\bfor\s+await\b/;
const FUNC_LINE = /^\s*(?:export\s+)?(?:async\s+)?(?:function\b|def\b|class\b)|^\s*(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>\s*\{?\s*$/;

const DEP_SDKS = { openai: 'openai', '@anthropic-ai/sdk': 'anthropic', anthropic: 'anthropic', '@google/genai': 'google',
  '@google/generative-ai': 'google', 'google-generativeai': 'google', 'google-genai': 'google', '@mistralai/mistralai': 'mistral',
  mistralai: 'mistral', 'groq-sdk': 'groq', groq: 'groq', ai: 'vercel-ai-sdk', '@ai-sdk/openai': 'openai', '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google', langchain: 'langchain', '@langchain/core': 'langchain', litellm: 'litellm', llamaindex: 'llamaindex',
  'llama-index': 'llamaindex', '@openrouter/ai-sdk-provider': 'openrouter' };
const DEP_VECTOR = ['pinecone', '@pinecone-database/pinecone', 'weaviate-client', 'weaviate', 'chromadb', '@qdrant/js-client-rest', 'qdrant-client',
  'pgvector', 'pymilvus', '@zilliz/milvus2-sdk-node', '@upstash/vector', 'vectordb', 'lancedb', 'faiss-cpu', 'faiss-node'];
const DEP_FRAMEWORK = ['next', 'express', 'fastify', 'hono', 'nestjs', '@nestjs/core', 'fastapi', 'flask', 'django', 'remix', '@sveltejs/kit'];

// ---------- low-level helpers ----------

/** Reads a string literal starting at text[i]. Returns {end, len, interp, value?} or null. */
export function readString(text, i, py = false) {
  let j = i;
  while (py && /[rRbBfFuU]/.test(text[j] ?? '') && j - i < 3) j++;
  const q = text[j];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const prefix = text.slice(i, j).toLowerCase();
  const triple = py && text.startsWith(q.repeat(3), j);
  const close = triple ? q.repeat(3) : q;
  let k = j + close.length;
  const start = k;
  let interp = prefix.includes('f') || false;
  while (k < text.length) {
    const c = text[k];
    if (c === '\\') { k += 2; continue; }
    if (text.startsWith(close, k)) break;
    if (!triple && !py && q !== '`' && c === '\n') return null;
    if (q === '`' && c === '$' && text[k + 1] === '{') interp = true;
    k++;
  }
  if (k >= text.length) return null;
  const raw = text.slice(start, k);
  return { end: k + close.length, len: raw.length, interp, raw };
}

/** Index of the matching ')' for the '(' at openIdx, string- and comment-aware. */
export function matchParen(text, openIdx, py = false, limit = 30_000) {
  let depth = 0;
  for (let i = openIdx; i < text.length && i - openIdx < limit; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; if (depth < 0) return -1; }
    else if (c === '"' || c === "'" || c === '`') {
      const s = readString(text, i, py);
      if (s) i = s.end - 1;
    } else if (c === '/' && text[i + 1] === '/' && !py) { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '#' && py) { while (i < text.length && text[i] !== '\n') i++; }
  }
  return -1;
}

function maskComments(text, py) {
  return text.split('\n').map((l) => {
    const t = l.trimStart();
    const comment = py ? t.startsWith('#') : (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    return comment ? ' '.repeat(l.length) : l;
  }).join('\n');
}

const lineOf = (text, idx) => { let n = 1; for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++; return n; };
const indentOf = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);

/** top-level string constants: name -> {len, hash} */
function collectConstants(text, py) {
  const out = new Map();
  const re = py ? /^([A-Za-z_]\w*)\s*(?::\s*[\w.\[\]]+\s*)?=\s*/gm
    : /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*/g;
  let m;
  while ((m = re.exec(text))) {
    const s = readString(text, m.index + m[0].length, py);
    if (s) out.set(m[1], { len: s.len, hash: hash(s.raw), value: s.len <= 100 ? s.raw : null, interp: s.interp });
  }
  return out;
}

function detectFileProviders(text) {
  return FILE_PROVIDERS.filter(([, re]) => re.test(text)).map(([p]) => p);
}

function parseArgs(args, consts, py) {
  const out = { model: null, model_source: null, model_provider: null, max_tokens: null, has_cache_control: false,
    stream: false, static_chars: 0, prompt_hashes: [], dynamic_prompt: false };

  // model: literal, provider-wrapped (vercel ai), env-with-fallback, or constant
  let m;
  if ((m = args.match(/\bmodel\s*[:=]\s*(?:process\.env\.\w+|os\.(?:getenv|environ\.get)\(\s*['"][^'"]+['"])\s*(?:\|\||\?\?|,)\s*(['"`])([^'"`]+)\1/))) {
    out.model = m[2]; out.model_source = 'env-fallback';
  } else if ((m = args.match(/\bmodel\s*[:=]\s*(?:\w+\.)?(openai|anthropic|google|groq|mistral|openrouter|createOpenAI|createAnthropic)\w*\s*(?:\([^)]*\))?\s*\(\s*(['"`])([^'"`]+)\2/))) {
    out.model = m[3]; out.model_source = 'literal'; out.model_provider = m[1].replace(/^create/, '').toLowerCase();
  } else if ((m = args.match(/\bmodel\s*[:=]\s*(['"`])([^'"`$]+)\1/))) {
    out.model = m[2]; out.model_source = 'literal';
  } else if ((m = args.match(/\bmodel\s*[:=]\s*([A-Za-z_$][\w$.]*)/))) {
    const c = consts.get(m[1]);
    if (c?.value) { out.model = c.value; out.model_source = 'constant'; }
    else out.model_source = 'dynamic';
  } else if ((m = args.match(/\bmodel\b\s*,|\bmodel\b\s*\}/))) { out.model_source = 'dynamic'; }
  else out.model_source = 'missing';
  if (out.model && (!MODEL_OK.test(out.model) || SECRET_LIKE.test(out.model))) { out.model = null; out.model_source = 'dynamic'; } // never echo odd strings (could be secrets)

  if ((m = args.match(/\b(?:max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens|maxTokens|maxCompletionTokens)\s*[:=]\s*(\d[\d_]*)/))) {
    out.max_tokens = parseInt(m[1].replace(/_/g, ''), 10);
  }
  out.has_cache_control = /cache_control|cacheControl|cached_content|cachedContent/.test(args);
  out.stream = /\bstream\s*[:=]\s*(?:true|True)|\.stream\s*\(|\bstreamText\b|\bstreamObject\b|generate_content_stream|generateContentStream/.test(args);

  // static prompt size: literals >= 30 chars inside args (excluding the model), plus referenced constants
  const argsNoModel = args.replace(/\bmodel\s*[:=]\s*(['"`])[^'"`]*\1/, 'model: M');
  args = argsNoModel;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === "'" || c === '`' || (py && /[rRbBfFuU]/.test(c) && /["']/.test(args[i + 1] ?? ''))) {
      const s = readString(args, i, py);
      if (s) {
        if (s.len >= 30) { out.static_chars += s.len; out.prompt_hashes.push(hash(s.raw)); }
        if (s.interp) out.dynamic_prompt = true;
        i = s.end - 1;
      }
    }
  }
  const idents = new Set(args.match(/[A-Za-z_$][\w$]*/g) ?? []);
  for (const id of idents) {
    const c = consts.get(id);
    if (c && c.len >= 200) { out.static_chars += c.len; out.prompt_hashes.push(c.hash); if (c.interp) out.dynamic_prompt = true; }
  }
  if (/\b(messages|input|contents|prompt|history)\b\s*[,}:)]|\.\.\.\s*\w+/.test(args.replace(/\bmodel\b[^,}]*/, ''))
    && !/\b(messages|input|contents|prompt)\s*[:=]\s*[\[`'"]/.test(args)) out.dynamic_prompt = true;
  return out;
}


const TASK_HINT = /(classif|categor|route|routing|intent|\btag|label|sentiment|moderat|extract|detect|triage|spam|validat)/i;
const BACKGROUND_PATH = /(^|\/)(jobs?|cron|workers?|scripts?|batch|etl|backfill|ingest\w*|pipelines?|queues?|tasks?)(\/|\.|-|_)|nightly/i;
const REQUEST_PATH = /(^|\/)api\/|route\.[jt]s$|handler|controller|endpoint|actions?\.[jt]s$|views?\.py$|routers?\//i;
/** Derives coarse flags from the path + preceding code. Returns only booleans/keywords, never source text. */
function hints(rel, before) {
  const m = (rel + ' ' + before).match(TASK_HINT);
  return { task_hint: m ? m[1].toLowerCase() : null, background_path: BACKGROUND_PATH.test(rel), request_path: REQUEST_PATH.test(rel) };
}

function loopInfo(lines, lineIdx, prefixOnLine) {
  if (LOOP_LINE.test(prefixOnLine)) return true; // loop opened earlier on the same line
  let cur = indentOf(lines[lineIdx]);
  for (let i = lineIdx - 1, steps = 0; i >= 0 && steps < 250; i--, steps++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (ind < cur) {
      if (LOOP_LINE.test(l)) return true;
      if (FUNC_LINE.test(l)) return false;
      cur = ind;
      if (cur === 0) return false;
    }
  }
  return false;
}

// ---------- project walk ----------

function* walk(root, rootReal, state) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { state.unreadable++; continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { state.skipped.symlink++; continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); continue; }
      if (!e.isFile()) continue;
      if (DENY_FILE.test(e.name)) { state.skipped.denied++; continue; }
      if (!CODE_EXT.has(path.extname(e.name))) continue;
      if (++state.seen > MAX_FILES) { state.truncated = true; return; }
      yield full;
    }
  }
}

function readDeps(root) {
  const deps = { sdks: new Set(), vector_dbs: new Set(), frameworks: new Set() };
  const add = (name) => {
    const n = name.toLowerCase();
    if (DEP_SDKS[n]) deps.sdks.add(DEP_SDKS[n]);
    if (DEP_VECTOR.includes(n)) deps.vector_dbs.add(n);
    if (DEP_FRAMEWORK.includes(n)) deps.frameworks.add(n);
  };
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const k of ['dependencies', 'devDependencies']) for (const n of Object.keys(pkg[k] ?? {})) add(n);
  } catch { /* no/invalid package.json */ }
  for (const f of ['requirements.txt', 'pyproject.toml']) {
    try {
      const t = readFileSync(path.join(root, f), 'utf8');
      for (const m of t.matchAll(/^[\s"'-]*([A-Za-z0-9_.@/-]+)\s*(?:[=<>!~\[;]|$|"|')/gm)) add(m[1]);
    } catch { /* ignore */ }
  }
  return { sdks: [...deps.sdks].sort(), vector_dbs: [...deps.vector_dbs].sort(), frameworks: [...deps.frameworks].sort() };
}

/**
 * @param {string} root absolute project root (already validated by caller)
 * @param {{includeTests?: boolean}} opts
 */
export function scanProject(root, opts = {}) {
  const rootReal = realpathSync(root);
  const state = { seen: 0, unreadable: 0, truncated: false, skipped: { symlink: 0, denied: 0, tests: 0, too_large: 0, binary: 0 } };
  const sites = [];
  const filesWithCalls = new Set();
  const parseErrors = [];
  let scanned = 0;

  for (const file of walk(rootReal, rootReal, state)) {
    const rel = path.relative(rootReal, file).split(path.sep).join('/');
    if (!opts.includeTests && TEST_PATH.test(rel)) { state.skipped.tests++; continue; }
    let st;
    try { st = lstatSync(file); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) { state.skipped.too_large++; continue; }
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch { state.unreadable++; continue; }
    if (raw.includes('\u0000')) { state.skipped.binary++; continue; }
    scanned++;
    try {
      const py = file.endsWith('.py');
      const text = maskComments(raw, py);
      const lines = text.split('\n');
      const fileProviders = detectFileProviders(text);
      let consts = null;
      for (const spec of CALLS) {
        spec.re.lastIndex = 0;
        let m;
        while ((m = spec.re.exec(text))) {
          const open = m.index + m[0].length - 1;
          const close = matchParen(text, open, py);
          if (close < 0) { parseErrors.push(`${rel}: unbalanced call near line ${lineOf(text, m.index)}`); continue; }
          // vercel-ai / generic names need an LLM-ish import in the file to avoid false positives
          if (spec.api === 'vercel-ai' && !/from\s+['"]ai['"]|require\(['"]ai['"]\)/.test(text)) continue;
          if (spec.api === 'messages' && !fileProviders.includes('anthropic') && !fileProviders.includes('openrouter')) continue;
          if (['chat.completions', 'embeddings'].includes(spec.api) && !fileProviders.some((p) => ['openai', 'groq', 'mistral', 'openrouter', 'litellm', 'google'].includes(p))) continue;
          if (spec.api === 'mistral.chat' && !fileProviders.includes('mistral')) continue;
          if (spec.api === 'generate_content' && !fileProviders.includes('google')) continue;
          consts ??= collectConstants(text, py);
          const args = text.slice(open + 1, close);
          const a = parseArgs(args, consts, py);
          const line = lineOf(text, m.index);
          let provider = spec.provider ?? a.model_provider;
          if (!provider) {
            provider = fileProviders.includes('groq') ? 'groq' : fileProviders.includes('openrouter') ? 'openrouter'
              : fileProviders.includes('mistral') && spec.api === 'chat.completions' ? 'mistral'
              : fileProviders.includes('openai') ? 'openai' : fileProviders.find((p) => p !== 'litellm') ?? 'unknown';
          }
          if (spec.api === 'messages' && fileProviders.includes('openrouter') && !fileProviders.includes('anthropic')) provider = 'openrouter';
          const lineStart = text.lastIndexOf('\n', m.index) + 1;
          sites.push({
            file: rel, line, kind: spec.kind, api: spec.api, provider, language: py ? 'python' : 'js/ts',
            model: a.model, model_source: a.model_source, max_tokens: a.max_tokens,
            has_cache_control: a.has_cache_control, stream: a.stream, static_prompt_chars: a.static_chars,
            dynamic_prompt: a.dynamic_prompt, prompt_hashes: [...new Set(a.prompt_hashes)],
            in_loop: loopInfo(lines, line - 1, text.slice(lineStart, m.index)),
            ...hints(rel, text.slice(Math.max(0, m.index - 400), m.index)),
          });
          filesWithCalls.add(rel);
        }
      }
    } catch (e) { parseErrors.push(`${rel}: ${String(e.message).slice(0, 80)}`); }
  }
  sites.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  return {
    root_name: path.basename(rootReal),
    dependencies: readDeps(rootReal),
    files_scanned: scanned,
    files_with_calls: filesWithCalls.size,
    skipped: state.skipped,
    truncated: state.truncated,
    parse_errors: parseErrors.slice(0, 20),
    sites,
  };
}
