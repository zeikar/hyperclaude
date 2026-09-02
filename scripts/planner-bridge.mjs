#!/usr/bin/env node
// Planner bridge — runs the planner agent as a persistent `claude -p` session
// instead of a native Claude Code subagent.
//
// Why: a native subagent writes its prompt cache into the 5-minute TTL bucket,
// and every planner round in a plan-loop is separated by a Codex review that
// takes minutes, so the cache has always expired by the next round. A
// `claude -p` conversation writes into the 1-hour bucket instead (measured:
// ephemeral_1h 17334 / ephemeral_5m 0), which survives a review boundary.
//
// One session per planning workflow, keyed by the plan-file stem: `--start`
// mints and atomically reserves it, later calls resume it, `--end` discards it.
// Start and continue are explicit, never inferred from whether the mapping file
// happens to exist — a start that collides fails so the caller picks another
// key, and a continue with no mapping fails instead of silently planning anew. `--agent` is
// re-passed on EVERY call including resumes — dropping it changes the system
// prompt and throws the cached prefix away (measured: cache_read 17343 with it,
// 4132 without).
//
// Like the codex bridge, this imposes no wall-clock deadline; cancellation is
// signal-driven (see forwardSignals).

import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const SESSION_DIR = '.hyperclaude/planner-sessions';
export const PLANNER_AGENT = 'hyperclaude:planner';
// The planner writes the plan file itself (caller-directed write-file mode) and
// inspects the repo with Bash, and a headless session has nobody to approve
// either. Measured against the real CLI in a scratch repo, same prompt each
// time: `default` blocked every Write and produced no plan file; `acceptEdits`
// wrote the plan but denied all three Bash calls, so the plan was composed
// without looking at the tree; `auto` wrote the plan with zero denials. `auto`
// is therefore the narrowest mode that satisfies the WHOLE contract, and it
// still honours configured deny rules.
export const PLANNER_PERMISSION_MODE = 'auto';
export const ROLE_ENV = 'HYPERCLAUDE_ROLE';

// The workflow key is the plan file's stem (`<YYYYMMDD-HHMM>-<slug>`), NOT the
// slug: slugs are derived from the first few task words and two different
// planning workflows can mint the same one, which would resume the wrong
// conversation. The timestamp prefix is what makes it unique.
//
// The pattern is a path-traversal guard (the key becomes a filename), not a
// slug validator: it allows trailing and repeated hyphens because `slugify()`
// returns null for an all-non-ASCII task, leaving the stem such a task produces
// undefined. Rejecting those shapes here would add a failure mode on top of
// that pre-existing gap rather than fixing it.
const WORKFLOW_RE = /^[a-z0-9][a-z0-9-]*$/;

const ALLOWED_FLAGS = new Set(['--workflow', '--prompt-file', '--start', '--end']);

