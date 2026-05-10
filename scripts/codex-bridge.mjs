#!/usr/bin/env node
// Codex bridge — see docs/specs/2026-05-10-v0.1-design.md §6.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
