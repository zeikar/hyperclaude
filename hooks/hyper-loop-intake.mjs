#!/usr/bin/env node
// UserPromptExpansion hook — intercepts /hyperclaude:hyper-loop and
// /hyperclaude:hyper-loop-cancel slash commands to validate args and
// write/update a state file in .hyperclaude/loops/ before the skill runs.
// Non-matching prompts are passed through silently (suppressOutput).

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';

// Matches hyperclaude's plan filename convention: YYYYMMDD-HHMM-<slug>.md
const PLAN_FILENAME_RE = /^\d{8}-\d{4}-(.+)\.md$/;

// Accept both "hyperclaude:hyper-loop" (plugin-namespaced) and "hyper-loop" (bare).
const LOOP_START_NAMES = new Set(['hyperclaude:hyper-loop', 'hyper-loop']);
const LOOP_CANCEL_NAMES = new Set(['hyperclaude:hyper-loop-cancel', 'hyper-loop-cancel']);

// Fallback for UserPromptSubmit (no command_name field).
const PROMPT_RE = /^\s*\/(?:hyperclaude:)?hyper-loop(-cancel)?\b/;

function toSafeSlug(v) {
  let s = String(v).replace(/[^A-Za-z0-9._-]/g, '_');
  s = s.replace(/_+/g, '_');
  if (s.length > 60) {
    s = s.slice(0, 60) + '-' + createHash('sha256').update(String(v)).digest('hex').slice(0, 8);
  }
  return s;
}

function shellQuote(p) {
  if (/^[A-Za-z0-9._/-]+$/.test(p)) return p;
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Minimal shell-like tokenizer: whitespace-separated; double-quoted segments
// collapse into one token; single quotes are literal. Throws on unclosed quote.
function tokenize(argString) {
  const tokens = [];
  let i = 0;
  const s = argString;
  while (i < s.length) {
    // skip whitespace
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    let token = '';
    while (i < s.length && !/\s/.test(s[i])) {
      if (s[i] === '"') {
        i++; // consume opening quote
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length && (s[i + 1] === '"' || s[i + 1] === '\\')) {
            i++;
          }
          token += s[i++];
        }
        if (i >= s.length) throw new Error('unclosed double quote in arguments');
        i++; // consume closing quote
      } else {
        token += s[i++];
      }
    }
    tokens.push(token);
  }
  return tokens;
}

// Parse tokens into {planPath, max} for start, or {planPath} for cancel.
function parseArgs(tokens, isCancel) {
  if (tokens.length === 0) {
    return { error: 'plan-path is required' };
  }

  const positional = [];
  let max = 10;
  let maxSeen = false;

  for (const tok of tokens) {
    const maxMatch = tok.match(/^--max=([1-9]\d*)$/);
    if (maxMatch) {
      if (isCancel) return { error: `unknown flag: ${tok}` };
      if (maxSeen) return { error: '--max specified more than once' };
      maxSeen = true;
      const n = Number(maxMatch[1]);
      if (n > 1000) return { error: `--max=${n} exceeds maximum allowed value of 1000` };
      max = n;
    } else if (tok.startsWith('--')) {
      return { error: `unknown flag: ${tok}` };
    } else {
      positional.push(tok);
    }
  }

  if (positional.length === 0) return { error: 'plan-path is required' };
  if (positional.length > 1) return { error: `unexpected extra argument: ${positional[1]}` };

  if (isCancel && maxSeen) return { error: '--max is not valid for hyper-loop-cancel' };

  return { planPath: positional[0], max };
}

function deriveSlug(planPath) {
  const base = basename(planPath);
  const m = base.match(PLAN_FILENAME_RE);
  const raw = m ? m[1] : base.replace(/\.md$/, '');
  return toSafeSlug(raw);
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
      // raw session_id, not safeSid — bodies hold raw
      if (body.session_id === sessionId && body.active === true) {
        active.push(body);
      }
    } catch {
      // skip malformed
    }
  }
  return active;
}

function block(reason) {
  return { decision: 'block', reason };
}

const PASS_THROUGH = Object.freeze({ continue: true, suppressOutput: true });

function success(hookEventName, additionalContext) {
  return {
    continue: true,
    hookSpecificOutput: { hookEventName, additionalContext },
  };
}

