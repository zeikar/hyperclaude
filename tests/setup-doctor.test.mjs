import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseSemver,
  cmpSemver,
  evalNode,
  evalCodex,
  evalGit,
  evalCodexSearch,
  evalAgentTeams,
  aggregate,
} from '../scripts/setup-doctor.mjs';

// ---------- import-safety ----------

test('import-safety: importing setup-doctor.mjs does not run main()', () => {
  const testsDir = fileURLToPath(new URL('.', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['-e', 'import("../scripts/setup-doctor.mjs").then(()=>process.stdout.write("IMPORTED_NO_OUTPUT"))'],
    { cwd: testsDir, encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, `process exited with status ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout, 'IMPORTED_NO_OUTPUT');
});

// ---------- CLI: one JSON line ----------

test('CLI: exits 0 and emits exactly one parseable JSON line with ok + 4-element checks', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['scripts/setup-doctor.mjs'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 15000 },
  );
  // The script always exits 0; ok:false is emitted in JSON when prerequisites fail.
  assert.equal(result.status, 0, `process exited with status ${result.status}: ${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected exactly 1 line, got ${lines.length}`);
  const parsed = JSON.parse(lines[0]);
  assert.equal(typeof parsed.ok, 'boolean');
  assert.ok(Array.isArray(parsed.checks), 'checks should be an array');
  assert.equal(parsed.checks.length, 5, `expected 5 checks, got ${parsed.checks.length}`);
});

// ---------- parseSemver ----------

test('parseSemver: "codex-cli 0.130.0" → [0,130,0]', () => {
  assert.deepEqual(parseSemver('codex-cli 0.130.0'), [0, 130, 0]);
});

test('parseSemver: "git version 2.39.5" → [2,39,5]', () => {
  assert.deepEqual(parseSemver('git version 2.39.5'), [2, 39, 5]);
});

test('parseSemver: "v18.20.0" → [18,20,0]', () => {
  assert.deepEqual(parseSemver('v18.20.0'), [18, 20, 0]);
});

test('parseSemver: "2.39" (no patch) → [2,39,0]', () => {
  assert.deepEqual(parseSemver('2.39'), [2, 39, 0]);
});

test('parseSemver: garbage with no triple → null', () => {
  assert.equal(parseSemver('not a version at all'), null);
  assert.equal(parseSemver(''), null);
  assert.equal(parseSemver(42), null);
});

// ---------- cmpSemver ----------

test('cmpSemver: 0.129.0 < 0.130.0 → -1', () => {
  assert.equal(cmpSemver([0, 129, 0], [0, 130, 0]), -1);
});

test('cmpSemver: 0.130.0 == 0.130.0 → 0', () => {
  assert.equal(cmpSemver([0, 130, 0], [0, 130, 0]), 0);
});

test('cmpSemver: 0.131.0 > 0.130.0 → 1', () => {
  assert.equal(cmpSemver([0, 131, 0], [0, 130, 0]), 1);
});

// ---------- evalNode ----------

test('evalNode: "18.20.0" → PASS, hard', () => {
  const r = evalNode('18.20.0');
  assert.equal(r.status, 'PASS');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, '18.20.0');
});

test('evalNode: "16.20.0" → hard FAIL', () => {
  const r = evalNode('16.20.0');
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, '16.20.0');
});

test('evalNode: "nonsense" (unparseable) → hard FAIL', () => {
  const r = evalNode('nonsense');
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'nonsense');
});

// ---------- evalCodex ----------

test('evalCodex: {kind:"enoent"} → hard FAIL, detected "not found"', () => {
  const r = evalCodex({ kind: 'enoent' });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'not found');
});

test('evalCodex: {kind:"timeout"} → hard FAIL, detected "timeout"', () => {
  const r = evalCodex({ kind: 'timeout' });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'timeout');
});

test('evalCodex: {kind:"error"} → hard FAIL, detected "error"', () => {
  const r = evalCodex({ kind: 'error' });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'error');
});

test('evalCodex: {kind:"error-exit",status:1} → hard FAIL, detected "error-exit"', () => {
  const r = evalCodex({ kind: 'error-exit', status: 1 });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'error-exit');
});

test('evalCodex: {kind:"ok",output:"no version here"} → hard FAIL, detected "unparseable"', () => {
  const r = evalCodex({ kind: 'ok', output: 'no version here', status: 0 });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'unparseable');
});

test('evalCodex: {kind:"ok",output:"codex-cli 0.129.0"} → hard FAIL, detected "0.129.0"', () => {
  const r = evalCodex({ kind: 'ok', output: 'codex-cli 0.129.0', status: 0 });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, '0.129.0');
});

test('evalCodex: {kind:"ok",output:"codex-cli 0.130.0"} → PASS', () => {
  const r = evalCodex({ kind: 'ok', output: 'codex-cli 0.130.0', status: 0 });
  assert.equal(r.status, 'PASS');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, '0.130.0');
});

test('evalCodex: {kind:"ok",output:"codex-cli 0.131.2"} → PASS', () => {
  const r = evalCodex({ kind: 'ok', output: 'codex-cli 0.131.2', status: 0 });
  assert.equal(r.status, 'PASS');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, '0.131.2');
});

// ---------- evalGit ----------

test('evalGit: {kind:"enoent"} → hard FAIL, detected "not found"', () => {
  const r = evalGit({ kind: 'enoent' });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'not found');
});

test('evalGit: {kind:"error-exit",status:1} → hard FAIL, detected "error-exit"', () => {
  const r = evalGit({ kind: 'error-exit', status: 1 });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'error-exit');
});

test('evalGit: {kind:"timeout"} → hard FAIL, detected "timeout"', () => {
  const r = evalGit({ kind: 'timeout' });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'timeout');
});

test('evalGit: {kind:"error"} → hard FAIL, detected "error"', () => {
  const r = evalGit({ kind: 'error' });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'error');
});

test('evalGit: {kind:"ok",output:"no version here"} → hard FAIL, detected "unparseable"', () => {
  const r = evalGit({ kind: 'ok', output: 'no version here', status: 0 });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'unparseable');
});

test('evalGit: {kind:"ok",output:"git version 2.39.5"} → PASS', () => {
  const r = evalGit({ kind: 'ok', output: 'git version 2.39.5', status: 0 });
  assert.equal(r.status, 'PASS');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, '2.39.5');
});

// ---------- evalCodexSearch ----------

test('evalCodexSearch: {kind:"ok"} → PASS, hard, detected "accepted"', () => {
  const r = evalCodexSearch({ kind: 'ok', output: '', status: 0 });
  assert.equal(r.status, 'PASS');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'accepted');
});

test('evalCodexSearch: {kind:"error-exit",status:1} → hard FAIL, detected "rejected"', () => {
  const r = evalCodexSearch({ kind: 'error-exit', status: 1 });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'rejected');
});

test('evalCodexSearch: {kind:"enoent"} → hard FAIL, detected "not found"', () => {
  const r = evalCodexSearch({ kind: 'enoent' });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.severity, 'hard');
  assert.equal(r.detected, 'not found');
});

// ---------- evalAgentTeams ----------

test('evalAgentTeams: "1" → PASS, severity NOT hard', () => {
  const r = evalAgentTeams('1');
  assert.equal(r.status, 'PASS');
  assert.equal(r.severity, 'conditional');
  assert.equal(r.detected, '1');
});

test('evalAgentTeams: undefined → WARN, severity "conditional", detected "<unset>"', () => {
  const r = evalAgentTeams(undefined);
  assert.equal(r.status, 'WARN');
  assert.equal(r.severity, 'conditional');
  assert.equal(r.detected, '<unset>');
});

test('evalAgentTeams: "" (empty string) → WARN, severity "conditional", detected "<unset>"', () => {
  const r = evalAgentTeams('');
  assert.equal(r.status, 'WARN');
  assert.equal(r.severity, 'conditional');
  assert.equal(r.detected, '<unset>');
});

// ---------- aggregate ----------

test('aggregate: one hard FAIL → ok === false', () => {
  const checks = [
    evalNode('16.0.0'),                                                       // hard FAIL
    evalCodex({ kind: 'ok', output: 'codex-cli 0.130.0', status: 0 }),        // PASS
    evalGit({ kind: 'ok', output: 'git version 2.39.5', status: 0 }),         // PASS
    evalCodexSearch({ kind: 'ok', output: '', status: 0 }),                   // PASS
    evalAgentTeams('1'),                                                       // PASS
  ];
  const result = aggregate(checks);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks, checks);
});

test('aggregate: all hard checks PASS, agent-teams WARNs → ok === true', () => {
  const checks = [
    evalNode('18.20.0'),                                                       // PASS
    evalCodex({ kind: 'ok', output: 'codex-cli 0.130.0', status: 0 }),        // PASS
    evalGit({ kind: 'ok', output: 'git version 2.39.5', status: 0 }),         // PASS
    evalCodexSearch({ kind: 'ok', output: '', status: 0 }),                   // PASS
    evalAgentTeams(undefined),                                                 // WARN conditional
  ];
  const result = aggregate(checks);
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, checks);
});

test('aggregate: codexSearch hard FAIL → ok === false', () => {
  const checks = [
    evalNode('18.20.0'),                                                       // PASS
    evalCodex({ kind: 'ok', output: 'codex-cli 0.130.0', status: 0 }),        // PASS
    evalGit({ kind: 'ok', output: 'git version 2.39.5', status: 0 }),         // PASS
    evalCodexSearch({ kind: 'error-exit', status: 1 }),                       // hard FAIL
    evalAgentTeams('1'),                                                       // PASS
  ];
  const result = aggregate(checks);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks, checks);
});
