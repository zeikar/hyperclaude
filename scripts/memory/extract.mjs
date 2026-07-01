#!/usr/bin/env node
// hyper-memory v1 — single-file extraction module (CLI entry + exported pure
// helpers; tests import helpers directly from here, mirroring setup-doctor.mjs).
//
// Scans the accumulated `.hyperclaude/` corpus and emits one evidence-anchored
// knowledge candidate per deterministic copy-based span. NO Codex spawn, stdlib
// only, zero npm deps.
//
// v1 source allowlist: `plans/done/`, `plan-reviews/`, `research/`.
// `code-reviews/` and `docs-reviews/` are v1 non-goals.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { parseFrontmatter } from '../codex/frontmatter.mjs';
import { extractSlugFromPlanFilename } from '../codex/slug.mjs';
import { getPluginVersion } from '../codex/plugin.mjs';

// Re-export parseFrontmatter so tests import the whole helper surface from this
// single module (they must NOT reach into ../codex/frontmatter.mjs directly).
export { parseFrontmatter };

// ---------- corpus enumeration ----------

// `mode` is assigned BY DIR, not read from frontmatter: plans/done files carry
// only a `plugin-version` line (no `mode:` scalar).
export const SOURCE_DIRS = [
  { dir: 'plans/done', mode: 'plan' },
  { dir: 'plan-reviews', mode: 'plan-review' },
  { dir: 'research', mode: 'research' },
];

/**
 * The displayed `source-artifact:` path must reflect the ACTUAL hcRoot, not a
 * hardcoded `.hyperclaude/` prefix. When run against the default root, emit the
 * canonical `.hyperclaude/<dir>/<name>`; for a `--root /tmp/fixture` run, emit
 * the real fixture path so provenance never records a false `.hyperclaude/...`.
 */
export function displaySourcePath(hcRoot, dir, name) {
  if (path.resolve(hcRoot) === path.resolve('.hyperclaude')) {
    return `.hyperclaude/${dir}/${name}`;
  }
  return path.join(hcRoot, dir, name);
}

/**
 * Enumerate all `*.md` artifacts across the v1 source dirs. Fail-open at every
 * level: a missing dir is normal (returns []), a per-file read/parse error is
 * skipped (continue). Returns a flat array of artifact descriptors.
 */
export async function enumerateArtifacts(hcRoot) {
  const artifacts = [];
  for (const { dir, mode } of SOURCE_DIRS) {
    let names;
    try {
      names = await readdir(path.resolve(hcRoot, dir));
    } catch {
      // Missing dir is the normal case for a fresh corpus.
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const absPath = path.resolve(hcRoot, dir, name);
      try {
        const content = await readFile(absPath, 'utf8');
        const frontmatter = parseFrontmatter(content);
        artifacts.push({
          mode,
          name,
          relPath: displaySourcePath(hcRoot, dir, name),
          frontmatter,
          content,
        });
      } catch {
        // Fail-open per file (mirrors session-start-reminder's per-file catch).
        continue;
      }
    }
  }
  return artifacts;
}

/**
 * Derive the trace identity for an artifact.
 * plans/done files carry no `slug:`/`generated:`/`git-head:` scalars (only
 * `plugin-version`), so each field falls back to the filename or 'unknown'.
 */
export function deriveIdentity(artifact) {
  const { mode, name, frontmatter } = artifact;
  const slug = frontmatter.slug || extractSlugFromPlanFilename(name);
  let generated = frontmatter.generated;
  if (!generated) {
    const m = name.match(/^(\d{8}-\d{4})/);
    generated = m ? m[1] : 'unknown';
  }
  const gitHead = frontmatter['git-head'] || 'unknown';
  return { mode, slug, generated, gitHead };
}

// ---------- span + verdict helpers ----------

// ONE ship-as-is rule (no contradiction): ONLY `Ship as-is` prose counts.
// `Ship after fixes` / `Ship after minor fixes` / `Send back to design` do NOT
// match — they are ship-with-fixes or reject. Best-effort prose match; false
// negatives are expected and NO determinism about verdict phrasing is claimed.
export const SHIP_AS_IS_RE = /^ship as-is\b/i;

/**
 * Return the first non-empty line beneath the `### Verdict` heading, else null.
 */