// Returns { ok: true, additionalContext } or { ok: false, reason }.
async function handleStart(parsed, planPath, max, loopsDir) {
  const absPath = resolve(parsed.cwd || process.cwd(), planPath);

  try {
    await readFile(absPath);
  } catch {
    return { ok: false, reason: `plan file not found: ${absPath}` };
  }

  try {
    await mkdir(loopsDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `cannot create loops directory: ${err.message}` };
  }

  const rawSessionId = parsed.session_id || '';
  const safeSid = toSafeSlug(rawSessionId);
  if (!safeSid) return { ok: false, reason: 'session_id missing' };

  const safeSlug = deriveSlug(absPath);
  const stateFile = join(loopsDir, safeSlug + '__' + safeSid + '.json');

  let activeLoops;
  try {
    activeLoops = await findActiveLoopsInSession(loopsDir, rawSessionId);
  } catch (err) {
    return { ok: false, reason: `cannot scan loops directory: ${err.message}` };
  }

  for (const loop of activeLoops) {
    if (loop.plan_path !== absPath) {
      return {
        ok: false,
        reason:
          'another loop is already active for plan ' + shellQuote(loop.plan_path) +
          ' in this session; cancel with /hyperclaude:hyper-loop-cancel ' + shellQuote(loop.plan_path),
      };
    }
    // same plan_path → restart (overwrite below)
  }

  const state = {
    active: true,
    iteration: 0,
    max,
    plan_path: absPath,
    session_id: rawSessionId, // raw session_id, not safeSid — bodies hold raw
    started_at: new Date().toISOString(),
  };

  try {
    await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    return { ok: false, reason: `cannot write state file: ${err.message}` };
  }

  return { ok: true, additionalContext: `hyper-loop started for ${absPath} (max ${max})` };
}

// Returns { ok: true, additionalContext } or { ok: false, reason }.
async function handleCancel(parsed, planPath, loopsDir) {
  const absPath = resolve(parsed.cwd || process.cwd(), planPath);
  // absPath MAY not exist — cancel is a recovery path; do NOT check file existence.

  const rawSessionId = parsed.session_id || '';
  const safeSid = toSafeSlug(rawSessionId);
  if (!safeSid) return { ok: false, reason: 'session_id missing' };

  const safeSlug = deriveSlug(absPath);
  const stateFile = join(loopsDir, safeSlug + '__' + safeSid + '.json');

  let existing;
  try {
    const text = await readFile(stateFile, 'utf8');
    existing = JSON.parse(text);
  } catch {
    // state file missing or unreadable → not-active response
    return { ok: true, additionalContext: `no active hyper-loop found for ${absPath} in this session` };
  }

  if (!existing.active) {
    return { ok: true, additionalContext: `no active hyper-loop found for ${absPath} in this session` };
  }

  existing.active = false;

  try {
    await writeFile(stateFile, JSON.stringify(existing, null, 2) + '\n');
  } catch (err) {
    return { ok: false, reason: `cannot update state file: ${err.message}` };
  }

  return { ok: true, additionalContext: `hyper-loop cancelled for ${absPath}` };
}

function resolveDispatch(parsed) {
  if (typeof parsed.command_name === 'string') {
    if (LOOP_START_NAMES.has(parsed.command_name)) {
      return { isCancel: false, argString: parsed.command_args ?? '', hookEventName: 'UserPromptExpansion' };
    }
    if (LOOP_CANCEL_NAMES.has(parsed.command_name)) {
      return { isCancel: true, argString: parsed.command_args ?? '', hookEventName: 'UserPromptExpansion' };
    }
    return null;
  }

  // UserPromptSubmit fallback — regex on prompt
  const m = (parsed.prompt || '').match(PROMPT_RE);
  if (m) {
    return {
      isCancel: m[1] === '-cancel',
      // strip the matched command prefix to get the args string
      argString: (parsed.prompt || '').replace(PROMPT_RE, '').trim(),
      hookEventName: 'UserPromptSubmit',
    };
  }

  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const parsed = JSON.parse(input);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || parsed.cwd || process.cwd();
  const loopsDir = resolve(projectDir, '.hyperclaude', 'loops');

  const dispatch = resolveDispatch(parsed);
  if (!dispatch) {
    process.stdout.write(JSON.stringify(PASS_THROUGH) + '\n');
    return;
  }

  const { isCancel, argString, hookEventName } = dispatch;

  // All subsequent IO must be locally try/catch'd and converted to block responses.
  let tokens;
  try {
    tokens = tokenize(argString);
  } catch (err) {
    process.stdout.write(JSON.stringify(block(err.message)) + '\n');
    return;
  }

  const args = parseArgs(tokens, isCancel);
  if (args.error) {
    process.stdout.write(JSON.stringify(block(args.error)) + '\n');
    return;
  }

  const { planPath, max } = args;

  const handlerResult = isCancel
    ? await handleCancel(parsed, planPath, loopsDir)
    : await handleStart(parsed, planPath, max, loopsDir);

  const result = handlerResult.ok
    ? success(hookEventName, handlerResult.additionalContext)
    : block(handlerResult.reason);

  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[hyper-loop-intake] ${err?.message ?? err}\n`);
  process.stdout.write(JSON.stringify(PASS_THROUGH) + '\n');
});
