#!/usr/bin/env node
// Stop hook — fires on every agent stop event to enforce hyper-loop iteration
// budget and checkpoint plan progress. Finds the active loop for the current
// session, counts remaining unchecked tasks, and either advances the iteration
// counter or deactivates the loop when complete or over budget.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const PASS_THROUGH = Object.freeze({ continue: true, suppressOutput: true });

function block(reason) {
  return { decision: 'block', reason };
}

function shellQuote(p) {
  if (/^[A-Za-z0-9._/-]+$/.test(p)) return p;
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// leading \s* is intentional — nested plan checkboxes count toward unchecked.
// (session-start-reminder.mjs uses root-only /^- \[ \]/gm for a different purpose.)
function countUnchecked(content) {
  return (content.match(/^\s*- \[ \]/gm) || []).length;
}

async function findActiveLoopsInSession(loopsDir, sessionId) {
  let entries;
  try {
    entries = await readdir(loopsDir);
  } catch {
    return [];
  }

  const active = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const text = await readFile(join(loopsDir, name), 'utf8');
      const body = JSON.parse(text);
      if (body.session_id === sessionId && body.active === true) {
        active.push({ file: join(loopsDir, name), body });
      }
    } catch {
      // skip malformed files
    }
  }
  return active;
}

function decide(body, uncheckedCount) {
  const { iteration, max, plan_path } = body;
  const q = shellQuote(plan_path);

  if (uncheckedCount === 0) {
    return {
      decision: 'block',
      reason: `[HYPER-LOOP] all plan tasks complete. Run /hyperclaude:hyper-code-review then exit. Plan: ${q}`,
      newBody: { ...body, active: false },
    };
  }

  if (iteration >= max) {
    return {
      decision: 'block',
      reason: `[HYPER-LOOP] max iterations (${max}) reached with ${uncheckedCount} tasks remaining. Cancel: /hyperclaude:hyper-loop-cancel ${q}. Or resume with a fresh /hyperclaude:hyper-loop ${q} --max=<N>.`,
      newBody: { ...body, active: false },
    };
  }

  return {
    decision: 'block',
    reason: `[HYPER-LOOP iter ${iteration + 1}/${max}] ${uncheckedCount} unchecked tasks remain. Continue executing the plan per /hyperclaude:hyper-implement protocol. Plan: ${q}`,
    newBody: { ...body, iteration: iteration + 1 },
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const parsed = JSON.parse(input);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || parsed.cwd || process.cwd();
  const loopsDir = resolve(projectDir, '.hyperclaude', 'loops');

  const matches = await findActiveLoopsInSession(loopsDir, parsed.session_id);

  if (matches.length === 0) {
    process.stdout.write(JSON.stringify(PASS_THROUGH) + '\n');
    return;
  }

  if (matches.length > 1) {
    const examplePath = matches[0].body.plan_path;
    const reason =
      '[HYPER-LOOP] multiple active loops in this session: ' +
      matches.map((m) => shellQuote(m.body.plan_path)).join(', ') +
      '. Cancel all but one with /hyperclaude:hyper-loop-cancel ' + shellQuote(examplePath) + '.';
    process.stdout.write(JSON.stringify(block(reason)) + '\n');
    return;
  }

  const { file, body } = matches[0];

  let planContent;
  try {
    planContent = await readFile(body.plan_path, 'utf8');
  } catch {
    const reason =
      '[HYPER-LOOP] plan file ' + shellQuote(body.plan_path) + ' is missing/unreadable. ' +
      'Run /hyperclaude:hyper-loop-cancel ' + shellQuote(body.plan_path) + ' to clear state.';
    process.stdout.write(JSON.stringify(block(reason)) + '\n');
    return;
  }

  const uncheckedCount = countUnchecked(planContent);
  const { reason, newBody } = decide(body, uncheckedCount);

  if (newBody) {
    await writeFile(file, JSON.stringify(newBody, null, 2) + '\n');
  }

  process.stdout.write(JSON.stringify(block(reason)) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[hyper-loop-stop] ${err?.message ?? err}\n`);
  process.stdout.write(JSON.stringify(PASS_THROUGH) + '\n');
});
