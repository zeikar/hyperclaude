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
