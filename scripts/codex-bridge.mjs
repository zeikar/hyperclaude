#!/usr/bin/env node
// Codex bridge — see docs/architecture.md "The bridge" section.

import { readFile, readdir, mkdir, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// ---------- slug ----------

export function slugify(input) {
  if (typeof input !== 'string') return null;
  // Drop non-ASCII, lowercase, then keep alnum + spaces.
  const ascii = input.replace(/[^\x00-\x7f]/g, '');
  const cleaned = ascii.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return null;
  return words.join('-');
}

// ---------- frontmatter ----------

export function renderFrontmatter({
  mode, task, slug, generated, codexVersion, templateVersion,
  planPath, cwd, gitHead, codexThreadId, codexResumeStatus, codexResumedFrom,
}) {
  const lines = ['---'];
  lines.push(`mode: ${mode}`);
  // task: always block scalar (|-) to handle quotes/colons/newlines safely.
  lines.push('task: |-');
  for (const line of String(task).split('\n')) {
    lines.push(`  ${line}`);
  }
  lines.push(`slug: ${slug}`);
  lines.push(`generated: ${generated}`);
  lines.push(`codex-version: ${codexVersion}`);
  lines.push(`template-version: ${templateVersion}`);
  if (planPath) lines.push(fmString('plan-path', planPath));
  lines.push(fmString('cwd', cwd));
  lines.push(fmString('git-head', gitHead));
  if (codexThreadId) lines.push(fmString('codex-thread-id', codexThreadId));
  lines.push(`codex-resume-status: ${codexResumeStatus}`);
  if (codexResumedFrom) lines.push(fmString('codex-resumed-from', codexResumedFrom));
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

// ---------- code-review frontmatter ----------

export function slugifyRef(ref) {
  if (ref === 'main') return 'vs-main';
  const cleaned = ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) return 'vs-ref';
  // Cap at 8 hyphen-separated segments to keep filenames safely under FS limits
  // (mirrors slugify's word cap; an unbounded ref body can trip ENAMETOOLONG on
  // pathological branch names like 200+ char auto-generated names).
  const body = cleaned.split('-').slice(0, 8).join('-');
  return 'vs-' + body;
}

export function renderCodeReviewFrontmatter({
  slug, generated, codexVersion, gitHead, reviewTarget, baseRef, commit, title,
  cwd, codexThreadId, codexResumeStatus, codexResumedFrom,
}) {
  const lines = ['---'];
  lines.push('mode: code-review');
  lines.push(`slug: ${slug}`);
  lines.push(`generated: ${generated}`);
  lines.push(`codex-version: ${codexVersion}`);
  lines.push(fmString('git-head', gitHead));
  if (reviewTarget === 'base') lines.push(fmString('base-ref', baseRef));
  if (reviewTarget === 'commit') lines.push(fmString('commit', commit));
  if (title) lines.push(fmString('title', title));
  lines.push(fmString('cwd', cwd));
  if (codexThreadId) lines.push(fmString('codex-thread-id', codexThreadId));
  lines.push(`codex-resume-status: ${codexResumeStatus}`);
  if (codexResumedFrom) lines.push(fmString('codex-resumed-from', codexResumedFrom));
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

export function renderDocsReviewFrontmatter({
  slug, generated, codexVersion, docsTarget, diffBase,
  cwd, gitHead, codexThreadId, codexResumeStatus, codexResumedFrom,
}) {
  const lines = ['---'];
  lines.push('mode: docs-review');
  lines.push(`slug: ${slug}`);
  lines.push(`generated: ${generated}`);
  lines.push(`codex-version: ${codexVersion}`);
  lines.push('template-version: 1');
  lines.push(fmString('docs-target', docsTarget));
  if (diffBase) lines.push(fmString('diff-base', diffBase));
  lines.push(fmString('cwd', cwd));
  lines.push(fmString('git-head', gitHead));
  if (codexThreadId) lines.push(fmString('codex-thread-id', codexThreadId));
  lines.push(`codex-resume-status: ${codexResumeStatus}`);
  if (codexResumedFrom) lines.push(fmString('codex-resumed-from', codexResumedFrom));
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

export function getGitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: process.cwd() });
  if (r.error || r.status !== 0) return 'unknown';
  return r.stdout.trim();
}

// ---------- templates ----------

export function loadTemplate(templateText, vars) {
  return templateText.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
  });
}

// Resolve a template file relative to this script's directory.
export async function readTemplateFile(name) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filepath = path.join(here, '..', 'templates', 'codex', `${name}.md`);
  return readFile(filepath, 'utf8');
}

import { existsSync } from 'node:fs';

// ---------- args ----------

