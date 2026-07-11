// Tests for get-changelog.mjs — the cc-changelog slice helper. Pure-logic only
// (no network): version compare + changelog slicing against a fixed fixture.
// Run: node --test .claude/skills/cc-changelog/get-changelog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { cmp, sliceChangelog } from './get-changelog.mjs';

// Fixture: descending, with a skipped number (205 absent) and a preamble line.
const FIXTURE = `# Changelog

## 2.1.207

- entry a

## 2.1.206

- entry b

## 2.1.204

- entry c (205 was skipped)

## 2.1.200

- entry d
`;

// ---------- cmp ----------

test('cmp: greater / lesser / equal', () => {
  assert.equal(cmp('2.1.207', '2.1.206'), 1);
  assert.equal(cmp('2.1.206', '2.1.207'), -1);
  assert.equal(cmp('2.1.207', '2.1.207'), 0);
});

test('cmp: numeric, not lexicographic (2.1.100 > 2.1.99)', () => {
  assert.equal(cmp('2.1.100', '2.1.99'), 1);
});

test('cmp: minor and major dominate patch', () => {
  assert.equal(cmp('2.2.0', '2.1.999'), 1);
  assert.equal(cmp('3.0.0', '2.9.9'), 1);
});

test('cmp: skipped-number ordering (2.1.193 > 2.1.192)', () => {
  assert.equal(cmp('2.1.193', '2.1.192'), 1);
});

// ---------- sliceChangelog ----------

test('slice: baseline present → keeps only strictly-newer, verbatim, newest first', () => {
  const { latest, slice } = sliceChangelog(FIXTURE, '2.1.204');
  assert.equal(latest, '2.1.207');
  assert.match(slice, /^## 2\.1\.207/); // newest first
  assert.ok(slice.includes('## 2.1.206'));
  assert.ok(slice.includes('- entry a'));
  assert.ok(!slice.includes('## 2.1.204'), 'baseline itself excluded');
  assert.ok(!slice.includes('## 2.1.200'), 'older excluded');
  assert.ok(!slice.includes('# Changelog'), 'preamble excluded');
});

test('slice: skipped baseline (205 never a header) stops at first ≤ baseline', () => {
  const { latest, slice } = sliceChangelog(FIXTURE, '2.1.205');
  assert.equal(latest, '2.1.207');
  assert.ok(slice.includes('## 2.1.207'));
  assert.ok(slice.includes('## 2.1.206'));
  assert.ok(!slice.includes('## 2.1.204'), '204 ≤ 205 → excluded');
});

test('slice: baseline == latest → empty slice, latest still reported', () => {
  const { latest, slice } = sliceChangelog(FIXTURE, '2.1.207');
  assert.equal(latest, '2.1.207');
  assert.equal(slice, '');
});

test('slice: baseline newer than latest → empty slice', () => {
  const { slice } = sliceChangelog(FIXTURE, '2.1.999');
  assert.equal(slice, '');
});

test('slice: low baseline keeps all real entries but never the baseline gap', () => {
  const { slice } = sliceChangelog(FIXTURE, '2.1.200');
  assert.ok(slice.includes('## 2.1.207'));
  assert.ok(slice.includes('## 2.1.204'));
  assert.ok(!slice.includes('## 2.1.200'), '200 == baseline → excluded');
});

test('slice: no headers at all → latest null, empty slice', () => {
  const { latest, slice } = sliceChangelog('just prose, no versions\n', '2.1.0');
  assert.equal(latest, null);
  assert.equal(slice, '');
});

// ---------- import safety ----------

test('importing get-changelog.mjs does not run main()', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const res = spawnSync(
    process.execPath,
    ['-e', 'import("./get-changelog.mjs").then(()=>process.stdout.write("IMPORTED_NO_OUTPUT"))'],
    { cwd: dir, encoding: 'utf8' }
  );
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'IMPORTED_NO_OUTPUT'); // no LATEST=/fetch output leaked
});
