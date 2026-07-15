// Unit tests: argv parsing and per-mode invocation planning (parseArgs / buildInvocation / dry-run CLI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import { slugify, parseArgs, buildInvocation } from '../scripts/codex-bridge.mjs';
import { BRIDGE } from './helpers/fixtures.mjs';

test('parseArgs: research mode', () => {
  const a = parseArgs(['research', '--task', 'add OAuth', '--slug', 'oauth']);
  assert.deepEqual(a, {
    mode: 'research',
    task: 'add OAuth',
    taskFile: null,
    slug: 'oauth',
    planPath: null,
    out: null,
    dryRun: false,
    timeout: 600,
    reviewTarget: null,
    baseRef: null,
    commit: null,
    title: null,
    background: null,
    reviewBrief: null,
    docsPaths: [],
    docsDir: null,
    diffBase: null,
    resumeFrom: null,
    model: null,
    effort: null,
  });
});

test('parseArgs: plan-review mode with dry-run', () => {
  const a = parseArgs([
    'plan-review',
    '--plan-path', '.hyperclaude/plans/p.md',
    '--dry-run',
  ]);
  assert.equal(a.mode, 'plan-review');
  assert.equal(a.planPath, '.hyperclaude/plans/p.md');
  assert.equal(a.dryRun, true);
  assert.equal(a.task, null);
});

test('parseArgs: rejects unknown mode', () => {
  assert.throws(() => parseArgs(['banana', '--task', 'x']), /unknown mode/);
});

test('parseArgs: research requires --task or --task-file', () => {
  assert.throws(() => parseArgs(['research']), /--task or --task-file is required/);
});

test('parseArgs: plan-review requires --plan-path', () => {
  assert.throws(() => parseArgs(['plan-review']), /--plan-path is required/);
});

test('parseArgs: --timeout must be a positive finite number', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--timeout', 'abc']),
    /--timeout/
  );
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--timeout', '-5']),
    /--timeout/
  );
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--timeout', '0']),
    /--timeout/
  );
  // Default (600) and explicit positive values are accepted.
  assert.equal(parseArgs(['research', '--task', 'x']).timeout, 600);
  assert.equal(parseArgs(['research', '--task', 'x', '--timeout', '60']).timeout, 60);
});

test('buildInvocation: derives slug and output path for research', () => {
  const inv = buildInvocation({
    args: { mode: 'research', task: 'add OAuth login', slug: null, out: null, dryRun: true, timeout: 600, planPath: null },
    now: new Date('2026-05-10T10:15:30.000Z'),
  });
  assert.equal(inv.slug, 'add-oauth-login');
  assert.equal(inv.outputPath, '.hyperclaude/research/20260510-1015-add-oauth-login.md');
  assert.equal(inv.timestamp, '20260510-1015');
});

test('buildInvocation: timestamp-only filename when slug derivation fails', () => {
  const inv = buildInvocation({
    args: { mode: 'research', task: '한글만', slug: null, out: null, dryRun: true, timeout: 600, planPath: null },
    now: new Date('2026-05-10T10:15:30.000Z'),
  });
  assert.equal(inv.slug, null);
  assert.equal(inv.outputPath, '.hyperclaude/research/20260510-1015.md');
});

test('buildInvocation: plan-review reuses plan slug, not the timestamp prefix', () => {
  // Plan filenames follow `<YYYYMMDD-HHMM>-<slug>.md`; the review's slug must
  // match the plan's slug for the research → plan → review trio traceability.
  const inv = buildInvocation({
    args: {
      mode: 'plan-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: '.hyperclaude/plans/20260510-1015-oauth-login.md',
    },
    now: new Date('2026-05-10T11:30:00.000Z'),
  });
  assert.equal(inv.slug, 'oauth-login');
  assert.equal(inv.outputPath, '.hyperclaude/plan-reviews/20260510-1130-oauth-login.md');
});

test('buildInvocation: plan-review falls back to full basename for non-timestamped plan paths', () => {
  const inv = buildInvocation({
    args: {
      mode: 'plan-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: 'docs/plans/oauth-login.md',
    },
    now: new Date('2026-05-10T11:30:00.000Z'),
  });
  assert.equal(inv.slug, 'oauth-login');
});

