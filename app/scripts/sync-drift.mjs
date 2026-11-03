// Copies the two Drift result files the #built section reads that are not produced by drift/export.py:
//   results/drift/memo-example.html  ->  app/public/drift/memo.html          (the linked memo, byte for byte)
//   results/drift/infinitime_hr.json ->  app/public/data/drift-infinitime.json (Figure 8, byte for byte)
// app/public/data/winner.json is written by `python -m drift all` and is not touched here.
// Usage (from app/):  node scripts/sync-drift.mjs
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pairs = [
  ['results/drift/memo-example.html', 'app/public/drift/memo.html'],
  ['results/drift/infinitime_hr.json', 'app/public/data/drift-infinitime.json'],
];
for (const [from, to] of pairs) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) { console.error(`sync-drift: ${from} is missing (run python -m drift all first)`); process.exitCode = 1; continue; }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`sync-drift: ${from} -> ${to}`);
}
