#!/usr/bin/env node
// Codex bridge — see docs/specs/2026-05-10-v0.1-design.md §6.

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
  planPath,
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
  if (planPath) lines.push(`plan-path: ${JSON.stringify(planPath)}`);
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

export function renderCodeReviewFrontmatter({ slug, generated, codexVersion, gitHead, reviewTarget, baseRef, commit, title }) {
  const lines = ['---'];
  lines.push('mode: code-review');
  lines.push(`slug: ${slug}`);
  lines.push(`generated: ${generated}`);
  lines.push(`codex-version: ${codexVersion}`);
  lines.push('codex-subcommand: review');
  lines.push(`git-head: ${JSON.stringify(gitHead)}`);
  if (reviewTarget === 'base') lines.push(`base-ref: ${JSON.stringify(baseRef)}`);
  if (reviewTarget === 'commit') lines.push(`commit: ${JSON.stringify(commit)}`);
  if (title) lines.push(`title: ${JSON.stringify(title)}`);
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

export function renderDocsReviewFrontmatter({ slug, generated, codexVersion, docsTarget, diffBase }) {
  const lines = ['---'];
  lines.push('mode: docs-review');
  lines.push(`slug: ${slug}`);
  lines.push(`generated: ${generated}`);
  lines.push(`codex-version: ${codexVersion}`);
  lines.push('template-version: 1');
  lines.push(`docs-target: ${JSON.stringify(docsTarget)}`);
  if (diffBase) lines.push(`diff-base: ${JSON.stringify(diffBase)}`);
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
  review:        new Set(['--plan-path', '--slug', '--out', '--dry-run', '--timeout']),
  'code-review': new Set(['--base', '--uncommitted', '--commit', '--title', '--out', '--dry-run', '--timeout']),
  'docs-review': new Set(['--docs-path', '--docs-dir', '--diff-base', '--out', '--dry-run', '--timeout']),
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
const MIN_CODEX_MINOR = 128;

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

function spawnCodex(spawnArgs, { stdinPayload = null } = {}, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn('codex', spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
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
      settle({ ok: false, reason: `spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        return settle({ ok: false, reason: `codex timed out after ${timeoutSec}s`, stdout, stderr });
      }
      if (code !== 0) {
        return settle({ ok: false, reason: `codex exited ${code}`, stdout, stderr });
      }
      settle({ ok: true, stdout, stderr });
    });
    if (stdinPayload !== null) {
      child.stdin.end(stdinPayload);
    } else {
      child.stdin.end();
    }
  });
}

function runCodex(prompt, timeoutSec) {
  // --sandbox read-only forbids workspace writes regardless of user defaults;
  // hyperclaude treats Codex strictly as a critic, never as an editor.
  return spawnCodex(['exec', '--sandbox', 'read-only', '-'], { stdinPayload: prompt }, timeoutSec);
}

// codex review is a review-only subcommand: it inspects diffs, never authors patches.
// It does not expose --sandbox (verified via `codex review --help`), and we keep the argv
// minimal — no -c overrides, no extra flags — so the spawn shape is auditable.
function runCodexReview(reviewArgv, timeoutSec) {
  return spawnCodex(['review', ...reviewArgv], {}, timeoutSec);
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
    // Step 1: read docs content.
    let docsContent;
    if (args.docsPath) {
      try {
        // Prefix with file marker so Codex can attribute findings to the path
        // (mirrors the per-file marker in --docs-dir mode; the docs-review template
        // requires findings to cite "<doc path>:<line-or-section>").
        const raw = await readFile(args.docsPath, 'utf8');
        docsContent = `## File: ${args.docsPath}\n\n${raw}`;
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
    }

    // Step 2: 200KB docs guard.
    const docsBytes = Buffer.byteLength(docsContent, 'utf8');
    if (docsBytes > 204800) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: 'docs payload exceeds 200KB; narrow scope with --docs-path or a smaller directory',
        totalBytes: docsBytes,
      }) + '\n');
      process.exit(1);
    }

    // Step 3: codex version check.
    const v = getCodexVersion();
    if (!v.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: v.reason,
        hint: 'Install or upgrade codex-cli (>= 0.128.0). See: https://github.com/openai/codex',
      }) + '\n');
      process.exit(1);
    }

    // Step 4: load template.
    let templateText;
    try {
      templateText = await readTemplateFile('docs-review');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `failed to read prompt template: ${err.message}`,
      }) + '\n');
      process.exit(1);
    }

    // Step 5: build prompt with optional diff context.
    const vars = { DOCS: docsContent };
    if (args.diffBase) {
      const r = spawnSync('git', ['diff', `${args.diffBase}...HEAD`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (r.error || r.status !== 0) {
        process.stdout.write(JSON.stringify({ ok: false, error: `git diff failed: ${r.stderr || r.error?.message}` }) + '\n');
        process.exit(1);
      }
      if (Buffer.byteLength(r.stdout, 'utf8') > 512000) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: 'git diff exceeds 500KB; narrow --diff-base scope',
          diffBytes: Buffer.byteLength(r.stdout, 'utf8'),
        }) + '\n');
        process.exit(1);
      }
      vars.DIFF = r.stdout;
    }
    const prompt = loadTemplate(templateText, vars);

    // Step 6: spawn codex.
    const result = await runCodex(prompt, args.timeout);

    // Step 7: ensure output dir exists.
    await mkdir(inv.dir, { recursive: true });

    // Step 8-10: build output file content.
    const fm = renderDocsReviewFrontmatter({
      slug: inv.slug,
      generated: new Date().toISOString(),
      codexVersion: v.version,
      docsTarget: args.docsPath ?? args.docsDir,
      diffBase: args.diffBase,
    });
    const heading = `# Docs review: ${path.basename(args.docsPath ?? args.docsDir)}`;
    const body = result.ok
      ? result.stdout
      : `# (codex failed)\n\n${result.stdout}\n\n## stderr\n\n${result.stderr}\n`;

    // Step 11: write file.
    await writeFile(inv.outputPath, fm + heading + '\n\n' + body, 'utf8');

    // Step 12: emit result JSON.
    if (!result.ok) {
      process.stdout.write(JSON.stringify({ ok: false, error: result.reason, path: inv.outputPath }) + '\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ ok: true, path: inv.outputPath, slug: inv.slug }) + '\n');
    return;
  }

  // code-review path: uses `codex review` subcommand, no prompt template.
  if (args.mode === 'code-review') {
    const v = getCodexVersion();
    if (!v.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: v.reason,
        hint: 'Install or upgrade codex-cli (>= 0.128.0). See: https://github.com/openai/codex',
      }) + '\n');
      process.exit(1);
    }

    const reviewArgv = [];
    if (args.reviewTarget === 'base') {
      reviewArgv.push('--base', args.baseRef);
    } else if (args.reviewTarget === 'uncommitted') {
      reviewArgv.push('--uncommitted');
    } else {
      reviewArgv.push('--commit', args.commit);
    }
    if (args.title) {
      reviewArgv.push('--title', args.title);
    }

    const gitHead = getGitHead();
    const result = await runCodexReview(reviewArgv, args.timeout);
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
      ? result.stdout
      : `# (codex failed)\n\n${result.stdout}\n\n## stderr\n\n${result.stderr}\n`;

    await writeFile(inv.outputPath, fm + heading + '\n\n' + body, 'utf8');

    if (!result.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: result.reason,
        path: inv.outputPath,
      }) + '\n');
      process.exit(1);
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      path: inv.outputPath,
      slug: inv.slug,
    }) + '\n');
    return;
  }

  // Real path: version-check codex, load template, build prompt, spawn, write file.
  const v = getCodexVersion();
  if (!v.ok) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: v.reason,
      hint: 'Install or upgrade codex-cli (>= 0.128.0). See: https://github.com/openai/codex',
    }) + '\n');
    process.exit(1);
  }

  let templateText;
  try {
    templateText = await readTemplateFile(args.mode);
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `failed to read prompt template: ${err.message}`,
    }) + '\n');
    process.exit(1);
  }

  let plan = '';
  if (args.mode === 'review') {
    try {
      plan = await readFile(args.planPath, 'utf8');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `cannot read plan file: ${args.planPath} (${err.message})`,
      }) + '\n');
      process.exit(1);
    }
  }

  const prompt = loadTemplate(templateText, {
    TASK: args.task ?? '',
    PLAN: plan,
  });

  const result = await runCodex(prompt, args.timeout);
  await mkdir(inv.dir, { recursive: true });

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
  });

  const heading = args.mode === 'research'
    ? `# Research: ${args.task}\n\n`
    : `# Review: ${path.basename(args.planPath)}\n\n`;

  const body = result.ok ? result.stdout : `# (codex failed)\n\n${result.stdout}\n\n## stderr\n\n${result.stderr}\n`;
  await writeFile(inv.outputPath, fm + heading + body, 'utf8');

  if (!result.ok) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: result.reason,
      path: inv.outputPath,
    }) + '\n');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    path: inv.outputPath,
    slug: inv.slug,
  }) + '\n');
}

// Run main only when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