test('buildInvocation: plan-review preserves long plan slugs (no re-slugify truncation)', () => {
  const inv = buildInvocation({
    args: {
      mode: 'plan-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: '.hyperclaude/plans/20260510-1015-a-b-c-d-e-f.md',
    },
    now: new Date('2026-05-10T11:30:00.000Z'),
  });
  assert.equal(inv.slug, 'a-b-c-d-e-f');
});

test('buildInvocation: appends -2, -3 suffixes on filesystem collision', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-collision-'));
  try {
    const args = {
      mode: 'research',
      task: 'collide',
      slug: null,
      out: tmp,
      dryRun: true,
      timeout: 600,
      planPath: null,
    };
    const now = new Date('2026-05-10T10:15:00.000Z');

    const inv1 = buildInvocation({ args, now });
    assert.equal(inv1.outputPath, path.join(tmp, '20260510-1015-collide.md'));

    writeFileSync(inv1.outputPath, '');
    const inv2 = buildInvocation({ args, now });
    assert.equal(inv2.outputPath, path.join(tmp, '20260510-1015-collide-2.md'));

    writeFileSync(inv2.outputPath, '');
    const inv3 = buildInvocation({ args, now });
    assert.equal(inv3.outputPath, path.join(tmp, '20260510-1015-collide-3.md'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: --dry-run prints JSON without spawning codex', () => {
  const result = spawnSync(
    'node',
    [BRIDGE, 'research', '--task', 'add OAuth login', '--dry-run'],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.slug, 'add-oauth-login');
  assert.match(out.outputPath, /^\.hyperclaude\/research\/\d{8}-\d{4}-add-oauth-login\.md$/);
});

// M7 — --slug validation

test('parseArgs: --slug accepts valid slugs', () => {
  assert.equal(parseArgs(['research', '--task', 'x', '--slug', 'oauth-login']).slug, 'oauth-login');
  assert.equal(parseArgs(['research', '--task', 'x', '--slug', 'a']).slug, 'a');
  assert.equal(parseArgs(['research', '--task', 'x', '--slug', 'a-b-c-d-e']).slug, 'a-b-c-d-e');
});

test('parseArgs: --slug rejects invalid', () => {
  assert.throws(() => parseArgs(['research', '--task', 'x', '--slug', 'oauth login']),   /--slug must match/);
  assert.throws(() => parseArgs(['research', '--task', 'x', '--slug', '../oauth']),      /--slug must match/);
  assert.throws(() => parseArgs(['research', '--task', 'x', '--slug', 'OAuth-Login']),   /--slug must match/);
  assert.throws(() => parseArgs(['research', '--task', 'x', '--slug', 'a-b-c-d-e-f']),  /--slug must match/);
  assert.throws(() => parseArgs(['research', '--task', 'x', '--slug', 'oauth--login']), /--slug must match/);
  assert.throws(() => parseArgs(['research', '--task', 'x', '--slug', '']),              /--slug must match/);
});

// M5 — --dry-run fails fast on missing template

test('cli: --dry-run reports missing template', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const templatePath = path.join(repoRoot, 'templates', 'codex', 'research.md');
  const bakPath = templatePath + '.bak';
  renameSync(templatePath, bakPath);
  let result;
  try {
    result = spawnSync(
      'node',
      [BRIDGE, 'research', '--task', 'smoke', '--dry-run'],
      { encoding: 'utf8' }
    );
  } finally {
    renameSync(bakPath, templatePath);
  }
  assert.equal(result.status, 1, `expected exit 1, stderr: ${result.stderr}`);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.match(out.error, /failed to read prompt template/);
});

test('parseArgs: --task-file accepted as alternative to --task', () => {
  const a = parseArgs(['research', '--task-file', '/tmp/x.txt']);
  assert.equal(a.task, null);
  assert.equal(a.taskFile, '/tmp/x.txt');
});

test('parseArgs: research with neither --task nor --task-file throws', () => {
  assert.throws(() => parseArgs(['research']), /--task or --task-file is required/);
});

test('parseArgs: --task and --task-file mutually exclusive', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--task-file', '/tmp/x.txt']),
    /mutually exclusive/
  );
});

