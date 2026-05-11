// Slug helpers used by the codex bridge.

import path from 'node:path';

export function slugify(input) {
  if (typeof input !== 'string') return null;
  // Drop non-ASCII, lowercase, then keep alnum + spaces.
  const ascii = input.replace(/[^\x00-\x7f]/g, '');
  const cleaned = ascii.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return null;
  return words.join('-');
}

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

// Plan files are named `<YYYYMMDD-HHMM>-<slug>.md` per convention.
// Strip the timestamp prefix so the review reuses the plan's slug — preserves
// the same-slug traceability of the research → plan → review trio.
export function extractSlugFromPlanFilename(planPath) {
  const base = path.basename(planPath, '.md');
  const m = base.match(/^\d{8}-\d{4}-(.+)$/);
  return m ? m[1] : base;
}
