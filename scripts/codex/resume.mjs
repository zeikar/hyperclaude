// Resume helpers for the codex bridge.
// loadResumeContext validates a prior artifact and extracts its thread id;
// discoverResumeArtifact finds the newest valid artifact under the mode's
// output directory; resolveResume is the high-level dispatch used by main().

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';
import { readTemplateWithVersion } from './templates.mjs';

// defaultModeDir: maps a mode to its conventional output directory under
// .hyperclaude/. Mirrors the implicit mapping in buildInvocation.
export function defaultModeDir(mode) {
  if (mode === 'research') return '.hyperclaude/research';
  if (mode === 'plan-review') return '.hyperclaude/plan-reviews';
  if (mode === 'code-review') return '.hyperclaude/code-reviews';
  if (mode === 'docs-review') return '.hyperclaude/docs-reviews';
  throw new Error(`unknown mode: ${mode}`);
}

// templateVersionGateError: shared --resume identity rule for every resumable
// mode (plan-review / docs-review / code-review; research has no resume path).
// A resumed thread keeps running under the prior prompt's semantics while the
// new artifact is stamped with the CURRENT template version; when the versions
// differ that label would lie, so the mismatch is rejected (auto → fresh
// fallback, explicit → fatal) instead of mislabeled. The expected value is
// sourced from the mode's fresh template frontmatter (no hardcoded constant).
// Returns an error string, or null when the gate passes.
async function templateVersionGateError(mode, fm) {
  let expectedVersion;
  try {
    expectedVersion = (await readTemplateWithVersion(mode)).version;
  } catch (err) {
    return `cannot read current ${mode} template: ${err.message}`;
  }
  const tv = fm['template-version'];
  if (tv === undefined || String(tv) !== String(expectedVersion)) {
    return `prior ${mode} artifact template-version differs from the current template (or predates it); not resumable`;
  }
  return null;
}

// loadResumeContext: validates a prior artifact and extracts thread-id.
// Returns either { threadId, frontmatter } or { error: <reason> }.
//
// Validations (in order, first failure wins):
//  1. file readable + parses
//  2. mode field equals expectedMode
//  3. cwd matches process.cwd() under path.resolve()
//  4. codex-thread-id is truthy
//  5. codex-resume-status is fresh or resumed (not fallback / resume-failed)
//  6. template-version matches the mode's current fresh template
//  7. mode-specific identity (plan-path for plan-review; docs-target+diff-base
//     for docs-review; base-ref/commit/uncommitted for code-review)
export async function loadResumeContext(prevPath, expectedMode, currentArgs) {
  let text;
  try {
    text = await readFile(prevPath, 'utf8');
  } catch {
    return { error: `cannot read prior artifact: ${prevPath}` };
  }
  const fm = parseFrontmatter(text);
  if (fm.mode !== expectedMode) {
    return { error: `prior artifact mode is "${fm.mode ?? ''}"; current mode is "${expectedMode}"` };
  }
  const prevCwd = fm.cwd;
  if (typeof prevCwd !== 'string' || prevCwd.length === 0) {
    return { error: `prior artifact cwd is ""; current cwd is "${process.cwd()}"` };
  }
  const here = process.cwd();
  if (path.resolve(prevCwd) !== path.resolve(here)) {
    return { error: `prior artifact cwd is "${prevCwd}"; current cwd is "${here}"` };
  }
  const threadId = fm['codex-thread-id'];
  if (!threadId || typeof threadId !== 'string') {
    return { error: 'prior artifact has no codex-thread-id' };
  }
  const status = fm['codex-resume-status'];
  if (status !== 'fresh' && status !== 'resumed') {
    return { error: `prior artifact has resume-status "${status ?? ''}"; only fresh/resumed eligible` };
  }
  const gateError = await templateVersionGateError(expectedMode, fm);
  if (gateError) {
    return { error: gateError };
  }
  if (expectedMode === 'plan-review') {
    const prevPlan = fm['plan-path'];
    if (typeof prevPlan !== 'string' || path.resolve(prevPlan) !== path.resolve(currentArgs.planPath)) {
      return { error: 'prior artifact plan-path differs from current' };
    }
  } else if (expectedMode === 'docs-review') {
    const prevTarget = fm['docs-target'];
    const curTarget = currentArgs.docsPath || currentArgs.docsDir;
    if (typeof prevTarget !== 'string' || path.resolve(prevTarget) !== path.resolve(curTarget)) {
      return { error: 'prior artifact docs-target/diff-base differs from current' };
    }
    const prevDiff = fm['diff-base'] ?? null;
    const curDiff = currentArgs.diffBase ?? null;
    if (prevDiff !== curDiff) {
      return { error: 'prior artifact docs-target/diff-base differs from current' };
    }
  } else if (expectedMode === 'code-review') {
    // title is purely cosmetic — does NOT participate in identity (it does not
    // affect what Codex reviewed, only the display label in the output file).
    const hasPriorBaseRef = Object.prototype.hasOwnProperty.call(fm, 'base-ref');
    const hasPriorCommit = Object.prototype.hasOwnProperty.call(fm, 'commit');
    // Precheck: a well-formed prior artifact has at most one of base-ref/commit.
    // Both present means malformed frontmatter — reject before target matching to
    // prevent the absence-means-uncommitted inference from granting a false match.
    if (hasPriorBaseRef && hasPriorCommit) {
      return { error: 'prior artifact code-review target differs from current' };
    }
    const curTarget = currentArgs.reviewTarget;
    if (curTarget === 'base') {
      // Match on ref name string only (no SHA resolve).
      if (!hasPriorBaseRef || fm['base-ref'] !== currentArgs.baseRef) {
        return { error: 'prior artifact code-review target differs from current' };
      }
    } else if (curTarget === 'commit') {
      // Match on exact SHA string.
      if (!hasPriorCommit || fm['commit'] !== currentArgs.commit) {
        return { error: 'prior artifact code-review target differs from current' };
      }
    } else {
      // uncommitted: prior must lack both base-ref and commit keys.
      if (hasPriorBaseRef || hasPriorCommit) {
        return { error: 'prior artifact code-review target differs from current' };
      }
    }
  }
  // Mode-INDEPENDENT model/effort match (applies to plan-review/code-review/
  // docs-review; research has no resume path so never reaches here). This is a
  // SEPARATE rule from the shared template-version identity gate above —
  // do NOT fold them together. When the requested overrides differ, the bridge
  // cannot prove the prior thread ran under the same effective model/effort:
  // the recorded values are the requested bridge overrides, not the resolved
  // effective settings, so it conservatively rejects that artifact rather than
  // continuing a thread whose model/effort it can't confirm (prompt-caching
  // motivated). Scope: this compares ONLY the recorded bridge overrides — two
  // flagless runs both record null and match; it does NOT detect
  // ~/.codex/config.toml drift. Message stays neutral (no "fresh fallback"
  // wording): the fallback-vs-fatal decision belongs to resolveResume/caller.
  const prevModel = fm['codex-model-requested'] ?? null;
  const curModel = currentArgs.model ?? null;
  const prevEffort = fm['codex-effort-requested'] ?? null;
  const curEffort = currentArgs.effort ?? null;
  if (prevModel !== curModel || prevEffort !== curEffort) {
    return { error: 'prior artifact requested model/effort override differs from current' };
  }
  return { threadId, frontmatter: fm };
}

