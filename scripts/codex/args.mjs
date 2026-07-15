// Argv parsing for the codex bridge.
// One parseArgs() handles all four modes; mode is the first positional, and
// the rest is mode-dispatched flag handling with strict allow-listing.

import path from 'node:path';

const ALLOWED_FLAGS_PER_MODE = {
  research:      new Set(['--task', '--task-file', '--slug', '--out', '--dry-run', '--timeout', '--model', '--effort']),
  'plan-review': new Set(['--plan-path', '--slug', '--out', '--dry-run', '--timeout', '--resume', '--model', '--effort', '--review-brief']),
  'code-review': new Set(['--base', '--uncommitted', '--commit', '--title', '--background', '--out', '--dry-run', '--timeout', '--resume', '--model', '--effort', '--review-brief']),
  'docs-review': new Set(['--docs-path', '--docs-dir', '--diff-base', '--out', '--dry-run', '--timeout', '--resume', '--model', '--effort']),
};

const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'research' && mode !== 'plan-review' && mode !== 'code-review' && mode !== 'docs-review') {
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
    timeout: 600,
    reviewTarget: null,
    baseRef: null,
    commit: null,
    title: null,
    background: null,
    reviewBrief: null,
    docsPaths: [],
    docsDir: null,
    diffBase: null,
    resumeFrom: null,
    model: null,
    effort: null,
  };
  // Tracks resolved --docs-path values so a repeated flag dedups; first-seen
  // spelling wins (the original v is what's kept in out.docsPaths).
  const docsPathsResolved = new Set();
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
      case '--background': {
        const v = next();
        if (!v || v.startsWith('-')) throw new Error(`--background must be a non-empty string with no leading dash, got: "${v}"`);
        out.background = v;
        break;
      }
      case '--review-brief': {
        // No leading-dash rule here (unlike --background): next() already consumes
        // the following token unconditionally, so the rule buys no flag-parsing
        // protection, and briefs are naturally bullet-form (e.g. "- user asked for X").
        const v = next();
        if (!v.trim()) throw new Error(`--review-brief must be a non-empty string, got: "${v}"`);
        out.reviewBrief = v;
        break;
      }
      case '--docs-path': {
        if (out.docsDir !== null) throw new Error('--docs-path and --docs-dir are mutually exclusive');
        const v = next();
        if (!v || v.startsWith('-')) throw new Error(`--docs-path must be a non-empty path with no leading dash, got: "${v}"`);
        const resolved = path.resolve(v);
        if (!docsPathsResolved.has(resolved)) {
          docsPathsResolved.add(resolved);
          out.docsPaths.push(v);
        }
        break;
      }
      case '--docs-dir': {
        if (out.docsPaths.length > 0) throw new Error('--docs-path and --docs-dir are mutually exclusive');
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
      case '--model': {
        const v = next();
        if (!v || v.startsWith('-')) throw new Error(`--model must be a non-empty model name with no leading dash, got: "${v}"`);
        out.model = v;
        break;
      }
      case '--effort': {
        const v = next();
        if (!ALLOWED_EFFORTS.has(v)) throw new Error(`--effort must be one of low|medium|high|xhigh, got: "${v}"`);
        out.effort = v;
        break;
      }
    }
  }
  if (mode === 'code-review' && !out.reviewTarget) {
    out.reviewTarget = 'base';
    out.baseRef = 'main';
  }
  if (mode === 'code-review' && out.background && out.resumeFrom) {
    throw new Error('--background is only supported when --resume is omitted');
  }
  // --review-brief is deliberately NOT rejected alongside --resume (unlike --background):
  // the brief must reach the reviewer on resumed rounds too.
  if (mode === 'research' && out.task && out.taskFile) throw new Error('--task and --task-file are mutually exclusive');
  if (mode === 'research' && !out.task && !out.taskFile) throw new Error('--task or --task-file is required for research');
  if (mode === 'plan-review' && !out.planPath) throw new Error('--plan-path is required for plan-review');
  if (mode === 'docs-review' && out.docsPaths.length === 0 && !out.docsDir) throw new Error('--docs-path or --docs-dir is required for docs-review');
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) {
    throw new Error(`--timeout must be a positive finite number, got: ${out.timeout}`);
  }
  return out;
}
