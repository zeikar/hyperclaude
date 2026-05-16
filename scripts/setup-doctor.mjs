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
 * Evaluate the CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS env var check.
 * Pure — performs no env read (caller passes the value).
 * @param {string|undefined} envValue - process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
 * @returns check result object
 */
export function evalAgentTeams(envValue) {
  const name = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1';
  const required = '=1';
  const remediation =
    'Set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to enable /hyperclaude:hyper-plan-loop (optional — the research→plan→implement flow works without it).';
  if (envValue === '1') {
    return { name, detected: '1', required, status: 'PASS', severity: 'conditional', remediation };
  }
  const detected = (envValue === undefined || envValue === '') ? '<unset>' : envValue;
  // severity 'conditional' is intentional — aggregate() only blocks on 'hard'
  return { name, detected, required, status: 'WARN', severity: 'conditional', remediation };
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

    // Check 4: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
    const agentTeamsCheck = evalAgentTeams(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS);

    const checks = [nodeCheck, codexCheck, gitCheck, agentTeamsCheck];
    const result = aggregate(checks);

    process.stdout.write(JSON.stringify({ ok: result.ok, checks: result.checks }) + '\n');
    process.exit(0);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