const ALLOWED_FLAGS_PER_MODE = {
  research:      new Set(['--task', '--task-file', '--slug', '--out', '--dry-run', '--timeout']),
  review:        new Set(['--plan-path', '--slug', '--out', '--dry-run', '--timeout', '--resume']),
  'code-review': new Set(['--base', '--uncommitted', '--commit', '--title', '--out', '--dry-run', '--timeout', '--resume']),
  'docs-review': new Set(['--docs-path', '--docs-dir', '--diff-base', '--out', '--dry-run', '--timeout', '--resume']),
};

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'research' && mode !== 'review' && mode !== 'code-review' && mode !== 'docs-review') {
    throw new Error(`unknown mode: ${mode}`);
  }
  const allowed = ALLOWED_FLAGS_PER_MODE[mode];
  const out = {
    mode,
    task: null,
    taskFile: null,
    slug: null,
    planPath: null,
    out: null,
    dryRun: false,
    timeout: 300,
    reviewTarget: null,
    baseRef: null,
    commit: null,
    title: null,
    docsPath: null,
    docsDir: null,
    diffBase: null,
    resumeFrom: null,
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`flag ${flag} expects a value`);
      return v;
    };
    if (!allowed.has(flag)) {
      throw new Error(`unknown flag for mode ${mode}: ${flag}`);
    }
    switch (flag) {
      case '--task':       out.task = next(); break;
      case '--task-file':  out.taskFile = next(); break;
      case '--plan-path':  out.planPath = next(); break;
      case '--slug': {
        const s = next();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/.test(s)) {
          throw new Error(`--slug must match /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/, got: "${s}"`);
        }
        out.slug = s;
        break;
      }
      case '--out':        out.out = next(); break;
      case '--timeout':    out.timeout = Number(next()); break;
      case '--dry-run':    out.dryRun = true; break;
      case '--base': {
        if (out.reviewTarget !== null) throw new Error('--base, --uncommitted, and --commit are mutually exclusive');
        const v = next();
        if (!v || v.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(v)) {
          throw new Error(`--base must be a non-empty git ref ([A-Za-z0-9._/-]+, no leading dash), got: "${v}"`);
        }
        out.reviewTarget = 'base';
        out.baseRef = v;
        break;
      }
      case '--uncommitted': {
        if (out.reviewTarget !== null) throw new Error('--base, --uncommitted, and --commit are mutually exclusive');
        out.reviewTarget = 'uncommitted';
        break;
      }
      case '--commit': {
        if (out.reviewTarget !== null) throw new Error('--base, --uncommitted, and --commit are mutually exclusive');
        const v = next();
        if (!/^[0-9a-f]{7,40}$/.test(v)) {
          throw new Error(`--commit must be a hex SHA (7-40 hex chars), got: "${v}"`);
        }
        out.reviewTarget = 'commit';
        out.commit = v;
        break;
      }
      case '--title': out.title = next(); break;
      case '--docs-path': {
        if (out.docsDir !== null) throw new Error('--docs-path and --docs-dir are mutually exclusive');
        const v = next();
        if (!v || v.startsWith('-')) throw new Error(`--docs-path must be a non-empty path with no leading dash, got: "${v}"`);
        out.docsPath = v;
        break;
      }
      case '--docs-dir': {
        if (out.docsPath !== null) throw new Error('--docs-path and --docs-dir are mutually exclusive');
        const v = next();
        if (!v || v.startsWith('-')) throw new Error(`--docs-dir must be a non-empty path with no leading dash, got: "${v}"`);
        out.docsDir = v;
        break;
      }
      case '--diff-base': {
        const v = next();
        if (!v || v.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(v)) {
          throw new Error(`--diff-base must be a non-empty git ref ([A-Za-z0-9._/-]+, no leading dash), got: "${v}"`);
        }
        out.diffBase = v;
        break;
      }
      case '--resume': {
        const v = next();
        if (!v || v.startsWith('-')) {
          throw new Error(`--resume must be a non-empty path or "auto" (no leading dash), got: "${v}"`);
        }
        out.resumeFrom = v;
        break;
      }
    }
  }
  if (mode === 'code-review' && !out.reviewTarget) {
    out.reviewTarget = 'base';
    out.baseRef = 'main';
  }
  if (mode === 'research' && out.task && out.taskFile) throw new Error('--task and --task-file are mutually exclusive');
  if (mode === 'research' && !out.task && !out.taskFile) throw new Error('--task or --task-file is required for research');
  if (mode === 'review' && !out.planPath) throw new Error('--plan-path is required for review');
  if (mode === 'docs-review' && !out.docsPath && !out.docsDir) throw new Error('--docs-path or --docs-dir is required for docs-review');
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) {
    throw new Error(`--timeout must be a positive finite number, got: ${out.timeout}`);
  }
  return out;
}

// ---------- invocation planning ----------

function pad(n) { return String(n).padStart(2, '0'); }

function formatTimestamp(d) {
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes())
  );
}

