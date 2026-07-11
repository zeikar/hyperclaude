#!/usr/bin/env node
// get-releases — list openai/codex GitHub Releases and print only the STABLE release
// notes newer than a baseline, plus a one-line alpha-awareness note. Repo-local dev
// tool for the codex-changelog skill; no Codex, stdlib only (shells out to `gh`).
//
// Usage:  node get-releases.mjs [BASELINE]
//   BASELINE  optional stable X.Y.Z. If omitted, reads `.last-checked-version` next to
//             this script (the maintainer's diff baseline).
//
// Output (stdout):
//   LATEST_STABLE=<x.y.z>
//   ALPHAS=<n> newer[ (latest <tag>)]        alpha stream awareness (not per-release)
//   [NOTE: window did not reach baseline ...] only when the 40-release window truncates
//   then, per new stable (newest first):  === <tag> (<name>) ===\n<body>
//   or, when nothing newer:               (up to date — no new stable since <baseline>)
// Exit: 0 on success; 1 on `gh` failure; 2 on bad/missing baseline.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = 'openai/codex';
const LIMIT = 40;
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), '.last-checked-version');
const SEMVER = /^\d+\.\d+\.\d+$/;
const TAG = /^rust-v(\d+\.\d+\.\d+)(-[0-9A-Za-z.]+)?$/;

// Numeric X.Y.Z compare (releases skip patch numbers too; never string-compare).
export function cmp(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

// `rust-v0.145.0-alpha.4` -> { version: '0.145.0', isPrerelease: true }; null if unparseable.
export function parseTag(tagName) {
  const m = String(tagName).match(TAG);
  if (!m) return null;
  return { version: m[1], isPrerelease: Boolean(m[2]) };
}

// Pure core. Given the `gh release list --json tagName,isPrerelease,isLatest` array
// (newest-first) and a stable baseline, decide what's new.
export function selectReleases(list, baseline) {
  let latestStable = null;
  const newStables = [];
  let newerAlphaCount = 0;
  let latestAlphaTag = null;
  let windowReachedBaseline = false;

  for (const rel of list) {
    const parsed = parseTag(rel.tagName);
    if (!parsed) continue;
    const { version } = parsed;
    const prerelease = rel.isPrerelease ?? parsed.isPrerelease;

    if (prerelease) {
      if (cmp(version, baseline) > 0) {
        newerAlphaCount++;
        if (!latestAlphaTag) latestAlphaTag = rel.tagName; // list is newest-first
      }
      continue;
    }
    // stable
    if (!latestStable || cmp(version, latestStable) > 0) latestStable = version;
    if (cmp(version, baseline) > 0) newStables.push({ tag: rel.tagName, version });
    else windowReachedBaseline = true; // saw a stable at/below baseline → window is deep enough
  }

  newStables.sort((a, b) => cmp(b.version, a.version)); // newest first
  return { latestStable, newStables, newerAlphaCount, latestAlphaTag, windowReachedBaseline };
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

function gh(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8' });
  if (res.error) throw new Error(res.error.message);
  if (res.status !== 0) throw new Error(`gh ${args.join(' ')} → ${(res.stderr || '').trim()}`);
  return res.stdout;
}

function main() {
  const baseline = resolveBaseline();
  if (!SEMVER.test(baseline)) {
    console.error(`Baseline must be stable X.Y.Z, got: "${baseline}"`);
    process.exit(2);
  }

  let list;
  try {
    list = JSON.parse(
      gh(['release', 'list', '--repo', REPO, '--limit', String(LIMIT),
        '--json', 'tagName,isPrerelease,isLatest'])
    );
  } catch (err) {
    console.error(`Failed to list releases: ${err.message}`);
    process.exit(1);
  }

  const sel = selectReleases(list, baseline);
  console.log(`LATEST_STABLE=${sel.latestStable ?? 'unknown'}`);
  console.log(
    sel.newerAlphaCount > 0
      ? `ALPHAS=${sel.newerAlphaCount} newer (latest ${sel.latestAlphaTag})`
      : 'ALPHAS=0 newer'
  );
  if (sel.newStables.length && !sel.windowReachedBaseline) {
    console.log(`NOTE: window of ${LIMIT} releases did not reach ${baseline}; older stables may be missing — increase LIMIT.`);
  }

  if (!sel.newStables.length) {
    console.log(`(up to date — no new stable since ${baseline})`);
    return;
  }

  for (const { tag } of sel.newStables) {
    let notes;
    try {
      notes = JSON.parse(gh(['release', 'view', tag, '--repo', REPO, '--json', 'name,body']));
    } catch (err) {
      console.error(`Failed to read ${tag}: ${err.message}`);
      process.exit(1);
    }
    console.log(`\n=== ${tag} (${notes.name}) ===`);
    console.log((notes.body || '').trim());
  }
}

// Run main() only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
