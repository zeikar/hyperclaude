#!/usr/bin/env node
// PostToolUse(Write) hook — SPIKE.
// Stamps Claude-authored .hyperclaude/ artifacts (plans, epic roadmaps,
// research-claude) with `plugin-version` deterministically, so provenance does
// not depend on the model remembering to write the line. Bridge-written
// artifacts already carry the key and are skipped by the idempotency check;
// they are also written via fs (not the Write tool), so this hook never fires
// for them. Fail-open: any error exits 0 without disturbing the tool flow.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPluginVersion } from '../scripts/codex/plugin.mjs';

function emitAndExit() {
  // PostToolUse: nothing to inject back into the model; continue silently.
  // suppressOutput keeps the per-Write `{continue:true}` out of the transcript.
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n');
  process.exit(0);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  const parsed = JSON.parse(input);
  const filePath = parsed?.tool_input?.file_path;
  const cwd = parsed?.cwd || process.cwd();
  if (typeof filePath !== 'string' || !filePath.endsWith('.md')) emitAndExit();

  // Only Claude-authored artifact dirs under <cwd>/.hyperclaude/.
  const abs = path.resolve(cwd, filePath);
  const hcRoot = path.resolve(cwd, '.hyperclaude') + path.sep;
  if (!abs.startsWith(hcRoot)) emitAndExit();

  const content = await readFile(abs, 'utf8');

  // Idempotent: skip if a plugin-version line already exists in a leading
  // frontmatter block (bridge artifacts, or a re-write of an already-stamped file).
  const hasFrontmatter = content.startsWith('---\n');
  if (hasFrontmatter) {
    const close = content.indexOf('\n---', 4);
    const fmBlock = close === -1 ? content : content.slice(0, close);
    if (/^plugin-version:/m.test(fmBlock)) emitAndExit();
  }

  const line = `plugin-version: ${getPluginVersion()}`;
  let next;
  if (hasFrontmatter) {
    // Insert as the first key, right after the opening '---' line.
    next = content.replace('---\n', `---\n${line}\n`);
  } else {
    next = `---\n${line}\n---\n\n${content}`;
  }

  await writeFile(abs, next, 'utf8');
  emitAndExit();
}

main().catch(() => {
  try { process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n'); } catch {}
  process.exit(0);
});