function pickAvailablePath(basePath) {
  // Returns basePath if it's free; otherwise -2.md, -3.md, ... up to a sane cap.
  if (!existsSync(basePath)) return basePath;
  const ext = path.extname(basePath); // ".md"
  const stem = basePath.slice(0, -ext.length);
  for (let n = 2; n < 100; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  // Astronomically unlikely; fall through.
  return `${stem}-${Date.now()}${ext}`;
}

// Plan files are named `<YYYYMMDD-HHMM>-<slug>.md` per convention.
// Strip the timestamp prefix so the review reuses the plan's slug — preserves
// the same-slug traceability of the research → plan → review trio.
function extractSlugFromPlanFilename(planPath) {
  const base = path.basename(planPath, '.md');
  const m = base.match(/^\d{8}-\d{4}-(.+)$/);
  return m ? m[1] : base;
}

export function buildInvocation({ args, now = new Date() }) {
  const timestamp = formatTimestamp(now);
  let slug;
  let dir;
  if (args.mode === 'code-review') {
    if (args.reviewTarget === 'base') {
      slug = slugifyRef(args.baseRef);
    } else if (args.reviewTarget === 'uncommitted') {
      slug = 'uncommitted';
    } else {
      slug = 'commit-' + args.commit.slice(0, 7);
    }
    dir = args.out ?? '.hyperclaude/code-reviews';
  } else if (args.mode === 'docs-review') {
    if (args.docsPath) {
      slug = slugify(path.basename(args.docsPath, path.extname(args.docsPath))) ?? 'docs';
    } else {
      const lastSegment = args.docsDir.split('/').filter(Boolean).slice(-1)[0];
      slug = slugify(lastSegment) ?? 'docs';
    }
    dir = args.out ?? '.hyperclaude/docs-reviews';
  } else {
    slug = args.slug ?? (
      args.mode === 'research'
        ? slugify(args.task)
        : extractSlugFromPlanFilename(args.planPath)
    );
    dir = args.out ?? `.hyperclaude/${args.mode === 'research' ? 'research' : 'reviews'}`;
  }
  const filename = slug ? `${timestamp}-${slug}.md` : `${timestamp}.md`;
  const baseOutputPath = path.join(dir, filename);
  const outputPath = pickAvailablePath(baseOutputPath);
  return { timestamp, slug, outputPath, dir };
}

// ---------- codex version check ----------

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

// ---------- JSONL parser (pure) ----------

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

// ---------- frontmatter helper ----------

export function fmString(key, value) {
  return `${key}: ${JSON.stringify(value)}`;
}

// ---------- failure body renderer ----------

export function renderFailureBody({ parseDiagnostics, lastMessageText, stderr, exit }) {
  const d = parseDiagnostics || {};
  const errors = Array.isArray(d.topLevelErrors) ? d.topLevelErrors : [];
  const lastThree = errors.slice(-3);
  const errorsLine = lastThree.length > 0
    ? `${errors.length} (last ${lastThree.length} messages: ${lastThree.map((m) => JSON.stringify(m)).join(', ')})`
    : `${errors.length}`;

  const threadStarted = d.threadId
    ? `yes, thread_id ${d.threadId}`
    : 'no';
  const turnCompleted = d.hasTurnCompleted ? 'yes' : 'no';
  const turnFailed = d.turnFailedMessage
    ? `yes, message ${JSON.stringify(d.turnFailedMessage)}`
    : 'no';
  const malformed = typeof d.malformedLines === 'number' ? d.malformedLines : 0;

  const lastMsgBody = (typeof lastMessageText === 'string' && lastMessageText.length > 0)
    ? lastMessageText
    : '(empty)';
  const stderrBody = typeof stderr === 'string' ? stderr : '';

  const ex = exit || {};
  const status = (ex.status === undefined || ex.status === null) ? 'null' : String(ex.status);
  const signal = (ex.signal === undefined || ex.signal === null) ? 'null' : String(ex.signal);
  const timedOut = ex.timedOut ? 'true' : 'false';

  return [
    '# (codex failed)',
    '',
    '## JSONL parser report',
    `- thread.started: ${threadStarted}`,
    `- turn.completed: ${turnCompleted}`,
    `- turn.failed: ${turnFailed}`,
    `- top-level error events: ${errorsLine}`,
    `- malformed lines: ${malformed}`,
    '',
    '## Last message (from --output-last-message)',
    lastMsgBody,
    '',
    '## stderr',
    stderrBody,
    '',
    '## Exit',
    `status=${status}, signal=${signal}, timed-out=${timedOut}`,
    '',
  ].join('\n');
}

// ---------- spawn ----------

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
async function runCodexExec(argv, stdinPayload, timeoutSec, knownThreadId = null) {
  const lastMessagePath = path.join(os.tmpdir(), `hyperclaude-codex-${crypto.randomUUID()}.txt`);
  const fullArgv = injectJsonAndOutputFlags(argv, lastMessagePath);

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

// ---------- resume helpers ----------

// renderFileListBlock: for a non-empty array of file paths, returns a numbered
// "Files reviewed:" block (with trailing newline). For empty/null input returns ''.
export function renderFileListBlock(files) {
  if (!Array.isArray(files) || files.length === 0) return '';
  const lines = ['Files reviewed:'];
  for (let i = 0; i < files.length; i++) {
    lines.push(`  ${i + 1}. ${files[i]}`);
  }
  lines.push('');
  return lines.join('\n');
}

// renderDiffBaseBlock: for a truthy ref returns the "Also re-check `git diff <ref>...HEAD`.\n"
// line. For falsy input returns ''.
export function renderDiffBaseBlock(diffBase) {
  if (!diffBase) return '';
  return `Also re-check \`git diff ${diffBase}...HEAD\`.\n`;
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

// ---------- frontmatter parser ----------

// parseFrontmatter: narrow extractor for the frontmatter we write. Returns
// a flat object of scalar fields. Block-scalar values (`key: |-`) are skipped
// (we only need scalar identity fields for resume validation).
//
// Behaviour:
// - CRLF tolerant.
// - Returns {} when the text has no leading `---` line.
// - Reads `key: value` lines until the closing `---`.
// - JSON-quoted values (starting with `"`) are JSON.parsed; on parse failure
//   the raw substring is stored verbatim.
// - Bare-token values are stored as the raw substring after `: `.
// - `key: |-` and `key: |` start a block scalar; subsequent indented lines
//   (any line starting with at least one space) are skipped without storing.
export function parseFrontmatter(text) {
  const out = {};
  if (typeof text !== 'string' || text.length === 0) return out;
  const rawLines = text.split('\n');
  // Strip CRLF.
  const lines = rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length === 0 || lines[0] !== '---') return out;
  let i = 1;
  let inBlockScalar = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '---') break;
    if (inBlockScalar) {
      // Continuation of a block scalar: any line with leading whitespace (or empty).
      // Empty line stays inside the block; non-indented non-empty line ends it.
      if (line.length === 0 || line.startsWith(' ')) {
        i += 1;
        continue;
      }
      inBlockScalar = false;
      // Fall through to top-level key handling.
    }
    // Top-level key: `key: <rest>` — match minimally.
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const rest = m[2] === undefined ? '' : m[2];
    if (rest === '|-' || rest === '|') {
      inBlockScalar = true;
      i += 1;
      continue;
    }
    if (rest.startsWith('"')) {
      try {
        out[key] = JSON.parse(rest);
      } catch {
        out[key] = rest;
      }
    } else {
      out[key] = rest;
    }
    i += 1;
  }
  return out;
}

