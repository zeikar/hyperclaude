#!/usr/bin/env node
// SessionStart hook — loads templates/hooks/session-start-reminder.md at
// runtime and injects its contents as additionalContext. When the project
// has a `.hyperclaude/` directory with recent artifacts, appends a short
// "snapshot" footer so a freshly-started session knows where to pick up.

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The loop-first router is injected only when the experimental agent-teams
// feature is enabled (the *-loop / hyper-auto skills require it); otherwise the
// default manual-first router is used. Matches setup-doctor's `=== '1'` check.
const reminderFile = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1'
  ? 'session-start-reminder-loop.md'
  : 'session-start-reminder.md';
const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'hooks', reminderFile);

const SNAPSHOT_SECTIONS = [
  { dir: 'plans', label: 'Active plan', countUnchecked: true },
  { dir: 'epics', label: 'Active epic roadmap' },
  { dir: 'specs', label: 'Recent spec' },
  { dir: 'research', label: 'Recent research' },
  { dir: 'plan-reviews', label: 'Recent plan-review' },
  { dir: 'code-reviews', label: 'Recent code-review' },
  { dir: 'docs-reviews', label: 'Recent docs-review' },
];

async function newestMarkdown(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const mdFiles = entries.filter((f) => f.endsWith('.md'));
  if (mdFiles.length === 0) return null;
  // Stat per-file with a local catch so one broken symlink, permission error,
  // or readdir/stat race cannot reject the whole Promise.all and disable the
  // SessionStart hook (the snapshot is optional local state).
  const stats = (await Promise.all(mdFiles.map(async (name) => {
    const path = resolve(dir, name);
    try {
      const st = await stat(path);
      return { name, path, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  }))).filter(Boolean);
  if (stats.length === 0) return null;
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0];
}

async function countUncheckedTasks(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');
    return (content.match(/^- \[ \]/gm) || []).length;
  } catch {
    return 0;
  }
}

async function buildSnapshotFooter(projectDir) {
  const hcRoot = resolve(projectDir, '.hyperclaude');
  try {
    const st = await stat(hcRoot);
    if (!st.isDirectory()) return '';
  } catch {
    return '';
  }

  const lines = [];
  for (const section of SNAPSHOT_SECTIONS) {
    const newest = await newestMarkdown(resolve(hcRoot, section.dir));
    if (!newest) continue;
    let suffix = '';
    if (section.countUnchecked) {
      const unchecked = await countUncheckedTasks(newest.path);
      if (unchecked > 0) {
        suffix = ` (${unchecked} unchecked task${unchecked === 1 ? '' : 's'})`;
      }
    }
    lines.push(`- ${section.label}: \`.hyperclaude/${section.dir}/${newest.name}\`${suffix}`);
  }

  if (lines.length === 0) return '';

  return [
    '',
    '---',
    '',
    '## .hyperclaude/ snapshot',
    '',
    ...lines,
    '',
    'If picking up where you left off, consult these artifacts.',
    '',
  ].join('\n');
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    const parsed = JSON.parse(input);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || parsed.cwd || process.cwd();
    const template = await readFile(templatePath, 'utf8');
    const footer = await buildSnapshotFooter(projectDir);
    const additionalContext = template + footer;
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    }) + '\n');
  } catch (err) {
    process.stderr.write(`[session-start-reminder] ${err?.message ?? err}\n`);
    process.stdout.write(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }) + '\n');
  }
}

main();
