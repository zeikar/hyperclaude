// Tests for get-releases.mjs — the codex-changelog release-selection helper.
// Pure-logic only (no `gh`, no network): tag parsing + version compare + selection.
// Run: node --test .claude/skills/codex-changelog/get-releases.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { cmp, parseTag, selectReleases } from './get-releases.mjs';

// Fixture: newest-first, as `gh release list --json` returns.
const LIST = [
  { tagName: 'rust-v0.145.0-alpha.4', isPrerelease: true, isLatest: false },
  { tagName: 'rust-v0.144.1', isPrerelease: false, isLatest: true },
  { tagName: 'rust-v0.144.0', isPrerelease: false, isLatest: false },
  { tagName: 'rust-v0.144.0-alpha.2', isPrerelease: true, isLatest: false },
  { tagName: 'rust-v0.143.0', isPrerelease: false, isLatest: false },
  { tagName: 'rust-v0.142.5', isPrerelease: false, isLatest: false },
  { tagName: 'rust-v0.142.4', isPrerelease: false, isLatest: false },
];

// ---------- cmp ----------

test('cmp: numeric, not lexicographic (0.144.10 > 0.144.9)', () => {
  assert.equal(cmp('0.144.10', '0.144.9'), 1);
  assert.equal(cmp('0.144.1', '0.144.1'), 0);
  assert.equal(cmp('0.143.0', '0.144.0'), -1);
});

// ---------- parseTag ----------

test('parseTag: stable strips rust-v prefix, not a prerelease', () => {
  assert.deepEqual(parseTag('rust-v0.144.1'), { version: '0.144.1', isPrerelease: false });
});

test('parseTag: alpha/beta/rc suffix → prerelease, base version extracted', () => {
  assert.deepEqual(parseTag('rust-v0.145.0-alpha.4'), { version: '0.145.0', isPrerelease: true });
  assert.deepEqual(parseTag('rust-v0.143.0-beta.1'), { version: '0.143.0', isPrerelease: true });
  assert.deepEqual(parseTag('rust-v0.143.0-rc.2'), { version: '0.143.0', isPrerelease: true });
});

test('parseTag: unparseable tag → null', () => {
  assert.equal(parseTag('v1.2.3'), null);
  assert.equal(parseTag('nightly'), null);
});

// ---------- selectReleases ----------

test('select: baseline mid-list → new stables desc, baseline & older excluded', () => {
  const sel = selectReleases(LIST, '0.142.5');
  assert.equal(sel.latestStable, '0.144.1');
  assert.deepEqual(sel.newStables.map((s) => s.version), ['0.144.1', '0.144.0', '0.143.0']);
  assert.ok(!sel.newStables.some((s) => s.version === '0.142.5'), 'baseline excluded');
  assert.ok(!sel.newStables.some((s) => s.version === '0.142.4'), 'older excluded');
  assert.equal(sel.windowReachedBaseline, true);
});

test('select: alphas counted only when base version > baseline; latest is newest-first', () => {
  const sel = selectReleases(LIST, '0.142.5');
  // 0.145.0-alpha.4 (base 0.145.0 > 0.142.5) and 0.144.0-alpha.2 (base 0.144.0 > 0.142.5)
  assert.equal(sel.newerAlphaCount, 2);
  assert.equal(sel.latestAlphaTag, 'rust-v0.145.0-alpha.4');
});

test('select: at latest stable → no new stables, alpha for a future minor still counts', () => {
  const sel = selectReleases(LIST, '0.144.1');
  assert.deepEqual(sel.newStables, []);
  assert.equal(sel.latestStable, '0.144.1');
  // 0.145.0-alpha.4 base > 0.144.1 counts; 0.144.0-alpha.2 base 0.144.0 <= 0.144.1 does not.
  assert.equal(sel.newerAlphaCount, 1);
  assert.equal(sel.latestAlphaTag, 'rust-v0.145.0-alpha.4');
});

test('select: no newer alphas → count 0, latestAlphaTag null', () => {
  const sel = selectReleases(LIST, '0.145.0');
  assert.equal(sel.newerAlphaCount, 0);
  assert.equal(sel.latestAlphaTag, null);
});

test('select: window truncated (no stable ≤ baseline) flagged', () => {
  const sel = selectReleases(LIST, '0.140.0');
  assert.equal(sel.windowReachedBaseline, false, 'oldest stable 0.142.4 still > baseline');
  assert.ok(sel.newStables.length > 0);
});

test('select: newStables sorted desc even if input order is odd', () => {
  const shuffled = [LIST[4], LIST[1], LIST[2]]; // 0.143.0, 0.144.1, 0.144.0
  const sel = selectReleases(shuffled, '0.142.5');
  assert.deepEqual(sel.newStables.map((s) => s.version), ['0.144.1', '0.144.0', '0.143.0']);
});

// ---------- import safety ----------

test('importing get-releases.mjs does not run main()', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const res = spawnSync(
    process.execPath,
    ['-e', 'import("./get-releases.mjs").then(()=>process.stdout.write("IMPORTED_NO_OUTPUT"))'],
    { cwd: dir, encoding: 'utf8' }
  );
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'IMPORTED_NO_OUTPUT'); // no LATEST_STABLE=/gh output leaked
});