test('cli: --task-file path drives the dry-run slug', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-taskfile-'));
  try {
    const taskPath = path.join(tmp, 'task.txt');
    writeFileSync(taskPath, 'fixed test task');
    const result = spawnSync(
      'node',
      [BRIDGE, 'research', '--task-file', taskPath, '--dry-run', '--out', tmp],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.equal(out.slug, 'fixed-test-task');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
// ── code-review mode parseArgs tests ──────────────────────────────────────────

test('parseArgs: code-review mode accepted — defaults to base main when no target flag given', () => {
  const a = parseArgs(['code-review']);
  assert.equal(a.mode, 'code-review');
  assert.equal(a.reviewTarget, 'base');
  assert.equal(a.baseRef, 'main');
  assert.equal(a.commit, null);
  assert.equal(a.title, null);
});

test('parseArgs: code-review with --base <ref>', () => {
  const a = parseArgs(['code-review', '--base', 'origin/main']);
  assert.equal(a.reviewTarget, 'base');
  assert.equal(a.baseRef, 'origin/main');
});

test('parseArgs: code-review with --uncommitted', () => {
  const a = parseArgs(['code-review', '--uncommitted']);
  assert.equal(a.reviewTarget, 'uncommitted');
});

test('parseArgs: code-review with --commit <sha>', () => {
  const a = parseArgs(['code-review', '--commit', 'abc1234f']);
  assert.equal(a.reviewTarget, 'commit');
  assert.equal(a.commit, 'abc1234f');
});

test('parseArgs: code-review with --title', () => {
  const a = parseArgs(['code-review', '--title', 'my review']);
  assert.equal(a.title, 'my review');
});

test('parseArgs: code-review --commit rejects non-hex', () => {
  for (const bad of ['HEAD', 'HEAD~1', 'main', 'abc123x']) {
    assert.throws(
      () => parseArgs(['code-review', '--commit', bad]),
      /--commit must be a hex SHA/
    );
  }
});

test('parseArgs: code-review --commit rejects too-short SHA', () => {
  assert.throws(
    () => parseArgs(['code-review', '--commit', 'abc123']),
    /--commit must be a hex SHA/
  );
});

test('parseArgs: code-review --base and --uncommitted are mutually exclusive', () => {
  assert.throws(
    () => parseArgs(['code-review', '--base', 'main', '--uncommitted']),
    /mutually exclusive/
  );
});

test('parseArgs: code-review --base and --commit are mutually exclusive', () => {
  assert.throws(
    () => parseArgs(['code-review', '--base', 'main', '--commit', 'abc1234f']),
    /mutually exclusive/
  );
});

test('parseArgs: code-review --uncommitted and --commit are mutually exclusive', () => {
  assert.throws(
    () => parseArgs(['code-review', '--uncommitted', '--commit', 'abc1234f']),
    /mutually exclusive/
  );
});

// ── --base validation tests ───────────────────────────────────────────────────

test('parseArgs: --base accepts valid refs', () => {
  assert.equal(parseArgs(['code-review', '--base', 'main']).baseRef, 'main');
  assert.equal(parseArgs(['code-review', '--base', 'origin/main']).baseRef, 'origin/main');
  assert.equal(parseArgs(['code-review', '--base', 'release/2026.05']).baseRef, 'release/2026.05');
  assert.equal(parseArgs(['code-review', '--base', 'feature_branch-1']).baseRef, 'feature_branch-1');
});

test('parseArgs: --base rejects empty string', () => {
  assert.throws(
    () => parseArgs(['code-review', '--base', '']),
    /--base must be a non-empty git ref/
  );
});

test('parseArgs: --base rejects leading dash', () => {
  assert.throws(
    () => parseArgs(['code-review', '--base', '-rf']),
    /--base must be a non-empty git ref/
  );
});

test('parseArgs: --base rejects whitespace', () => {
  assert.throws(
    () => parseArgs(['code-review', '--base', 'origin main']),
    /--base must be a non-empty git ref/
  );
});

test('parseArgs: --base rejects shell metacharacters', () => {
  for (const bad of ['main;rm', 'main$(rm)', 'main`rm`', 'main|rm']) {
    assert.throws(
      () => parseArgs(['code-review', '--base', bad]),
      /--base must be a non-empty git ref/
    );
  }
});

// ── per-mode flag-isolation tests ─────────────────────────────────────────────

test('parseArgs: code-review rejects --task', () => {
  assert.throws(
    () => parseArgs(['code-review', '--task', 'x']),
    /unknown flag for mode code-review: --task/
  );
});

test('parseArgs: code-review rejects --task-file', () => {
  assert.throws(
    () => parseArgs(['code-review', '--task-file', '/tmp/x.txt']),
    /unknown flag for mode code-review: --task-file/
  );
});

test('parseArgs: code-review rejects --plan-path', () => {
  assert.throws(
    () => parseArgs(['code-review', '--plan-path', '/tmp/p.md']),
    /unknown flag for mode code-review: --plan-path/
  );
});

test('parseArgs: research rejects --base', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--base', 'main']),
    /unknown flag for mode research: --base/
  );
});

test('parseArgs: research rejects --uncommitted', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--uncommitted']),
    /unknown flag for mode research: --uncommitted/
  );
});

