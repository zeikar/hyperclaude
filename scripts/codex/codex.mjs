// Codex CLI wrapper for the bridge.
// Spawns `codex exec`, `codex exec resume`, `codex exec review`; parses the
// resulting JSONL stream; surfaces a structured success / failure result.

import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { renderFailureBody } from './failure.mjs';

const MIN_CODEX_MAJOR = 0;
const MIN_CODEX_MINOR = 130;

export function getCodexVersion() {
  const r = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (r.error) {
    if (r.error.code === 'ENOENT') {
      return { ok: false, reason: 'codex CLI not found on PATH' };
    }
    return { ok: false, reason: `codex --version errored: ${r.error.message}` };
  }
  if (r.status !== 0) {
    return { ok: false, reason: `codex --version exited ${r.status}: ${r.stderr.trim()}` };
  }
  const m = r.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return { ok: true, version: 'unknown' };
  const [, maj, min] = m.map(Number);
  if (maj < MIN_CODEX_MAJOR || (maj === MIN_CODEX_MAJOR && min < MIN_CODEX_MINOR)) {
    return {
      ok: false,
      reason: `codex ${m[0]} is too old; need >= ${MIN_CODEX_MAJOR}.${MIN_CODEX_MINOR}.0`,
    };
  }
  return { ok: true, version: m[0] };
}

// Pure parser over Codex's `--json` stdout stream. CRLF tolerant. Tallies
// the events the bridge cares about: thread.started, turn.completed,
// turn.failed, top-level error events, and malformed lines (kept-going).
// `usage` from the LAST `turn.completed` wins (later events authoritative).
export function parseCodexJsonl(stdoutText) {
  const out = {
    threadId: null,
    hasTurnCompleted: false,
    turnFailedMessage: null,
    topLevelErrors: [],   // list of error messages (caller can take last 3)
    malformedLines: 0,
    usage: null,
  };
  if (typeof stdoutText !== 'string' || stdoutText.length === 0) return out;
  // Split on \n; strip optional trailing \r so CRLF input parses identically.
  const rawLines = stdoutText.split('\n');
  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue; // ignore blank separator lines
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      out.malformedLines += 1;
      continue;
    }
    if (!evt || typeof evt !== 'object') {
      out.malformedLines += 1;
      continue;
    }
    const type = evt.type;
    if (type === 'thread.started') {
      if (typeof evt.thread_id === 'string' && evt.thread_id.length > 0) {
        out.threadId = evt.thread_id;
      }
    } else if (type === 'turn.completed') {
      out.hasTurnCompleted = true;
      if (evt.usage && typeof evt.usage === 'object') {
        out.usage = evt.usage; // last one wins
      }
    } else if (type === 'turn.failed') {
      // Capture message even when nested under `error` (Codex shape).
      const msg =
        (evt.error && typeof evt.error.message === 'string' && evt.error.message) ||
        (typeof evt.message === 'string' && evt.message) ||
        '';
      out.turnFailedMessage = msg;
    } else if (type === 'error') {
      const msg = typeof evt.message === 'string' ? evt.message : '';
      out.topLevelErrors.push(msg);
    }
  }
  return out;
}

// Internal codex spawn helper. Returns a structured result with explicit
// exit shape `{ status, signal, timedOut }` so callers can tell the
// difference between "exited 7", "killed by SIGTERM", and "we timed out".
//
// `stdinMode` is the stdio[0] config: 'pipe' (default — caller may write+end
// via stdinPayload) or 'ignore' (no stdin fd; child sees /dev/null).
function spawnCodex(spawnArgs, { stdinPayload = null, stdinMode = 'pipe' } = {}, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn('codex', spawnArgs, { stdio: [stdinMode, 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    // `settled` ensures the promise resolves at most once. On spawn failure,
    // Node fires both `error` and then `close` (code=null); without this guard
    // `resolve` would be called twice (harmless in native Promises, but fragile
    // if the caller ever wraps this in an observable that detects multi-settlement).
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const KILL_GRACE_MS = 2000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS).unref();
    }, timeoutSec * 1000);

    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', (err) => {
      settle({
        ok: false,
        reason: `spawn error: ${err.message}`,
        stdout: '',
        stderr: '',
        exit: { status: null, signal: null, timedOut: false },
      });
    });
    child.on('close', (status, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const exit = { status, signal, timedOut };
      if (timedOut) {
        return settle({ ok: false, reason: `codex timed out after ${timeoutSec}s`, stdout, stderr, exit });
      }
      if (status !== 0) {
        return settle({ ok: false, reason: `codex exited ${status}`, stdout, stderr, exit });
      }
      settle({ ok: true, stdout, stderr, exit });
    });
    if (stdinMode === 'pipe') {
      if (stdinPayload !== null) {
        child.stdin.end(stdinPayload);
      } else {
        child.stdin.end();
      }
    }
  });
}

