import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';

const BRIDGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'codex-bridge.mjs'
);

// Mock codex script that succeeds: records argv and stdin, returns fake output.
const MOCK_CODEX_SUCCESS = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.128.0'
  exit 0
fi
echo "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
echo '### Prior Art'
echo '- nothing'
exit 0
`;

// Mock codex script that exits 7 with partial output and stderr.
const MOCK_CODEX_FAILURE = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.128.0'
  exit 0
fi
echo "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
printf 'partial output before failure'
printf 'mock codex failure' >&2
exit 7
`;

test('mock codex: bridge spawns codex with exact argv and pipes prompt via stdin', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-spawn-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const result = spawnSync(
      'node',
      [BRIDGE, 'research', '--task', 'verify spawn argv', '--timeout', '30', '--out', tmpdir],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
      }
    );

    // Bridge should exit 0 and report ok: true.
    assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, true);
    assert.ok(typeof json.path === 'string' && json.path.length > 0, 'json.path should be a non-empty string');

    // argv.log must contain exactly the four args (space-separated by echo "$@").
    const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8').trim();
    assert.equal(argvLog, 'exec --sandbox read-only -');

    // stdin.log must contain the rendered prompt with TASK substituted.
    const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');
    assert.ok(
      stdinLog.includes('verify spawn argv'),
      `stdin.log should contain "verify spawn argv", got: ${stdinLog.slice(0, 200)}`
    );

    // Output .md file must exist at the reported path, have YAML frontmatter,
    // and include the fake codex response.
    const outputPath = json.path;
    assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.startsWith('---\n'), 'output file should start with YAML frontmatter');
    assert.ok(outputContent.includes('---'), 'output file should close YAML frontmatter');
    assert.ok(
      outputContent.includes('### Prior Art'),
      'output file should include fake codex response'
    );
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: bridge handles failed codex (exit 7) — writes file and reports error', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-fail-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_FAILURE);
    chmodSync(mockCodexPath, 0o755);

    const result = spawnSync(
      'node',
      [BRIDGE, 'research', '--task', 'verify spawn argv', '--timeout', '30', '--out', tmpdir],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
      }
    );

    // Bridge should exit 1 on codex failure.
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, false);
    assert.ok(
      json.error && json.error.includes('codex exited 7'),
      `json.error should contain "codex exited 7", got: ${json.error}`
    );
    assert.ok(
      typeof json.path === 'string' && json.path.length > 0,
      'json.path should be present even on failure'
    );

    // Output file must still be written even on failure.
    const outputPath = json.path;
    assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.startsWith('---\n'), 'output file should have YAML frontmatter');
    assert.ok(
      outputContent.includes('# (codex failed)'),
      'output file should include failure marker'
    );
    assert.ok(
      outputContent.includes('partial output before failure'),
      'output file should include partial stdout'
    );
    assert.ok(
      outputContent.includes('mock codex failure'),
      'output file should include stderr'
    );
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});
