// Output-path planning for the codex bridge.
// buildInvocation() turns a parsed argv into a concrete output path under
// .hyperclaude/<dir>/<timestamp>-<slug>.md, picking a -2/-3/... suffix on
// collision.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { slugify, slugifyRef, extractSlugFromPlanFilename } from './slug.mjs';

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
    if (args.docsPaths.length > 0) {
      const first = args.docsPaths[0];
      const firstSlug = slugify(path.basename(first, path.extname(first))) ?? 'docs';
      // The multi-file list slug is a human-readable LABEL, not a unique key:
      // different file sets sharing a first-file basename can collide on it.
      // That's fine — resume auto-discovery re-validates via loadResumeContext's
      // set-equality identity gate, and pickAvailablePath appends -2/-3 so no
      // artifact is ever overwritten. See docs/decisions.md.
      slug = args.docsPaths.length === 1
        ? firstSlug
        : `${firstSlug}-plus-${args.docsPaths.length - 1}`;
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
    dir = args.out ?? `.hyperclaude/${args.mode === 'research' ? 'research' : 'plan-reviews'}`;
  }
  const filename = slug ? `${timestamp}-${slug}.md` : `${timestamp}.md`;
  const baseOutputPath = path.join(dir, filename);
  const outputPath = pickAvailablePath(baseOutputPath);
  return { timestamp, slug, outputPath, dir };
}
