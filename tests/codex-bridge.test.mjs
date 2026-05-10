import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify, renderFrontmatter, loadTemplate, renderCodeReviewFrontmatter, slugifyRef, getGitHead, renderDocsReviewFrontmatter } from '../scripts/codex-bridge.mjs';

test('slugify: simple ASCII task', () => {
  assert.equal(slugify('Add OAuth login to the API'), 'add-oauth-login-to-the');
});

test('slugify: drops non-ASCII characters', () => {
  // "한글 mixed task" → Korean dropped, leaves "mixed task"
  assert.equal(slugify('한글 mixed task'), 'mixed-task');
});

test('slugify: caps at 5 words', () => {
  assert.equal(
    slugify('one two three four five six seven'),
    'one-two-three-four-five'
  );
});

test('slugify: returns null when nothing usable', () => {
  assert.equal(slugify('한글만'), null);
  assert.equal(slugify('   '), null);
  assert.equal(slugify(''), null);
});

test('renderFrontmatter: task uses block scalar', () => {
  const fm = renderFrontmatter({
    mode: 'research',
    task: 'task: with colon and "quote"',
    slug: 'oauth-login',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
  });
  assert.match(fm, /^---\n/);
  assert.match(fm, /\n---\n$/);
  assert.match(fm, /mode: research/);
  assert.match(fm, /task: \|-\n {2}task: with colon and "quote"/);
  assert.match(fm, /slug: oauth-login/);
  assert.match(fm, /generated: 2026-05-10T10:15:00\.000Z/);
  assert.match(fm, /codex-version: 0\.128\.0/);
  assert.match(fm, /template-version: 1/);
});

test('renderFrontmatter: multi-line task indents each line', () => {
  const fm = renderFrontmatter({
    mode: 'review',
    task: 'line one\nline two\n  indented',
    slug: 'multi',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
  });
  assert.match(fm, /task: \|-\n {2}line one\n {2}line two\n {2} {2}indented\n/);
});

test('loadTemplate: substitutes placeholders', () => {
  const tpl = 'Hello {{NAME}}, you have {{COUNT}} items.';
  assert.equal(
    loadTemplate(tpl, { NAME: 'world', COUNT: '3' }),
    'Hello world, you have 3 items.'
  );
});

test('loadTemplate: leaves unknown placeholders untouched', () => {
  const tpl = 'Hello {{NAME}}, {{UNKNOWN}}.';
  assert.equal(
    loadTemplate(tpl, { NAME: 'world' }),
    'Hello world, {{UNKNOWN}}.'
  );
});

import { parseArgs, buildInvocation } from '../scripts/codex-bridge.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';

// `path` and `fileURLToPath` were imported in Task 2's initial test setup.
const BRIDGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'codex-bridge.mjs'
);

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
    timeout: 300,
    reviewTarget: null,
    baseRef: null,
    commit: null,
    title: null,
    docsPath: null,
    docsDir: null,
    diffBase: null,
  });
});

