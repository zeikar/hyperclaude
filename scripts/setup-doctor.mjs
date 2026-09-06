#!/usr/bin/env node
// setup-doctor — local prerequisite probe. No Codex spawn; stdlib only.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// ---------- semver helpers ----------

/**
 * Extract the first MAJOR.MINOR[.PATCH] triple from arbitrary text.
 * Returns [major, minor, patch] or null if none found.
 * Missing patch component defaults to 0.
 */
export function parseSemver(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/**
 * Compare two [major, minor, patch] triples.
 * Returns -1, 0, or 1.
 */
// a, b must be [major, minor, patch] triples from parseSemver()
export function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ---------- pure eval functions (no spawn) ----------

/**
 * Evaluate Node.js version check.
 * @param {string} versionString - e.g. process.versions.node ("18.0.0")
 * @returns check result object
 */
export function evalNode(versionString) {
  const name = 'Node.js >= 18';
  const required = '>= 18';
  const remediation = 'Install Node.js >= 18 (https://nodejs.org).';
  const parsed = parseSemver(versionString);
  if (!parsed) {
    return { name, detected: String(versionString), required, status: 'FAIL', severity: 'hard', remediation };
  }
  const pass = parsed[0] >= 18;
  return {
    name,
    detected: String(versionString),
    required,
    status: pass ? 'PASS' : 'FAIL',
    severity: 'hard',
    remediation,
  };
}

/**
 * Evaluate codex-cli version check from a sentinel object.
 * Pure — performs no spawn.
 * @param {{ kind: "ok"|"enoent"|"timeout"|"error-exit"|"error", output?: string, status?: number }} sentinel
 * @returns check result object
 */
export function evalCodex(sentinel) {
  const name = 'codex-cli >= 0.130.0 (version floor only)';
  const required = '>= 0.130.0';
  const remediation = 'Install or upgrade codex-cli to >= 0.130.0 and ensure it is on PATH.';
  const base = { name, required, severity: 'hard', remediation };
  const floor = [0, 130, 0];

  switch (sentinel.kind) {
    case 'enoent':
      return { ...base, detected: 'not found', status: 'FAIL' };
    case 'timeout':
      return { ...base, detected: 'timeout', status: 'FAIL' };
    case 'error':
      return { ...base, detected: 'error', status: 'FAIL' };
    case 'error-exit':
      return { ...base, detected: 'error-exit', status: 'FAIL' };
    case 'ok': {
      const parsed = parseSemver(sentinel.output ?? '');
      if (!parsed) {
        return { ...base, detected: 'unparseable', status: 'FAIL' };
      }
      const pass = cmpSemver(parsed, floor) >= 0;
      const detected = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
      return { ...base, detected, status: pass ? 'PASS' : 'FAIL' };
    }
    default:
      return { ...base, detected: 'error', status: 'FAIL' };
  }
}

/**
 * Evaluate git version check from a sentinel object.
 * Pure — performs no spawn.
 * @param {{ kind: "ok"|"enoent"|"timeout"|"error-exit"|"error", output?: string, status?: number }} sentinel
 * @returns check result object
 */
export function evalGit(sentinel) {
  const name = 'git on PATH';
  const required = 'on PATH';
  const remediation = 'Install git and ensure it is on PATH.';
  const base = { name, required, severity: 'hard', remediation };

  switch (sentinel.kind) {
    case 'enoent':
      return { ...base, detected: 'not found', status: 'FAIL' };
    case 'timeout':
      return { ...base, detected: 'timeout', status: 'FAIL' };
    case 'error':
      return { ...base, detected: 'error', status: 'FAIL' };
    case 'error-exit':
      return { ...base, detected: 'error-exit', status: 'FAIL' };
    case 'ok': {
      const parsed = parseSemver(sentinel.output ?? '');
      if (!parsed) {
        return { ...base, detected: 'unparseable', status: 'FAIL' };
      }
      const detected = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
      return { ...base, detected, status: 'PASS' };
    }
    default:
      return { ...base, detected: 'error', status: 'FAIL' };
  }
}

/**
 * Evaluate the codex --search flag preflight check.
 * Pure — performs no spawn.
 * @param {{ kind: "ok"|"enoent"|"timeout"|"error-exit"|"error", output?: string, status?: number }} sentinel
 * @returns check result object
 */
export function evalCodexSearch(sentinel) {
  const name = 'codex --search (global flag, pre-subcommand)';
  const required = 'codex --search exec --help exits 0';
  const remediation =
    'Upgrade codex-cli to a version that accepts --search as a global flag before the subcommand (run: codex --search exec --help).';
  const base = { name, required, severity: 'hard', remediation };

  switch (sentinel.kind) {
    case 'enoent':
      return { ...base, detected: 'not found', status: 'FAIL' };
    case 'timeout':
      return { ...base, detected: 'timeout', status: 'FAIL' };
    case 'error':
      return { ...base, detected: 'error', status: 'FAIL' };
    case 'error-exit':
      return { ...base, detected: 'rejected', status: 'FAIL' };
    case 'ok':
      return { ...base, detected: 'accepted', status: 'PASS' };
    default:
      return { ...base, detected: 'error', status: 'FAIL' };
  }
}

/**
 * Evaluate the Claude Code version check from a sentinel object.
 * Reports the known-good floor for the *-loop skills' background-agent transport.
 * Pure — performs no spawn.
 * @param {{ kind: "ok"|"enoent"|"timeout"|"error-exit"|"error", output?: string, status?: number }} sentinel
 * @returns check result object
 */
export function evalClaudeCodeVersion(sentinel) {
  const name = 'Claude Code >= 2.1.232 (loop transport floor)';
  const required = '>= 2.1.232';
  const remediation =
    'Upgrade Claude Code to >= 2.1.232 for /hyperclaude:hyper-plan-loop, /hyperclaude:hyper-implement-loop, /hyperclaude:hyper-docs-loop, and /hyperclaude:hyper-auto (which chains hyper-plan-loop → hyper-implement-loop): that release is the known-good floor for their background-agent transport — a spawned agent runs in the background and its final text arrives as the task-notification <result> the loops read. Reported only, nothing blocks on it; the research→plan→implement flow works regardless.';
  // severity 'conditional' is intentional — aggregate() only blocks on 'hard'
  const base = { name, required, severity: 'conditional', remediation };
  const floor = [2, 1, 232];

  // Anything short of a parseable version reads as unknown, never a throw.
  if (sentinel.kind !== 'ok') {
    return { ...base, detected: '<unknown>', status: 'WARN' };
  }
  const parsed = parseSemver(sentinel.output ?? '');
  if (!parsed) {
    return { ...base, detected: '<unknown>', status: 'WARN' };
  }
  const pass = cmpSemver(parsed, floor) >= 0;
  const detected = `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
  return { ...base, detected, status: pass ? 'PASS' : 'WARN' };
}

// ---------- aggregate ----------

/**
 * Compute aggregate ok: true iff no check with severity "hard" has status "FAIL".
 * A conditional WARN never flips ok.
 * @param {Array} checks
 * @returns {{ ok: boolean, checks: Array }}
 */
export function aggregate(checks) {
  const ok = !checks.some((c) => c.severity === 'hard' && c.status === 'FAIL');
  return { ok, checks };
}

// ---------- sentinel builder (used only by main) ----------

function buildSentinel(result) {
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return { kind: 'enoent' };
    }
    if (
      result.signal === 'SIGTERM' ||
      result.error.code === 'ETIMEDOUT'
    ) {
      return { kind: 'timeout' };
    }
    return { kind: 'error' };
  }
  if (result.signal === 'SIGTERM') {
    return { kind: 'timeout' };
  }
  if (result.status !== 0) {
    return { kind: 'error-exit', status: result.status };
  }
  // Concatenate stdout then stderr: codex/git --version print the version to stdout; stderr is appended only as a fallback so a version emitted there is still seen.
  return { kind: 'ok', output: (result.stdout ?? '') + (result.stderr ?? ''), status: 0 };
}

// ---------- CLI entry ----------

function main() {
  try {
    // Check 1: Node.js >= 18
    const nodeCheck = evalNode(process.versions.node);

    // Check 2: codex-cli >= 0.130.0
    const codexResult = spawnSync('codex', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1 << 20,
    });
    const codexSentinel = buildSentinel(codexResult);
    const codexCheck = evalCodex(codexSentinel);

    // Check 3: git on PATH
    const gitResult = spawnSync('git', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1 << 20,
    });
    const gitSentinel = buildSentinel(gitResult);
    const gitCheck = evalGit(gitSentinel);

    // Check 4: codex --search global flag (required by the bridge for every Codex spawn)
    const codexSearchResult = spawnSync('codex', ['--search', 'exec', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1 << 20,
    });
    const codexSearchSentinel = buildSentinel(codexSearchResult);
    const codexSearchCheck = evalCodexSearch(codexSearchSentinel);

    // Check 5: Claude Code >= 2.1.232 (floor for the *-loop skills' background-agent transport)
    const claudeResult = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1 << 20,
    });
    const claudeSentinel = buildSentinel(claudeResult);
    const claudeCodeCheck = evalClaudeCodeVersion(claudeSentinel);

    const checks = [nodeCheck, codexCheck, gitCheck, codexSearchCheck, claudeCodeCheck];
    const result = aggregate(checks);

    process.stdout.write(JSON.stringify({ ok: result.ok, checks: result.checks }) + '\n');
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
