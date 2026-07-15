// Unit tests: --resume validation — loadResumeContext, discoverResumeArtifact, template-version gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { loadResumeContext, discoverResumeArtifact, defaultModeDir } from '../scripts/codex-bridge.mjs';

// ── Task 4: defaultModeDir ───────────────────────────────────────────────────

test('defaultModeDir: maps known modes to their .hyperclaude dirs', () => {
  assert.equal(defaultModeDir('research'), '.hyperclaude/research');
  assert.equal(defaultModeDir('plan-review'), '.hyperclaude/plan-reviews');
  assert.equal(defaultModeDir('code-review'), '.hyperclaude/code-reviews');
  assert.equal(defaultModeDir('docs-review'), '.hyperclaude/docs-reviews');
});

test('defaultModeDir: throws for unknown mode', () => {
  assert.throws(() => defaultModeDir('banana'), /unknown mode/);
});

// ── Task 4: loadResumeContext ────────────────────────────────────────────────

// Helpers for writing fixtures.
function writePriorReview(filePath, fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === 'codex-resume-status') {
      lines.push(`${k}: ${v}`);
    } else if (k === 'mode') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---');
  lines.push('body');
  writeFileSync(filePath, lines.join('\n'));
}

test('loadResumeContext: plan-review identity success', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-rev-ok-'));
  try {
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# plan');
    const prior = path.join(tmp, '20260510-1015-x.md');
    writePriorReview(prior, {
      mode: 'plan-review',
      cwd: process.cwd(),
      'plan-path': planPath,
      'template-version': 3,
      'codex-thread-id': 'thread-abc',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'plan-review', { planPath });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'thread-abc');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: mode mismatch rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-mode-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': '/tmp/api.md',
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'plan-review', { planPath: '/tmp/p.md' });
    assert.match(ctx.error, /mode is "docs-review"; current mode is "plan-review"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: cwd mismatch via path.resolve (trailing slash equivalent passes)', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cwd-'));
  try {
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# plan');
    const prior = path.join(tmp, 'p.md');
    // Use process.cwd() with a trailing slash — path.resolve normalizes it.
    writePriorReview(prior, {
      mode: 'plan-review',
      cwd: process.cwd() + '/',
      'plan-path': planPath,
      'template-version': 3,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'plan-review', { planPath });
    assert.equal(ctx.error, undefined, `should pass with trailing slash, got: ${ctx.error}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: cwd mismatch fails with clean message', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cwd2-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'plan-review',
      cwd: '/some/other/dir',
      'plan-path': '/tmp/p.md',
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'plan-review', { planPath: '/tmp/p.md' });
    assert.match(ctx.error, /cwd is "\/some\/other\/dir"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: plan-review plan-path mismatch rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-plan-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'plan-review',
      cwd: process.cwd(),
      'plan-path': '/tmp/old-plan.md',
      'template-version': 3,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'plan-review', { planPath: '/tmp/new-plan.md' });
    assert.match(ctx.error, /plan-path differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: docs-target mismatch rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-dt-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': '/tmp/api.md',
      'template-version': 2,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPath: '/tmp/other.md' });
    assert.match(ctx.error, /docs-target\/diff-base differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: diff-base null vs set mismatch rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-db-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': '/tmp/api.md',
      'template-version': 2,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
      // no diff-base
    });
    // Current has diff-base set.
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPath: '/tmp/api.md', diffBase: 'main' });
    assert.match(ctx.error, /docs-target\/diff-base differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: diff-base set vs null mismatch rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-db2-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': '/tmp/api.md',
      'diff-base': 'main',
      'template-version': 2,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPath: '/tmp/api.md' });
    assert.match(ctx.error, /docs-target\/diff-base differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: diff-base equal strings pass', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-db3-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': '/tmp/api.md',
      'diff-base': 'main',
      'template-version': 2,
      'codex-thread-id': 'tid',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPath: '/tmp/api.md', diffBase: 'main' });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'tid');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Task 2: docs-review docs-target set-equality (multi --docs-path) ────────

test('loadResumeContext: docs-review multi docs-target set match, reordered → success', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-dt-multi-'));
  try {
    const a = path.join(tmp, 'a.md');
    const b = path.join(tmp, 'b.md');
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': [a, b],
      'template-version': 2,
      'codex-thread-id': 'thread-multi',
      'codex-resume-status': 'fresh',
    });
    // Current list is the same set, reordered — must still match.
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPaths: [b, a] });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'thread-multi');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: docs-review legacy scalar docs-target vs single-element docsPaths → success (backward-compat)', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-dt-legacy-'));
  try {
    const api = path.join(tmp, 'api.md');
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': api,
      'template-version': 2,
      'codex-thread-id': 'thread-legacy',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPaths: [api] });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'thread-legacy');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: docs-review docs-target superset (cur adds an extra file) rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-dt-super-'));
  try {
    const a = path.join(tmp, 'a.md');
    const b = path.join(tmp, 'b.md');
    const c = path.join(tmp, 'c.md');
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': [a, b],
      'template-version': 2,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPaths: [a, b, c] });
    assert.match(ctx.error, /docs-target\/diff-base differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: docs-review docs-target subset (cur missing a file) rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-dt-sub-'));
  try {
    const a = path.join(tmp, 'a.md');
    const b = path.join(tmp, 'b.md');
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': [a, b],
      'template-version': 2,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPaths: [a] });
    assert.match(ctx.error, /docs-target\/diff-base differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: docs-review malformed prior docs-target array ([null]) rejected without throwing', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-dt-malformed-null-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': [null],
      'template-version': 2,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPaths: [path.join(tmp, 'a.md')] });
    assert.match(ctx.error, /docs-target\/diff-base differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: docs-review malformed prior docs-target array ([1]) rejected without throwing', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-dt-malformed-num-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': [1],
      'template-version': 2,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'docs-review', { docsPaths: [path.join(tmp, 'a.md')] });
    assert.match(ctx.error, /docs-target\/diff-base differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: missing thread-id rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-tid-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'plan-review',
      cwd: process.cwd(),
      'plan-path': '/tmp/p.md',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'plan-review', { planPath: '/tmp/p.md' });
    assert.match(ctx.error, /no codex-thread-id/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: status fallback rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-st-fb-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'plan-review',
      cwd: process.cwd(),
      'plan-path': '/tmp/p.md',
      'codex-thread-id': 't',
      'codex-resume-status': 'fallback',
    });
    const ctx = await loadResumeContext(prior, 'plan-review', { planPath: '/tmp/p.md' });
    assert.match(ctx.error, /resume-status "fallback"; only fresh\/resumed eligible/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: status resume-failed rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-st-rf-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'plan-review',
      cwd: process.cwd(),
      'plan-path': '/tmp/p.md',
      'codex-thread-id': 't',
      'codex-resume-status': 'resume-failed',
    });
    const ctx = await loadResumeContext(prior, 'plan-review', { planPath: '/tmp/p.md' });
    assert.match(ctx.error, /resume-status "resume-failed"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: unreadable path returns error', async () => {
  const ctx = await loadResumeContext('/nonexistent/path/foo.md', 'plan-review', { planPath: '/tmp/p.md' });
  assert.match(ctx.error, /cannot read prior artifact/);
});

// ── Task 4: discoverResumeArtifact ───────────────────────────────────────────

test('discoverResumeArtifact: returns newest-first; honors --out', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-newest-'));
  try {
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# plan');
    // Write three timestamped files; the newest should win.
    const older = path.join(tmp, '20260101-0000-old.md');
    const newer = path.join(tmp, '20260510-1015-mid.md');
    const newest = path.join(tmp, '20260601-0000-new.md');
    for (const p of [older, newer, newest]) {
      writePriorReview(p, {
        mode: 'plan-review',
        cwd: process.cwd(),
        'plan-path': planPath,
        'template-version': 3,
        'codex-thread-id': `thread-${path.basename(p)}`,
        'codex-resume-status': 'fresh',
      });
    }
    const r = await discoverResumeArtifact('plan-review', { out: tmp, planPath });
    assert.equal(r.error, undefined);
    assert.equal(r.path, newest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverResumeArtifact: no candidates returns error', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-empty-'));
  try {
    const r = await discoverResumeArtifact('plan-review', { out: tmp, planPath: '/tmp/p.md' });
    assert.match(r.error, /no matching artifact in/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverResumeArtifact: ignores non-.md files', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-nomd-'));
  try {
    writeFileSync(path.join(tmp, '20260510-1015-x.txt'), 'not markdown');
    writeFileSync(path.join(tmp, '20260510-1015-x.json'), '{}');
    const r = await discoverResumeArtifact('plan-review', { out: tmp, planPath: '/tmp/p.md' });
    assert.match(r.error, /no matching artifact in/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverResumeArtifact: ignores files without timestamp prefix', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-noprefix-'));
  try {
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# plan');
    // These lack the 8-4 timestamp prefix and must be skipped.
    writePriorReview(path.join(tmp, 'README.md'), {
      mode: 'plan-review',
      cwd: process.cwd(),
      'plan-path': planPath,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    writePriorReview(path.join(tmp, 'just-some-name.md'), {
      mode: 'plan-review',
      cwd: process.cwd(),
      'plan-path': planPath,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const r = await discoverResumeArtifact('plan-review', { out: tmp, planPath });
    assert.match(r.error, /no matching artifact in/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverResumeArtifact: ignores subdirectories', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-subdir-'));
  try {
    mkdirSync(path.join(tmp, '20260510-1015-subdir'));
    const r = await discoverResumeArtifact('plan-review', { out: tmp, planPath: '/tmp/p.md' });
    assert.match(r.error, /no matching artifact in/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverResumeArtifact: skips ineligible artifacts (mode mismatch) and finds the next valid one', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-skip-'));
  try {
    const planPath = path.join(tmp, 'plan.md');
    writeFileSync(planPath, '# plan');
    // Newer but wrong mode → should be skipped.
    writePriorReview(path.join(tmp, '20260601-0000-newer.md'), {
      mode: 'docs-review',
      cwd: process.cwd(),
      'docs-target': '/tmp/x.md',
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    // Older but valid → should win.
    const older = path.join(tmp, '20260510-1015-older.md');
    writePriorReview(older, {
      mode: 'plan-review',
      cwd: process.cwd(),
      'plan-path': planPath,
      'template-version': 3,
      'codex-thread-id': 'tid-older',
      'codex-resume-status': 'fresh',
    });
    const r = await discoverResumeArtifact('plan-review', { out: tmp, planPath });
    assert.equal(r.error, undefined);
    assert.equal(r.path, older);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Task 2: loadResumeContext code-review identity ────────────────────────────

test('loadResumeContext: code-review --base main identity success', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-base-'));
  try {
    const prior = path.join(tmp, '20260510-1015-x.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'main',
      'codex-thread-id': 'thread-cr-base',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'base', baseRef: 'main' });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'thread-cr-base');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: code-review base-ref mismatch rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-basemis-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'main',
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'base', baseRef: 'develop' });
    assert.match(ctx.error, /code-review target differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: code-review --uncommitted identity success when prior also uncommitted', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-unc-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      // no base-ref, no commit — means uncommitted
      'codex-thread-id': 'thread-unc',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'uncommitted' });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'thread-unc');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: code-review --commit <sha> identity success on exact SHA match', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-sha-'));
  try {
    const sha = 'abc1234567890abcdef1234567890abcdef12345';
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'commit': sha,
      'codex-thread-id': 'thread-sha',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'commit', commit: sha });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'thread-sha');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: code-review --uncommitted current vs --base prior rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-uncvbase-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'main',
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'uncommitted' });
    assert.match(ctx.error, /code-review target differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: code-review title differs but base-ref matches → identity success', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-title-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'main',
      'title': 'Old title',
      'codex-thread-id': 'thread-title',
      'codex-resume-status': 'fresh',
    });
    // title is purely cosmetic — a different --title arg must not block resumption
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'base', baseRef: 'main', title: 'New title' });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'thread-title');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: code-review commit SHA mismatch (prefix of the other) rejected', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-shapfx-'));
  try {
    const fullSha = 'abc1234567890abcdef1234567890abcdef12345';
    const shortSha = 'abc1234';
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'commit': fullSha,
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    // Passing the 7-char prefix must not match (string equality, not prefix match)
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'commit', commit: shortSha });
    assert.match(ctx.error, /code-review target differs from current/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: code-review malformed prior with both base-ref and commit rejected for every target', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-both-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'main',
      'commit': 'abc1234567890abcdef1234567890abcdef12345',
      'codex-thread-id': 't',
      'codex-resume-status': 'fresh',
    });
    // Must be rejected regardless of what the current target is
    for (const args of [
      { reviewTarget: 'base', baseRef: 'main' },
      { reviewTarget: 'commit', commit: 'abc1234567890abcdef1234567890abcdef12345' },
      { reviewTarget: 'uncommitted' },
    ]) {
      const ctx = await loadResumeContext(prior, 'code-review', args);
      assert.match(ctx.error, /code-review target differs from current/);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Task 5: code-review template-version resume gate ─────────────────────────

test('loadResumeContext: code-review legacy artifact WITHOUT template-version rejected as not resumable', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-notv-'));
  try {
    const prior = path.join(tmp, 'p.md');
    // legacy-native shape: valid target/cwd/thread/status but no template-version
    writePriorReview(prior, {
      mode: 'code-review',
      cwd: process.cwd(),
      'base-ref': 'main',
      'codex-thread-id': 'thread-legacy',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'base', baseRef: 'main' });
    assert.match(ctx.error, /predates|not resumable/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadResumeContext: code-review artifact WITH template-version: 4 and matching target → normal context', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-lrc-cr-tv-'));
  try {
    const prior = path.join(tmp, 'p.md');
    writePriorReview(prior, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'main',
      'codex-thread-id': 'thread-tv-ok',
      'codex-resume-status': 'fresh',
    });
    const ctx = await loadResumeContext(prior, 'code-review', { reviewTarget: 'base', baseRef: 'main' });
    assert.equal(ctx.error, undefined);
    assert.equal(ctx.threadId, 'thread-tv-ok');
    assert.equal(ctx.frontmatter['template-version'], '4');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Task 2: discoverResumeArtifact code-review ────────────────────────────────

test('discoverResumeArtifact: code-review --base skips newer wrong-target artifact, picks matching one', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-cr-base-'));
  try {
    // newest: wrong base-ref (feature-x)
    writePriorReview(path.join(tmp, '20260601-0000-newest.md'), {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'feature-x',
      'codex-thread-id': 'thread-wrong',
      'codex-resume-status': 'fresh',
    });
    // middle: matching base-ref (main)
    const middle = path.join(tmp, '20260510-1015-middle.md');
    writePriorReview(middle, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'main',
      'codex-thread-id': 'thread-match',
      'codex-resume-status': 'fresh',
    });
    // oldest: wrong base-ref (feature-x)
    writePriorReview(path.join(tmp, '20260101-0000-oldest.md'), {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'feature-x',
      'codex-thread-id': 'thread-old-wrong',
      'codex-resume-status': 'fresh',
    });
    const r = await discoverResumeArtifact('code-review', { out: tmp, reviewTarget: 'base', baseRef: 'main' });
    assert.equal(r.error, undefined);
    assert.equal(r.path, middle);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverResumeArtifact: code-review --commit skips newer wrong-SHA artifact, picks matching one', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-cr-sha-'));
  try {
    const targetSha = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
    const otherSha = 'ffff9999aaaa1111bbbb2222cccc3333dddd4444';
    // newest: wrong commit SHA
    writePriorReview(path.join(tmp, '20260601-0000-newest.md'), {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'commit': otherSha,
      'codex-thread-id': 'thread-wrong',
      'codex-resume-status': 'fresh',
    });
    // middle: matching commit SHA
    const middle = path.join(tmp, '20260510-1015-middle.md');
    writePriorReview(middle, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'commit': targetSha,
      'codex-thread-id': 'thread-match',
      'codex-resume-status': 'fresh',
    });
    // oldest: wrong commit SHA
    writePriorReview(path.join(tmp, '20260101-0000-oldest.md'), {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'commit': otherSha,
      'codex-thread-id': 'thread-old-wrong',
      'codex-resume-status': 'fresh',
    });
    const r = await discoverResumeArtifact('code-review', { out: tmp, reviewTarget: 'commit', commit: targetSha });
    assert.equal(r.error, undefined);
    assert.equal(r.path, middle);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('discoverResumeArtifact: code-review --uncommitted skips newer non-uncommitted artifact, picks matching one', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-disc-cr-unc-'));
  try {
    // newest: has base-ref, so not uncommitted
    writePriorReview(path.join(tmp, '20260601-0000-newest.md'), {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'base-ref': 'main',
      'codex-thread-id': 'thread-wrong',
      'codex-resume-status': 'fresh',
    });
    // middle: no base-ref, no commit → uncommitted
    const middle = path.join(tmp, '20260510-1015-middle.md');
    writePriorReview(middle, {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      // no base-ref, no commit
      'codex-thread-id': 'thread-match',
      'codex-resume-status': 'fresh',
    });
    // oldest: has commit, so not uncommitted
    writePriorReview(path.join(tmp, '20260101-0000-oldest.md'), {
      mode: 'code-review',
      'template-version': 4,
      cwd: process.cwd(),
      'commit': 'deadbeef1234deadbeef1234deadbeef12345678',
      'codex-thread-id': 'thread-old-wrong',
      'codex-resume-status': 'fresh',
    });
    const r = await discoverResumeArtifact('code-review', { out: tmp, reviewTarget: 'uncommitted' });
    assert.equal(r.error, undefined);
    assert.equal(r.path, middle);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
