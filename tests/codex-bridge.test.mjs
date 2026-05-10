import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify, renderFrontmatter, loadTemplate } from '../scripts/codex-bridge.mjs';

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
