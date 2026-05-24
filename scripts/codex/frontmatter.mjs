// Frontmatter renderers and parser used by the codex bridge.
// All renderers produce the YAML header block; parseFrontmatter reads back
// the scalar fields we write (block scalars are skipped).

export function fmString(key, value) {
  return `${key}: ${JSON.stringify(value)}`;
}

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

export function renderCodeReviewFrontmatter({
  slug, generated, codexVersion, templateVersion, gitHead, reviewTarget, baseRef, commit, title,
  cwd, codexThreadId, codexResumeStatus, codexResumedFrom,
}) {
  const lines = ['---'];
  lines.push('mode: code-review');
  lines.push(`slug: ${slug}`);
  lines.push(`generated: ${generated}`);
  lines.push(`codex-version: ${codexVersion}`);
  // template-version is sourced from templates/codex/code-review.md frontmatter
  // (see readTemplateWithVersion); resume.mjs compares the same value.
  lines.push(`template-version: ${templateVersion}`);
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
  slug, generated, codexVersion, templateVersion, docsTarget, diffBase,
  cwd, gitHead, codexThreadId, codexResumeStatus, codexResumedFrom,
}) {
  const lines = ['---'];
  lines.push('mode: docs-review');
  lines.push(`slug: ${slug}`);
  lines.push(`generated: ${generated}`);
  lines.push(`codex-version: ${codexVersion}`);
  // template-version sourced from templates/codex/docs-review.md frontmatter.
  lines.push(`template-version: ${templateVersion}`);
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
