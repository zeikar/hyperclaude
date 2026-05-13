import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'hyper-loop-intake.mjs');

function newProjectDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hcl-intake-'));
  mkdirSync(path.join(dir, '.hyperclaude', 'plans'), { recursive: true });
  return dir;
}

function writePlan(projectDir, name, content = '# plan\n\n- [ ] task\n') {
  const planPath = path.join(projectDir, '.hyperclaude', 'plans', name);
  writeFileSync(planPath, content);
  return planPath;
}

function mkPayload({ sessionId, projectDir, isCancel = false, argString = '' }) {
  return {
    session_id: sessionId,
    cwd: projectDir,
    command_name: isCancel ? 'hyperclaude:hyper-loop-cancel' : 'hyperclaude:hyper-loop',
    command_args: argString,
    expansion_type: 'slash_command',
    command_source: 'plugin',
    prompt: `/hyperclaude:hyper-loop${isCancel ? '-cancel' : ''} ${argString}`,
  };
}

function runHook({ sessionId, projectDir, payload }) {
  const stdin = JSON.stringify(payload);
  const result = spawnSync('node', [HOOK], {
    input: stdin,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    parsed: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
  };
}

function loadStateFiles(projectDir) {
  const loopsDir = path.join(projectDir, '.hyperclaude', 'loops');
  if (!existsSync(loopsDir)) return [];
  return readdirSync(loopsDir).filter(f => f.endsWith('.json')).map(name => {
    const filePath = path.join(loopsDir, name);
    return { name, filePath, body: JSON.parse(readFileSync(filePath, 'utf8')) };
  });
}

// ---------------------------------------------------------------------------
// Test 1: unrelated command — pass-through, no loops dir created
// ---------------------------------------------------------------------------
test('unrelated command', () => {
  const projectDir = newProjectDir();
  const payload = {
    session_id: 'ses-1',
    cwd: projectDir,
    command_name: 'other:thing',
    command_args: '',
    prompt: '/other:thing',
  };
  const { parsed } = runHook({ projectDir, payload });
  assert.equal(parsed.continue, true);
  assert.equal(parsed.suppressOutput, true);
  assert.equal(parsed.decision, undefined);
  const stateFiles = loadStateFiles(projectDir);
  assert.equal(stateFiles.length, 0);
});

// ---------------------------------------------------------------------------
// Test 2: start happy path
// ---------------------------------------------------------------------------
test('start happy path', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const sessionId = 'ses-happy';
  const payload = mkPayload({ sessionId, projectDir, argString: `${planPath} --max=5` });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.continue, true);
  assert.equal(parsed.decision, undefined);

  const stateFiles = loadStateFiles(projectDir);
  assert.equal(stateFiles.length, 1);
  const { body } = stateFiles[0];
  assert.equal(body.active, true);
  assert.equal(body.iteration, 0);
  assert.equal(body.max, 5);
  assert.equal(body.plan_path, planPath);
  assert.equal(body.session_id, sessionId);
});

// ---------------------------------------------------------------------------
// Test 3: start default max
// ---------------------------------------------------------------------------
test('start default max', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const sessionId = 'ses-default-max';
  const payload = mkPayload({ sessionId, projectDir, argString: planPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.continue, true);

  const stateFiles = loadStateFiles(projectDir);
  assert.equal(stateFiles.length, 1);
  assert.equal(stateFiles[0].body.max, 10);
});

// ---------------------------------------------------------------------------
// Test 4: start invalid max=abc
// ---------------------------------------------------------------------------
test('start invalid max=abc', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const sessionId = 'ses-inv-max-abc';
  const payload = mkPayload({ sessionId, projectDir, argString: `${planPath} --max=abc` });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /max/i);
});

// ---------------------------------------------------------------------------
// Test 5: start invalid max=0
// ---------------------------------------------------------------------------
test('start invalid max=0', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const sessionId = 'ses-inv-max-0';
  const payload = mkPayload({ sessionId, projectDir, argString: `${planPath} --max=0` });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /max/i);
});

// ---------------------------------------------------------------------------
// Test 6: start invalid max=1001
// ---------------------------------------------------------------------------
test('start invalid max=1001', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const sessionId = 'ses-inv-max-1001';
  const payload = mkPayload({ sessionId, projectDir, argString: `${planPath} --max=1001` });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /max/i);
});

// ---------------------------------------------------------------------------
// Test 7: start duplicate --max
// ---------------------------------------------------------------------------
test('start duplicate --max', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const sessionId = 'ses-dup-max';
  const payload = mkPayload({ sessionId, projectDir, argString: `${planPath} --max=5 --max=6` });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /--max/);
});

