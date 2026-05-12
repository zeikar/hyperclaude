#!/usr/bin/env node
// SessionStart hook — loads templates/hooks/session-start-reminder.md at runtime
// and injects its contents as additionalContext.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'hooks', 'session-start-reminder.md');

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    JSON.parse(input);
    const additionalContext = await readFile(templatePath, 'utf8');
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