test('parseArgs: review mode with dry-run', () => {
  const a = parseArgs([
    'review',
    '--plan-path', '.hyperclaude/plans/p.md',
    '--dry-run',
  ]);
  assert.equal(a.mode, 'review');
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

test('parseArgs: review requires --plan-path', () => {
  assert.throws(() => parseArgs(['review']), /--plan-path is required/);
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
  // Default (300) and explicit positive values are accepted.
  assert.equal(parseArgs(['research', '--task', 'x']).timeout, 300);
  assert.equal(parseArgs(['research', '--task', 'x', '--timeout', '60']).timeout, 60);
});

test('buildInvocation: derives slug and output path for research', () => {
  const inv = buildInvocation({
    args: { mode: 'research', task: 'add OAuth login', slug: null, out: null, dryRun: true, timeout: 300, planPath: null },
    now: new Date('2026-05-10T10:15:30.000Z'),
  });
  assert.equal(inv.slug, 'add-oauth-login');
  assert.equal(inv.outputPath, '.hyperclaude/research/20260510-1015-add-oauth-login.md');
  assert.equal(inv.timestamp, '20260510-1015');
});

test('buildInvocation: timestamp-only filename when slug derivation fails', () => {
  const inv = buildInvocation({
    args: { mode: 'research', task: '한글만', slug: null, out: null, dryRun: true, timeout: 300, planPath: null },
    now: new Date('2026-05-10T10:15:30.000Z'),
  });
  assert.equal(inv.slug, null);
  assert.equal(inv.outputPath, '.hyperclaude/research/20260510-1015.md');
});

test('buildInvocation: review reuses plan slug, not the timestamp prefix', () => {
  // Plan filenames follow `<YYYYMMDD-HHMM>-<slug>.md`; the review's slug must
  // match the plan's slug for the research → plan → review trio traceability.
  const inv = buildInvocation({
    args: {
      mode: 'review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 300,
      planPath: '.hyperclaude/plans/20260510-1015-oauth-login.md',
    },
    now: new Date('2026-05-10T11:30:00.000Z'),
  });
  assert.equal(inv.slug, 'oauth-login');
  assert.equal(inv.outputPath, '.hyperclaude/reviews/20260510-1130-oauth-login.md');
});

test('buildInvocation: review falls back to full basename for non-timestamped plan paths', () => {
  const inv = buildInvocation({
    args: {
      mode: 'review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 300,
      planPath: 'docs/plans/oauth-login.md',
    },
    now: new Date('2026-05-10T11:30:00.000Z'),
  });
  assert.equal(inv.slug, 'oauth-login');
});

test('buildInvocation: review preserves long plan slugs (no re-slugify truncation)', () => {
  const inv = buildInvocation({
    args: {
      mode: 'review',
      task: null,
      slug: null,
      out: null,
      dryRun: true,
      timeout: 300,
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
      timeout: 300,
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

test('parseArgs: review rejects --task', () => {
  assert.throws(
    () => parseArgs(['review', '--plan-path', '/tmp/p.md', '--task', 'x']),
    /unknown flag for mode review: --task/
  );
});

test('parseArgs: review rejects --base', () => {
  assert.throws(
    () => parseArgs(['review', '--plan-path', '/tmp/p.md', '--base', 'main']),
    /unknown flag for mode review: --base/
  );
});

test('parseArgs: review rejects --uncommitted', () => {
  assert.throws(
    () => parseArgs(['review', '--plan-path', '/tmp/p.md', '--uncommitted']),
    /unknown flag for mode review: --uncommitted/
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
      timeout: 300,
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
      timeout: 300,
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
      timeout: 300,
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
      timeout: 300,
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
      timeout: 300,
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
      timeout: 300,
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
      timeout: 300,
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

// ── slugifyRef ────────────────────────────────────────────────────────────────

test('slugifyRef: main returns vs-main', () => {
  assert.equal(slugifyRef('main'), 'vs-main');
});

test('slugifyRef: origin/main returns vs-origin-main', () => {
  assert.equal(slugifyRef('origin/main'), 'vs-origin-main');
});

test('slugifyRef: release/2026.05 returns vs-release-2026-05', () => {
  assert.equal(slugifyRef('release/2026.05'), 'vs-release-2026-05');
});

test('slugifyRef: refs/heads/develop returns vs-refs-heads-develop', () => {
  assert.equal(slugifyRef('refs/heads/develop'), 'vs-refs-heads-develop');
});

test('slugifyRef: empty body falls back to vs-ref (input "@@@" has no alphanumeric content)', () => {
  assert.equal(slugifyRef('@@@'), 'vs-ref');
});

test('slugifyRef: caps at 8 hyphen-separated segments (FS-name safety)', () => {
  // 10-segment ref → first 8 kept; pathological 200-char branch names would otherwise
  // produce filenames that trip ENAMETOOLONG on writeFile.
  assert.equal(
    slugifyRef('a/b/c/d/e/f/g/h/i/j'),
    'vs-a-b-c-d-e-f-g-h'
  );
  // Boundary: exactly 8 segments → preserved as-is
  assert.equal(slugifyRef('s1/s2/s3/s4/s5/s6/s7/s8'), 'vs-s1-s2-s3-s4-s5-s6-s7-s8');
});

// ── renderCodeReviewFrontmatter ───────────────────────────────────────────────

test('renderCodeReviewFrontmatter: starts with --- and ends with ---\\n followed by blank line', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    slug: 'vs-main',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: null,
  });
  assert.match(fm, /^---\n/);
  assert.match(fm, /\n---\n$/);
});

test('renderCodeReviewFrontmatter: base-ref variant has required fields and no template-version/task', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    slug: 'vs-main',
    gitHead: 'abc1234567890abcd1234567890abcd1234567890',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: null,
  });
  assert.match(fm, /mode: code-review/);
  assert.match(fm, /codex-subcommand: review/);
  assert.match(fm, /base-ref: "main"/);
  assert.match(fm, /git-head:/);
  assert.match(fm, /generated:/);
  assert.match(fm, /codex-version:/);
  assert.match(fm, /slug:/);
  assert.doesNotMatch(fm, /template-version:/);
  assert.doesNotMatch(fm, /\btask:/);
});

test('renderCodeReviewFrontmatter: commit variant uses commit field, not base-ref', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'commit',
    baseRef: null,
    commit: 'abc1234f',
    slug: 'commit-abc1234',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: null,
  });
  assert.match(fm, /commit:/);
  assert.doesNotMatch(fm, /base-ref:/);
});

test('renderCodeReviewFrontmatter: uncommitted variant has neither base-ref nor commit', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'uncommitted',
    baseRef: null,
    commit: null,
    slug: 'uncommitted',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: null,
  });
  assert.doesNotMatch(fm, /base-ref:/);
  assert.doesNotMatch(fm, /\bcommit:/);
});

