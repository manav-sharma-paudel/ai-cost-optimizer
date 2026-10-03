import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const FIXTURE = path.join(HERE, 'fixtures', 'nextjs-saas');
export const PRICING_FIXTURE = path.join(HERE, 'fixtures', 'pricing-fixture.json');

/** Create a temp project from {relPath: content}. */
export function tmpProject(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aco-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}