test('parseArgs: research rejects --commit', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--commit', 'abc1234f']),
    /unknown flag for mode research: --commit/
  );
});

test('parseArgs: research rejects --title', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--title', 'my review']),
    /unknown flag for mode research: --title/
  );
});

test('parseArgs: plan-review rejects --task', () => {
  assert.throws(
    () => parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--task', 'x']),
    /unknown flag for mode plan-review: --task/
  );
});

test('parseArgs: plan-review rejects --base', () => {
  assert.throws(
    () => parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--base', 'main']),
    /unknown flag for mode plan-review: --base/
  );
});

test('parseArgs: plan-review rejects --uncommitted', () => {
  assert.throws(
    () => parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--uncommitted']),
    /unknown flag for mode plan-review: --uncommitted/
  );
});

// ── buildInvocation: code-review mode ─────────────────────────────────────────

test('buildInvocation: code-review --base main → slug vs-main, dir .hyperclaude/code-reviews', () => {
  const inv = buildInvocation({
    args: {
      mode: 'code-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: 'base',
      baseRef: 'main',
      commit: null,
      title: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'vs-main');
  assert.match(inv.outputPath, /\.hyperclaude\/code-reviews\/\d{8}-\d{4}-vs-main\.md$/);
});

test('buildInvocation: code-review --base origin/main → slug vs-origin-main', () => {
  const inv = buildInvocation({
    args: {
      mode: 'code-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: 'base',
      baseRef: 'origin/main',
      commit: null,
      title: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'vs-origin-main');
});

test('buildInvocation: code-review --base release/2026.05 → slug vs-release-2026-05', () => {
  const inv = buildInvocation({
    args: {
      mode: 'code-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: 'base',
      baseRef: 'release/2026.05',
      commit: null,
      title: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'vs-release-2026-05');
});

test('buildInvocation: code-review --base feature_branch → slug vs-feature-branch', () => {
  const inv = buildInvocation({
    args: {
      mode: 'code-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: 'base',
      baseRef: 'feature_branch',
      commit: null,
      title: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'vs-feature-branch');
});

test('buildInvocation: code-review --uncommitted → slug uncommitted', () => {
  const inv = buildInvocation({
    args: {
      mode: 'code-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: 'uncommitted',
      baseRef: null,
      commit: null,
      title: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'uncommitted');
});

test('buildInvocation: code-review --commit abc1234f → slug commit-abc1234 (first 7 chars)', () => {
  const inv = buildInvocation({
    args: {
      mode: 'code-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: 'commit',
      baseRef: null,
      commit: 'abc1234f',
      title: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'commit-abc1234');
});

test('buildInvocation: code-review --commit abc1234f567890 → slug commit-abc1234', () => {
  const inv = buildInvocation({
    args: {
      mode: 'code-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: 'commit',
      baseRef: null,
      commit: 'abc1234f567890',
      title: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'commit-abc1234');
});
// ── docs-review mode parseArgs tests ──────────────────────────────────────────

test('parseArgs: docs-review mode accepted with --docs-path', () => {
  const a = parseArgs(['docs-review', '--docs-path', 'docs/api.md']);
  assert.equal(a.mode, 'docs-review');
  assert.deepEqual(a.docsPaths, ['docs/api.md']);
  assert.equal(a.docsDir, null);
  assert.equal(a.diffBase, null);
});

test('parseArgs: docs-review mode accepted with --docs-dir', () => {
  const a = parseArgs(['docs-review', '--docs-dir', 'docs/']);
  assert.equal(a.docsDir, 'docs/');
  assert.deepEqual(a.docsPaths, []);
  assert.equal(a.diffBase, null);
});

test('parseArgs: docs-review repeated --docs-path appends in order', () => {
  const a = parseArgs(['docs-review', '--docs-path', 'a.md', '--docs-path', 'b.md']);
  assert.deepEqual(a.docsPaths, ['a.md', 'b.md']);
});

test('parseArgs: docs-review duplicate --docs-path deduped (first spelling wins)', () => {
  const a = parseArgs(['docs-review', '--docs-path', 'a.md', '--docs-path', 'a.md', '--docs-path', 'b.md']);
  assert.deepEqual(a.docsPaths, ['a.md', 'b.md']);
});

test('parseArgs: docs-review --docs-dir then --docs-path mutually exclusive (reverse order)', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-dir', 'docs/', '--docs-path', 'docs/api.md']),
    /mutually exclusive/
  );
});

test('parseArgs: docs-review repeated --docs-path still rejects an unknown docs flag (allow-list intact)', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'a.md', '--docs-path', 'b.md', '--base', 'main']),
    /unknown flag for mode docs-review: --base/
  );
});

test('parseArgs: docs-review --diff-base sets diffBase', () => {
  const a = parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--diff-base', 'main']);
  assert.equal(a.diffBase, 'main');
});

test('parseArgs: docs-review requires --docs-path or --docs-dir', () => {
  assert.throws(
    () => parseArgs(['docs-review']),
    /--docs-path or --docs-dir is required for docs-review/
  );
});

test('parseArgs: docs-review --docs-path and --docs-dir are mutually exclusive', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--docs-dir', 'docs/']),
    /mutually exclusive/
  );
});

test('parseArgs: docs-review --docs-path rejects empty string', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', '']),
    /--docs-path must be a non-empty path/
  );
});

test('parseArgs: docs-review --docs-path rejects leading dash', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', '-rf']),
    /--docs-path must be a non-empty path/
  );
});

test('parseArgs: docs-review --docs-dir rejects empty string', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-dir', '']),
    /--docs-dir must be a non-empty path/
  );
});

