#!/usr/bin/env node
// get-changelog — fetch the Claude Code CHANGELOG and print only the entries
// strictly newer than a baseline version. Repo-local dev tool for the cc-changelog
// skill; no Codex, stdlib only (Node 18+ global fetch — no temp file, no curl/awk).
//
// Usage:  node get-changelog.mjs [BASELINE]
//   BASELINE  optional X.Y.Z. If omitted, reads `.last-checked-version` next to this
//             script (the maintainer's diff baseline).
//
// Output (stdout):
//   line 1        LATEST=<x.y.z>              (topmost changelog version)
//   then          the sliced markdown         (entries strictly newer than BASELINE,
//                                               verbatim, newest first)
//   or            (up to date — nothing newer than <baseline>)   when nothing is newer.
// Exit: 0 on success (new or not); 1 on fetch failure; 2 on bad/missing baseline.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const CHANGELOG_URL =
  'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '.last-checked-version');
const SEMVER = /^\d+\.\d+\.\d+$/;
const HEADER = /^## (\d+\.\d+\.\d+)\b/;

// Compare X.Y.Z triples numerically. The changelog skips numbers (e.g. 2.1.191→2.1.193),
// so we must order by version, never stop at the literal baseline header (it may not exist).
export function cmp(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

// Pure core: from full changelog text, return the latest version and the slice of
// entries strictly newer than `baseline` (verbatim, newest first; '' if none).
export function sliceChangelog(text, baseline) {
  let latest = null;
  let keep = false;
  const kept = [];
  for (const line of text.split('\n')) {
    const m = line.match(HEADER);
    if (m) {
      if (!latest) latest = m[1];
      keep = cmp(m[1], baseline) > 0;
    }
    if (keep) kept.push(line);
  }
  return { latest, slice: kept.join('\n').trim() };
}

function resolveBaseline() {
  const arg = process.argv[2]?.trim();
  if (arg) return arg;
  try {
    return readFileSync(STATE_FILE, 'utf8').trim();
  } catch {
    console.error(`No baseline given and ${STATE_FILE} is missing/unreadable.`);
    process.exit(2);
  }
}

async function main() {
  const baseline = resolveBaseline();
  if (!SEMVER.test(baseline)) {
    console.error(`Baseline must be X.Y.Z, got: "${baseline}"`);
    process.exit(2);
  }

  let text;
  try {
    const res = await fetch(CHANGELOG_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    console.error(`Failed to fetch changelog: ${err.message}`);
    process.exit(1);
  }

  const { latest, slice } = sliceChangelog(text, baseline);
  console.log(`LATEST=${latest ?? 'unknown'}`);
  console.log(slice || `(up to date — nothing newer than ${baseline})`);
}

// Run main() only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
