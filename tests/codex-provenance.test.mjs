// Unit tests: plugin-version provenance stamped into artifact frontmatter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { renderFrontmatter, renderCodeReviewFrontmatter, renderDocsReviewFrontmatter, getPluginVersion } from '../scripts/codex-bridge.mjs';

// ── plugin-version (provenance) ───────────────────────────────────────────────

test('getPluginVersion: returns the loaded copy\'s .claude-plugin/plugin.json version', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(getPluginVersion(), manifest.version);
  assert.match(getPluginVersion(), /^\d+\.\d+\.\d+/);
});

test('renderFrontmatter: plugin-version emitted IMMEDIATELY BEFORE codex-version', () => {
  const fm = renderFrontmatter({
    mode: 'research',
    task: 'x',
    slug: 's',
    generated: '2026-05-10T10:15:00.000Z',
    pluginVersion: '0.18.0',
    codexVersion: '0.130.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  const lines = fm.split('\n');
  const pvIdx = lines.findIndex((l) => l.startsWith('plugin-version:'));
  assert.ok(pvIdx >= 0, 'plugin-version line must be present');
  assert.equal(lines[pvIdx], 'plugin-version: 0.18.0');
  assert.equal(lines[pvIdx + 1], 'codex-version: 0.130.0', 'codex-version must immediately follow plugin-version');
});

test('renderCodeReviewFrontmatter: plugin-version present and precedes codex-version', () => {
  const fm = renderCodeReviewFrontmatter({
    reviewTarget: 'uncommitted',
    baseRef: null,
    commit: null,
    slug: 'uncommitted',
    gitHead: 'unknown',
    generated: '2026-05-10T10:15:00.000Z',
    pluginVersion: '0.18.0',
    codexVersion: '0.130.0',
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  const lines = fm.split('\n');
  const pvIdx = lines.findIndex((l) => l.startsWith('plugin-version:'));
  assert.equal(lines[pvIdx], 'plugin-version: 0.18.0');
  assert.equal(lines[pvIdx + 1], 'codex-version: 0.130.0');
});

test('renderDocsReviewFrontmatter: plugin-version present and precedes codex-version', () => {
  const fm = renderDocsReviewFrontmatter({
    slug: 'docs',
    generated: '2026-05-10T10:15:00.000Z',
    pluginVersion: '0.18.0',
    codexVersion: '0.130.0',
    templateVersion: 1,
    docsTarget: 'docs/',
    diffBase: undefined,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  const lines = fm.split('\n');
  const pvIdx = lines.findIndex((l) => l.startsWith('plugin-version:'));
  assert.equal(lines[pvIdx], 'plugin-version: 0.18.0');
  assert.equal(lines[pvIdx + 1], 'codex-version: 0.130.0');
});

test('renderFrontmatter: plugin-version defaults to unknown when omitted', () => {
  const fm = renderFrontmatter({
    mode: 'research',
    task: 'x',
    slug: 's',
    generated: '2026-05-10T10:15:00.000Z',
    codexVersion: '0.130.0',
    templateVersion: 1,
    cwd: '/tmp',
    gitHead: 'unknown',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /^plugin-version: unknown$/m);
});

test('renderCodeReviewFrontmatter: does not emit codex-subcommand field', () => {
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
    codexThreadId: 'thread-abc123',
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.doesNotMatch(fm, /codex-subcommand:/);
  // Shared fields from Task 2 must be present.
  assert.match(fm, /cwd:/);
  assert.match(fm, /codex-thread-id:/);
  assert.match(fm, /codex-resume-status: fresh/);
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
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    templateVersion: 1,
    title: 'my review title',
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
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
    templateVersion: 1,
    title: null,
    cwd: '/tmp',
    codexThreadId: null,
    codexResumeStatus: 'fresh',
    codexResumedFrom: undefined,
  });
  assert.match(fm, /base-ref: "origin\/main"/);
});