// ---------------------------------------------------------------------------
// Test 8: start unknown flag
// ---------------------------------------------------------------------------
test('start unknown flag', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const sessionId = 'ses-unk-flag';
  const payload = mkPayload({ sessionId, projectDir, argString: `${planPath} --foo=bar` });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /unknown flag/);
});

// ---------------------------------------------------------------------------
// Test 9: start missing plan-path
// ---------------------------------------------------------------------------
test('start missing plan-path', () => {
  const projectDir = newProjectDir();
  const sessionId = 'ses-no-path';
  const payload = mkPayload({ sessionId, projectDir, argString: '' });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /plan-path/);
});

// ---------------------------------------------------------------------------
// Test 10: start plan file missing
// ---------------------------------------------------------------------------
test('start plan file missing', () => {
  const projectDir = newProjectDir();
  const sessionId = 'ses-plan-missing';
  const nonExistentPath = path.join(projectDir, '.hyperclaude', 'plans', 'no-such-plan.md');
  const payload = mkPayload({ sessionId, projectDir, argString: nonExistentPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /not found/i);
});

// ---------------------------------------------------------------------------
// Test 11: quoted plan path
// ---------------------------------------------------------------------------
test('quoted plan path', () => {
  const projectDir = newProjectDir();
  const spacyDir = path.join(projectDir, '.hyperclaude', 'plans', 'path with spaces');
  mkdirSync(spacyDir, { recursive: true });
  const planPath = path.join(spacyDir, 'plan.md');
  writeFileSync(planPath, '# plan\n\n- [ ] task\n');
  const sessionId = 'ses-quoted';
  const payload = mkPayload({ sessionId, projectDir, argString: `"${planPath}"` });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.continue, true);
  assert.equal(parsed.decision, undefined);

  const stateFiles = loadStateFiles(projectDir);
  assert.equal(stateFiles.length, 1);
  assert.equal(stateFiles[0].body.plan_path, planPath);
});

// ---------------------------------------------------------------------------
// Test 12: tokenizer error (unclosed quote)
// ---------------------------------------------------------------------------
test('tokenizer error', () => {
  const projectDir = newProjectDir();
  const sessionId = 'ses-tokenize-err';
  const payload = mkPayload({ sessionId, projectDir, argString: '"unclosed' });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /unclosed|tokeniz/i);
});

// ---------------------------------------------------------------------------
// Test 13: session_id missing
// ---------------------------------------------------------------------------
test('session_id missing', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const payload = mkPayload({ sessionId: '', projectDir, argString: planPath });
  const { parsed } = runHook({ sessionId: '', projectDir, payload });
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /session_id missing/);
});

// ---------------------------------------------------------------------------
// Test 14: start refuse when another loop active in session
// ---------------------------------------------------------------------------
test('start refuse when another loop active in session', () => {
  const projectDir = newProjectDir();
  const sessionId = 'ses-conflict';
  const safeSid = sessionId; // no unsafe chars

  // Write an existing state file for a DIFFERENT plan with the same session_id
  const otherPlanPath = writePlan(projectDir, '20260513-1000-other-plan.md');
  const otherSlug = 'other-plan';
  const loopsDir = path.join(projectDir, '.hyperclaude', 'loops');
  mkdirSync(loopsDir, { recursive: true });
  const otherStateFile = path.join(loopsDir, `${otherSlug}__${safeSid}.json`);
  const otherState = {
    active: true,
    iteration: 0,
    max: 10,
    plan_path: otherPlanPath,
    session_id: sessionId,
    started_at: new Date().toISOString(),
  };
  writeFileSync(otherStateFile, JSON.stringify(otherState, null, 2) + '\n');

  // Now try to start a new loop for a different plan
  const newPlanPath = writePlan(projectDir, '20260513-1200-new-plan.md');
  const payload = mkPayload({ sessionId, projectDir, argString: newPlanPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });

  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.match(parsed.reason, /another loop is already active/);

  // No new state file created for the new plan
  const stateFiles = loadStateFiles(projectDir);
  assert.equal(stateFiles.length, 1); // only the original
  assert.equal(stateFiles[0].body.plan_path, otherPlanPath);
});

