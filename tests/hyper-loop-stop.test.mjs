import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'hyper-loop-stop.mjs');

function newProjectDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hcl-stop-'));
  mkdirSync(path.join(dir, '.hyperclaude', 'plans'), { recursive: true });
  return dir;
}

function writeState(projectDir, slug, sessionId, fields) {
  const loopsDir = path.join(projectDir, '.hyperclaude', 'loops');
  mkdirSync(loopsDir, { recursive: true });
  const stateFile = path.join(loopsDir, `${slug}__${sessionId}.json`);
  writeFileSync(stateFile, JSON.stringify({ session_id: sessionId, ...fields }));
  return stateFile;
}

function writePlan(projectDir, slug, content) {
  const planPath = path.join(projectDir, '.hyperclaude', 'plans', `20260101-0000-${slug}.md`);
  writeFileSync(planPath, content);
  return planPath;
}

function runHook({ sessionId, projectDir }) {
  const stdin = JSON.stringify({ session_id: sessionId, cwd: projectDir });
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

function readState(stateFile) {
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

// Test 1: no loops dir — pass-through
test('no loops dir', () => {
  const projectDir = newProjectDir();
  // Do NOT create .hyperclaude/loops
  const result = runHook({ sessionId: 'sess-1', projectDir });
  assert.equal(result.status, 0, 'hook should exit 0');
  assert.ok(result.parsed, 'should produce JSON output');
  assert.equal(result.parsed.continue, true, 'should be pass-through');
  assert.equal(result.parsed.suppressOutput, true, 'should suppress output');
  assert.equal(result.parsed.decision, undefined, 'should have no decision');
});

// Test 2: loops dir empty — pass-through
test('loops dir empty', () => {
  const projectDir = newProjectDir();
  mkdirSync(path.join(projectDir, '.hyperclaude', 'loops'), { recursive: true });
  const result = runHook({ sessionId: 'sess-2', projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.continue, true);
  assert.equal(result.parsed.suppressOutput, true);
  assert.equal(result.parsed.decision, undefined);
});

// Test 3: state active: false — pass-through
test('state active: false', () => {
  const projectDir = newProjectDir();
  const sessionId = 'sess-3';
  const planPath = writePlan(projectDir, 'myplan', '- [ ] task\n');
  writeState(projectDir, 'myslug', sessionId, {
    active: false,
    iteration: 1,
    max: 10,
    plan_path: planPath,
  });
  const result = runHook({ sessionId, projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.continue, true);
  assert.equal(result.parsed.decision, undefined);
});

// Test 4: mismatched session_id — pass-through
test('state mismatched session_id', () => {
  const projectDir = newProjectDir();
  const planPath = writePlan(projectDir, 'myplan', '- [ ] task\n');
  writeState(projectDir, 'myslug', 'other-session', {
    active: true,
    iteration: 1,
    max: 10,
    plan_path: planPath,
  });
  const result = runHook({ sessionId: 'this-session', projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.continue, true);
  assert.equal(result.parsed.decision, undefined);
});

// Test 5: all tasks checked — block with hyper-code-review, state active: false
test('all checked', () => {
  const projectDir = newProjectDir();
  const sessionId = 'sess-5';
  const planContent = '- [x] one\n  - [x] nested\n';
  const planPath = writePlan(projectDir, 'allchecked', planContent);
  const stateFile = writeState(projectDir, 'allchecked', sessionId, {
    active: true,
    iteration: 3,
    max: 10,
    plan_path: planPath,
  });
  const result = runHook({ sessionId, projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.decision, 'block', 'should block');
  assert.match(result.parsed.reason, /hyper-code-review/, 'reason should mention hyper-code-review');
  const persisted = readState(stateFile);
  assert.equal(persisted.active, false, 'persisted state should be inactive');
});

// Test 6: nested unchecked detected — block with iter 2/10, iteration incremented
test('nested unchecked detected', () => {
  const projectDir = newProjectDir();
  const sessionId = 'sess-6';
  const planContent = '# plan\n  - [ ] nested task\n';
  const planPath = writePlan(projectDir, 'nested', planContent);
  const stateFile = writeState(projectDir, 'nested', sessionId, {
    active: true,
    iteration: 1,
    max: 10,
    plan_path: planPath,
  });
  const result = runHook({ sessionId, projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.decision, 'block');
  assert.match(result.parsed.reason, /\[HYPER-LOOP iter 2\/10\] 1 unchecked/, 'reason should show iter 2/10 with 1 unchecked');
  const persisted = readState(stateFile);
  assert.equal(persisted.iteration, 2, 'iteration should be incremented to 2');
});

// Test 7: max reached — block mentioning max iterations, state active: false
test('max reached', () => {
  const projectDir = newProjectDir();
  const sessionId = 'sess-7';
  const planContent = '- [ ] task one\n- [ ] task two\n';
  const planPath = writePlan(projectDir, 'maxed', planContent);
  const stateFile = writeState(projectDir, 'maxed', sessionId, {
    active: true,
    iteration: 10,
    max: 10,
    plan_path: planPath,
  });
  const result = runHook({ sessionId, projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.decision, 'block');
  assert.match(result.parsed.reason, /max iterations \(10\) reached/, 'reason should mention max iterations (10) reached');
  const persisted = readState(stateFile);
  assert.equal(persisted.active, false, 'persisted state should be inactive');
});

// Test 8: continue — 5 unchecked, iteration advanced, reason mentions hyper-implement and plan path
test('continue', () => {
  const projectDir = newProjectDir();
  const sessionId = 'sess-8';
  const planContent = [
    '- [ ] root task 1',
    '- [ ] root task 2',
    '  - [ ] nested a',
    '- [x] done task',
    '- [ ] root task 3',
    '  - [ ] nested b',
  ].join('\n') + '\n';
  const planPath = writePlan(projectDir, 'continue', planContent);
  const stateFile = writeState(projectDir, 'continue', sessionId, {
    active: true,
    iteration: 2,
    max: 10,
    plan_path: planPath,
  });
  const result = runHook({ sessionId, projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.decision, 'block');
  assert.match(result.parsed.reason, /\[HYPER-LOOP iter 3\/10\] 5 unchecked/, 'reason should show iter 3/10 with 5 unchecked');
  assert.match(result.parsed.reason, /hyperclaude:hyper-implement/, 'reason should mention hyper-implement');
  assert.ok(result.parsed.reason.includes(planPath), 'reason should include the plan path');
  const persisted = readState(stateFile);
  assert.equal(persisted.iteration, 3, 'iteration should be incremented to 3');
  assert.equal(persisted.active, true, 'loop should remain active');
});

// Test 9: plan missing — block with "missing" or "unreadable", state unchanged
test('plan missing', () => {
  const projectDir = newProjectDir();
  const sessionId = 'sess-9';
  const nonExistentPath = '/tmp/never-existed-999999.md';
  const stateFile = writeState(projectDir, 'missing', sessionId, {
    active: true,
    iteration: 1,
    max: 10,
    plan_path: nonExistentPath,
  });
  const stateBefore = readFileSync(stateFile, 'utf8');
  const result = runHook({ sessionId, projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.decision, 'block');
  assert.match(result.parsed.reason, /missing|unreadable/, 'reason should mention missing or unreadable');
  const stateAfter = readFileSync(stateFile, 'utf8');
  assert.equal(stateAfter, stateBefore, 'state file should be unchanged when plan is missing');
});

// Test 10: malformed sibling skipped — valid state's continue branch fires; broken file untouched
test('malformed sibling skipped', () => {
  const projectDir = newProjectDir();
  const sessionId = 'sess-10';
  const loopsDir = path.join(projectDir, '.hyperclaude', 'loops');
  mkdirSync(loopsDir, { recursive: true });

  // Write a syntactically-broken JSON file
  const brokenFile = path.join(loopsDir, 'broken__sess-10.json');
  writeFileSync(brokenFile, '{this is not valid json');

  // Write a valid active state
  const planContent = '- [ ] task\n';
  const planPath = writePlan(projectDir, 'goodstate', planContent);
  const stateFile = writeState(projectDir, 'goodstate', sessionId, {
    active: true,
    iteration: 1,
    max: 5,
    plan_path: planPath,
  });

  const result = runHook({ sessionId, projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.decision, 'block', 'valid state should trigger block');
  assert.match(result.parsed.reason, /\[HYPER-LOOP iter 2\/5\] 1 unchecked/, 'reason from valid state');

  // Broken file should remain untouched
  const brokenAfter = readFileSync(brokenFile, 'utf8');
  assert.equal(brokenAfter, '{this is not valid json', 'broken file should be untouched');
});

// Test 11: multiple active matches — block listing both plan_paths, mentions hyper-loop-cancel
test('multiple active matches', () => {
  const projectDir = newProjectDir();
  const sessionId = 'sess-11';

  const planPath1 = writePlan(projectDir, 'plan-alpha', '- [ ] task\n');
  const planPath2 = writePlan(projectDir, 'plan-beta', '- [ ] task\n');

  writeState(projectDir, 'slug-alpha', sessionId, {
    active: true,
    iteration: 1,
    max: 5,
    plan_path: planPath1,
  });
  writeState(projectDir, 'slug-beta', sessionId, {
    active: true,
    iteration: 1,
    max: 5,
    plan_path: planPath2,
  });

  const result = runHook({ sessionId, projectDir });
  assert.equal(result.status, 0);
  assert.ok(result.parsed);
  assert.equal(result.parsed.decision, 'block', 'should block on multiple active loops');
  assert.ok(
    result.parsed.reason.includes(planPath1),
    'reason should list first plan path'
  );
  assert.ok(
    result.parsed.reason.includes(planPath2),
    'reason should list second plan path'
  );
  assert.match(result.parsed.reason, /hyperclaude:hyper-loop-cancel/, 'reason should mention hyper-loop-cancel');
});

// Test 12: reason strings quote paths with spaces
test('reason strings quote paths with spaces', () => {
  // Create a plan path with spaces by using a directory with spaces in the name.
  // We can use a temp dir that has spaces via a subdirectory.
  const baseDir = mkdtempSync(path.join(tmpdir(), 'hcl-stop-spaces-'));
  const spacedDir = path.join(baseDir, 'path with spaces');
  mkdirSync(path.join(spacedDir, '.hyperclaude', 'plans'), { recursive: true });

  const sessionId = 'sess-12';

  // Sub-test: all-checked branch
  const planContentAllChecked = '- [x] done\n';
  const planPathAllChecked = path.join(spacedDir, '.hyperclaude', 'plans', '20260101-0000-allchecked.md');
  writeFileSync(planPathAllChecked, planContentAllChecked);
  writeState(spacedDir, 'slug-allchecked', sessionId, {
    active: true,
    iteration: 1,
    max: 5,
    plan_path: planPathAllChecked,
  });

  const result1 = runHook({ sessionId, projectDir: spacedDir });
  assert.equal(result1.status, 0);
  assert.ok(result1.parsed);
  assert.equal(result1.parsed.decision, 'block');
  assert.match(result1.parsed.reason, /"[^"]*\s[^"]*"/, 'path with spaces should be quoted in all-checked reason');

  // Sub-test: max-reached branch — need a separate project/state
  const spacedDir2 = path.join(baseDir, 'path with spaces 2');
  mkdirSync(path.join(spacedDir2, '.hyperclaude', 'plans'), { recursive: true });
  const sessionId2 = 'sess-12b';
  const planContentMaxed = '- [ ] remaining\n';
  const planPathMaxed = path.join(spacedDir2, '.hyperclaude', 'plans', '20260101-0000-maxed.md');
  writeFileSync(planPathMaxed, planContentMaxed);
  writeState(spacedDir2, 'slug-maxed', sessionId2, {
    active: true,
    iteration: 5,
    max: 5,
    plan_path: planPathMaxed,
  });

  const result2 = runHook({ sessionId: sessionId2, projectDir: spacedDir2 });
  assert.equal(result2.status, 0);
  assert.ok(result2.parsed);
  assert.equal(result2.parsed.decision, 'block');
  assert.match(result2.parsed.reason, /"[^"]*\s[^"]*"/, 'path with spaces should be quoted in max-reached reason');

  // Sub-test: continue branch
  const spacedDir3 = path.join(baseDir, 'path with spaces 3');
  mkdirSync(path.join(spacedDir3, '.hyperclaude', 'plans'), { recursive: true });
  const sessionId3 = 'sess-12c';
  const planContentContinue = '- [ ] still pending\n';
  const planPathContinue = path.join(spacedDir3, '.hyperclaude', 'plans', '20260101-0000-continue.md');
  writeFileSync(planPathContinue, planContentContinue);
  writeState(spacedDir3, 'slug-continue', sessionId3, {
    active: true,
    iteration: 2,
    max: 10,
    plan_path: planPathContinue,
  });

  const result3 = runHook({ sessionId: sessionId3, projectDir: spacedDir3 });
  assert.equal(result3.status, 0);
  assert.ok(result3.parsed);
  assert.equal(result3.parsed.decision, 'block');
  assert.match(result3.parsed.reason, /"[^"]*\s[^"]*"/, 'path with spaces should be quoted in continue reason');
});
