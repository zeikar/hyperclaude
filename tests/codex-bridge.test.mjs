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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    slug: 'oauth',
    planPath: null,
    out: null,
    dryRun: false,
    timeout: 300,
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

test('parseArgs: research requires --task', () => {
  assert.throws(() => parseArgs(['research']), /--task is required/);
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