export function parseArgs(argv) {
  const out = { workflow: null, promptFile: null, start: false, end: false };
  let i = 0;
  const next = () => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${argv[i]} requires a value`);
    i += 1;
    return v;
  };
  for (; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!ALLOWED_FLAGS.has(flag)) throw new Error(`unknown flag: ${flag}`);
    switch (flag) {
      case '--workflow': {
        const s = next();
        if (!WORKFLOW_RE.test(s)) {
          throw new Error(`--workflow must match /^[a-z0-9][a-z0-9-]*$/, got: "${s}"`);
        }
        out.workflow = s;
        break;
      }
      case '--prompt-file': out.promptFile = next(); break;
      case '--start':       out.start = true; break;
      case '--end':         out.end = true; break;
    }
  }
  if (!out.workflow) throw new Error('--workflow is required');
  if (!out.end && !out.promptFile) throw new Error('--prompt-file is required (or pass --end)');
  if (out.end && out.promptFile) throw new Error('--end takes no --prompt-file');
  if (out.end && out.start) throw new Error('--end and --start are mutually exclusive');
  return out;
}

export function sessionPathFor(workflow) {
  return path.join(SESSION_DIR, `${workflow}.id`);
}

// buildClaudeArgv: the flags handed to `claude`, as an array. The PROMPT IS NOT
// HERE — it is piped over stdin (see spawnClaude), which the codex bridge
// already does for its own spawns. Two reasons it must not be a positional:
// Step 2 inlines whole research artifacts, so the prompt is unbounded and can
// exceed the platform argv limit (E2BIG) before claude starts; and a revise
// prompt opens with verbatim Codex findings ("- **Major** …"), which the CLI
// parses as a flag — verified against the real binary, which answers
//   error: unknown option '- **Major** …'
export function buildClaudeArgv({ sessionId, resume }) {
  return [
    '-p',
    resume ? '--resume' : '--session-id', sessionId,
    '--agent', PLANNER_AGENT,
    '--permission-mode', PLANNER_PERMISSION_MODE,
    '--output-format', 'json',
  ];
}

// parseClaudeJson: strict parse of `--output-format json` output.
// Returns { ok, body, sessionId } or { ok: false, error }.
export function parseClaudeJson(stdoutText) {
  let j;
  try {
    j = JSON.parse(stdoutText);
  } catch {
    return { ok: false, error: 'claude output was not valid JSON' };
  }
  if (!j || typeof j !== 'object') return { ok: false, error: 'claude output was not a JSON object' };
  if (j.is_error === true) {
    const detail = typeof j.result === 'string' && j.result.length > 0 ? j.result : '(no detail)';
    return { ok: false, error: `claude reported is_error: ${detail}` };
  }
  if (typeof j.result !== 'string' || j.result.length === 0) {
    return { ok: false, error: 'claude output carried no result text' };
  }
  return {
    ok: true,
    body: j.result,
    sessionId: typeof j.session_id === 'string' && j.session_id.length > 0 ? j.session_id : null,
  };
}

// Forward interrupt/terminate to the child so a cancelled call stops the
// planner turn instead of orphaning it, and REMEMBER which signal arrived.
// Installing a handler disables Node's default termination, so the caller would
// otherwise see an ordinary exit-1 failure where a cancellation happened; main()
// re-raises on itself once the child is gone (see reRaise).
function spawnClaude(argv, promptText) {
  return new Promise((resolve) => {
    const child = spawn('claude', argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, [ROLE_ENV]: 'planner' },
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    // Cancellation is already armed (main arms it before reserving the key);
    // registering the child is what lets a signal reach it. Queueing a large
    // prompt is a real window, so this happens before stdin is written.
    activeChild = child;
    child.stdin.on('error', () => { /* child died before reading the prompt */ });
    child.stdin.end(promptText);
    const settle = (r) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      resolve(r);
    };
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    // A spawn error means claude never started — nothing can have been written.
    child.on('error', (err) => settle({
      ok: false,
      spawned: false,
      reason: `spawn error: ${err.message}`,
      stdout: '',
      stderr: '',
    }));
    child.on('close', (status, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (status !== 0) {
        const how = signal ? `killed by ${signal}` : `exited ${status}`;
        return settle({ ok: false, spawned: true, reason: `claude ${how}`, stdout, stderr });
      }
      settle({ ok: true, spawned: true, stdout, stderr });
    });
  });
}

// Cancellation state, armed for the whole of main(). A signal that lands while
// the key is being reserved, or after the child closed but before the session
// id is persisted, would otherwise terminate on Node's default handling and
// strand a mapping nothing can resume.
let activeChild = null;
let receivedSignal = null;
let cancelHandlers = [];

function armCancellation() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const h = () => {
      receivedSignal = sig;
      if (activeChild && activeChild.exitCode === null) activeChild.kill(sig);
    };
    process.on(sig, h);
    cancelHandlers.push([sig, h]);
  }
}

function disarmCancellation() {
  for (const [sig, h] of cancelHandlers) process.off(sig, h);
  cancelHandlers = [];
}

// Re-raise a forwarded signal on ourselves so the caller sees a signal death
// rather than a plain non-zero exit.
function reRaise(sig) {
  disarmCancellation();
  process.removeAllListeners(sig);
  process.kill(process.pid, sig);
}

// Shared exit for a cancellation at any point in the run: drop a mapping this
// run owns, report, then die by the signal.
async function bailOnSignal(workflow, sessionId, base = {}) {
  const leak = sessionId ? await releaseSession(workflow, sessionId) : null;
  emit({ ok: false, ...base, workflow, error: `cancelled by ${receivedSignal}`, ...(leak ? { cleanup: leak } : {}) });
  reRaise(receivedSignal);
}

// Distinguishes "no session yet" from "cannot read the session". Treating an
// unreadable mapping as absent would silently start a FRESH planner on a
// revision prompt that carries only Codex findings — which can rewrite the plan
// from nothing before the caller notices `resumed:false`.
// Returns { kind: 'none' } | { kind: 'id', id } | { kind: 'error', message }.
async function readSessionId(workflow) {
  let raw;
  try {
    raw = await readFile(sessionPathFor(workflow), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: 'none' };
    return { kind: 'error', message: `cannot read session state: ${err.message}` };
  }
  const id = raw.trim();
  if (id.length === 0 || /[\s/\\]/.test(id)) {
    return { kind: 'error', message: 'session state is empty or malformed' };
  }
  return { kind: 'id', id };
}

// Claims the workflow key with an exclusive create, so two runs that resolved
// the same key cannot each mint a session. The loser does NOT join the winner:
// that would put two distinct planning tasks in one conversation, and either
// task's --end would delete the other's mapping.
async function reserveSession(workflow, id) {
  await mkdir(SESSION_DIR, { recursive: true });
  try {
    await writeFile(sessionPathFor(workflow), `${id}\n`, { encoding: 'utf8', flag: 'wx' });
    return { reserved: true };
  } catch (err) {
    if (err.code !== 'EEXIST') return { reserved: false, error: `cannot reserve session: ${err.message}` };
    return { reserved: false };
  }
}

// Drops a mapping this call owns, so an abandoned round leaves behind no id
// that nothing can resume. Verifies the file still holds OUR session id first:
// deleting another workflow's mapping would be worse than leaking our own.
// Returns null on success, or a message describing what could not be cleaned.
async function releaseSession(workflow, sessionId) {
  const found = await readSessionId(workflow);
  if (found.kind === 'none') return null;
  if (found.kind === 'error') return found.message;
  if (found.id !== sessionId) return null; // not ours to remove
  try {
    await unlink(sessionPathFor(workflow));
  } catch (err) {
    if (err.code !== 'ENOENT') return `cannot release session: ${err.message}`;
  }
  return null;
}

// Written via a temp file + rename so an interrupted write cannot leave a
// truncated session id that would silently start a new conversation.
async function writeSessionId(workflow, id) {
  await mkdir(SESSION_DIR, { recursive: true });
  const finalPath = sessionPathFor(workflow);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${id}\n`, 'utf8');
  await rename(tmpPath, finalPath);
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  if (code !== 0) process.exit(code);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    emit({ ok: false, spawned: false, error: err.message }, 2);
    return;
  }

  armCancellation();

  // Session lifecycle: discard. Ending an unknown workflow is a no-op, but any
  // OTHER unlink failure means the session is still there — say so rather than
  // reporting a cleanup that did not happen.
  if (args.end) {
    try {
      await unlink(sessionPathFor(args.workflow));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        emit({ ok: false, spawned: false, workflow: args.workflow, error: `cannot discard session: ${err.message}` }, 1);
        return;
      }
    }
    emit({ ok: true, workflow: args.workflow, ended: true });
    return;
  }

  let promptText;
  try {
    promptText = await readFile(args.promptFile, 'utf8');
  } catch {
    emit({ ok: false, spawned: false, error: `cannot read --prompt-file: ${args.promptFile}` }, 1);
    return;
  }
  if (promptText.trim().length === 0) {
    emit({ ok: false, spawned: false, error: `--prompt-file is empty: ${args.promptFile}` }, 1);
    return;
  }

  // Session lifecycle: reuse if this workflow already has one, else mint and
  // atomically reserve the key before spawning.
  const found = await readSessionId(args.workflow);
  if (found.kind === 'error') {
    emit({ ok: false, spawned: false, workflow: args.workflow, error: found.message }, 1);
    return;
  }
  if (receivedSignal) return bailOnSignal(args.workflow, null, { spawned: false });

  let sessionId;
  if (args.start) {
    if (found.kind === 'id') {
      emit({ ok: false, spawned: false, workflow: args.workflow, error: `workflow key already in use: ${args.workflow} — resolve a different plan path` }, 1);
      return;
    }
    sessionId = crypto.randomUUID();
    const claim = await reserveSession(args.workflow, sessionId);
    if (!claim.reserved) {
      // Either a hard failure, or another run claimed the key between our read
      // and our write. Both mean this workflow must pick a different key —
      // joining the other one would put two planning tasks in one conversation.
      emit({ ok: false, spawned: false, workflow: args.workflow, error: claim.error ?? `workflow key already in use: ${args.workflow} — resolve a different plan path` }, 1);
      return;
    }
  } else {
    if (found.kind === 'none') {
      emit({ ok: false, spawned: false, workflow: args.workflow, error: `no planner session for ${args.workflow}; start one with --start` }, 1);
      return;
    }
    sessionId = found.id;
  }
  if (receivedSignal) return bailOnSignal(args.workflow, args.start ? sessionId : null, { spawned: false });

  const resume = !args.start;
  const argv = buildClaudeArgv({ sessionId, resume });

  const result = await spawnClaude(argv, promptText);
  const base = { workflow: args.workflow, sessionId, resumed: resume, spawned: result.spawned };

  if (receivedSignal) return bailOnSignal(args.workflow, sessionId, base);

  if (!result.ok) {
    const leak = args.start ? await releaseSession(args.workflow, sessionId) : null;
    const tail = (result.stderr || '').trim().split('\n').slice(-3).join(' | ');
    emit({ ok: false, ...base, error: tail.length > 0 ? `${result.reason}: ${tail}` : result.reason, ...(leak ? { cleanup: leak } : {}) }, 1);
    return;
  }

  const parsed = parseClaudeJson(result.stdout);
  if (!parsed.ok) {
    const leak = args.start ? await releaseSession(args.workflow, sessionId) : null;
    emit({ ok: false, ...base, error: parsed.error, ...(leak ? { cleanup: leak } : {}) }, 1);
    return;
  }

  // claude's own session_id is authoritative when present; the reservation held
  // the minted id, so only a mismatch needs a rewrite.
  const finalId = parsed.sessionId ?? sessionId;
  try {
    if (finalId !== sessionId) await writeSessionId(args.workflow, finalId);
  } catch (err) {
    // The planner ran and may have written the plan; losing the id only costs
    // the next round its context, so report it rather than crashing silently.
    emit({ ok: false, ...base, sessionId: finalId, error: `planner ran but its session id could not be persisted: ${err.message}` }, 1);
    return;
  }
  if (receivedSignal) return bailOnSignal(args.workflow, finalId, base);
  disarmCancellation();
  emit({ ok: true, ...base, sessionId: finalId, body: parsed.body });
}

// Only run main() when invoked as a CLI, so tests can import the helpers.
// A top-level catch keeps the one-JSON-envelope contract even on an unexpected
// throw, which an unhandled rejection would otherwise break.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('planner-bridge.mjs')) {
  main().catch((err) => {
    emit({ ok: false, spawned: false, error: `planner bridge failed: ${err && err.message ? err.message : String(err)}` }, 1);
  });
}
