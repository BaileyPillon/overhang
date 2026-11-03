// Checks that the text copied into app/src/built.ts (the run commands, the README sentence on Collins and Woolley, the five credits)
// still appears in drift/README.md or results/drift/memo-example.md. Usage (from app/):  node scripts/check-built-text.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'app/src/built.ts'), 'utf8');
const readme = readFileSync(join(root, 'drift/README.md'), 'utf8');
const memo = readFileSync(join(root, 'results/drift/memo-example.md'), 'utf8');
const norm = (t) => t.replace(/\*+/g, '').replace(/<\/?em>/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const R = norm(readme);
const M = norm(memo);
const STR = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
let bad = 0;
const ok = (label, hay, needle) => {
  const hit = hay.includes(norm(needle));
  if (!hit) { bad++; console.error(`MISSING ${label}: ${needle.slice(0, 90)}...`); }
  return hit;
};
// run commands: each line of the RUN_CMDS block must be a line of the README quickstart
const cmds = /const RUN_CMDS = `([^`]*)`/.exec(src)?.[1] ?? '';
for (const line of cmds.split('\n')) if (!readme.includes(line)) { bad++; console.error(`MISSING README command line: ${line}`); }
const memoCmd = /const MEMO_CMD = '([^']*)'/.exec(src)?.[1] ?? '';
if (!readme.includes(memoCmd)) { bad++; console.error(`MISSING README memo command: ${memoCmd}`); }
// the README sentence
const prior = new RegExp(String.raw`const README_PRIOR =\s*` + STR).exec(src)?.[1];
if (prior) ok('README prior-art sentence', R, new Function(`return ${prior}`)());
else { bad++; console.error('README_PRIOR not found'); }
// credits: who, text and url strings, worded as in the memo
const credits = src.slice(src.indexOf('const CREDITS'), src.indexOf('/* ================================================================== the section'));
let n = 0;
for (const m of credits.matchAll(new RegExp(String.raw`(who|text|url): ` + STR, 'g'))) {
  const v = new Function(`return ${m[2]}`)();
  n++;
  if (m[1] === 'url') ok('memo url', memo, v);
  else ok(`memo ${m[1]}`, M, v);
}
console.log(bad ? `check-built-text: ${bad} problem(s)` : `check-built-text: ${n} credit strings, ${cmds.split('\n').length + 1} commands and the README sentence all appear in the repository text`);
process.exit(bad ? 1 : 0);
