// Unit tests: slug derivation + artifact frontmatter (render + parse).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, renderFrontmatter, renderCodeReviewFrontmatter, slugifyRef, renderDocsReviewFrontmatter, fmString, parseFrontmatter } from '../scripts/codex-bridge.mjs';

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
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    mode: 'plan-review',
    task: 'line one\nline two\n  indented',
    slug: 'multi',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /task: \|-\n {2}line one\n {2}line two\n {2} {2}indented\n/);
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
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /^---\n/);
  assert.match(fm, /\n---\n$/);
});

test('renderCodeReviewFrontmatter: base-ref variant has required fields and template-version, no task', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    slug: 'vs-main',
    gitHead: 'abc1234567890abcd1234567890abcd1234567890',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /mode: code-review/);
  assert.doesNotMatch(fm, /codex-subcommand:/, 'codex-subcommand must be absent (v0.4+)');
  assert.match(fm, /base-ref: "main"/);
  assert.match(fm, /git-head:/);
  assert.match(fm, /generated:/);
  assert.match(fm, /codex-version:/);
  assert.match(fm, /slug:/);
  assert.match(fm, /template-version: 1/);
  assert.doesNotMatch(fm, /\btask:/);
});

test('renderCodeReviewFrontmatter: template-version: 1 emitted IMMEDIATELY AFTER codex-version line (positional sanity)', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    slug: 'vs-main',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.130.0',
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  const lines = fm.split('\n');
  const cvIdx = lines.findIndex((l) => l.startsWith('codex-version:'));
  assert.ok(cvIdx >= 0, 'codex-version line must be present');
  assert.equal(lines[cvIdx + 1], 'template-version: 1', 'template-version must be the line immediately after codex-version');
});
// ── renderDocsReviewFrontmatter ───────────────────────────────────────────────

test('renderDocsReviewFrontmatter: starts with --- and ends with ---\\n followed by blank line', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
  });
  assert.match(fm, /^---\n/);
  assert.match(fm, /\n---\n$/);
});

test('renderDocsReviewFrontmatter: has required fields and no task/codex-subcommand', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /mode: docs-review/);
  assert.match(fm, /slug:/);
  assert.match(fm, /generated:/);
  assert.match(fm, /codex-version:/);
  assert.match(fm, /template-version: 1/);
  assert.match(fm, /docs-target:/);
  assert.match(fm, /cwd:/);
  assert.match(fm, /git-head:/);
  assert.doesNotMatch(fm, /\btask:/);
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
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /docs-target: "docs\/api reference\.md"/);
});

// ── Task 2: New frontmatter fields (cwd, git-head, codex-thread-id, codex-resume-status, codex-resumed-from) ────

