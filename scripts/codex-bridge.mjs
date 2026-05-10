#!/usr/bin/env node
// Codex bridge — see docs/specs/2026-05-10-v0.1-design.md §6.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
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

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'research' && mode !== 'review') {
    throw new Error(`unknown mode: ${mode}`);
  }
  const out = {
    mode,
    task: null,
    slug: null,
    planPath: null,
    out: null,
    dryRun: false,
    timeout: 300,
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`flag ${flag} expects a value`);
      return v;
    };
    switch (flag) {
      case '--task':       out.task = next(); break;
      case '--plan-path':  out.planPath = next(); break;
      case '--slug':       out.slug = next(); break;
      case '--out':        out.out = next(); break;
      case '--timeout':    out.timeout = Number(next()); break;
      case '--dry-run':    out.dryRun = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (mode === 'research' && !out.task) throw new Error('--task is required for research');
  if (mode === 'review' && !out.planPath) throw new Error('--plan-path is required for review');
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
  const subject =
    args.mode === 'research' ? args.task :
    /* review */ extractSlugFromPlanFilename(args.planPath);
  const slug = args.slug ?? slugify(subject);
  const dir = args.out ?? `.hyperclaude/${args.mode === 'research' ? 'research' : 'reviews'}`;
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

function runCodex(prompt, timeoutSec) {
  return new Promise((resolve) => {
    // --sandbox read-only forbids workspace writes regardless of user defaults;
    // hyperclaude treats Codex strictly as a critic, never as an editor.
    const child = spawn(
      'codex',
      ['exec', '--sandbox', 'read-only', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutSec * 1000);

    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        return resolve({ ok: false, reason: `codex timed out after ${timeoutSec}s`, stdout, stderr });
      }
      if (code !== 0) {
        return resolve({ ok: false, reason: `codex exited ${code}`, stdout, stderr });
      }
      resolve({ ok: true, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
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
  const inv = buildInvocation({ args });
  if (args.dryRun) {
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