export function extractVerdict(content) {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '### Verdict');
  if (idx === -1) return null;
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length > 0) return t;
  }
  return null;
}

export function isShipAsIs(content) {
  const v = extractVerdict(content);
  return v != null && SHIP_AS_IS_RE.test(v.trim());
}

/**
 * Locate `heading` (e.g. `### Recommendations`) and return the TEXT of the
 * first bullet beneath it — the leading `- `/`* ` list marker removed and
 * surrounding whitespace trimmed. This stripped text becomes the verbatim
 * `## Evidence` span. Returns null when the heading or a bullet is absent.
 */
export function firstBulletUnderHeading(content, heading) {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === heading);
  if (idx === -1) return null;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*[-*]\s+(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Return the first `# ` line's text (the plan title, `# ` marker removed), else
 * null.
 */
export function firstH1(content) {
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.match(/^#\s+(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

// ---------- candidate rendering + compound key ----------

/**
 * Compound identity key (never slug alone): sha256 over the five parts joined
 * by the literal escape '\x00'. A NUL byte cannot appear in any joined text
 * part, so it is a collision-safe separator. Absent fields collapse to '' so
 * the key stays deterministic.
 */
export function candidateKey({ mode, slug, generated, gitHead, claim }) {
  const parts = [mode, slug, generated, gitHead, claim].map((p) => (p == null ? '' : String(p)));
  return createHash('sha256').update(parts.join('\x00')).digest('hex').slice(0, 12);
}

/**
 * Render the candidate markdown. Leading YAML frontmatter carries EXACTLY these
 * keys in this order: plugin-version, type, source-artifact, anchors, mode,
 * slug, git-head, generated, staleness. `plugin-version` is authored BY THE
 * SCRIPT via getPluginVersion() — the PostToolUse stamp hook fires only on the
 * Write tool, NOT on node:fs writes, so this module emits provenance the same
 * way the bridge does. `anchors:` renders as a YAML list (empty → `[]`).
 */
export function renderCandidate({ type, sourceArtifact, anchors, mode, slug, gitHead, generated, staleness, claim, evidence }) {
  const list = Array.isArray(anchors) ? anchors : [];
  const lines = ['---'];
  lines.push(`plugin-version: ${getPluginVersion()}`);
  lines.push(`type: ${type}`);
  lines.push(`source-artifact: ${sourceArtifact}`);
  if (list.length === 0) {
    lines.push('anchors: []');
  } else {
    lines.push('anchors:');
    for (const a of list) lines.push(`  - ${a}`);
  }
  lines.push(`mode: ${mode}`);
  lines.push(`slug: ${slug}`);
  lines.push(`git-head: ${gitHead}`);
  lines.push(`generated: ${generated}`);
  lines.push(`staleness: ${staleness}`);
  lines.push('---');
  lines.push('');
  lines.push('## Claim');
  lines.push('');
  lines.push(claim);
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  lines.push('> ' + evidence);
  lines.push('');
  return lines.join('\n');
}

/**
 * Two-dir idempotency check: a candidate's compound-key file may already exist
 * in candidates/ OR promoted/. Promotion `mv`s a candidate into promoted/, so a
 * candidates-only check would resurrect an already-promoted candidate on the
 * next run.
 */
export function candidateExistsInEitherDir(hcRoot, key) {
  const inCandidates = path.resolve(hcRoot, 'memory/candidates', key + '.md');
  const inPromoted = path.resolve(hcRoot, 'memory/promoted', key + '.md');
  return existsSync(inCandidates) || existsSync(inPromoted);
}

/**
 * Write the candidate iff its compound-key file is absent from BOTH memory dirs.
 * Idempotent skip returns { written: false }; a fresh write returns
 * { written: true }.
 */
export async function writeCandidateIfAbsent(hcRoot, key, markdown) {
  const candidatesDir = path.resolve(hcRoot, 'memory/candidates');
  const dest = path.resolve(candidatesDir, key + '.md');
  if (candidateExistsInEitherDir(hcRoot, key)) {
    return { written: false, path: dest };
  }
  await mkdir(candidatesDir, { recursive: true });
  await writeFile(dest, markdown);
  return { written: true, path: dest };
}

// ---------- git head + staleness ----------

/**
 * Resolve the current repo HEAD ONCE (called once in run(), threaded into every
 * computeStaleness call). Degrades to 'unknown' rather than propagating.
 */
export function currentGitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Compare the artifact's recorded git-head against the precomputed current HEAD.
 * No per-call git spawn. Unknown on either side → 'unknown'.
 */
export function computeStaleness(artifactGitHead, currentHead) {
  if (!artifactGitHead || artifactGitHead === 'unknown' || currentHead === 'unknown') {
    return 'unknown';
  }
  return artifactGitHead === currentHead ? 'current' : 'stale';
}

// ---------- candidate builder ----------

/**
 * Build the candidate objects for one artifact. Deterministic per artifact.mode
 * (exact copy-based spans). `anchors` is ALWAYS [] at extraction, and
 * `## Evidence` (the `evidence` field) is ALWAYS a verbatim copied span — never
 * a generated line.
 */
export function buildCandidatesForArtifact(artifact, currentHead) {
  const { mode, slug, generated, gitHead } = deriveIdentity(artifact);
  const staleness = computeStaleness(gitHead, currentHead);
  const common = { mode, slug, gitHead, generated, staleness, anchors: [] };
  const out = [];

  if (mode === 'research') {
    for (const heading of ['### Recommendations', '### Pitfalls']) {
      const bullet = firstBulletUnderHeading(artifact.content, heading);
      if (!bullet) continue;
      const headingName = heading.replace(/^#+\s*/, '');
      out.push({
        ...common,
        type: 'research-note',
        sourceArtifact: artifact.relPath,
        claim: `Research (${slug}) ${headingName}: ${bullet.slice(0, 120)}`,
        evidence: bullet,
      });
    }
    return out;
  }

  if (mode === 'plan-review') {
    if (!isShipAsIs(artifact.content)) return out;
    const verdict = extractVerdict(artifact.content);
    out.push({
      ...common,
      type: 'ratified-plan',
      // The verdict literally lives in the plan-review artifact.
      sourceArtifact: artifact.relPath,
      claim: `Plan '${slug}' shipped as-is per Codex plan-review.`,
      evidence: verdict,
    });
    return out;
  }

  if (mode === 'plan') {
    const title = firstH1(artifact.content);
    if (!title) return out;
    out.push({
      ...common,
      type: 'implemented-plan',
      // The plan file is itself a gitignored artifact, not a canonical anchor.
      sourceArtifact: artifact.relPath,
      claim: `Implemented plan: ${title}`,
      evidence: title,
    });
    return out;
  }

  return out;
}

// ---------- run ----------

/**
 * Enumerate the corpus and emit candidates. Per-artifact fail-open: any throw
 * while BUILDING or WRITING an artifact's candidates is logged to stderr,
 * counted in `errored`, and skipped — never aborting the batch. Candidates
 * built/written before a mid-artifact write throw stay counted. In dryRun keys
 * are still computed but nothing is written.
 */
export async function run({ hcRoot = '.hyperclaude', dryRun = false } = {}) {
  const currentHead = currentGitHead();
  const artifacts = await enumerateArtifacts(hcRoot);
  const candidatesDir = path.resolve(hcRoot, 'memory/candidates');

  let scanned = 0;
  let candidates = 0;
  let written = 0;
  let skipped = 0;
  let errored = 0;

  for (const artifact of artifacts) {
    scanned += 1;
    try {
      const built = buildCandidatesForArtifact(artifact, currentHead);
      for (const cand of built) {
        candidates += 1;
        const key = candidateKey(cand);
        if (dryRun) continue;
        const markdown = renderCandidate(cand);
        const res = await writeCandidateIfAbsent(hcRoot, key, markdown);
        if (res.written) written += 1;
        else skipped += 1;
      }
    } catch (err) {
      errored += 1;
      process.stderr.write(`hyper-memory: skipping ${artifact.relPath}: ${err.message}\n`);
      continue;
    }
  }

  return { ok: true, scanned, candidates, written, skipped, errored, candidatesDir };
}

// ---------- CLI entry ----------

async function main() {
  try {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');
    let hcRoot = '.hyperclaude';
    const rootIdx = argv.indexOf('--root');
    if (rootIdx !== -1 && argv[rootIdx + 1]) hcRoot = argv[rootIdx + 1];

    const result = await run({ hcRoot, dryRun });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