test('parseArgs: docs-review --docs-dir rejects leading dash', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-dir', '-rf']),
    /--docs-dir must be a non-empty path/
  );
});

test('parseArgs: docs-review --diff-base rejects empty string', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--diff-base', '']),
    /--diff-base must be a non-empty git ref/
  );
});

test('parseArgs: docs-review --diff-base rejects leading dash', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--diff-base', '-rf']),
    /--diff-base must be a non-empty git ref/
  );
});

test('parseArgs: docs-review --diff-base rejects shell metacharacters', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--diff-base', 'main;rm']),
    /--diff-base must be a non-empty git ref/
  );
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--diff-base', 'main$(rm)']),
    /--diff-base must be a non-empty git ref/
  );
});

test('parseArgs: docs-review --diff-base accepts valid refs', () => {
  assert.equal(
    parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--diff-base', 'main']).diffBase,
    'main'
  );
  assert.equal(
    parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--diff-base', 'origin/main']).diffBase,
    'origin/main'
  );
  assert.equal(
    parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--diff-base', 'release/2026.05']).diffBase,
    'release/2026.05'
  );
});

// ── per-mode flag-isolation: docs-review rejects non-docs flags ───────────────

test('parseArgs: docs-review rejects --task', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--task', 'x']),
    /unknown flag for mode docs-review: --task/
  );
});

test('parseArgs: docs-review rejects --plan-path', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--plan-path', '/tmp/p.md']),
    /unknown flag for mode docs-review: --plan-path/
  );
});

test('parseArgs: docs-review rejects --base', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--base', 'main']),
    /unknown flag for mode docs-review: --base/
  );
});