// ---------------------------------------------------------------------------
// Test 15: start same slug restart
// ---------------------------------------------------------------------------
test('start same slug restart', () => {
  const projectDir = newProjectDir();
  const sessionId = 'ses-restart';

  // Pre-write active state for the same plan with iteration=5
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const loopsDir = path.join(projectDir, '.hyperclaude', 'loops');
  mkdirSync(loopsDir, { recursive: true });
  const safeSlug = 'my-plan';
  const safeSid = sessionId;
  const stateFile = path.join(loopsDir, `${safeSlug}__${safeSid}.json`);
  const existingState = {
    active: true,
    iteration: 5,
    max: 10,
    plan_path: planPath,
    session_id: sessionId,
    started_at: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(existingState, null, 2) + '\n');

  // Run start again for same plan
  const payload = mkPayload({ sessionId, projectDir, argString: planPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.continue, true);
  assert.equal(parsed.decision, undefined);

  const stateFiles = loadStateFiles(projectDir);
  assert.equal(stateFiles.length, 1);
  assert.equal(stateFiles[0].body.active, true);
  assert.equal(stateFiles[0].body.iteration, 0); // reset to 0
});

// ---------------------------------------------------------------------------
// Test 16: cancel existing
// ---------------------------------------------------------------------------
test('cancel existing', () => {
  const projectDir = newProjectDir();
  const sessionId = 'ses-cancel';

  // Pre-write active state file
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const loopsDir = path.join(projectDir, '.hyperclaude', 'loops');
  mkdirSync(loopsDir, { recursive: true });
  const safeSlug = 'my-plan';
  const safeSid = sessionId;
  const stateFile = path.join(loopsDir, `${safeSlug}__${safeSid}.json`);
  const activeState = {
    active: true,
    iteration: 3,
    max: 10,
    plan_path: planPath,
    session_id: sessionId,
    started_at: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(activeState, null, 2) + '\n');

  const payload = mkPayload({ sessionId, projectDir, isCancel: true, argString: planPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.continue, true);
  assert.equal(parsed.decision, undefined);

  // State file still exists, but active is now false
  assert.equal(existsSync(stateFile), true);
  const body = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(body.active, false);
});

// ---------------------------------------------------------------------------
// Test 17: cancel non-existent
// ---------------------------------------------------------------------------
test('cancel non-existent', () => {
  const projectDir = newProjectDir();
  const sessionId = 'ses-cancel-none';
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');

  // No state file pre-created
  const payload = mkPayload({ sessionId, projectDir, isCancel: true, argString: planPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });

  // Should be success, NOT a block
  assert.equal(parsed.continue, true);
  assert.equal(parsed.decision, undefined);
  // additionalContext mentions "no active hyper-loop found"
  assert.match(parsed.hookSpecificOutput.additionalContext, /no active hyper-loop found/);
});

// ---------------------------------------------------------------------------
// Test 18: cancel with missing plan file
// ---------------------------------------------------------------------------
test('cancel with missing plan file', () => {
  const projectDir = newProjectDir();
  const sessionId = 'ses-cancel-missing-plan';

  // Pre-write active state referencing a plan that no longer exists
  const nonExistentPlanPath = path.join(projectDir, '.hyperclaude', 'plans', '20260513-1200-gone-plan.md');
  const loopsDir = path.join(projectDir, '.hyperclaude', 'loops');
  mkdirSync(loopsDir, { recursive: true });
  const safeSlug = 'gone-plan';
  const safeSid = sessionId;
  const stateFile = path.join(loopsDir, `${safeSlug}__${safeSid}.json`);
  const activeState = {
    active: true,
    iteration: 2,
    max: 10,
    plan_path: nonExistentPlanPath,
    session_id: sessionId,
    started_at: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(activeState, null, 2) + '\n');

  // Cancel with that missing plan path
  const payload = mkPayload({ sessionId, projectDir, isCancel: true, argString: nonExistentPlanPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });

  // Should succeed (cancel doesn't check file existence)
  assert.equal(parsed.continue, true);
  assert.equal(parsed.decision, undefined);

  // State body should now have active: false
  const body = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(body.active, false);
});

// ---------------------------------------------------------------------------
// Test 19: session isolation
// ---------------------------------------------------------------------------
test('session isolation', () => {
  const projectDir = newProjectDir();
  const sessionA = 'ses-A';
  const sessionB = 'ses-B';

  // Pre-write active state for session A
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const loopsDir = path.join(projectDir, '.hyperclaude', 'loops');
  mkdirSync(loopsDir, { recursive: true });
  const safeSlug = 'my-plan';
  const stateFileA = path.join(loopsDir, `${safeSlug}__${sessionA}.json`);
  const activeStateA = {
    active: true,
    iteration: 1,
    max: 10,
    plan_path: planPath,
    session_id: sessionA,
    started_at: new Date().toISOString(),
  };
  writeFileSync(stateFileA, JSON.stringify(activeStateA, null, 2) + '\n');

  // Run cancel with session B — should be a no-op success
  const payload = mkPayload({ sessionId: sessionB, projectDir, isCancel: true, argString: planPath });
  const { parsed } = runHook({ sessionId: sessionB, projectDir, payload });
  assert.equal(parsed.continue, true);
  assert.equal(parsed.decision, undefined);

  // Session A's state file untouched (still active: true)
  const bodyA = JSON.parse(readFileSync(stateFileA, 'utf8'));
  assert.equal(bodyA.active, true);
});

// ---------------------------------------------------------------------------
// Test 20: sanitized filename
// ---------------------------------------------------------------------------
test('sanitized filename', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');

  // session_id with unsafe chars: "a/b\c"
  const sessionId = 'a/b\\c';
  const payload = mkPayload({ sessionId, projectDir, argString: planPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.continue, true);

  const stateFiles = loadStateFiles(projectDir);
  assert.equal(stateFiles.length, 1);
  // Each unsafe char becomes _, collapsed via _+
  assert.match(stateFiles[0].name, /^my-plan__a_b_c\.json$/);

  // Also test a//b collapses to a_b (not a__b)
  const projectDir2 = newProjectDir();
  const planPath2 = writePlan(projectDir2, '20260513-1200-my-plan.md');
  const sessionId2 = 'a//b';
  const payload2 = mkPayload({ sessionId: sessionId2, projectDir: projectDir2, argString: planPath2 });
  const { parsed: parsed2 } = runHook({ sessionId: sessionId2, projectDir: projectDir2, payload: payload2 });
  assert.equal(parsed2.continue, true);

  const stateFiles2 = loadStateFiles(projectDir2);
  assert.equal(stateFiles2.length, 1);
  // a//b → a_b (not a__b — double slash collapses)
  assert.match(stateFiles2[0].name, /^my-plan__a_b\.json$/);
  assert.doesNotMatch(stateFiles2[0].name, /a__b/);
});

// ---------------------------------------------------------------------------
// Test 21: long-slug truncation appends hash
// ---------------------------------------------------------------------------
test('long-slug truncation appends hash', () => {
  // Slug is derived from plan filename slug (after stripping YYYYMMDD-HHMM- prefix)
  // Need a slug part > 60 chars
  const longSlugBase = 'a'.repeat(65);
  const longSlugBase2 = 'a'.repeat(64) + 'b'; // differs after char 60

  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, `20260513-1200-${longSlugBase}.md`);
  const sessionId = 'ses-longslug';
  const payload = mkPayload({ sessionId, projectDir, argString: planPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });
  assert.equal(parsed.continue, true);

  const stateFiles = loadStateFiles(projectDir);
  assert.equal(stateFiles.length, 1);
  const filename = stateFiles[0].name;
  // Should be truncated at 60 chars + '-' + 8 hex chars
  assert.match(filename, /^.{60}-[0-9a-f]{8}__ses-longslug\.json$/);

  // Second plan whose slug shares first 60 chars but differs after
  const projectDir2 = newProjectDir();
  const planPath2 = writePlan(projectDir2, `20260513-1200-${longSlugBase2}.md`);
  const sessionId2 = 'ses-longslug';
  const payload2 = mkPayload({ sessionId: sessionId2, projectDir: projectDir2, argString: planPath2 });
  const { parsed: parsed2 } = runHook({ sessionId: sessionId2, projectDir: projectDir2, payload: payload2 });
  assert.equal(parsed2.continue, true);

  const stateFiles2 = loadStateFiles(projectDir2);
  assert.equal(stateFiles2.length, 1);
  const filename2 = stateFiles2[0].name;

  // Filenames should differ (different hash suffixes)
  assert.notEqual(filename, filename2);
});

// ---------------------------------------------------------------------------
// Test 22: target-command IO failure blocks
// ---------------------------------------------------------------------------
test('target-command IO failure blocks', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, '20260513-1200-my-plan.md');
  const sessionId = 'ses-io-fail';

  // Create .hyperclaude/loops as a regular FILE, not a directory
  const loopsPath = path.join(projectDir, '.hyperclaude', 'loops');
  writeFileSync(loopsPath, 'i am a file not a dir');

  const payload = mkPayload({ sessionId, projectDir, argString: planPath });
  const { parsed } = runHook({ sessionId, projectDir, payload });

  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  // reason should mention IO/filesystem error
  assert.match(parsed.reason, /cannot create loops directory|IO|filesystem|ENOTDIR|EEXIST/i);
});
