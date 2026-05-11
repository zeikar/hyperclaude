// Git helpers used by the codex bridge.

import { spawnSync } from 'node:child_process';

export function getGitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: process.cwd() });
  if (r.error || r.status !== 0) return 'unknown';
  return r.stdout.trim();
}