// ---------- resume context loaders ----------

// defaultModeDir: maps a mode to its conventional output directory under
// .hyperclaude/. Mirrors the implicit mapping in buildInvocation.
export function defaultModeDir(mode) {
  if (mode === 'research') return '.hyperclaude/research';
  if (mode === 'review') return '.hyperclaude/reviews';
  if (mode === 'code-review') return '.hyperclaude/code-reviews';
  if (mode === 'docs-review') return '.hyperclaude/docs-reviews';
  throw new Error(`unknown mode: ${mode}`);
}

// loadResumeContext: validates a prior artifact and extracts thread-id.
// Returns either { threadId, frontmatter } or { error: <reason> }.
//
// Validations (in order, first failure wins):
//  1. file readable + parses
//  2. mode field equals expectedMode
//  3. cwd matches process.cwd() under path.resolve()
//  4. codex-thread-id is truthy
//  5. codex-resume-status is fresh or resumed (not fallback / resume-failed)
//  6. mode-specific identity (plan-path for review; docs-target+diff-base for docs-review)
export async function loadResumeContext(prevPath, expectedMode, currentArgs) {
  let text;
  try {
    text = await readFile(prevPath, 'utf8');
  } catch {
    return { error: `cannot read prior artifact: ${prevPath}` };
  }
  const fm = parseFrontmatter(text);
  if (fm.mode !== expectedMode) {
    return { error: `prior artifact mode is "${fm.mode ?? ''}"; current mode is "${expectedMode}"` };
  }
  const prevCwd = fm.cwd;
  if (typeof prevCwd !== 'string' || prevCwd.length === 0) {
    return { error: `prior artifact cwd is ""; current cwd is "${process.cwd()}"` };
  }
  const here = process.cwd();
  if (path.resolve(prevCwd) !== path.resolve(here)) {
    return { error: `prior artifact cwd is "${prevCwd}"; current cwd is "${here}"` };
  }
  const threadId = fm['codex-thread-id'];
  if (!threadId || typeof threadId !== 'string') {
    return { error: 'prior artifact has no codex-thread-id' };
  }
  const status = fm['codex-resume-status'];
  if (status !== 'fresh' && status !== 'resumed') {
    return { error: `prior artifact has resume-status "${status ?? ''}"; only fresh/resumed eligible` };
  }
  if (expectedMode === 'review') {
    const prevPlan = fm['plan-path'];
    if (typeof prevPlan !== 'string' || path.resolve(prevPlan) !== path.resolve(currentArgs.planPath)) {
      return { error: 'prior artifact plan-path differs from current' };
    }
  } else if (expectedMode === 'docs-review') {
    const prevTarget = fm['docs-target'];
    const curTarget = currentArgs.docsPath || currentArgs.docsDir;
    if (typeof prevTarget !== 'string' || path.resolve(prevTarget) !== path.resolve(curTarget)) {
      return { error: 'prior artifact docs-target/diff-base differs from current' };
    }
    const prevDiff = fm['diff-base'] ?? null;
    const curDiff = currentArgs.diffBase ?? null;
    if (prevDiff !== curDiff) {
      return { error: 'prior artifact docs-target/diff-base differs from current' };
    }
  } else if (expectedMode === 'code-review') {
    // title is purely cosmetic — does NOT participate in identity (it does not
    // affect what Codex reviewed, only the display label in the output file).
    const hasPriorBaseRef = Object.prototype.hasOwnProperty.call(fm, 'base-ref');
    const hasPriorCommit = Object.prototype.hasOwnProperty.call(fm, 'commit');
    // Precheck: a well-formed prior artifact has at most one of base-ref/commit.
    // Both present means malformed frontmatter — reject before target matching to
    // prevent the absence-means-uncommitted inference from granting a false match.
    if (hasPriorBaseRef && hasPriorCommit) {
      return { error: 'prior artifact code-review target differs from current' };
    }
    const curTarget = currentArgs.reviewTarget;
    if (curTarget === 'base') {
      // Match on ref name string only (no SHA resolve).
      if (!hasPriorBaseRef || fm['base-ref'] !== currentArgs.base) {
        return { error: 'prior artifact code-review target differs from current' };
      }
    } else if (curTarget === 'commit') {
      // Match on exact SHA string.
      if (!hasPriorCommit || fm['commit'] !== currentArgs.commit) {
        return { error: 'prior artifact code-review target differs from current' };
      }
    } else {
      // uncommitted: prior must lack both base-ref and commit keys.
      if (hasPriorBaseRef || hasPriorCommit) {
        return { error: 'prior artifact code-review target differs from current' };
      }
    }
  }
  return { threadId, frontmatter: fm };
}

