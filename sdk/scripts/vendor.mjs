#!/usr/bin/env node
/**
 * Copies the SDK into the games that vendor it.
 *
 * The games do not `npm install @playkit/sdk` — one of them has no build step
 * at all — so each keeps its own copy of this file. Three hand-maintained
 * copies drift, and a drifted auth client fails in ways that look like server
 * bugs. This makes the copy a command instead of a habit.
 *
 * TypeScript projects take the source (their own compiler handles it); plain
 * ones take the bundle. Targets that are not checked out are skipped, so this
 * still works for anyone who cloned playkit on its own.
 *
 *   npm run vendor
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repos = resolve(here, '../../..');

const HEADER = [
  '// Vendored from the playkit SDK — do not edit here.',
  '// Source: playkit/sdk/src/index.ts',
  '// Re-sync with: npm run vendor  (in playkit/sdk)',
  '',
].join('\n');

/** `source` ships the .ts straight through; `bundle` ships the esbuild output. */
const targets = [
  { to: 'decsion making game/src/lib/playkit.js', kind: 'bundle' },
  { to: 'dance-trainer/src/lib/playkit.ts', kind: 'source' },
  { to: 'pose-runner/playkit.js', kind: 'bundle' },
];

const source = resolve(here, '../src/index.ts');
const bundle = resolve(here, '../dist/playkit.js');

if (!existsSync(bundle)) {
  console.error('dist/playkit.js is missing — run `npm run build` first.');
  process.exit(1);
}

let copied = 0;
for (const { to, kind } of targets) {
  const dest = resolve(repos, to);
  if (!existsSync(dirname(dest))) {
    console.log(`skip  ${to}  (not checked out)`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const body = readFileSync(kind === 'source' ? source : bundle, 'utf8');
  writeFileSync(dest, HEADER + body);
  console.log(`write ${to}  (${kind})`);
  copied++;
}
console.log(`\n${copied} of ${targets.length} target(s) updated.`);
