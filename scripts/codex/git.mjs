// Git helpers used by the codex bridge.

import { spawnSync } from 'node:child_process';

export function getGitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: process.cwd() });
  if (r.error || r.status !== 0) return 'unknown';
  return r.stdout.trim();
}

// Verify the selected code-review target actually resolves in git BEFORE we
// spawn Codex. The code-review prompt instructs Codex to continue on failed
// git reads (so per-file deleted/binary cases don't abort a review); without
// this preflight a wholly-unresolvable target (bad base ref, typoed commit,
// not a repo) would yield ok:true over an empty review. For the base target a
// resolvable ref is not enough — the prompt diffs `<baseRef>...HEAD`, so we
// also probe for a merge base; unrelated/shallow histories can resolve the ref
// while the committed slice silently vanishes. Local git plumbing only — NOT a
// Codex spawn, so the read-only sandbox invariant is unaffected.
export function verifyReviewTarget(args) {
  const inTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', cwd: process.cwd() });
  if (inTree.error || inTree.status !== 0 || inTree.stdout.trim() !== 'true') {
    return { ok: false, reason: 'not inside a git work tree' };
  }
  if (args.reviewTarget === 'base') {
    // Refs/SHAs passed as single argv elements (no shell, no interpolation).
    const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${args.baseRef}^{commit}`], { encoding: 'utf8', cwd: process.cwd() });
    if (r.status !== 0) return { ok: false, reason: `base ref not found: ${args.baseRef}` };
    const mb = spawnSync('git', ['merge-base', args.baseRef, 'HEAD'], { encoding: 'utf8', cwd: process.cwd() });
    if (mb.status !== 0) return { ok: false, reason: `no merge base between ${args.baseRef} and HEAD (cannot compute ${args.baseRef}...HEAD)` };
  } else if (args.reviewTarget === 'commit') {
    const r = spawnSync('git', ['cat-file', '-e', `${args.commit}^{commit}`], { encoding: 'utf8', cwd: process.cwd() });
    if (r.status !== 0) return { ok: false, reason: `commit not found: ${args.commit}` };
  }
  // 'uncommitted': the work-tree check above is sufficient.
  return { ok: true };
}