// resolveResume: for `--resume <path>` or `--resume auto`, returns one of:
//   { ok: true, prevPath, context }
//   { ok: false, fatal: true,  error }   // explicit path → caller fails hard
//   { ok: false, fatal: false, error }   // 'auto' miss → caller falls back to fresh
async function resolveResume(mode, args) {
  let prevPath;
  if (args.resumeFrom === 'auto') {
    const d = await discoverResumeArtifact(mode, args);
    if (d.error) return { ok: false, fatal: false, error: d.error };
    prevPath = d.path;
  } else {
    prevPath = args.resumeFrom;
  }
  const ctx = await loadResumeContext(prevPath, mode, args);
  if (ctx.error) {
    return { ok: false, fatal: args.resumeFrom !== 'auto', error: ctx.error };
  }
  return { ok: true, prevPath, context: ctx };
}

// discoverResumeArtifact: searches the configured output directory for the
// newest artifact whose frontmatter passes loadResumeContext. Returns either
// { path } or { error: 'no matching artifact in <dir>' }.
export async function discoverResumeArtifact(mode, args) {
  const dir = args.out ?? defaultModeDir(mode);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { error: `no matching artifact in ${dir}` };
  }
  const candidates = entries
    .filter((d) => d.isFile() && d.name.endsWith('.md') && /^\d{8}-\d{4}-/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => {
      // Newest first: same-minute collisions (`-2.md`, `-3.md`) are written LATER
      // than the unsuffixed name; lex order puts unsuffixed first, so we read the
      // collision suffix and treat higher suffix = newer within the same prefix.
      const m = (n) => n.match(/^(\d{8}-\d{4}-.*?)(?:-(\d+))?\.md$/);
      const ma = m(a), mb = m(b);
      if (ma && mb && ma[1] === mb[1]) {
        return Number(mb[2] ?? 1) - Number(ma[2] ?? 1);
      }
      return b.localeCompare(a);
    });
  for (const name of candidates) {
    const candidatePath = path.join(dir, name);
    const ctx = await loadResumeContext(candidatePath, mode, args);
    if (!ctx.error) {
      return { path: candidatePath };
    }
  }
  return { error: `no matching artifact in ${dir}` };
}

