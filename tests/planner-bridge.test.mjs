// Planner bridge: argv shape, session lifecycle, recursion guard, failure propagation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PLANNER_BRIDGE,
  MOCK_CLAUDE_SUCCESS,
  MOCK_CLAUDE_IS_ERROR,
  MOCK_CLAUDE_NONZERO,
  MOCK_CLAUDE_SLOW,
  MOCK_CLAUDE_RESERVATION_CHECK,
} from './helpers/fixtures.mjs';
import { parseArgs, buildClaudeArgv, parseClaudeJson, sessionPathFor, PLANNER_AGENT } from '../scripts/planner-bridge.mjs';

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'hooks',
  'session-start-reminder.mjs'
);

// Sets up a workspace with a mock `claude` on PATH and a prompt file.
// Returns { dir, run } where run(...args) invokes the bridge with cwd=dir.
function workspace(mockScript) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-planner-'));
  const mockPath = path.join(dir, 'claude');
  writeFileSync(mockPath, mockScript);
  chmodSync(mockPath, 0o755);
  writeFileSync(path.join(dir, 'prompt.txt'), 'Decompose: add OAuth login\n');
  const run = (...args) => spawnSync('node', [PLANNER_BRIDGE, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const argvLog = () => readFileSync(path.join(dir, 'argv.log'), 'utf8').split('\n').filter((l) => l.length > 0);
  return { dir, run, argvLog };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('parseArgs: --workflow is required and path-traversal shaped slugs are rejected', () => {
  assert.throws(() => parseArgs(['--prompt-file', 'p.txt']), /--workflow is required/);
  assert.throws(() => parseArgs(['--workflow', '../etc', '--prompt-file', 'p.txt']), /--workflow must match/);
  assert.throws(() => parseArgs(['--workflow', 'ok-slug']), /--prompt-file is required/);
  assert.throws(() => parseArgs(['--workflow', 'ok-slug', '--bogus']), /unknown flag: --bogus/);
  assert.deepEqual(
    parseArgs(['--workflow', 'ok-slug', '--prompt-file', 'p.txt']),
    { workflow: 'ok-slug', promptFile: 'p.txt', start: false, end: false },
  );
});

test('buildClaudeArgv: fresh uses --session-id, resume uses --resume, both carry --agent', () => {
  const fresh = buildClaudeArgv({ sessionId: 'sid-1', resume: false });
  assert.deepEqual(fresh, ['-p', '--session-id', 'sid-1', '--agent', PLANNER_AGENT, '--permission-mode', 'auto', '--output-format', 'json']);

  const resumed = buildClaudeArgv({ sessionId: 'sid-1', resume: true });
  assert.deepEqual(resumed, ['-p', '--resume', 'sid-1', '--agent', PLANNER_AGENT, '--permission-mode', 'auto', '--output-format', 'json']);

  // Re-passing --agent on resume is load-bearing: without it the system prompt
  // changes and the cached prefix is discarded (measured cache_read 4132 vs 17343).
  assert.ok(resumed.includes('--agent'), 'resume argv must re-pass --agent');
  // The prompt is piped, never an argv element — see buildClaudeArgv.
  assert.equal(resumed.filter((a) => a === '--').length, 0, 'no end-of-options separator is needed once the prompt is piped');
});

test('parseClaudeJson: is_error, missing result, and non-JSON all fail; a good envelope parses', () => {
  assert.equal(parseClaudeJson('not json').ok, false);
  assert.match(parseClaudeJson('{"is_error":true,"result":"denied"}').error, /denied/);
  assert.equal(parseClaudeJson('{"is_error":false}').ok, false);
  const good = parseClaudeJson('{"is_error":false,"session_id":"s1","result":"plan body"}');
  assert.deepEqual(good, { ok: true, body: 'plan body', sessionId: 's1' });
});

// ── Session lifecycle ────────────────────────────────────────────────────────

test('first planner call spawns claude -p with --agent and a minted --session-id', () => {
  const { dir, run, argvLog } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    const r = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.resumed, false, 'first call is not a resume');
    assert.equal(json.body, '## Task 1: do the thing');

    const argv = argvLog();
    assert.equal(argv[0], '-p');
    assert.equal(argv[1], '--session-id');
    assert.match(argv[2], /^[0-9a-f-]{36}$/, 'minted session id should be a uuid');
    assert.equal(argv[3], '--agent');
    assert.equal(argv[4], PLANNER_AGENT);
    assert.deepEqual(argv.slice(5, 9), ['--permission-mode', 'auto', '--output-format', 'json']);

    // The session id is persisted for the next round of the same workflow.
    assert.equal(readFileSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth')), 'utf8').trim(), json.sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the second call for the same slug resumes the SAME session id', () => {
  const { dir, run, argvLog } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    const first = JSON.parse(run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt').stdout);
    const second = JSON.parse(run('--workflow', '20260902-0100-add-oauth', '--prompt-file', 'prompt.txt').stdout);

    assert.equal(second.ok, true);
    assert.equal(second.resumed, true, 'second call must resume');
    assert.equal(second.sessionId, first.sessionId, 'same workflow keeps one session');

    const argv = argvLog();
    assert.equal(argv[1], '--resume');
    assert.equal(argv[2], first.sessionId);
    assert.equal(argv[3], '--agent', '--agent must be re-passed on resume');
    assert.equal(argv[4], PLANNER_AGENT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('different planning workflows do not share a session id', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    const a = JSON.parse(run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt').stdout);
    const b = JSON.parse(run('--workflow', '20260902-0200-other-task', '--start', '--prompt-file', 'prompt.txt').stdout);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(b.resumed, false, 'a separate workflow starts fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--end discards the session so the next call for that slug starts fresh', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    const first = JSON.parse(run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt').stdout);
    const ended = run('--workflow', '20260902-0100-add-oauth', '--end');
    assert.equal(ended.status, 0);
    assert.equal(JSON.parse(ended.stdout).ended, true);
    assert.equal(existsSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth'))), false);

    const after = JSON.parse(run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt').stdout);
    assert.equal(after.resumed, false);
    assert.notEqual(after.sessionId, first.sessionId);

    // Ending an unknown slug is a no-op, not an error.
    assert.equal(run('--workflow', '20260902-0300-never-started', '--end').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Recursion guard ──────────────────────────────────────────────────────────

test('the child planner gets HYPERCLAUDE_ROLE=planner in its environment', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt');
    assert.equal(readFileSync(path.join(dir, 'role.log'), 'utf8').trim(), 'planner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the SessionStart router is skipped under HYPERCLAUDE_ROLE but injected without it', () => {
  const withoutRole = spawnSync('node', [HOOK], { input: '{}', encoding: 'utf8' });
  assert.equal(withoutRole.status, 0);
  assert.match(withoutRole.stdout, /additionalContext/, 'a normal session still gets the router');

  const withRole = spawnSync('node', [HOOK], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, HYPERCLAUDE_ROLE: 'planner' },
  });
  assert.equal(withRole.status, 0);
  assert.equal(withRole.stdout.trim(), '', 'a hyperclaude child gets no router injection');
});

// ── Failure propagation ──────────────────────────────────────────────────────

test('a non-zero claude exit propagates as ok:false with exit 1', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_NONZERO);
  try {
    const r = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, false);
    assert.match(json.error, /claude exited 7/);
    assert.match(json.error, /something broke/, 'stderr tail is surfaced');
    // A failed round must not record a session it cannot resume.
    assert.equal(existsSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth'))), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an is_error envelope propagates as ok:false with exit 1', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_IS_ERROR);
  try {
    const r = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, false);
    assert.match(json.error, /permission denial/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable or empty prompt file fails before spawning claude', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    const missing = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'nope.txt');
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stdout).error, /cannot read --prompt-file/);

    writeFileSync(path.join(dir, 'blank.txt'), '   \n');
    const empty = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'blank.txt');
    assert.equal(empty.status, 1);
    assert.match(JSON.parse(empty.stdout).error, /is empty/);

    assert.equal(existsSync(path.join(dir, 'argv.log')), false, 'claude should never have been spawned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Regression: workflow isolation is keyed on more than the slug ────────────

test('two workflows that derived the SAME slug still get different sessions', () => {
  // Slugs come from the first few task words, so distinct tasks collide often.
  // The key is the plan-file stem, whose timestamp is what separates them.
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    const a = JSON.parse(run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt').stdout);
    const b = JSON.parse(run('--workflow', '20260902-0945-add-oauth', '--start', '--prompt-file', 'prompt.txt').stdout);
    assert.equal(b.resumed, false, 'a same-slug, later workflow must not resume the earlier one');
    assert.notEqual(a.sessionId, b.sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--workflow rejects a key that would escape the session directory', () => {
  assert.throws(() => parseArgs(['--workflow', '../../etc/passwd', '--prompt-file', 'p.txt']), /--workflow must match/);
  // A long-but-valid key is accepted: the charset is the guard, not an
  // arbitrary cap the unchanged slug/path logic could trip over.
  assert.equal(parseArgs(['--workflow', 'a'.repeat(200), '--prompt-file', 'p.txt']).workflow, 'a'.repeat(200));
});

// ── Cancellation ─────────────────────────────────────────────────────────────

test('SIGTERM stops the child and terminates the bridge by signal, not exit 1', async () => {
  const { dir } = workspace(MOCK_CLAUDE_SLOW);
  try {
    const child = spawn('node', [PLANNER_BRIDGE, '--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt'], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Wait for the mock to actually be running before signalling.
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (existsSync(path.join(dir, 'ready.log'))) { clearInterval(poll); resolve(); }
        else if (Date.now() - started > 15000) { clearInterval(poll); reject(new Error('mock claude never started')); }
      }, 50);
    });
    const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const { code, signal } = await done;

    assert.equal(signal, 'SIGTERM', `bridge should die by signal, got code=${code} signal=${signal}`);
    assert.equal(readFileSync(path.join(dir, 'killed.log'), 'utf8'), 'killed', 'the child must receive the forwarded signal');
    // A cancelled round must not leave a session id behind.
    assert.equal(existsSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth'))), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Session cleanup failures are reported, not swallowed ────────────────────

test('--end reports a cleanup that did not happen instead of claiming success', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    // A directory at the session path makes unlink fail with something other
    // than ENOENT, standing in for a permissions or lock failure.
    mkdirSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth')), { recursive: true });
    const r = run('--workflow', '20260902-0100-add-oauth', '--end');
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, false);
    assert.match(json.error, /cannot discard session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Failure envelopes say whether the planner could have written anything ───

test('the failure envelope distinguishes a pre-spawn failure from a post-spawn one', () => {
  const nonzero = workspace(MOCK_CLAUDE_NONZERO);
  try {
    const after = JSON.parse(nonzero.run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt').stdout);
    assert.equal(after.spawned, true, 'a non-zero exit happened AFTER claude ran — the plan may be mutated');
  } finally {
    rmSync(nonzero.dir, { recursive: true, force: true });
  }

  const good = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    const before = JSON.parse(good.run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'nope.txt').stdout);
    assert.equal(before.spawned, false, 'an unreadable prompt fails before claude runs');
  } finally {
    rmSync(good.dir, { recursive: true, force: true });
  }
});

test('an unrelated HYPERCLAUDE_ROLE value still injects the router', () => {
  const other = spawnSync('node', [HOOK], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, HYPERCLAUDE_ROLE: 'something-else' },
  });
  assert.equal(other.status, 0);
  assert.match(other.stdout, /additionalContext/, 'only the planner role suppresses the router');
});

// ── Reservation is atomic and pre-spawn ─────────────────────────────────────

test('the workflow key is reserved BEFORE claude is spawned', () => {
  // Two runs that resolved the same key must not each mint a session and then
  // overwrite each other's mapping, so the claim happens before the child runs.
  const { dir, run } = workspace(MOCK_CLAUDE_RESERVATION_CHECK);
  try {
    const r = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(readFileSync(path.join(dir, 'reservation.log'), 'utf8'), 'reserved');
    // claude's own session_id wins over the minted one.
    assert.equal(readFileSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth')), 'utf8').trim(), 'sid-from-claude');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a --start that collides with an existing key refuses instead of joining it', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    // Stand in for another workflow having already claimed the key. Joining it
    // would put two distinct planning tasks in one conversation, and either
    // task's --end would then delete the other's mapping.
    mkdirSync(path.join(dir, '.hyperclaude', 'planner-sessions'), { recursive: true });
    writeFileSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth')), 'other-workflow-session\n');

    const r = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout);
    assert.equal(json.spawned, false, 'a colliding start must not run a planner');
    assert.match(json.error, /already in use/);
    assert.equal(existsSync(path.join(dir, 'argv.log')), false);
    // The other workflow's mapping is untouched.
    assert.equal(readFileSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth')), 'utf8').trim(), 'other-workflow-session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a continue with no session refuses rather than silently planning anew', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    const r = run('--workflow', '20260902-0100-add-oauth', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout);
    assert.equal(json.spawned, false);
    assert.match(json.error, /no planner session/);
    assert.equal(existsSync(path.join(dir, 'argv.log')), false, 'a findings-only prompt must never start a fresh planner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Unreadable session state never silently starts a fresh planner ──────────

test('an unreadable session fails before spawning rather than planning from scratch', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    // A directory where the id file belongs: readable path, unreadable content.
    mkdirSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth')), { recursive: true });
    const r = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, false);
    assert.equal(json.spawned, false, 'the planner must not have run');
    assert.match(json.error, /cannot read session state/);
    assert.equal(existsSync(path.join(dir, 'argv.log')), false, 'claude should never have been spawned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed session id is an error, not a fresh start', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  try {
    mkdirSync(path.join(dir, '.hyperclaude', 'planner-sessions'), { recursive: true });
    writeFileSync(path.join(dir, sessionPathFor('20260902-0100-add-oauth')), '   \n');
    const r = run('--workflow', '20260902-0100-add-oauth', '--start', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).spawned, false);
    assert.match(JSON.parse(r.stdout).error, /empty or malformed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Cancelling a RESUMED round must not leak the mapping ────────────────────

test('cancelling a resumed round removes the session it can no longer close', async () => {
  // After a Ctrl-C the lead is gone, so nobody is left to run the skill's STOP
  // cleanup — and a re-run resolves a new key, so a retained mapping is one
  // nothing can ever resume.
  const { dir } = workspace(MOCK_CLAUDE_SLOW);
  const key = '20260902-0100-add-oauth';
  try {
    mkdirSync(path.join(dir, '.hyperclaude', 'planner-sessions'), { recursive: true });
    writeFileSync(path.join(dir, sessionPathFor(key)), 'established-session\n');

    const child = spawn('node', [PLANNER_BRIDGE, '--workflow', key, '--prompt-file', 'prompt.txt'], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (existsSync(path.join(dir, 'ready.log'))) { clearInterval(poll); resolve(); }
        else if (Date.now() - started > 15000) { clearInterval(poll); reject(new Error('mock claude never started')); }
      }, 50);
    });
    const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const { signal } = await done;

    assert.equal(signal, 'SIGTERM');
    assert.equal(readFileSync(path.join(dir, 'argv.log'), 'utf8').split('\n')[1], '--resume', 'this was a resumed round');
    assert.equal(existsSync(path.join(dir, sessionPathFor(key))), false, 'a cancelled resumed round must clean up its mapping');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('releasing never deletes a mapping another workflow owns', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_NONZERO);
  const key = '20260902-0100-add-oauth';
  try {
    // A failed CONTINUE must leave the established mapping alone: only a failed
    // --start owns the id it just minted.
    mkdirSync(path.join(dir, '.hyperclaude', 'planner-sessions'), { recursive: true });
    writeFileSync(path.join(dir, sessionPathFor(key)), 'established-session\n');

    const r = run('--workflow', key, '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 1);
    assert.equal(readFileSync(path.join(dir, sessionPathFor(key)), 'utf8').trim(), 'established-session',
      'a failed revise must not discard the still-valid session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed --start surfaces a cleanup failure instead of hiding stale state', () => {
  const { dir, run } = workspace(MOCK_CLAUDE_NONZERO);
  const key = '20260902-0100-add-oauth';
  try {
    // Covers the wiring: a failed start releases what it minted, and the
    // envelope carries a cleanup field only when that release fails. Forcing a
    // real unlink failure is not portable, so the failing branch is unasserted.
    mkdirSync(path.join(dir, '.hyperclaude', 'planner-sessions'), { recursive: true });
    const r = run('--workflow', key, '--start', '--prompt-file', 'prompt.txt');
    assert.equal(r.status, 1);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, false);
    // The reservation WAS removable here, so no cleanup field — the point of
    // this test is that the field is wired to the branch at all.
    assert.equal(existsSync(path.join(dir, sessionPathFor(key))), false, 'a failed start releases what it minted');
    assert.equal('cleanup' in json, false, 'no cleanup field when cleanup succeeded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The prompt travels over stdin ───────────────────────────────────────────

test('the prompt is piped to claude, never placed in argv', () => {
  const { dir, run, argvLog } = workspace(MOCK_CLAUDE_SUCCESS);
  const key = '20260902-0100-add-oauth';
  try {
    run('--workflow', key, '--start', '--prompt-file', 'prompt.txt');
    const argv = argvLog();
    assert.equal(argv.includes('--'), false, 'no separator needed once nothing positional is passed');
    assert.equal(argv.some((a) => a.includes('Decompose')), false, 'prompt text must not appear in argv');
    assert.equal(readFileSync(path.join(dir, 'stdin.log'), 'utf8'), 'Decompose: add OAuth login\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a revise prompt starting with a hyphen reaches claude intact', () => {
  // Revise prompts open with verbatim Codex findings ("- **Major** …"). As a
  // positional the CLI read that as a flag; piped, it is just text.
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  const key = '20260902-0100-add-oauth';
  try {
    const findings = '- **Major** — scripts/x.mjs:1 — do the thing\n';
    writeFileSync(path.join(dir, 'findings.txt'), findings);
    assert.equal(run('--workflow', key, '--start', '--prompt-file', 'prompt.txt').status, 0);

    const r = run('--workflow', key, '--prompt-file', 'findings.txt');
    assert.equal(r.status, 0, `hyphen-leading prompt failed: ${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(path.join(dir, 'stdin.log'), 'utf8'), findings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a large prompt is not bounded by the platform argv limit', () => {
  // Step 2 inlines whole research artifacts, so the prompt is unbounded.
  const { dir, run } = workspace(MOCK_CLAUDE_SUCCESS);
  const key = '20260902-0100-add-oauth';
  try {
    const big = 'x'.repeat(1024 * 1024) + '\n'; // over a typical ARG_MAX
    writeFileSync(path.join(dir, 'big.txt'), big);
    const r = run('--workflow', key, '--start', '--prompt-file', 'big.txt');
    assert.equal(r.status, 0, `a 1MB prompt must survive: ${r.stderr.slice(0, 200)}`);
    assert.equal(readFileSync(path.join(dir, 'stdin.log'), 'utf8').length, big.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the planner is launched with a permission mode that can satisfy write-file mode', () => {
  // Measured against the real CLI: `default` blocks every write to the plan path,
  // `acceptEdits` writes it but denies the planner's Bash inspection, and `auto`
  // does both with zero denials — the narrowest mode that satisfies the whole
  // contract, deny rules still honoured.
  for (const resume of [false, true]) {
    const argv = buildClaudeArgv({ sessionId: 'sid-1', resume });
    const i = argv.indexOf('--permission-mode');
    assert.ok(i > 0, `${resume ? 'resumed' : 'fresh'} argv must set a permission mode`);
    assert.equal(argv[i + 1], 'auto');
  }
});