// Insert `--json --output-last-message <tmp>` into a SEMANTIC argv right after
// the codex subcommand tokens (`exec`, `exec resume`, `exec review`) and BEFORE
// any positional / `-` token. Argv ordering is pinned by spawn tests.
function injectJsonAndOutputFlags(semanticArgv, lastMessagePath) {
  const args = [...semanticArgv];
  // Find the index AFTER the subcommand prefix.
  let i = 0;
  if (args[i] === 'exec') {
    i += 1;
    if (args[i] === 'resume' || args[i] === 'review') {
      i += 1;
    }
  }
  // Insert at position i (right after the subcommand tokens).
  args.splice(i, 0, '--json', '--output-last-message', lastMessagePath);
  return args;
}

// runCodexExec: unified codex spawn for `exec`, `exec resume`, `exec review`.
//
// `argv` is the SEMANTIC argv (e.g. `['exec', '--sandbox', 'read-only', '-']`).
// The helper inserts `--json --output-last-message <tmp>` after the subcommand
// tokens and before any positional arg. Callers do NOT include those flags.
//
// `stdinPayload === null` → spawn with stdio[0]='ignore' (no stdin pipe).
// String (including '') → pipe + write + end.
//
// `knownThreadId` is an authority over the parsed threadId — used by resume
// callers so the result's threadId is correct even when `thread.started` is
// not re-emitted on resume.
export async function runCodexExec(argv, stdinPayload, timeoutSec, knownThreadId = null) {
  const lastMessagePath = path.join(os.tmpdir(), `hyperclaude-codex-${crypto.randomUUID()}.txt`);
  const fullArgv = injectJsonAndOutputFlags(argv, lastMessagePath);
  // --search is a global codex flag (must precede the subcommand) enabling web search;
  // it does NOT relax the read-only sandbox invariant (CLAUDE.md "Sandbox invariant").
  fullArgv.unshift('--search');

  let spawnResult;
  let lastMessageText = '';
  try {
    const spawnOpts = stdinPayload === null
      ? { stdinPayload: null, stdinMode: 'ignore' }
      : { stdinPayload, stdinMode: 'pipe' };
    spawnResult = await spawnCodex(fullArgv, spawnOpts, timeoutSec);
    // Read the tempfile BEFORE unlinking. Codex writes the final agent
    // message here; for many runs this is the entire body.
    try {
      lastMessageText = await readFile(lastMessagePath, 'utf8');
    } catch {
      // File may not exist if codex died very early (spawn error / immediate
      // crash). Treat as empty — the failure body renderer handles "(empty)".
      lastMessageText = '';
    }
  } finally {
    try { await unlink(lastMessagePath); } catch { /* tempfile may already be gone */ }
  }

  const parseDiagnostics = parseCodexJsonl(spawnResult.stdout || '');
  const exit = spawnResult.exit;
  // Thread id authority: parsed value first; if missing, fall back to the
  // known id (resume passes its own thread id in).
  const threadId = parseDiagnostics.threadId || knownThreadId || null;

  const success = (
    spawnResult.ok &&
    exit.status === 0 &&
    parseDiagnostics.hasTurnCompleted &&
    !parseDiagnostics.turnFailedMessage
  );

  if (success) {
    return {
      ok: true,
      body: lastMessageText,
      threadId,
      parseDiagnostics,
      lastMessageText,
      stderr: spawnResult.stderr,
      exit,
      reason: null,
    };
  }

  // Compose a precise failure reason for stdout JSON.
  let reason;
  if (spawnResult.reason) {
    reason = spawnResult.reason;
  } else if (parseDiagnostics.turnFailedMessage) {
    reason = `codex turn.failed: ${parseDiagnostics.turnFailedMessage}`;
  } else if (!parseDiagnostics.hasTurnCompleted) {
    reason = 'codex stream ended before turn.completed';
  } else {
    reason = `codex failed (exit status=${exit.status})`;
  }

  return {
    ok: false,
    body: renderFailureBody({
      parseDiagnostics,
      lastMessageText,
      stderr: spawnResult.stderr,
      exit,
    }),
    threadId,
    parseDiagnostics,
    lastMessageText,
    stderr: spawnResult.stderr,
    exit,
    reason,
  };
}

// runCodexResume: resumes an existing Codex thread by id.
// Passes knownThreadId as the 4th arg to runCodexExec so the result's threadId
// is authoritative even when `thread.started` is not re-emitted on resume.
export function runCodexResume(threadId, prompt, timeoutSec) {
  return runCodexExec(
    ['exec', 'resume', '-c', 'sandbox_mode=read-only', threadId, '-'],
    prompt,
    timeoutSec,
    threadId,
  );
}