// resolveResume: for `--resume <path>` or `--resume auto`, returns one of:
//   { ok: true, prevPath, context }
//   { ok: false, fatal: true,  error }   // explicit path → caller fails hard
//   { ok: false, fatal: false, error }   // 'auto' miss → caller falls back to fresh
export async function resolveResume(mode, args) {
  let prevPath;
  if (args.resumeFrom === 'auto') {
    const d = await discoverResumeArtifact(mode, args);
    if (d.error) return { ok: false, fatal: false, error: d.error };
    prevPath = d.path;
  } else {
    prevPath = args.resumeFrom;
  }
  const ctx = await loadResumeContext(prevPath, mode, args);
  if (ctx.error) {
    return { ok: false, fatal: args.resumeFrom !== 'auto', error: ctx.error };
  }
  return { ok: true, prevPath, context: ctx };
}

// discoverResumeArtifact: searches the configured output directory for the
// newest artifact whose frontmatter passes loadResumeContext. Returns either
// { path } or { error: 'no matching artifact in <dir>' }.
export async function discoverResumeArtifact(mode, args) {
  const dir = args.out ?? defaultModeDir(mode);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { error: `no matching artifact in ${dir}` };
  }
  const candidates = entries
    .filter((d) => d.isFile() && d.name.endsWith('.md') && /^\d{8}-\d{4}-/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => {
      // Newest first: same-minute collisions (`-2.md`, `-3.md`) are written LATER
      // than the unsuffixed name; lex order puts unsuffixed first, so we read the
      // collision suffix and treat higher suffix = newer within the same prefix.
      const m = (n) => n.match(/^(\d{8}-\d{4}-.*?)(?:-(\d+))?\.md$/);
      const ma = m(a), mb = m(b);
      if (ma && mb && ma[1] === mb[1]) {
        return Number(mb[2] ?? 1) - Number(ma[2] ?? 1);
      }
      return b.localeCompare(a);
    });
  for (const name of candidates) {
    const candidatePath = path.join(dir, name);
    const ctx = await loadResumeContext(candidatePath, mode, args);
    if (!ctx.error) {
      return { path: candidatePath };
    }
  }
  return { error: `no matching artifact in ${dir}` };
}
