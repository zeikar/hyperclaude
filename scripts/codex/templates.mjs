// Template helpers used by the codex bridge.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function loadTemplate(templateText, vars) {
  return templateText.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m;
  });
}

// Resolve a template file relative to this script's directory.
// `here` is `scripts/codex/`; templates live at `<repo>/templates/codex/`,
// so we walk up two segments.
export async function readTemplateFile(name) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filepath = path.join(here, '..', '..', 'templates', 'codex', `${name}.md`);
  return readFile(filepath, 'utf8');
}

// splitTemplateFrontmatter: parse the optional leading YAML frontmatter from a
// template body and extract `template-version`. Used only by fresh templates
// (research / plan-review / code-review / docs-review); *-resumed.md templates
// stay frontmatter-less by design and callers use loadTemplate directly.
//
// Returns { version: <integer>, body: <string after the closing --- + newline> }.
// Throws when frontmatter is missing, `template-version` is missing, or its
// value is not a positive integer — fresh templates MUST declare their version.
export function splitTemplateFrontmatter(text, nameForError = 'template') {
  if (typeof text !== 'string' || !text.startsWith('---\n')) {
    throw new Error(`${nameForError}: missing leading frontmatter (must start with '---\\n' + template-version)`);
  }
  const close = text.indexOf('\n---\n', 4);
  if (close === -1) {
    throw new Error(`${nameForError}: unterminated frontmatter (no closing '---' line)`);
  }
  const fmText = text.slice(0, close + 5); // include the closing "---\n"
  const body = text.slice(close + 5);
  const match = fmText.match(/^template-version:\s*(\d+)\s*$/m);
  if (!match) {
    throw new Error(`${nameForError}: frontmatter missing 'template-version: <positive integer>'`);
  }
  const version = Number(match[1]);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`${nameForError}: template-version must be a positive integer, got ${match[1]}`);
  }
  return { version, body };
}

// readTemplateWithVersion: convenience for fresh templates. Reads, splits, and
// returns { version, body } ready for loadTemplate(body, vars).
export async function readTemplateWithVersion(name) {
  const text = await readTemplateFile(name);
  return splitTemplateFrontmatter(text, name);
}

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