test('renderFrontmatter: new fields cwd, git-head, codex-resume-status always present', () => {
  const fm = renderFrontmatter({
    mode: 'research',
    task: 'test task',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/Users/test/project',
    gitHead: 'abc1234567890abcd1234567890abcd1234567890',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /cwd: "\/Users\/test\/project"/);
  assert.match(fm, /git-head: "abc1234567890abcd1234567890abcd1234567890"/);
  assert.match(fm, /^codex-resume-status: fresh$/m);
});

test('renderFrontmatter: codex-resume-status is bare token, not JSON-stringified', () => {
  const fm = renderFrontmatter({
    mode: 'research',
    task: 'test',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /^codex-resume-status: fresh$/m);
  assert.doesNotMatch(fm, /^codex-resume-status: "fresh"$/m);
});

test('renderFrontmatter: codex-thread-id omitted when null, present when truthy', () => {
  const fmWithout = renderFrontmatter({
    mode: 'research',
    task: 'test',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.doesNotMatch(fmWithout, /codex-thread-id:/);

  const fmWith = renderFrontmatter({
    mode: 'research',
    task: 'test',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: 'thread-abc123',
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fmWith, /codex-thread-id: "thread-abc123"/);
});

test('renderFrontmatter: codex-resumed-from omitted when absent, present when truthy', () => {
  const fmWithout = renderFrontmatter({
    mode: 'research',
    task: 'test',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.doesNotMatch(fmWithout, /codex-resumed-from:/);

  const fmWith = renderFrontmatter({
    mode: 'research',
    task: 'test',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'resumed',
    codexResumedFrom: 'thread-xyz789',
  });
  assert.match(fmWith, /codex-resumed-from: "thread-xyz789"/);
});

test('renderFrontmatter: plan-path migrated to fmString (quotes/spaces round-trip)', () => {
  const fm = renderFrontmatter({
    mode: 'plan-review',
    task: 'review task',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    planPath: '/path/with spaces/plan "2026".md',
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /plan-path: "\/path\/with spaces\/plan \\"2026\\"\.md"/);
});

test('renderCodeReviewFrontmatter: new fields cwd, git-head, codex-resume-status always present', () => {
  const fm = renderCodeReviewFrontmatter({
    slug: 'vs-main',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    gitHead: 'abc1234567890abcd1234567890abcd1234567890',
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    title: null,
    cwd: '/Users/test/project',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /cwd: "\/Users\/test\/project"/);
  assert.match(fm, /git-head: "abc1234567890abcd1234567890abcd1234567890"/);
  assert.match(fm, /^codex-resume-status: fresh$/m);
});

test('renderCodeReviewFrontmatter: codex-thread-id omitted when null, present when truthy', () => {
  const fmWithout = renderCodeReviewFrontmatter({
    slug: 'vs-main',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    gitHead: 'unknown',
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.doesNotMatch(fmWithout, /codex-thread-id:/);

  const fmWith = renderCodeReviewFrontmatter({
    slug: 'vs-main',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    gitHead: 'unknown',
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    title: null,
    cwd: '/tmp',
    codexThreadId: 'thread-def456',
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fmWith, /codex-thread-id: "thread-def456"/);
});

test('renderCodeReviewFrontmatter: base-ref and commit migrated to fmString', () => {
  const fm = renderCodeReviewFrontmatter({
    slug: 'vs-main',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    gitHead: 'unknown',
    reviewTarget: 'base',
    baseRef: 'origin/feature: new feature',
    commit: null,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /base-ref: "origin\/feature: new feature"/);
});

test('renderDocsReviewFrontmatter: new fields cwd, git-head, codex-resume-status always present', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/Users/test/project',
    gitHead: 'abc1234567890abcd1234567890abcd1234567890',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /cwd: "\/Users\/test\/project"/);
  assert.match(fm, /git-head: "abc1234567890abcd1234567890abcd1234567890"/);
  assert.match(fm, /^codex-resume-status: fresh$/m);
});

test('renderDocsReviewFrontmatter: codex-thread-id omitted when null, present when truthy', () => {
  const fmWithout = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.doesNotMatch(fmWithout, /codex-thread-id:/);

  const fmWith = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api.md',
    diffBase: null,
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: 'thread-ghi789',
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fmWith, /codex-thread-id: "thread-ghi789"/);
});

test('renderDocsReviewFrontmatter: docs-target and diff-base migrated to fmString', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'api',
    docsTarget: 'docs/api: reference.md',
    diffBase: 'origin/develop',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /docs-target: "docs\/api: reference\.md"/);
  assert.match(fm, /diff-base: "origin\/develop"/);
});

// ── Task 3: review-brief ─────────────────────────────────────────────────────

test('renderFrontmatter: review-brief present when truthy, absent when omitted', () => {
  const base = {
    mode: 'plan-review',
    task: 'test',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  };
  const fmWithout = renderFrontmatter(base);
  assert.doesNotMatch(fmWithout, /review-brief:/);

  const fmWith = renderFrontmatter({ ...base, reviewBrief: 'Add OAuth login' });
  assert.match(fmWith, /review-brief: "Add OAuth login"/);
});

test('renderFrontmatter: review-brief emitted immediately after plan-path', () => {
  const fm = renderFrontmatter({
    mode: 'plan-review',
    task: 'test',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    planPath: '/tmp/plan.md',
    reviewBrief: 'Add OAuth login',
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  const lines = fm.split('\n');
  const ppIdx = lines.findIndex((l) => l.startsWith('plan-path:'));
  assert.ok(ppIdx >= 0, 'plan-path line must be present');
  assert.equal(lines[ppIdx + 1], 'review-brief: "Add OAuth login"', 'review-brief must be the line immediately after plan-path');
});

test('renderFrontmatter: review-brief round-trips byte-identically through parseFrontmatter', () => {
  const brief = 'Scope: add "OAuth" login\nonly for the /api/v1 routes';
  const fm = renderFrontmatter({
    mode: 'plan-review',
    task: 'test',
    slug: 'test',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    reviewBrief: brief,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  const parsed = parseFrontmatter(fm);
  assert.equal(parsed['review-brief'], brief);
});

test('renderCodeReviewFrontmatter: review-brief present when truthy, absent when omitted', () => {
  const base = {
    slug: 'vs-main',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    gitHead: 'unknown',
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  };
  const fmWithout = renderCodeReviewFrontmatter(base);
  assert.doesNotMatch(fmWithout, /review-brief:/);

  const fmWith = renderCodeReviewFrontmatter({ ...base, reviewBrief: 'Add OAuth login' });
  assert.match(fmWith, /review-brief: "Add OAuth login"/);
});

test('renderCodeReviewFrontmatter: review-brief emitted immediately after title, before cwd', () => {
  const fm = renderCodeReviewFrontmatter({
    slug: 'vs-main',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    gitHead: 'unknown',
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    title: 'My PR title',
    reviewBrief: 'Add OAuth login',
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  const lines = fm.split('\n');
  const titleIdx = lines.findIndex((l) => l.startsWith('title:'));
  assert.ok(titleIdx >= 0, 'title line must be present');
  assert.equal(lines[titleIdx + 1], 'review-brief: "Add OAuth login"', 'review-brief must be the line immediately after title');
  assert.equal(lines[titleIdx + 2], 'cwd: "/tmp"', 'cwd must be the line immediately after review-brief');
});

test('renderCodeReviewFrontmatter: review-brief round-trips byte-identically through parseFrontmatter', () => {
  const brief = 'Scope: add "OAuth" login\nonly for the /api/v1 routes';
  const fm = renderCodeReviewFrontmatter({
    slug: 'vs-main',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.128.0',
    templateVersion: 1,
    gitHead: 'unknown',
    reviewTarget: 'base',
    baseRef: 'main',
    commit: null,
    title: null,
    reviewBrief: brief,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  const parsed = parseFrontmatter(fm);
  assert.equal(parsed['review-brief'], brief);
});

// ── fmString ──────────────────────────────────────────────────────────────────

test('fmString: simple value JSON-stringifies', () => {
  assert.equal(fmString('slug', 'oauth-login'), 'slug: "oauth-login"');
});

test('fmString: handles quotes, colons, and backslashes safely', () => {
  assert.equal(
    fmString('task', 'add "OAuth": login'),
    'task: "add \\"OAuth\\": login"',
  );
});

test('fmString: handles paths with spaces', () => {
  assert.equal(
    fmString('docs-target', 'docs/api reference.md'),
    'docs-target: "docs/api reference.md"',
  );
});
// ── Task 4: parseFrontmatter ─────────────────────────────────────────────────

test('parseFrontmatter: empty / missing leading --- returns {}', () => {
  assert.deepEqual(parseFrontmatter(''), {});
  assert.deepEqual(parseFrontmatter('no frontmatter here\nmore text\n'), {});
  assert.deepEqual(parseFrontmatter('---no\nstuff'), {});
});

test('parseFrontmatter: parses simple bare scalars verbatim', () => {
  const txt = '---\nmode: plan-review\nslug: oauth-login\ncodex-resume-status: fresh\n---\nbody';
  const fm = parseFrontmatter(txt);
  assert.equal(fm.mode, 'plan-review');
  assert.equal(fm.slug, 'oauth-login');
  assert.equal(fm['codex-resume-status'], 'fresh');
});

test('parseFrontmatter: parses JSON-quoted values via JSON.parse', () => {
  const txt = '---\ncwd: "/Users/test/project"\nplan-path: "/tmp/with \\"quotes\\".md"\n---\n';
  const fm = parseFrontmatter(txt);
  assert.equal(fm.cwd, '/Users/test/project');
  assert.equal(fm['plan-path'], '/tmp/with "quotes".md');
});

test('parseFrontmatter: malformed JSON-quoted falls back to raw', () => {
  // Truncated JSON string — store raw substring rather than throwing.
  const txt = '---\nbroken: "no closing\n---\n';
  const fm = parseFrontmatter(txt);
  assert.equal(fm.broken, '"no closing');
});

test('parseFrontmatter: skips block scalars (key: |-) including indented continuation', () => {
  const txt = [
    '---',
    'mode: research',
    'task: |-',
    '  multi-line task',
    '  with quotes "x"',
    '  and more',
    'slug: my-slug',
    '---',
    'body',
  ].join('\n');
  const fm = parseFrontmatter(txt);
  assert.equal(fm.mode, 'research');
  assert.equal(fm.slug, 'my-slug', 'slug after block scalar should still be picked up');
  // task is intentionally skipped (we don't need it for resume identity).
  assert.ok(!('task' in fm) || fm.task === undefined, 'task should be skipped');
});

test('parseFrontmatter: closing --- terminates parsing', () => {
  const txt = [
    '---',
    'mode: plan-review',
    '---',
    'after: should-not-parse',
  ].join('\n');
  const fm = parseFrontmatter(txt);
  assert.equal(fm.mode, 'plan-review');
  assert.ok(!('after' in fm), 'fields after closing --- should not be parsed');
});

test('parseFrontmatter: CRLF tolerant', () => {
  const txt = '---\r\nmode: plan-review\r\nslug: x\r\n---\r\nbody\r\n';
  const fm = parseFrontmatter(txt);
  assert.equal(fm.mode, 'plan-review');
  assert.equal(fm.slug, 'x');
});

test('parseFrontmatter: also handles |  (no dash) block scalar', () => {
  const txt = [
    '---',
    'note: |',
    '  hello',
    '  world',
    'mode: plan-review',
    '---',
  ].join('\n');
  const fm = parseFrontmatter(txt);
  assert.equal(fm.mode, 'plan-review');
  assert.ok(!('note' in fm) || fm.note === undefined);
});