test('renderCodeReviewFrontmatter: title field present when provided (JSON-stringified)', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    slug: 'vs-main',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: 'my review title',
  });
  assert.match(fm, /title: "my review title"/);
});

test('renderCodeReviewFrontmatter: title field absent when not provided', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    slug: 'vs-main',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: null,
  });
  assert.doesNotMatch(fm, /title:/);
});

test('renderCodeReviewFrontmatter: git-head written as JSON-stringified string', () => {
  const fmUnknown = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    slug: 'vs-main',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: null,
  });
  assert.match(fmUnknown, /git-head: "unknown"/);

  const sha = 'abc1234567890abcd1234567890abcd1234567890';
  const fmSha = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    slug: 'vs-main',
    gitHead: sha,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: null,
  });
  assert.match(fmSha, new RegExp(`git-head: "${sha}"`));
});

test('renderCodeReviewFrontmatter: base-ref JSON-stringified to handle slashes', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'origin/main',
    commit: null,
    slug: 'vs-origin-main',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    title: null,
  });
  assert.match(fm, /base-ref: "origin\/main"/);
});

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

// ── docs-review mode parseArgs tests ──────────────────────────────────────────

test('parseArgs: docs-review mode accepted with --docs-path', () => {
  const a = parseArgs(['docs-review', '--docs-path', 'docs/api.md']);
  assert.equal(a.mode, 'docs-review');
  assert.equal(a.docsPath, 'docs/api.md');
  assert.equal(a.docsDir, null);
  assert.equal(a.diffBase, null);
});

test('parseArgs: docs-review mode accepted with --docs-dir', () => {
  const a = parseArgs(['docs-review', '--docs-dir', 'docs/']);
  assert.equal(a.docsDir, 'docs/');
  assert.equal(a.docsPath, null);
  assert.equal(a.diffBase, null);
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

test('parseArgs: review rejects --docs-dir', () => {
  assert.throws(
    () => parseArgs(['review', '--plan-path', '/tmp/p.md', '--docs-dir', 'docs/']),
    /unknown flag for mode review: --docs-dir/
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
      timeout: 300,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPath: 'docs/api.md',
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
      timeout: 300,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPath: 'README.md',
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
      timeout: 300,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPath: 'API Reference.md',
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
      timeout: 300,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPath: null,
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
      timeout: 300,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPath: null,
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
      timeout: 300,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPath: 'path/to/some-guide.md',
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
      timeout: 300,
      planPath: null,
      reviewTarget: null,
      baseRef: null,
      commit: null,
      title: null,
      docsPath: '한글만.md',
      docsDir: null,
      diffBase: null,
    },
    now: new Date('2026-05-10T10:15:00.000Z'),
  });
  assert.equal(inv.slug, 'docs');
});

// ── renderDocsReviewFrontmatter ───────────────────────────────────────────────

test('renderDocsReviewFrontmatter: starts with --- and ends with ---\\n followed by blank line', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
  });
  assert.match(fm, /^---\n/);
  assert.match(fm, /\n---\n$/);
});

test('renderDocsReviewFrontmatter: has required fields and no task/git-head/codex-subcommand', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
  });
  assert.match(fm, /mode: docs-review/);
  assert.match(fm, /slug:/);
  assert.match(fm, /generated:/);
  assert.match(fm, /codex-version:/);
  assert.match(fm, /template-version: 1/);
  assert.match(fm, /docs-target:/);
  assert.doesNotMatch(fm, /\btask:/);
  assert.doesNotMatch(fm, /git-head:/);
  assert.doesNotMatch(fm, /codex-subcommand:/);
  assert.doesNotMatch(fm, /base-ref:/);
});

test('renderDocsReviewFrontmatter: diff-base present when provided', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: 'main',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
  });
  assert.match(fm, /diff-base: "main"/);
});

test('renderDocsReviewFrontmatter: diff-base absent when not provided', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
  });
  assert.doesNotMatch(fm, /diff-base:/);
});

test('renderDocsReviewFrontmatter: docs-target JSON-stringified to handle spaces/slashes', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api-reference',
    docsTarget: 'docs/api reference.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
  });
  assert.match(fm, /docs-target: "docs\/api reference\.md"/);
});