test('parseArgs: docs-review rejects --uncommitted', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--uncommitted']),
    /unknown flag for mode docs-review: --uncommitted/
  );
});

test('parseArgs: research rejects --docs-path', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--docs-path', 'docs/api.md']),
    /unknown flag for mode research: --docs-path/
  );
});

test('parseArgs: code-review rejects --docs-path', () => {
  assert.throws(
    () => parseArgs(['code-review', '--docs-path', 'docs/api.md']),
    /unknown flag for mode code-review: --docs-path/
  );
});

test('parseArgs: plan-review rejects --docs-dir', () => {
  assert.throws(
    () => parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--docs-dir', 'docs/']),
    /unknown flag for mode plan-review: --docs-dir/
  );
});

// ── buildInvocation: docs-review mode ─────────────────────────────────────────

test('buildInvocation: docs-review --docs-path docs/api.md → slug api, dir .hyperclaude/docs-reviews', () => {
  const inv = buildInvocation({
    args: {
      mode: 'docs-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPaths: ['docs/api.md'],
      docsDir: null,
      diffBase: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'api');
  assert.match(inv.outputPath, /\.hyperclaude\/docs-reviews\/\d{8}-\d{4}-api\.md$/);
});

test('buildInvocation: docs-review --docs-path README.md → slug readme', () => {
  const inv = buildInvocation({
    args: {
      mode: 'docs-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPaths: ['README.md'],
      docsDir: null,
      diffBase: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'readme');
});

test('buildInvocation: docs-review --docs-path "API Reference.md" → slug api-reference', () => {
  const inv = buildInvocation({
    args: {
      mode: 'docs-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPaths: ['API Reference.md'],
      docsDir: null,
      diffBase: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'api-reference');
});

test('buildInvocation: docs-review --docs-dir docs/reference/ → slug reference', () => {
  const inv = buildInvocation({
    args: {
      mode: 'docs-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPaths: [],
      docsDir: 'docs/reference/',
      diffBase: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'reference');
});

test('buildInvocation: docs-review --docs-dir docs/ → slug docs', () => {
  const inv = buildInvocation({
    args: {
      mode: 'docs-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPaths: [],
      docsDir: 'docs/',
      diffBase: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'docs');
});

test('buildInvocation: docs-review --docs-path path/to/some-guide.md → slug some-guide', () => {
  const inv = buildInvocation({
    args: {
      mode: 'docs-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPaths: ['path/to/some-guide.md'],
      docsDir: null,
      diffBase: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'some-guide');
});

test('buildInvocation: docs-review slug fallback to docs when slugify returns null', () => {
  const inv = buildInvocation({
    args: {
      mode: 'docs-review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 600,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPaths: ['한글만.md'],
      docsDir: null,
      diffBase: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'docs');
});

function docsInvArgs(docsPaths) {
  return {
    mode: 'docs-review',
    task: null,
    slug: null,
    out: null,
    dryRun: true,
    timeout: 600,
    planPath: null,
    reviewTarget: null,
    baseRef: null,
    commit: null,
    title: null,
    docsPaths,
    docsDir: null,
    diffBase: null,
  };
}

test('buildInvocation: docs-review two --docs-path → slug <first>-plus-1', () => {
  const inv = buildInvocation({
    args: docsInvArgs(['README.md', 'docs/workflow.md']),
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'readme-plus-1');
});

test('buildInvocation: docs-review three --docs-path → slug <first>-plus-2', () => {
  const inv = buildInvocation({
    args: docsInvArgs(['README.md', 'docs/workflow.md', 'docs/architecture.md']),
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'readme-plus-2');
});

test('buildInvocation: docs-review multi with non-sluggable first basename → docs-plus-<n-1>', () => {
  const inv = buildInvocation({
    args: docsInvArgs(['한글만.md', 'x.md']),
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'docs-plus-1');
});
// ── Task 4: parseArgs --resume ───────────────────────────────────────────────

test('parseArgs: plan-review accepts --resume <path>', () => {
  const a = parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--resume', '/tmp/prior.md']);
  assert.equal(a.resumeFrom, '/tmp/prior.md');
});

test('parseArgs: plan-review accepts --resume auto', () => {
  const a = parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--resume', 'auto']);
  assert.equal(a.resumeFrom, 'auto');
});

test('parseArgs: docs-review accepts --resume <path>', () => {
  const a = parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--resume', '/tmp/prior.md']);
  assert.equal(a.resumeFrom, '/tmp/prior.md');
});

test('parseArgs: docs-review accepts --resume auto', () => {
  const a = parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--resume', 'auto']);
  assert.equal(a.resumeFrom, 'auto');
});

test('parseArgs: research rejects --resume', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--resume', 'auto']),
    /unknown flag for mode research: --resume/
  );
});

test('parseArgs: code-review defaults to base main with --resume auto', () => {
  const a = parseArgs(['code-review', '--resume', 'auto']);
  assert.equal(a.reviewTarget, 'base');
  assert.equal(a.baseRef, 'main');
  assert.equal(a.resumeFrom, 'auto');
});

test('parseArgs: code-review accepts --base main --resume', () => {
  const a = parseArgs(['code-review', '--base', 'main', '--resume', '/tmp/prior.md']);
  assert.equal(a.reviewTarget, 'base');
  assert.equal(a.baseRef, 'main');
  assert.equal(a.resumeFrom, '/tmp/prior.md');
});

test('parseArgs: code-review accepts --uncommitted --resume', () => {
  const a = parseArgs(['code-review', '--uncommitted', '--resume', 'auto']);
  assert.equal(a.reviewTarget, 'uncommitted');
  assert.equal(a.resumeFrom, 'auto');
});

test('parseArgs: code-review accepts --commit <sha> --resume', () => {
  const a = parseArgs(['code-review', '--commit', 'abc1234', '--resume', '/tmp/prior.md']);
  assert.equal(a.reviewTarget, 'commit');
  assert.equal(a.commit, 'abc1234');
  assert.equal(a.resumeFrom, '/tmp/prior.md');
});

test('parseArgs: code-review accepts --background and returns it', () => {
  const a = parseArgs(['code-review', '--background', 'did X']);
  assert.equal(a.background, 'did X');
});

test('parseArgs: code-review --background rejects empty string', () => {
  assert.throws(
    () => parseArgs(['code-review', '--background', '']),
    /--background must be a non-empty string/
  );
});

test('parseArgs: code-review --background rejects leading dash', () => {
  assert.throws(
    () => parseArgs(['code-review', '--background', '-x']),
    /--background must be a non-empty string/
  );
});

test('parseArgs: code-review --background + --resume auto is rejected', () => {
  assert.throws(
    () => parseArgs(['code-review', '--background', 'x', '--resume', 'auto']),
    /only supported when --resume is omitted/
  );
});

test('parseArgs: code-review --background + --resume explicit-path is rejected', () => {
  assert.throws(
    () => parseArgs(['code-review', '--background', 'x', '--resume', '/tmp/prior.md']),
    /only supported when --resume is omitted/
  );
});

// ── --review-brief parser tests ───────────────────────────────────────────────

test('parseArgs: plan-review accepts --review-brief and returns it', () => {
  const a = parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--review-brief', 'user asked for X']);
  assert.equal(a.reviewBrief, 'user asked for X');
});

test('parseArgs: code-review accepts --review-brief and returns it', () => {
  const a = parseArgs(['code-review', '--review-brief', 'user asked for X']);
  assert.equal(a.reviewBrief, 'user asked for X');
});

test('parseArgs: --review-brief accepts bullet-form value starting with "- "', () => {
  const a = parseArgs(['code-review', '--review-brief', '- user asked for X\n- and Y']);
  assert.equal(a.reviewBrief, '- user asked for X\n- and Y');
});

test('parseArgs: --review-brief rejects empty string', () => {
  assert.throws(
    () => parseArgs(['code-review', '--review-brief', '']),
    /--review-brief must be a non-empty string/
  );
});

test('parseArgs: --review-brief rejects whitespace-only string', () => {
  assert.throws(
    () => parseArgs(['code-review', '--review-brief', '   ']),
    /--review-brief must be a non-empty string/
  );
});

test('parseArgs: research rejects --review-brief', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--review-brief', 'user asked for X']),
    /unknown flag for mode research: --review-brief/
  );
});

test('parseArgs: docs-review rejects --review-brief', () => {
  assert.throws(
    () => parseArgs(['docs-review', '--docs-path', 'docs/api.md', '--review-brief', 'user asked for X']),
    /unknown flag for mode docs-review: --review-brief/
  );
});

test('parseArgs: --review-brief + --resume auto accepted (plan-review)', () => {
  const a = parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--review-brief', 'user asked for X', '--resume', 'auto']);
  assert.equal(a.reviewBrief, 'user asked for X');
  assert.equal(a.resumeFrom, 'auto');
});

test('parseArgs: --review-brief + --resume auto accepted (code-review)', () => {
  const a = parseArgs(['code-review', '--review-brief', 'user asked for X', '--resume', 'auto']);
  assert.equal(a.reviewBrief, 'user asked for X');
  assert.equal(a.resumeFrom, 'auto');
});

test('parseArgs: --review-brief + --resume <path> accepted', () => {
  const a = parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--review-brief', 'user asked for X', '--resume', '/tmp/prior.md']);
  assert.equal(a.reviewBrief, 'user asked for X');
  assert.equal(a.resumeFrom, '/tmp/prior.md');
});

test('parseArgs: --review-brief + --background accepted together on fresh code-review', () => {
  const a = parseArgs(['code-review', '--review-brief', 'user asked for X', '--background', 'did Y']);
  assert.equal(a.reviewBrief, 'user asked for X');
  assert.equal(a.background, 'did Y');
});

test('parseArgs: --resume rejects empty string', () => {
  assert.throws(
    () => parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--resume', '']),
    /--resume must be a non-empty path or "auto"/
  );
});

test('parseArgs: --resume rejects leading dash', () => {
  assert.throws(
    () => parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--resume', '-rf']),
    /--resume must be a non-empty path or "auto"/
  );
});
// ── Task 4: --model / --effort parser tests ───────────────────────────────────

test('parseArgs: --model/--effort accepted in all four modes', () => {
  // research
  const r = parseArgs(['research', '--task', 'x', '--model', 'gpt-5', '--effort', 'medium']);
  assert.equal(r.model, 'gpt-5');
  assert.equal(r.effort, 'medium');

  // plan-review
  const pr = parseArgs(['plan-review', '--plan-path', '/tmp/p.md', '--model', 'gpt-5', '--effort', 'high']);
  assert.equal(pr.model, 'gpt-5');
  assert.equal(pr.effort, 'high');

  // code-review (no required flags)
  const cr = parseArgs(['code-review', '--model', 'gpt-5', '--effort', 'medium']);
  assert.equal(cr.model, 'gpt-5');
  assert.equal(cr.effort, 'medium');

  // docs-review
  const dr = parseArgs(['docs-review', '--docs-path', '/tmp/d.md', '--model', 'gpt-5', '--effort', 'low']);
  assert.equal(dr.model, 'gpt-5');
  assert.equal(dr.effort, 'low');
});

test('parseArgs: --model/--effort default to null when omitted', () => {
  const a = parseArgs(['research', '--task', 'x']);
  assert.equal(a.model, null);
  assert.equal(a.effort, null);
});

test('parseArgs: --effort rejects values outside low|medium|high|xhigh', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--effort', 'banana']),
    /--effort must be one of/
  );
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--effort', 'none']),
    /--effort must be one of/
  );
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--effort', 'minimal']),
    /--effort must be one of/
  );
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--effort', '']),
    /--effort must be one of/
  );

  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--effort', 'low']));
  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--effort', 'medium']));
  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--effort', 'high']));
  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--effort', 'xhigh']));
});

test('parseArgs: --model rejects empty / leading-dash but accepts arbitrary charset', () => {
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--model', '']),
    /--model must be/
  );
  assert.throws(
    () => parseArgs(['research', '--task', 'x', '--model', '-m']),
    /--model must be/
  );

  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--model', 'gpt-5']));
  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--model', 'o3']));
  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--model', 'gpt-5.1-codex']));
  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--model', 'openai/gpt-5']));
  assert.doesNotThrow(() => parseArgs(['research', '--task', 'x', '--model', 'gpt 5']));
});
