import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseFrontmatter,
  SOURCE_DIRS,
  displaySourcePath,
  enumerateArtifacts,
  deriveIdentity,
  SHIP_AS_IS_RE,
  extractVerdict,
  isShipAsIs,
  firstBulletUnderHeading,
  firstH1,
  candidateKey,
  renderCandidate,
  candidateExistsInEitherDir,
  writeCandidateIfAbsent,
  computeStaleness,
  buildCandidatesForArtifact,
  run,
} from '../scripts/memory/extract.mjs';

// ---------- fixture helper ----------

async function makeFixture() {
  return mkdtemp(path.join(os.tmpdir(), 'hyper-memory-'));
}

// ---------- import-safety ----------

test('import-safety: importing extract.mjs does not run main()', () => {
  const testsDir = fileURLToPath(new URL('.', import.meta.url));
  const result = spawnSync(
    process.execPath,
    ['-e', 'import("../scripts/memory/extract.mjs").then(()=>process.stdout.write("IMPORTED_NO_OUTPUT"))'],
    { cwd: testsDir, encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, `process exited with status ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout, 'IMPORTED_NO_OUTPUT');
});

// ---------- candidateKey ----------

test('candidateKey: stable for identical inputs, length 12', () => {
  const input = { mode: 'plan', slug: 's', generated: '20260101-0000', gitHead: 'abc', claim: 'c' };
  const a = candidateKey(input);
  const b = candidateKey({ ...input });
  assert.equal(a, b);
  assert.equal(a.length, 12);
});

test('candidateKey: differs when claim differs', () => {
  const base = { mode: 'plan', slug: 's', generated: 'g', gitHead: 'h', claim: 'c1' };
  assert.notEqual(candidateKey(base), candidateKey({ ...base, claim: 'c2' }));
});

test('candidateKey: differs when gitHead differs (compound identity)', () => {
  const base = { mode: 'plan', slug: 's', generated: 'g', gitHead: 'h1', claim: 'c' };
  assert.notEqual(candidateKey(base), candidateKey({ ...base, gitHead: 'h2' }));
});

test('candidateKey: deterministic with absent optional fields', () => {
  const a = candidateKey({ mode: 'plan', claim: 'c' });
  const b = candidateKey({ mode: 'plan', slug: undefined, generated: undefined, gitHead: undefined, claim: 'c' });
  assert.equal(a, b);
  assert.equal(a.length, 12);
});

// ---------- extractVerdict / isShipAsIs ----------

test('isShipAsIs: "Ship as-is." → true', () => {
  const content = '### Verdict\n\nShip as-is. Looks good.\n';
  assert.equal(extractVerdict(content), 'Ship as-is. Looks good.');
  assert.equal(isShipAsIs(content), true);
});

test('isShipAsIs: "Ship after minor fixes." → false', () => {
  const content = '### Verdict\n\nShip after minor fixes.\n';
  assert.equal(isShipAsIs(content), false);
});

test('isShipAsIs: "Ship after fixes." → false', () => {
  const content = '### Verdict\n\nShip after fixes.\n';
  assert.equal(isShipAsIs(content), false);
});

test('isShipAsIs: "Send back to design." → false', () => {
  const content = '### Verdict\n\nSend back to design.\n';
  assert.equal(isShipAsIs(content), false);
});

test('extractVerdict: no ### Verdict heading → null, isShipAsIs false', () => {
  const content = '# Some plan\n\nno verdict here\n';
  assert.equal(extractVerdict(content), null);
  assert.equal(isShipAsIs(content), false);
});

test('SHIP_AS_IS_RE is exported and case-insensitive on the one rule', () => {
  assert.ok(SHIP_AS_IS_RE.test('ship as-is now'));
  assert.ok(!SHIP_AS_IS_RE.test('Ship after fixes'));
});

// ---------- parseFrontmatter re-export ----------

test('parseFrontmatter re-export: is a function and skips a task block scalar', () => {
  assert.equal(typeof parseFrontmatter, 'function');
  const text = '---\nmode: research\ntask: |-\n  some multi\n  line task\nslug: foo\n---\n';
  const fm = parseFrontmatter(text);
  assert.equal(fm.mode, 'research');
  assert.equal(fm.slug, 'foo');
  // Block scalar is intentionally skipped (no extractBlockScalar).
  assert.equal(fm.task, undefined);
});

// ---------- firstBulletUnderHeading / firstH1 ----------

test('firstBulletUnderHeading: strips "- " marker, returns exact bullet text', () => {
  const body = '### Recommendations\n\n- Keep stdlib only\n- second\n';
  assert.equal(firstBulletUnderHeading(body, '### Recommendations'), 'Keep stdlib only');
});

test('firstBulletUnderHeading: strips "* " marker too', () => {
  const body = '### Pitfalls\n\n* watch out for X\n';
  assert.equal(firstBulletUnderHeading(body, '### Pitfalls'), 'watch out for X');
});

test('firstBulletUnderHeading: null when heading absent', () => {
  assert.equal(firstBulletUnderHeading('### Other\n\n- x\n', '### Recommendations'), null);
});

test('firstBulletUnderHeading: null when heading present but no bullet', () => {
  assert.equal(firstBulletUnderHeading('### Recommendations\n\nprose only\n', '### Recommendations'), null);
});

test('firstH1: returns title with "# " removed', () => {
  assert.equal(firstH1('# My Plan Title\n\nbody\n'), 'My Plan Title');
});

test('firstH1: null when no H1', () => {
  assert.equal(firstH1('no heading here\n## H2 only\n'), null);
});

// ---------- computeStaleness ----------

test('computeStaleness: matching heads → current', () => {
  assert.equal(computeStaleness('abc', 'abc'), 'current');
});

test('computeStaleness: differing heads → stale', () => {
  assert.equal(computeStaleness('abc', 'def'), 'stale');
});

test('computeStaleness: unknown artifact head → unknown', () => {
  assert.equal(computeStaleness('unknown', 'abc'), 'unknown');
  assert.equal(computeStaleness('', 'abc'), 'unknown');
});

test('computeStaleness: unknown current head → unknown', () => {
  assert.equal(computeStaleness('abc', 'unknown'), 'unknown');
});

// ---------- displaySourcePath ----------

test('displaySourcePath: default root → canonical .hyperclaude prefix', () => {
  assert.equal(displaySourcePath('.hyperclaude', 'research', 'x.md'), '.hyperclaude/research/x.md');
});

test('displaySourcePath: custom root → real fixture path, no false prefix', () => {
  const p = displaySourcePath('/tmp/fixture', 'research', 'x.md');
  assert.equal(p, path.join('/tmp/fixture', 'research', 'x.md'));
  assert.ok(!p.startsWith('.hyperclaude/'));
});

// ---------- deriveIdentity ----------

test('deriveIdentity: plans/done falls back to filename slug + prefix + unknown head', () => {
  const artifact = { mode: 'plan', name: '20260101-0900-my-slug.md', frontmatter: {} };
  const id = deriveIdentity(artifact);
  assert.equal(id.mode, 'plan');
  assert.equal(id.slug, 'my-slug');
  assert.equal(id.generated, '20260101-0900');
  assert.equal(id.gitHead, 'unknown');
});

test('deriveIdentity: uses frontmatter scalars when present', () => {
  const artifact = {
    mode: 'research',
    name: '20260101-0900-fname.md',
    frontmatter: { slug: 'fm-slug', generated: '2026-01-01T00:00:00Z', 'git-head': 'deadbeef' },
  };
  const id = deriveIdentity(artifact);
  assert.equal(id.slug, 'fm-slug');
  assert.equal(id.generated, '2026-01-01T00:00:00Z');
  assert.equal(id.gitHead, 'deadbeef');
});

// ---------- buildCandidatesForArtifact invariants ----------

test('buildCandidatesForArtifact: plan → anchors [] and evidence is the verbatim H1', () => {
  const artifact = {
    mode: 'plan',
    name: '20260101-0900-a-plan.md',
    relPath: '.hyperclaude/plans/done/20260101-0900-a-plan.md',
    frontmatter: {},
    content: '# The Real Title\n\nbody\n',
  };
  const cands = buildCandidatesForArtifact(artifact, 'unknown');
  assert.equal(cands.length, 1);
  assert.deepEqual(cands[0].anchors, []);
  assert.equal(cands[0].type, 'implemented-plan');
  assert.equal(cands[0].evidence, 'The Real Title');
  assert.equal(cands[0].claim, 'Implemented plan: The Real Title');
  assert.equal(cands[0].sourceArtifact, '.hyperclaude/plans/done/20260101-0900-a-plan.md');
});

test('buildCandidatesForArtifact: ship-as-is plan-review → anchors [] and evidence is the verbatim verdict line', () => {
  const artifact = {
    mode: 'plan-review',
    name: '20260101-0900-rev.md',
    relPath: '.hyperclaude/plan-reviews/20260101-0900-rev.md',
    frontmatter: { slug: 'rev', 'plan-path': 'docs/plans/rev.md' },
    content: '# Review\n\n### Verdict\n\nShip as-is. Solid plan.\n',
  };
  const cands = buildCandidatesForArtifact(artifact, 'unknown');
  assert.equal(cands.length, 1);
  assert.deepEqual(cands[0].anchors, []);
  assert.equal(cands[0].type, 'ratified-plan');
  assert.equal(cands[0].evidence, 'Ship as-is. Solid plan.');
  // No generated "archived plan located at" line anywhere.
  assert.ok(!cands[0].evidence.includes('archived plan'));
  assert.equal(cands[0].sourceArtifact, '.hyperclaude/plan-reviews/20260101-0900-rev.md');
});

test('buildCandidatesForArtifact: non-ship-as-is plan-review → zero candidates', () => {
  const artifact = {
    mode: 'plan-review',
    name: '20260101-0900-rev.md',
    relPath: '.hyperclaude/plan-reviews/20260101-0900-rev.md',
    frontmatter: { slug: 'rev' },
    content: '### Verdict\n\nSend back for fixes.\n',
  };
  assert.equal(buildCandidatesForArtifact(artifact, 'unknown').length, 0);
});

test('buildCandidatesForArtifact: plan-review with MISSING plan-path still emits its candidate and does not throw', () => {
  const artifact = {
    mode: 'plan-review',
    name: '20260101-0900-rev.md',
    relPath: '.hyperclaude/plan-reviews/20260101-0900-rev.md',
    frontmatter: { slug: 'rev' }, // no plan-path
    content: '### Verdict\n\nShip as-is.\n',
  };
  const cands = buildCandidatesForArtifact(artifact, 'unknown');
  assert.equal(cands.length, 1);
  assert.deepEqual(cands[0].anchors, []);
  assert.equal(cands[0].evidence, 'Ship as-is.');
});

test('buildCandidatesForArtifact: research → anchors [] and evidence is the verbatim stripped bullet', () => {
  const artifact = {
    mode: 'research',
    name: '20260101-0900-res.md',
    relPath: '.hyperclaude/research/20260101-0900-res.md',
    frontmatter: { slug: 'res' },
    content: '### Recommendations\n\n- Keep stdlib only\n\n### Pitfalls\n\n- Beware races\n',
  };
  const cands = buildCandidatesForArtifact(artifact, 'unknown');
  assert.equal(cands.length, 2);
  for (const c of cands) {
    assert.deepEqual(c.anchors, []);
    assert.equal(c.type, 'research-note');
  }
  assert.equal(cands[0].evidence, 'Keep stdlib only');
  assert.equal(cands[0].claim, 'Research (res) Recommendations: Keep stdlib only');
  assert.equal(cands[1].evidence, 'Beware races');
  assert.equal(cands[1].claim, 'Research (res) Pitfalls: Beware races');
});

test('buildCandidatesForArtifact: research with no bullets → zero candidates', () => {
  const artifact = {
    mode: 'research',
    name: '20260101-0900-res.md',
    relPath: '.hyperclaude/research/20260101-0900-res.md',
    frontmatter: { slug: 'res' },
    content: '# Research\n\nno recommendations or pitfalls headings\n',
  };
  assert.equal(buildCandidatesForArtifact(artifact, 'unknown').length, 0);
});

// ---------- renderCandidate ----------

test('renderCandidate: frontmatter key order, distinct source-artifact/anchors, empty anchors [], body', () => {
  const md = renderCandidate({
    type: 'implemented-plan',
    sourceArtifact: '.hyperclaude/plans/done/x.md',
    anchors: [],
    mode: 'plan',
    slug: 'x',
    gitHead: 'abc',
    generated: '20260101-0900',
    staleness: 'unknown',
    claim: 'Implemented plan: X',
    evidence: 'X',
  });

  const fmEnd = md.indexOf('\n---\n', 4);
  const header = md.slice(0, fmEnd);
  const keys = header
    .split('\n')
    .filter((l) => /^[a-z-]+:/.test(l))
    .map((l) => l.slice(0, l.indexOf(':')));
  assert.deepEqual(keys, [
    'plugin-version',
    'type',
    'source-artifact',
    'anchors',
    'mode',
    'slug',
    'git-head',
    'generated',
    'staleness',
  ]);
  assert.ok(/^plugin-version: .+$/m.test(md), 'plugin-version present');
  assert.ok(md.includes('source-artifact: .hyperclaude/plans/done/x.md'));
  assert.ok(md.includes('anchors: []'));
  assert.ok(md.includes('## Claim'));
  assert.ok(md.includes('Implemented plan: X'));
  assert.ok(md.includes('## Evidence'));
  assert.ok(md.includes('> X'));
});

test('renderCandidate: non-empty anchors render as a YAML list', () => {
  const md = renderCandidate({
    type: 'implemented-plan',
    sourceArtifact: '.hyperclaude/plans/done/x.md',
    anchors: ['scripts/foo.mjs', 'docs/bar.md'],
    mode: 'plan',
    slug: 'x',
    gitHead: 'abc',
    generated: 'g',
    staleness: 'unknown',
    claim: 'c',
    evidence: 'e',
  });
  assert.ok(md.includes('anchors:\n  - scripts/foo.mjs\n  - docs/bar.md'));
});

// ---------- cross-dir idempotency ----------

test('candidateExistsInEitherDir / writeCandidateIfAbsent: two-dir idempotency across a promotion mv', async () => {
  const root = await makeFixture();
  const key = 'abc123def456';
  const md = '---\nplugin-version: test\n---\n\n## Claim\n\nc\n';

  // (a) first write
  const first = await writeCandidateIfAbsent(root, key, md);
  assert.equal(first.written, true);
  assert.ok(existsSync(path.resolve(root, 'memory/candidates', key + '.md')));

  // (b) same key → skip
  const second = await writeCandidateIfAbsent(root, key, md);
  assert.equal(second.written, false);

  // simulate promotion: mv candidates/<key>.md → promoted/<key>.md
  await mkdir(path.resolve(root, 'memory/promoted'), { recursive: true });
  await rename(
    path.resolve(root, 'memory/candidates', key + '.md'),
    path.resolve(root, 'memory/promoted', key + '.md'),
  );
  assert.ok(candidateExistsInEitherDir(root, key));

  // (c) after promotion, same key STILL skips and is NOT recreated in candidates/
  const third = await writeCandidateIfAbsent(root, key, md);
  assert.equal(third.written, false);
  assert.ok(!existsSync(path.resolve(root, 'memory/candidates', key + '.md')));
});

// ---------- run() real fail-open ----------

test('run(): real fail-open — good artifacts write, empty + frontmatter-less files never reject', async () => {
  const root = await makeFixture();
  await mkdir(path.resolve(root, 'plans/done'), { recursive: true });
  await mkdir(path.resolve(root, 'plan-reviews'), { recursive: true });
  await mkdir(path.resolve(root, 'research'), { recursive: true });

  // good plan
  await writeFile(
    path.resolve(root, 'plans/done', '20260101-0900-good-plan.md'),
    '# A Good Plan\n\nbody\n',
  );
  // good ship-as-is review
  await writeFile(
    path.resolve(root, 'plan-reviews', '20260101-0901-good-rev.md'),
    '---\nslug: good-rev\n---\n# Review\n\n### Verdict\n\nShip as-is.\n',
  );
  // good research
  await writeFile(
    path.resolve(root, 'research', '20260101-0902-good-res.md'),
    '---\nslug: good-res\n---\n### Recommendations\n\n- do the thing\n',
  );
  // odd file: empty
  await writeFile(path.resolve(root, 'research', '20260101-0903-empty.md'), '');
  // odd file: frontmatter-less prose
  await writeFile(path.resolve(root, 'plans/done', '20260101-0904-noise.md'), 'just prose, no h1\n');

  const result = await run({ hcRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 5);
  // plan H1 + ship-as-is verdict + research bullet = 3 candidates written
  assert.equal(result.written, 3);
  assert.equal(result.errored, 0);

  const files = await readdir(path.resolve(root, 'memory/candidates'));
  assert.equal(files.length, 3);
});

test('run(): write failure is fail-open — batch survives with ok:true, errored:1, written:0', async () => {
  const root = await makeFixture();
  await mkdir(path.resolve(root, 'plans/done'), { recursive: true });

  // exactly one valid artifact → exactly one candidate (plan H1)
  await writeFile(
    path.resolve(root, 'plans/done', '20260101-0900-good-plan.md'),
    '# A Good Plan\n\nbody\n',
  );

  // Force the write to fail: pre-create <root>/memory as a regular FILE so
  // mkdir <root>/memory/candidates throws ENOTDIR inside writeCandidateIfAbsent.
  await writeFile(path.resolve(root, 'memory'), 'not a dir\n');

  const result = await run({ hcRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.errored, 1);
  assert.equal(result.written, 0);
});

test('run(): dry-run computes but writes nothing and creates no candidates dir', async () => {
  const root = await makeFixture();
  await mkdir(path.resolve(root, 'plans/done'), { recursive: true });
  await writeFile(path.resolve(root, 'plans/done', '20260101-0900-p.md'), '# T\n');

  const result = await run({ hcRoot: root, dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.candidates, 1);
  assert.equal(result.written, 0);
  assert.ok(!existsSync(path.resolve(root, 'memory/candidates')));
});

test('run(): missing corpus → ok:true, scanned:0', async () => {
  const root = await makeFixture(); // empty, no source dirs
  const result = await run({ hcRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, 0);
});

// ---------- enumerateArtifacts / SOURCE_DIRS ----------

test('SOURCE_DIRS: exactly the v1 allowlist with dir→mode assignment', () => {
  assert.deepEqual(SOURCE_DIRS, [
    { dir: 'plans/done', mode: 'plan' },
    { dir: 'plan-reviews', mode: 'plan-review' },
    { dir: 'research', mode: 'research' },
  ]);
});

test('enumerateArtifacts: reads *.md across source dirs, ignores non-md, missing dirs are fine', async () => {
  const root = await makeFixture();
  await mkdir(path.resolve(root, 'plans/done'), { recursive: true });
  await writeFile(path.resolve(root, 'plans/done', '20260101-0900-p.md'), '# T\n');
  await writeFile(path.resolve(root, 'plans/done', 'notes.txt'), 'ignored\n');
  // plan-reviews and research dirs intentionally absent → fail-open

  const arts = await enumerateArtifacts(root);
  assert.equal(arts.length, 1);
  assert.equal(arts[0].mode, 'plan');
  assert.equal(arts[0].name, '20260101-0900-p.md');
  assert.equal(arts[0].relPath, path.join(root, 'plans/done', '20260101-0900-p.md'));
});
