// Unit tests: git helpers — getGitHead and verifyReviewTarget preflight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { getGitHead, verifyReviewTarget } from '../scripts/codex-bridge.mjs';
import { BRIDGE } from './helpers/fixtures.mjs';

// ── getGitHead ────────────────────────────────────────────────────────────────

test('getGitHead: returns sha string in a git repo', () => {
  const sha = getGitHead();
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test('getGitHead: returns \'unknown\' outside a git repo', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-nogit-'));
  const orig = process.cwd();
  try {
    process.chdir(tmp);
    const sha = getGitHead();
    assert.equal(sha, 'unknown');
  } finally {
    process.chdir(orig);
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── verifyReviewTarget ────────────────────────────────────────────────────────

test('verifyReviewTarget: uncommitted ok inside a git work tree', () => {
  assert.deepEqual(verifyReviewTarget({ reviewTarget: 'uncommitted' }), { ok: true });
});

test('verifyReviewTarget: base ok when ref resolves', () => {
  const head = getGitHead();
  assert.deepEqual(verifyReviewTarget({ reviewTarget: 'base', baseRef: head }), { ok: true });
});

test('verifyReviewTarget: base fails for a nonexistent ref', () => {
  const r = verifyReviewTarget({ reviewTarget: 'base', baseRef: 'no-such-ref-zzz' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /base ref not found: no-such-ref-zzz/);
});

test('verifyReviewTarget: commit ok for a real sha, fails for a fake one', () => {
  const head = getGitHead();
  assert.deepEqual(verifyReviewTarget({ reviewTarget: 'commit', commit: head }), { ok: true });
  const bad = verifyReviewTarget({ reviewTarget: 'commit', commit: 'deadbeefdeadbeef' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /commit not found: deadbeefdeadbeef/);
});

test('verifyReviewTarget: base fails when ref resolves but has no merge base with HEAD', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-vrt-nomb-'));
  const orig = process.cwd();
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: tmp, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')} failed: ${r.stderr}`);
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('commit', '-q', '--allow-empty', '-m', 'main commit');
    const mainBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).stdout.trim();
    // Orphan branch: unrelated history, resolvable ref, no merge base with HEAD.
    git('checkout', '-q', '--orphan', 'orphan');
    git('commit', '-q', '--allow-empty', '-m', 'orphan commit');
    git('checkout', '-q', mainBranch);
    process.chdir(tmp);
    const r = verifyReviewTarget({ reviewTarget: 'base', baseRef: 'orphan' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no merge base/);
  } finally {
    process.chdir(orig);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifyReviewTarget: fails when not inside a git work tree', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-vrt-nogit-'));
  const orig = process.cwd();
  try {
    process.chdir(tmp);
    const r = verifyReviewTarget({ reviewTarget: 'uncommitted' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not inside a git work tree/);
  } finally {
    process.chdir(orig);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: code-review --dry-run does not require templates or codex on PATH', () => {
  const result = spawnSync(
    process.execPath,
    [BRIDGE, 'code-review', '--dry-run'],
    { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } }
  );
  assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
});