// ---------- CLI entry ----------

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(2);
  }
  if (args.taskFile) {
    try {
      args.task = (await readFile(args.taskFile, 'utf8')).trim();
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `cannot read task file: ${args.taskFile} (${err.message})`,
      }) + '\n');
      process.exit(1);
    }
    if (!args.task) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `task file is empty: ${args.taskFile}`,
      }) + '\n');
      process.exit(1);
    }
  }
  const inv = buildInvocation({ args });
  if (args.dryRun) {
    // code-review has no prompt template and does not require codex on PATH for dry-run.
    if (args.mode !== 'code-review') {
      // Fail fast if the prompt template is missing — better to find out now.
      try {
        await readTemplateFile(args.mode);
      } catch (err) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `failed to read prompt template: ${err.message}`,
        }) + '\n');
        process.exit(1);
      }
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      dryRun: true,
      mode: args.mode,
      slug: inv.slug,
      outputPath: inv.outputPath,
      timestamp: inv.timestamp,
    }) + '\n');
    return;
  }

  // docs-review path: reads docs file/dir, checks size, builds prompt, spawns codex exec.
  if (args.mode === 'docs-review') {
    // Step 1: read docs content. `aggregatedFiles` mirrors the markers we
    // emit so the resume prompt can re-list what was reviewed.
    let docsContent;
    let aggregatedFiles = [];
    if (args.docsPath) {
      try {
        // Prefix with file marker so Codex can attribute findings to the path
        // (mirrors the per-file marker in --docs-dir mode; the docs-review template
        // requires findings to cite "<doc path>:<line-or-section>").
        const raw = await readFile(args.docsPath, 'utf8');
        docsContent = `## File: ${args.docsPath}\n\n${raw}`;
        aggregatedFiles = [args.docsPath];
      } catch (err) {
        let errMsg;
        if (err.code === 'ENOENT') {
          errMsg = `docs file not found: ${args.docsPath}`;
        } else if (err.code === 'EISDIR') {
          errMsg = `--docs-path is a directory, use --docs-dir: ${args.docsPath}`;
        } else {
          errMsg = `cannot read docs file: ${args.docsPath} (${err.code})`;
        }
        process.stdout.write(JSON.stringify({ ok: false, error: errMsg }) + '\n');
        process.exit(1);
      }
    } else {
      // args.docsDir
      let entries;
      try {
        entries = await readdir(args.docsDir, { withFileTypes: true });
      } catch (err) {
        let errMsg;
        if (err.code === 'ENOENT') {
          errMsg = `docs dir not found: ${args.docsDir}`;
        } else {
          errMsg = `cannot read docs dir: ${args.docsDir} (${err.code})`;
        }
        process.stdout.write(JSON.stringify({ ok: false, error: errMsg }) + '\n');
        process.exit(1);
      }
      const mdFiles = entries
        .filter(dirent => dirent.isFile() && dirent.name.endsWith('.md'))
        .map(dirent => dirent.name)
        .sort();
      if (mdFiles.length === 0) {
        process.stdout.write(JSON.stringify({ ok: false, error: `no .md files in ${args.docsDir}` }) + '\n');
        process.exit(1);
      }
      const parts = [];
      for (const name of mdFiles) {
        const filePath = path.join(args.docsDir, name);
        const text = await readFile(filePath, 'utf8');
        parts.push(`## File: ${name}\n\n${text}`);
      }
      docsContent = parts.join('\n\n');
      // Resume prompt asks Codex to re-read these files from disk, so the list
      // must be cwd-relative paths (Codex's cwd = project root, not args.docsDir).
      aggregatedFiles = mdFiles.map((name) => path.join(args.docsDir, name));
    }

    // Step 2: 200KB docs guard.
    const docsBytes = Buffer.byteLength(docsContent, 'utf8');
    if (docsBytes > 204800) {
      const baseMsg = 'docs payload exceeds 200KB; narrow scope with --docs-path or a smaller directory';
      process.stdout.write(JSON.stringify({
        ok: false,
        error: args.resumeFrom ? `resume rejected: ${baseMsg}` : baseMsg,
        totalBytes: docsBytes,
        ...(args.resumeFrom ? { resumeStatus: 'fallback', threadId: null } : {}),
      }) + '\n');
      process.exit(1);
    }

    // Step 3: codex version check.
    const v = getCodexVersion();
    if (!v.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: v.reason,
        hint: 'Install or upgrade codex-cli (>= 0.130.0). See: https://github.com/openai/codex',
      }) + '\n');
      process.exit(1);
    }

    // Step 4 (resume): try to resolve a prior thread when --resume is set.
    // On 'auto' miss → fall back to fresh + stderr note. On explicit failure → fail hard.
    let resumeContext = null;       // { threadId, frontmatter } when valid
    let resumeFromPath = null;      // resolved prior artifact path (for codexResumedFrom)
    let resumeStatus = 'fresh';
    if (args.resumeFrom) {
      const r = await resolveResume('docs-review', args);
      if (r.ok) {
        resumeContext = r.context;
        resumeFromPath = r.prevPath;
      } else if (r.fatal) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `resume rejected: ${r.error}`,
          path: null,
          resumeStatus: 'fallback',
          threadId: null,
        }) + '\n');
        process.exit(1);
      } else {
        // 'auto' fell back: warn, run fresh.
        process.stderr.write(`hyperclaude: resume fallback — ${r.error}\n`);
        resumeStatus = 'fallback';
      }
    }

    // Step 5: optional diff context (always re-run for resume too, since the
    // template references the diff and we need to enforce the 500KB guard).
    let diffOutput = null;
    if (args.diffBase) {
      const r = spawnSync('git', ['diff', `${args.diffBase}...HEAD`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (r.error || r.status !== 0) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `git diff failed: ${r.stderr || r.error?.message}`,
          ...(args.resumeFrom ? { resumeStatus: 'fallback', threadId: null } : {}),
        }) + '\n');
        process.exit(1);
      }
      if (Buffer.byteLength(r.stdout, 'utf8') > 512000) {
        const baseMsg = 'git diff exceeds 500KB; narrow --diff-base scope';
        process.stdout.write(JSON.stringify({
          ok: false,
          error: args.resumeFrom ? `resume rejected: ${baseMsg}` : baseMsg,
          diffBytes: Buffer.byteLength(r.stdout, 'utf8'),
          ...(args.resumeFrom ? { resumeStatus: 'fallback', threadId: null } : {}),
        }) + '\n');
        process.exit(1);
      }
      diffOutput = r.stdout;
    }

    // Step 6: load template (fresh vs resume).
    let templateText;
    try {
      templateText = await readTemplateFile(resumeContext ? 'docs-review-resumed' : 'docs-review');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `failed to read prompt template: ${err.message}`,
      }) + '\n');
      process.exit(1);
    }

    // Step 7: build prompt.
    let prompt;
    if (resumeContext) {
      prompt = loadTemplate(templateText, {
        DOCS_TARGET: args.docsPath || args.docsDir,
        FILE_LIST_BLOCK: renderFileListBlock(aggregatedFiles),
        DIFF_BASE_BLOCK: renderDiffBaseBlock(args.diffBase),
      });
    } else {
      const vars = { DOCS: docsContent };
      if (diffOutput !== null) vars.DIFF = diffOutput;
      prompt = loadTemplate(templateText, vars);
    }

    // Step 8: spawn codex.
    let result;
    if (resumeContext) {
      result = await runCodexResume(resumeContext.threadId, prompt, args.timeout);
    } else {
      result = await runCodexExec(['exec', '--sandbox', 'read-only', '-'], prompt, args.timeout);
    }

    // Step 9: pick final resume status.
    if (resumeContext) {
      resumeStatus = result.ok ? 'resumed' : 'resume-failed';
    }
    // Else stays 'fresh' or 'fallback' (set above).

    // Step 10: ensure output dir exists.
    await mkdir(inv.dir, { recursive: true });

    // Step 11: build output file content.
    const fm = renderDocsReviewFrontmatter({
      slug: inv.slug,
      generated: new Date().toISOString(),
      codexVersion: v.version,
      docsTarget: args.docsPath ?? args.docsDir,
      diffBase: args.diffBase,
      cwd: process.cwd(),
      gitHead: getGitHead(),
      codexThreadId: result.threadId,
      codexResumeStatus: resumeStatus,
      codexResumedFrom: resumeContext && result.ok ? resumeFromPath : undefined,
    });
    const heading = `# Docs review: ${path.basename(args.docsPath ?? args.docsDir)}`;
    const body = result.body;

    // Step 12: write file.
    await writeFile(inv.outputPath, fm + heading + '\n\n' + body, 'utf8');

    // Step 13: emit result JSON.
    if (!result.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: result.reason,
        path: inv.outputPath,
        resumeStatus,
        threadId: result.threadId,
      }) + '\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      path: inv.outputPath,
      slug: inv.slug,
      threadId: result.threadId,
      resumeStatus,
    }) + '\n');
    return;
  }

  // code-review path: uses `codex exec review` subcommand, no prompt template.
  if (args.mode === 'code-review') {
    const v = getCodexVersion();
    if (!v.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: v.reason,
        hint: 'Install or upgrade codex-cli (>= 0.130.0). See: https://github.com/openai/codex',
      }) + '\n');
      process.exit(1);
    }

    // Resume resolution: try to resolve a prior thread when --resume is set.
    // On 'auto' miss → fall back to fresh + stderr note. On explicit failure → fail hard.
    let resumeContext = null;       // { threadId, frontmatter } when valid
    let resumeFromPath = null;      // resolved prior artifact path (for codexResumedFrom)
    let resumeStatus = 'fresh';
    if (args.resumeFrom) {
      const r = await resolveResume('code-review', args);
      if (r.ok) {
        resumeContext = r.context;
        resumeFromPath = r.prevPath;
      } else if (r.fatal) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `resume rejected: ${r.error}`,
          path: null,
          resumeStatus: 'fallback',
          threadId: null,
        }) + '\n');
        process.exit(1);
      } else {
        // 'auto' fell back: warn, run fresh.
        process.stderr.write(`hyperclaude: resume fallback — ${r.error}\n`);
        resumeStatus = 'fallback';
      }
    }

    const targetFlags = [];
    if (args.reviewTarget === 'base') {
      targetFlags.push('--base', args.baseRef);
    } else if (args.reviewTarget === 'uncommitted') {
      targetFlags.push('--uncommitted');
    } else {
      targetFlags.push('--commit', args.commit);
    }
    const titleFlag = args.title ? ['--title', args.title] : [];

    const gitHead = getGitHead();

    // Spawn: resume path uses runCodexResume; fresh path uses runCodexExec.
    let result;
    if (resumeContext) {
      // Build TARGET_INSTRUCTION block for the resume template.
      let targetInstruction;
      if (args.reviewTarget === 'base') {
        targetInstruction = `Re-read the diff via:\n\n  git diff ${args.baseRef}...HEAD --name-status\n  git diff ${args.baseRef}...HEAD -- <file>   # per changed path`;
      } else if (args.reviewTarget === 'commit') {
        targetInstruction = `Re-read the commit via:\n\n  git show --format= --patch ${args.commit}`;
      } else {
        targetInstruction = `Re-read the working tree via:\n\n  git status --short\n  git diff           # unstaged\n  git diff --cached  # staged\n\nFor untracked files (paths starting with "??" in git status output), read their content directly — they have no diff.`;
      }
      let resumeTemplateText;
      try {
        resumeTemplateText = await readTemplateFile('code-review-resumed');
      } catch (err) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `failed to read prompt template: ${err.message}`,
        }) + '\n');
        process.exit(1);
      }
      const prompt = loadTemplate(resumeTemplateText, { TARGET_INSTRUCTION: targetInstruction });
      result = await runCodexResume(resumeContext.threadId, prompt, args.timeout);
    } else {
      const argv = ['exec', 'review', '-c', 'sandbox_mode=read-only', ...targetFlags, ...titleFlag];
      result = await runCodexExec(argv, null, args.timeout);
    }

    // Pick final resume status.
    if (resumeContext) {
      resumeStatus = result.ok ? 'resumed' : 'resume-failed';
    }

    await mkdir(inv.dir, { recursive: true });

    const fm = renderCodeReviewFrontmatter({
      slug: inv.slug,
      generated: new Date().toISOString(),
      codexVersion: v.version,
      gitHead,
      reviewTarget: args.reviewTarget,
      baseRef: args.baseRef,
      commit: args.commit,
      title: args.title,
      cwd: process.cwd(),
      codexThreadId: result.threadId,
      codexResumeStatus: resumeStatus,
      codexResumedFrom: resumeContext && result.ok ? resumeFromPath : undefined,
    });

    let heading;
    if (args.title) {
      heading = `# Code review: ${args.title}`;
    } else if (args.reviewTarget === 'base') {
      heading = `# Code review: vs ${args.baseRef}`;
    } else if (args.reviewTarget === 'uncommitted') {
      heading = `# Code review: uncommitted`;
    } else {
      heading = `# Code review: commit ${args.commit.slice(0, 7)}`;
    }

    const body = result.ok
      ? result.body
      : renderFailureBody({
          parseDiagnostics: result.parseDiagnostics,
          lastMessageText: result.lastMessageText,
          stderr: result.stderr,
          exit: result.exit,
        });

    await writeFile(inv.outputPath, fm + heading + '\n\n' + body, 'utf8');

    if (!result.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: result.reason,
        path: inv.outputPath,
        resumeStatus,
        threadId: result.threadId,
      }) + '\n');
      process.exit(1);
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      path: inv.outputPath,
      slug: inv.slug,
      threadId: result.threadId,
      resumeStatus,
    }) + '\n');
    return;
  }

  // Real path: version-check codex, load template, build prompt, spawn, write file.
  const v = getCodexVersion();
  if (!v.ok) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: v.reason,
      hint: 'Install or upgrade codex-cli (>= 0.130.0). See: https://github.com/openai/codex',
    }) + '\n');
    process.exit(1);
  }

  // Review-only: try to resolve resume context before reading the plan, so
  // that an explicit-path validation failure short-circuits with a clean error.
  let resumeContext = null;
  let resumeFromPath = null;
  let resumeStatus = 'fresh';
  if (args.mode === 'review' && args.resumeFrom) {
    const r = await resolveResume('review', args);
    if (r.ok) {
      resumeContext = r.context;
      resumeFromPath = r.prevPath;
    } else if (r.fatal) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `resume rejected: ${r.error}`,
        path: null,
        resumeStatus: 'fallback',
        threadId: null,
      }) + '\n');
      process.exit(1);
    } else {
      process.stderr.write(`hyperclaude: resume fallback — ${r.error}\n`);
      resumeStatus = 'fallback';
    }
  }

  let plan = '';
  if (args.mode === 'review') {
    try {
      plan = await readFile(args.planPath, 'utf8');
    } catch (err) {
      // For resume, this is a precondition failure — fail with fallback shape.
      if (args.resumeFrom) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `resume rejected: cannot read plan file: ${args.planPath} (${err.message})`,
          path: null,
          resumeStatus: 'fallback',
          threadId: null,
        }) + '\n');
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `cannot read plan file: ${args.planPath} (${err.message})`,
      }) + '\n');
      process.exit(1);
    }
  }

  let templateText;
  try {
    const templateName = (args.mode === 'review' && resumeContext) ? 'review-resumed' : args.mode;
    templateText = await readTemplateFile(templateName);
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `failed to read prompt template: ${err.message}`,
    }) + '\n');
    process.exit(1);
  }

  let prompt;
  if (args.mode === 'review' && resumeContext) {
    prompt = loadTemplate(templateText, { PLAN_PATH: args.planPath });
  } else {
    prompt = loadTemplate(templateText, {
      TASK: args.task ?? '',
      PLAN: plan,
    });
  }

  let result;
  if (resumeContext) {
    result = await runCodexResume(resumeContext.threadId, prompt, args.timeout);
  } else {
    result = await runCodexExec(['exec', '--sandbox', 'read-only', '-'], prompt, args.timeout);
  }
  await mkdir(inv.dir, { recursive: true });

  if (resumeContext) {
    resumeStatus = result.ok ? 'resumed' : 'resume-failed';
  }

  const subject =
    args.mode === 'research' ? args.task :
    /* review */ args.planPath;

  const fm = renderFrontmatter({
    mode: args.mode,
    task: subject,
    slug: inv.slug ?? '',
    generated: new Date().toISOString(),
    codexVersion: v.version,
    templateVersion: 1,
    planPath: args.mode === 'review' ? args.planPath : undefined,
    cwd: process.cwd(),
    gitHead: getGitHead(),
    codexThreadId: result.threadId,
    codexResumeStatus: resumeStatus,
    codexResumedFrom: resumeContext && result.ok ? resumeFromPath : undefined,
  });

  const heading = args.mode === 'research'
    ? `# Research: ${args.task}\n\n`
    : `# Review: ${path.basename(args.planPath)}\n\n`;

  const body = result.body;
  await writeFile(inv.outputPath, fm + heading + body, 'utf8');

  if (!result.ok) {
    const json = {
      ok: false,
      error: result.reason,
      path: inv.outputPath,
    };
    if (args.mode === 'review') {
      json.resumeStatus = resumeStatus;
      json.threadId = result.threadId;
    }
    process.stdout.write(JSON.stringify(json) + '\n');
    process.exit(1);
  }

  const json = {
    ok: true,
    path: inv.outputPath,
    slug: inv.slug,
  };
  if (args.mode === 'review') {
    json.threadId = result.threadId;
    json.resumeStatus = resumeStatus;
  }
  process.stdout.write(JSON.stringify(json) + '\n');
}

// Run main only when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
