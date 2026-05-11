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
  mkdirSync,
} from 'node:fs';
import os from 'node:os';
import { readdirSync } from 'node:fs';
import { runCodexResume, parseFrontmatter } from '../scripts/codex-bridge.mjs';

const BRIDGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'codex-bridge.mjs'
);

// ---------------------------------------------------------------------------
// Inline mock codex scripts.
//
// Codex >= 0.130 exposes `--json` + `--output-last-message <path>`. The bridge
// inserts those flags right after the subcommand tokens. Each `exec`/`exec review`
// mock therefore:
//   - replies "codex-cli 0.130.0" to `--version`
//   - records the full argv (one per line) to argv.log
//   - parses --output-last-message from argv and writes the expected body there
//   - captures stdin to stdin.log
//   - emits JSONL on stdout (thread.started, turn.started, item.completed, turn.completed)
//
// `codex review` (the v0.3 path used by code-review until Task 5) does NOT support
// --json; those mocks remain markdown-only.
// ---------------------------------------------------------------------------

// Mock codex script for `exec` success: emits JSONL stream + writes last message
// to the path supplied via --output-last-message.
//
// We walk "$@" looking for --output-last-message and capture the next arg.
// Use a `prev` flag so the script doesn't need indexed-array dereferences
// (avoids \${!i}-style syntax that conflicts with JS template literals).
const MOCK_CODEX_SUCCESS = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.130.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
last_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last_path="$arg"; fi
  prev="$arg"
done
cat > "$(dirname "$0")/stdin.log"
printf '### Prior Art\\n- nothing\\n' > "$last_path"
printf '%s\\n' '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000001"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"item_type":"agent_message","text":"### Prior Art\\n- nothing\\n"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
exit 0
`;

// Mock codex script for `exec` failure: exits 7 with stderr; no turn.completed.
const MOCK_CODEX_FAILURE = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.130.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
last_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last_path="$arg"; fi
  prev="$arg"
done
cat > "$(dirname "$0")/stdin.log"
printf 'partial output before failure' > "$last_path"
printf '%s\\n' '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000ff"}'
printf '%s\\n' '{"type":"turn.started"}'
printf 'mock codex failure' >&2
exit 7
`;

// Mock codex script for `codex exec review` success: JSONL shape (v0.4+).
const MOCK_CODEX_REVIEW_SUCCESS = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.130.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
last_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last_path="$arg"; fi
  prev="$arg"
done
cat > "$(dirname "$0")/stdin.log"
printf '## Findings\\n- none\\n' > "$last_path"
printf '%s\\n' '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000cr"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"item_type":"agent_message","text":"## Findings\\n- none\\n"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":8,"output_tokens":4}}'
exit 0
`;

// Mock codex script for `codex exec review` failure: JSONL shape, no turn.completed.
const MOCK_CODEX_REVIEW_FAILURE = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.130.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
last_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last_path="$arg"; fi
  prev="$arg"
done
cat > "$(dirname "$0")/stdin.log"
printf 'partial review output' > "$last_path"
printf '%s\\n' '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000ce"}'
printf '%s\\n' '{"type":"turn.started"}'
printf 'mock review failure' >&2
exit 7
`;

// Mock codex script for docs-review success (uses `codex exec`).
const MOCK_CODEX_DOCS_REVIEW_SUCCESS = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.130.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
last_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last_path="$arg"; fi
  prev="$arg"
done
cat > "$(dirname "$0")/stdin.log"
printf '### Findings\\n- none\\n' > "$last_path"
printf '%s\\n' '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000d0"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"item_type":"agent_message","text":"### Findings\\n- none\\n"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'
exit 0
`;

// Mock codex script for docs-review failure (uses `codex exec`): no turn.completed.
const MOCK_CODEX_DOCS_REVIEW_FAILURE = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.130.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
last_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last_path="$arg"; fi
  prev="$arg"
done
cat > "$(dirname "$0")/stdin.log"
printf 'partial docs output' > "$last_path"
printf '%s\\n' '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-0000000000d1"}'
printf 'mock docs failure' >&2
exit 7
`;

test('mock codex: bridge spawns codex exec with --json + --output-last-message inserted right after subcommand', () => {
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

    // argv.log is one arg per line. The semantic argv is `exec --sandbox read-only -`,
    // and runCodexExec MUST insert `--json --output-last-message <tmp>` immediately
    // after `exec` (i.e. before `--sandbox`).
    const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
    const argv = argvLog.split('\n').filter((l) => l.length > 0);
    assert.equal(argv[0], 'exec', `first arg should be exec, got: ${argv[0]}`);
    assert.equal(argv[1], '--json', `second arg should be --json, got: ${argv[1]}`);
    assert.equal(argv[2], '--output-last-message', `third arg should be --output-last-message, got: ${argv[2]}`);
    assert.ok(argv[3] && argv[3].length > 0, 'fourth arg (tempfile path) should be non-empty');
    assert.deepEqual(
      argv.slice(4),
      ['--sandbox', 'read-only', '-'],
      `tail after injected flags should be [--sandbox, read-only, -], got: ${JSON.stringify(argv.slice(4))}`,
    );

    // stdin.log must contain the rendered prompt with TASK substituted.
    const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');
    assert.ok(
      stdinLog.includes('verify spawn argv'),
      `stdin.log should contain "verify spawn argv", got: ${stdinLog.slice(0, 200)}`
    );

    // Output .md file must exist at the reported path, have YAML frontmatter,
    // and include the body Codex wrote to --output-last-message (NOT raw stdout).
    const outputPath = json.path;
    assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.startsWith('---\n'), 'output file should start with YAML frontmatter');
    assert.ok(outputContent.includes('---'), 'output file should close YAML frontmatter');
    assert.ok(
      outputContent.includes('### Prior Art'),
      'output file should include the body from --output-last-message'
    );
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: bridge handles failed codex (exit 7) — writes file and reports structured failure body', () => {
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

    // Output file must still be written on failure with the structured failure body.
    const outputPath = json.path;
    assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.startsWith('---\n'), 'output file should have YAML frontmatter');
    assert.ok(outputContent.includes('# (codex failed)'), 'failure marker present');
    // JSONL parser report sections must be present.
    assert.ok(outputContent.includes('## JSONL parser report'), 'JSONL parser report section present');
    assert.ok(outputContent.includes('thread.started: yes'), 'parser saw thread.started');
    assert.ok(outputContent.includes('turn.completed: no'), 'parser saw NO turn.completed');
    // Last message contents (tempfile body) must be embedded.
    assert.ok(outputContent.includes('## Last message (from --output-last-message)'), 'last-message section present');
    assert.ok(outputContent.includes('partial output before failure'), 'last-message body embedded');
    // stderr verbatim.
    assert.ok(outputContent.includes('## stderr'), 'stderr section present');
    assert.ok(outputContent.includes('mock codex failure'), 'stderr verbatim');
    // Exit line.
    assert.ok(/status=7,\s*signal=(?:null|SIG[A-Z]+),\s*timed-out=false/.test(outputContent), 'exit line with status=7');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review --base main spawns exec review with --json injected after exec review, no stdin', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-cr-base-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [BRIDGE, 'code-review', '--out', tmpdir],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
      }
    );

    assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, true);

    // argv.log is one arg per line.
    // Semantic argv: ['exec', 'review', '-c', 'sandbox_mode=read-only', '--base', 'main']
    // runCodexExec inserts --json --output-last-message <tmp> after 'exec review'.
    // Expected: exec review --json --output-last-message <tmp> -c sandbox_mode=read-only --base main
    const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
    const argv = argvLog.split('\n').filter((l) => l.length > 0);
    assert.equal(argv[0], 'exec', `argv[0] should be exec, got: ${argv[0]}`);
    assert.equal(argv[1], 'review', `argv[1] should be review, got: ${argv[1]}`);
    assert.equal(argv[2], '--json', `argv[2] should be --json, got: ${argv[2]}`);
    assert.equal(argv[3], '--output-last-message', `argv[3] should be --output-last-message, got: ${argv[3]}`);
    assert.ok(argv[4] && argv[4].length > 0, 'argv[4] should be the tempfile path');
    assert.deepEqual(
      argv.slice(5),
      ['-c', 'sandbox_mode=read-only', '--base', 'main'],
      `tail should be [-c, sandbox_mode=read-only, --base, main], got: ${JSON.stringify(argv.slice(5))}`,
    );

    // stdin.log must be empty — exec review takes no stdin (stdio[0] = 'ignore').
    const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');
    assert.equal(stdinLog.length, 0, 'stdin.log should be empty (bridge must not pipe stdin to exec review)');

    // No positional '-' token.
    assert.ok(!argv.includes('-'), 'argv must not contain a positional - token');

    // Output file checks.
    const outputPath = json.path;
    assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.startsWith('---\n'), 'output should start with YAML frontmatter');
    assert.ok(outputContent.includes('mode: code-review'), 'frontmatter should contain mode: code-review');
    assert.doesNotMatch(outputContent, /codex-subcommand:/, 'frontmatter must NOT contain codex-subcommand:');
    assert.ok(outputContent.includes('base-ref: "main"'), 'frontmatter should contain base-ref: "main"');
    assert.ok(outputContent.includes('codex-thread-id:'), 'frontmatter should contain codex-thread-id');
    assert.ok(outputContent.includes('codex-resume-status: fresh'), 'frontmatter should contain codex-resume-status: fresh');
    assert.ok(outputContent.includes('## Findings'), 'body should include fake review output');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review --uncommitted spawns exec review -c sandbox_mode=read-only --uncommitted', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-cr-uncommitted-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [BRIDGE, 'code-review', '--uncommitted', '--out', tmpdir],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
      }
    );

    assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, true);

    const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
    const argv = argvLog.split('\n').filter((l) => l.length > 0);
    assert.equal(argv[0], 'exec');
    assert.equal(argv[1], 'review');
    assert.equal(argv[2], '--json');
    assert.equal(argv[3], '--output-last-message');
    assert.ok(argv[4] && argv[4].length > 0, 'argv[4] should be the tempfile path');
    assert.deepEqual(argv.slice(5), ['-c', 'sandbox_mode=read-only', '--uncommitted']);
    assert.ok(!argv.includes('-'), 'argv must not contain a positional - token');

    assert.equal(json.slug, 'uncommitted', 'slug should be "uncommitted"');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review --commit abc1234f spawns exec review -c sandbox_mode=read-only --commit abc1234f', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-cr-commit-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [BRIDGE, 'code-review', '--commit', 'abc1234f', '--out', tmpdir],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
      }
    );

    assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, true);

    const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
    const argv = argvLog.split('\n').filter((l) => l.length > 0);
    assert.equal(argv[0], 'exec');
    assert.equal(argv[1], 'review');
    assert.equal(argv[2], '--json');
    assert.equal(argv[3], '--output-last-message');
    assert.ok(argv[4] && argv[4].length > 0, 'argv[4] should be the tempfile path');
    assert.deepEqual(argv.slice(5), ['-c', 'sandbox_mode=read-only', '--commit', 'abc1234f']);
    assert.ok(!argv.includes('-'), 'argv must not contain a positional - token');

    const outputPath = json.path;
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.includes('commit: "abc1234f"'), 'frontmatter should contain commit: "abc1234f"');
    assert.equal(json.slug, 'commit-abc1234', 'slug should be "commit-abc1234"');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review --title appended last (after target flags)', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-cr-title-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [BRIDGE, 'code-review', '--base', 'main', '--title', 'My Review', '--out', tmpdir],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
      }
    );

    assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, true);

    const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
    const argv = argvLog.split('\n').filter((l) => l.length > 0);
    assert.equal(argv[0], 'exec');
    assert.equal(argv[1], 'review');
    assert.equal(argv[2], '--json');
    assert.equal(argv[3], '--output-last-message');
    assert.ok(argv[4] && argv[4].length > 0, 'argv[4] should be the tempfile path');
    assert.deepEqual(
      argv.slice(5),
      ['-c', 'sandbox_mode=read-only', '--base', 'main', '--title', 'My Review'],
    );
    assert.ok(!argv.includes('-'), 'argv must not contain a positional - token');

    const outputPath = json.path;
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.includes('title: "My Review"'), 'frontmatter should contain title: "My Review"');
    assert.ok(outputContent.includes('# Code review: My Review'), 'body should have titled heading');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review failure (exit 7) writes structured failure body and reports error', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-cr-fail-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_FAILURE);
    chmodSync(mockCodexPath, 0o755);

    const result = spawnSync(
      process.execPath,
      [BRIDGE, 'code-review', '--out', tmpdir],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
      }
    );

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

    const outputPath = json.path;
    assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.startsWith('---\n'), 'output file should have YAML frontmatter');
    assert.ok(outputContent.includes('# (codex failed)'), 'output file should include failure marker');
    // Structured failure body sections.
    assert.ok(outputContent.includes('## JSONL parser report'), 'JSONL parser report section present');
    assert.ok(outputContent.includes('thread.started: yes'), 'parser saw thread.started');
    assert.ok(outputContent.includes('turn.completed: no'), 'parser saw NO turn.completed');
    assert.ok(outputContent.includes('## Last message (from --output-last-message)'), 'last-message section present');
    assert.ok(outputContent.includes('partial review output'), 'last-message body embedded');
    assert.ok(outputContent.includes('## stderr'), 'stderr section present');
    assert.ok(outputContent.includes('mock review failure'), 'stderr verbatim');
    assert.ok(/status=7,\s*signal=(?:null|SIG[A-Z]+),\s*timed-out=false/.test(outputContent), 'exit line with status=7');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// docs-review tests
// ---------------------------------------------------------------------------

test('mock codex: docs-review --docs-path spawns codex exec --sandbox read-only - with DOCS in stdin', async () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-path-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const docPath = path.join(tmpdir, 'test-doc.md');
    writeFileSync(docPath, '# Test Doc\n\nHello from test-doc.\n');

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-out-'));
    try {
      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);

      // argv.log is one-arg-per-line. Pinned ordering: `--json --output-last-message <tmp>`
      // are inserted by runCodexExec right after `exec`, before `--sandbox`.
      const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
      const argv = argvLog.split('\n').filter((l) => l.length > 0);
      assert.equal(argv[0], 'exec');
      assert.equal(argv[1], '--json');
      assert.equal(argv[2], '--output-last-message');
      assert.ok(argv[3] && argv[3].length > 0, 'tempfile path arg should be non-empty');
      assert.deepEqual(argv.slice(4), ['--sandbox', 'read-only', '-']);

      // stdin.log must contain the doc content AND a file marker so Codex
      // can attribute findings to the path.
      const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');
      assert.ok(
        stdinLog.includes('Hello from test-doc.'),
        `stdin.log should contain doc content, got: ${stdinLog.slice(0, 200)}`
      );
      assert.ok(
        stdinLog.includes(`## File: ${docPath}`),
        `stdin.log should contain "## File: <path>" marker, got: ${stdinLog.slice(0, 300)}`
      );

      // Output file checks
      const outputPath = json.path;
      assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
      const outputContent = readFileSync(outputPath, 'utf8');
      assert.ok(outputContent.startsWith('---\n'), 'output should start with YAML frontmatter');
      assert.ok(outputContent.includes('mode: docs-review'), 'frontmatter should contain mode: docs-review');
      assert.ok(outputContent.includes('template-version: 1'), 'frontmatter should contain template-version: 1');
      assert.ok(outputContent.includes('docs-target:'), 'frontmatter should contain docs-target:');
      assert.ok(outputContent.includes('### Findings'), 'body should include fake codex output');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: docs-review --docs-path output path uses slug from basename', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-slug-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const docPath = path.join(tmpdir, 'test-doc.md');
    writeFileSync(docPath, '# Test Doc\n\nSome content.\n');

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-out2-'));
    try {
      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);
      assert.equal(json.slug, 'test-doc', `slug should be "test-doc", got: ${json.slug}`);
      assert.ok(
        /\d{8}-\d{4}-test-doc\.md$/.test(json.path),
        `json.path should match /\\d{8}-\\d{4}-test-doc\\.md$, got: ${json.path}`
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: docs-review --docs-dir sends all .md files with file markers in stdin', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-dir-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const docsDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-docs-'));
    try {
      writeFileSync(path.join(docsDir, 'a.md'), '# Alpha\n\nContent of alpha.\n');
      writeFileSync(path.join(docsDir, 'b.md'), '# Beta\n\nContent of beta.\n');

      const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-out3-'));
      try {
        const result = spawnSync(
          process.execPath,
          [BRIDGE, 'docs-review', '--docs-dir', docsDir, '--out', outDir],
          {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
          }
        );

        assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
        const json = JSON.parse(result.stdout);
        assert.equal(json.ok, true);

        const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');

        // Both file markers must appear in alphabetical order
        const posA = stdinLog.indexOf('## File: a.md');
        const posB = stdinLog.indexOf('## File: b.md');
        assert.ok(posA >= 0, 'stdin.log should contain "## File: a.md"');
        assert.ok(posB >= 0, 'stdin.log should contain "## File: b.md"');
        assert.ok(posA < posB, '"## File: a.md" must appear before "## File: b.md"');

        // Content of both files must be present
        assert.ok(stdinLog.includes('Content of alpha.'), 'stdin.log should contain alpha content');
        assert.ok(stdinLog.includes('Content of beta.'), 'stdin.log should contain beta content');

        // Slug should be the slugified (lowercased) directory basename
        const dirBasename = path.basename(docsDir);
        const expectedSlug = dirBasename.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '').split('-').slice(0, 5).join('-');
        assert.equal(json.slug, expectedSlug, `slug should equal slugified dir basename "${expectedSlug}", got: ${json.slug}`);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(docsDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: docs-review --docs-dir errors on empty directory', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-empty-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-nomd-'));
    try {
      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-dir', emptyDir, '--out', tmpdir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.ok(
        json.error && /no \.md files/.test(json.error),
        `json.error should match /no\\.md files/, got: ${json.error}`
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: docs-review --diff-base passes git diff output as DIFF', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-diff-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    // Set up a tiny git repo
    const gitRepo = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-repo-'));
    try {
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: gitRepo,
      };

      spawnSync('git', ['init', gitRepo], { encoding: 'utf8' });
      spawnSync('git', ['-C', gitRepo, 'config', 'user.email', 'test@test.com'], { encoding: 'utf8' });
      spawnSync('git', ['-C', gitRepo, 'config', 'user.name', 'Test'], { encoding: 'utf8' });

      // First commit
      writeFileSync(path.join(gitRepo, 'file.txt'), 'original content\n');
      spawnSync('git', ['-C', gitRepo, 'add', 'file.txt'], { encoding: 'utf8', env: gitEnv });
      spawnSync('git', ['-C', gitRepo, 'commit', '-m', 'first commit'], { encoding: 'utf8', env: gitEnv });
      const firstShaResult = spawnSync('git', ['-C', gitRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      const firstSha = firstShaResult.stdout.trim();

      // Second commit with a distinctive modification
      writeFileSync(path.join(gitRepo, 'file.txt'), 'original content\ndistinctive-modification-xyz\n');
      spawnSync('git', ['-C', gitRepo, 'add', 'file.txt'], { encoding: 'utf8', env: gitEnv });
      spawnSync('git', ['-C', gitRepo, 'commit', '-m', 'second commit'], { encoding: 'utf8', env: gitEnv });

      // Write a docs file in the git repo for the bridge to read
      const docPath = path.join(gitRepo, 'readme.md');
      writeFileSync(docPath, '# Readme\n\nDoc content.\n');

      const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-out4-'));
      try {
        const result = spawnSync(
          process.execPath,
          [BRIDGE, 'docs-review', '--docs-path', docPath, '--diff-base', firstSha, '--out', outDir],
          {
            encoding: 'utf8',
            cwd: gitRepo,
            env: { ...gitEnv, PATH: `${tmpdir}:${process.env.PATH}` },
          }
        );

        assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
        const json = JSON.parse(result.stdout);
        assert.equal(json.ok, true);

        const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');

        // The diff content (the distinctive modification) must be present
        assert.ok(
          stdinLog.includes('distinctive-modification-xyz'),
          `stdin.log should contain the diff content "distinctive-modification-xyz", got: ${stdinLog.slice(0, 400)}`
        );

        // The literal placeholder {{DIFF}} must NOT be present
        assert.ok(
          !stdinLog.includes('{{DIFF}}'),
          'stdin.log must not contain literal "{{DIFF}}" placeholder'
        );
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(gitRepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: docs-review failure (exit 7) writes file and reports error', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-fail-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_FAILURE);
    chmodSync(mockCodexPath, 0o755);

    const docPath = path.join(tmpdir, 'sample.md');
    writeFileSync(docPath, '# Sample\n\nSome content.\n');

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-out5-'));
    try {
      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

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

      const outputPath = json.path;
      assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
      const outputContent = readFileSync(outputPath, 'utf8');
      assert.ok(outputContent.startsWith('---\n'), 'output file should have YAML frontmatter');
      assert.ok(outputContent.includes('# (codex failed)'), 'output file should include failure marker');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: docs-review 200KB guard rejects oversized payload', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-dr-guard-'));
  try {
    // Create a .md file with 201KB content
    const oversizedContent = Buffer.alloc(201 * 1024, 'a').toString();
    const docPath = path.join(tmpdir, 'big.md');
    writeFileSync(docPath, oversizedContent);

    const result = spawnSync(
      process.execPath,
      [BRIDGE, 'docs-review', '--docs-path', docPath, '--out', tmpdir],
      {
        encoding: 'utf8',
        // Use a PATH where codex does not exist — guard fires before spawn
        env: { ...process.env, PATH: '/nonexistent' },
      }
    );

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, false);
    assert.ok(
      json.error && /exceeds 200KB/.test(json.error),
      `json.error should match /exceeds 200KB/, got: ${json.error}`
    );
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 3: runCodexResume tests
// ---------------------------------------------------------------------------

// Mock codex for exec resume success: emits JSONL including thread.started,
// and writes the last-message body to --output-last-message.
const MOCK_CODEX_RESUME_SUCCESS = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.130.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
last_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last_path="$arg"; fi
  prev="$arg"
done
cat > "$(dirname "$0")/stdin.log"
printf '### Updated Critique\\n- no new issues\\n' > "$last_path"
printf '%s\\n' '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000099"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"item_type":"agent_message","text":"### Updated Critique\\n- no new issues\\n"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":3}}'
exit 0
`;

// Mock codex for exec resume where thread.started is omitted (simulate real
// Codex behaviour where it may not re-emit thread.started on resume turns).
const MOCK_CODEX_RESUME_NO_THREAD_STARTED = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.130.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
last_path=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then last_path="$arg"; fi
  prev="$arg"
done
cat > "$(dirname "$0")/stdin.log"
printf '### Resumed body\\n' > "$last_path"
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}'
exit 0
`;

test('runCodexResume: argv shape — exec resume -c sandbox_mode=read-only <threadId> with --json injected after exec resume', async () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-resume-argv-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_RESUME_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const origPath = process.env.PATH;
    process.env.PATH = `${tmpdir}:${origPath}`;
    try {
      const result = await runCodexResume('test-thread-id-123', 'continue the review', 30);
      assert.equal(result.ok, true, `runCodexResume should succeed, reason: ${result.reason}`);
    } finally {
      process.env.PATH = origPath;
    }

    // argv.log is one arg per line.
    // Semantic argv passed to runCodexExec is:
    //   ['exec', 'resume', '-c', 'sandbox_mode=read-only', 'test-thread-id-123', '-']
    // runCodexExec inserts --json --output-last-message <tmp> after 'exec resume' tokens.
    // Expected final argv: exec resume --json --output-last-message <tmp> -c sandbox_mode=read-only test-thread-id-123 -
    const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
    const argv = argvLog.split('\n').filter((l) => l.length > 0);
    assert.equal(argv[0], 'exec', `argv[0] should be exec, got: ${argv[0]}`);
    assert.equal(argv[1], 'resume', `argv[1] should be resume, got: ${argv[1]}`);
    assert.equal(argv[2], '--json', `argv[2] should be --json, got: ${argv[2]}`);
    assert.equal(argv[3], '--output-last-message', `argv[3] should be --output-last-message, got: ${argv[3]}`);
    assert.ok(argv[4] && argv[4].length > 0, 'argv[4] should be the tempfile path');
    assert.equal(argv[5], '-c', `argv[5] should be -c, got: ${argv[5]}`);
    assert.equal(argv[6], 'sandbox_mode=read-only', `argv[6] should be sandbox_mode=read-only, got: ${argv[6]}`);
    assert.equal(argv[7], 'test-thread-id-123', `argv[7] should be the thread id, got: ${argv[7]}`);
    assert.equal(argv[8], '-', `argv[8] should be -, got: ${argv[8]}`);
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('runCodexResume: knownThreadId propagates as result.threadId when thread.started absent from JSONL', async () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-resume-tid-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_RESUME_NO_THREAD_STARTED);
    chmodSync(mockCodexPath, 0o755);

    const origPath = process.env.PATH;
    process.env.PATH = `${tmpdir}:${origPath}`;
    let result;
    try {
      result = await runCodexResume('my-known-thread-id', 'resume prompt', 30);
    } finally {
      process.env.PATH = origPath;
    }

    assert.equal(result.ok, true, `should succeed, reason: ${result.reason}`);
    assert.equal(
      result.threadId,
      'my-known-thread-id',
      `threadId should be the knownThreadId "my-known-thread-id", got: ${result.threadId}`
    );
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 4: --resume integration tests (review + docs-review).
// ---------------------------------------------------------------------------

// Helper: write a prior-artifact fixture with valid-looking frontmatter.
function writePriorArtifact(filePath, fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === 'mode' || k === 'codex-resume-status') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push('---');
  lines.push('# Prior body');
  writeFileSync(filePath, lines.join('\n'));
}

test('resume happy path: docs-review --resume <prev> spawns exec resume and writes resumed status', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-dr-ok-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_RESUME_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const docPath = path.join(tmpdir, 'api.md');
    writeFileSync(docPath, '# API\n\nDoc body.\n');

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-dr-out-'));
    try {
      // Prior artifact: valid identity, status fresh, our cwd, our docs target.
      const prior = path.join(outDir, '20260510-1015-api.md');
      writePriorArtifact(prior, {
        mode: 'docs-review',
        slug: 'api',
        cwd: process.cwd(),
        'docs-target': docPath,
        'codex-thread-id': 'thread-resume-1',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);
      assert.equal(json.resumeStatus, 'resumed');
      assert.ok(typeof json.threadId === 'string' && json.threadId.length > 0, 'threadId should be present');

      // argv inserted after `exec resume`: --json --output-last-message <tmp> -c sandbox_mode=read-only <threadId> -
      const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
      const argv = argvLog.split('\n').filter((l) => l.length > 0);
      assert.equal(argv[0], 'exec');
      assert.equal(argv[1], 'resume');
      assert.equal(argv[5], '-c');
      assert.equal(argv[6], 'sandbox_mode=read-only');
      assert.equal(argv[7], 'thread-resume-1');

      // Output frontmatter should reflect resume.
      const outputContent = readFileSync(json.path, 'utf8');
      assert.ok(outputContent.includes('codex-resume-status: resumed'), 'frontmatter should record resumed status');
      assert.ok(outputContent.includes(`codex-resumed-from: ${JSON.stringify(prior)}`), 'frontmatter should record resumed-from path');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume validation fail (explicit path, mode mismatch) → ok:false, no fresh fallback, no artifact', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-dr-fail-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const docPath = path.join(tmpdir, 'api.md');
    writeFileSync(docPath, '# API\n\nbody.\n');

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-dr-fail-out-'));
    try {
      // Prior artifact has mode: review (mismatch with docs-review).
      const prior = path.join(outDir, '20260510-1015-old.md');
      writePriorArtifact(prior, {
        mode: 'review',
        slug: 'old',
        cwd: process.cwd(),
        'plan-path': '/tmp/p.md',
        'codex-thread-id': 'thread-x',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 1, `expected exit 1, stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.match(json.error, /resume rejected:/);
      assert.equal(json.resumeStatus, 'fallback');
      assert.equal(json.threadId, null);
      assert.equal(json.path, null);

      // No new fresh artifact should have been written.
      const remaining = readFileSync(prior, 'utf8');
      assert.ok(remaining.length > 0, 'prior artifact still readable');
      // Codex must NOT have been spawned (no argv.log).
      assert.ok(!existsSync(path.join(tmpdir, 'argv.log')), 'codex must not be spawned on explicit-path validation failure');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume auto with no candidate → fallback to fresh + stderr note + status fallback', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-auto-none-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const docPath = path.join(tmpdir, 'api.md');
    writeFileSync(docPath, '# API\n\nbody.\n');

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-auto-none-out-'));
    try {
      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--resume', 'auto', '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);
      assert.equal(json.resumeStatus, 'fallback', 'status should be fallback after auto miss');
      assert.match(result.stderr, /hyperclaude: resume fallback —/);

      // Fresh artifact written.
      const outputContent = readFileSync(json.path, 'utf8');
      assert.ok(outputContent.includes('codex-resume-status: fallback'));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume size-budget exceeded (200KB docs payload on resume) → ok:false, fallback status, no spawn', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-budget-'));
  try {
    // Codex must NOT be spawned; provide stub codex on PATH that would record argv if invoked.
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_RESUME_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    // 201KB doc — over the 200KB cap.
    const oversized = Buffer.alloc(201 * 1024, 'a').toString();
    const docPath = path.join(tmpdir, 'big.md');
    writeFileSync(docPath, oversized);

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-budget-out-'));
    try {
      const prior = path.join(outDir, '20260510-1015-big.md');
      writePriorArtifact(prior, {
        mode: 'docs-review',
        slug: 'big',
        cwd: process.cwd(),
        'docs-target': docPath,
        'codex-thread-id': 'thread-budget',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 1);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.match(json.error, /^resume rejected:/);
      assert.match(json.error, /200KB/);
      assert.match(json.error, /narrow scope/);
      assert.equal(json.resumeStatus, 'fallback');

      // Codex must not have been spawned.
      assert.ok(!existsSync(path.join(tmpdir, 'argv.log')), 'codex must not be spawned when guard fires');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume spawn fails (codex exits 7) → status resume-failed, failure body written, ok:false', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-spawnfail-'));
  try {
    // Use docs-review failure mock — same JSONL "no turn.completed" shape on resume.
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_DOCS_REVIEW_FAILURE);
    chmodSync(mockCodexPath, 0o755);

    const docPath = path.join(tmpdir, 'api.md');
    writeFileSync(docPath, '# API\n');

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-spawnfail-out-'));
    try {
      const prior = path.join(outDir, '20260510-1015-api.md');
      writePriorArtifact(prior, {
        mode: 'docs-review',
        slug: 'api',
        cwd: process.cwd(),
        'docs-target': docPath,
        'codex-thread-id': 'thread-spawnfail',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 1);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.equal(json.resumeStatus, 'resume-failed');
      assert.ok(typeof json.path === 'string' && json.path.length > 0, 'failure should still record path');

      const outputContent = readFileSync(json.path, 'utf8');
      assert.ok(outputContent.includes('# (codex failed)'), 'failure body should be written');
      assert.ok(outputContent.includes('codex-resume-status: resume-failed'), 'frontmatter status should be resume-failed');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume auto honors --out: discovers prior under custom dir, not the default', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-auto-out-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_RESUME_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const docPath = path.join(tmpdir, 'api.md');
    writeFileSync(docPath, '# API\n\nbody.\n');

    const customDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-custom-'));
    try {
      // Prior in customDir only (not in .hyperclaude/docs-reviews/).
      const prior = path.join(customDir, '20260510-1015-api.md');
      writePriorArtifact(prior, {
        mode: 'docs-review',
        slug: 'api',
        cwd: process.cwd(),
        'docs-target': docPath,
        'codex-thread-id': 'thread-from-custom-dir',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'docs-review', '--docs-path', docPath, '--resume', 'auto', '--out', customDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);
      assert.equal(json.resumeStatus, 'resumed');
      assert.ok(typeof json.threadId === 'string' && json.threadId.length > 0, 'threadId should be present');

      // argv must include the discovered thread id (passed to codex resume).
      const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
      const argv = argvLog.split('\n').filter((l) => l.length > 0);
      assert.equal(argv[7], 'thread-from-custom-dir', 'argv[7] should be the thread id discovered from custom --out dir');

      // Frontmatter records resumed-from with the customDir path.
      const outputContent = readFileSync(json.path, 'utf8');
      assert.ok(
        outputContent.includes(`codex-resumed-from: ${JSON.stringify(prior)}`),
        'frontmatter should reference the prior artifact found in custom --out dir'
      );
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume happy path: review --resume <prev> spawns exec resume', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-rev-ok-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_RESUME_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const planPath = path.join(tmpdir, '20260510-1015-oauth.md');
    writeFileSync(planPath, '# Plan v2\n\nUpdated plan body.\n');

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-rev-out-'));
    try {
      const prior = path.join(outDir, '20260510-1130-oauth.md');
      writePriorArtifact(prior, {
        mode: 'review',
        slug: 'oauth',
        cwd: process.cwd(),
        'plan-path': planPath,
        'codex-thread-id': 'thread-rev-resume',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'review', '--plan-path', planPath, '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);
      assert.equal(json.resumeStatus, 'resumed');
      assert.ok(typeof json.threadId === 'string' && json.threadId.length > 0, 'threadId should be present');

      // argv shape: exec resume ... -c sandbox_mode=read-only <threadId> -
      // The threadId passed to codex must be the prior artifact's id (knownThreadId).
      const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
      const argv = argvLog.split('\n').filter((l) => l.length > 0);
      assert.equal(argv[0], 'exec');
      assert.equal(argv[1], 'resume');
      assert.equal(argv[7], 'thread-rev-resume');

      // Resumed prompt must mention the plan path.
      const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');
      assert.ok(stdinLog.includes(planPath), 'resumed prompt should embed the plan path');

      // Frontmatter records resumed status + resumed-from.
      const outputContent = readFileSync(json.path, 'utf8');
      assert.ok(outputContent.includes('codex-resume-status: resumed'));
      assert.ok(outputContent.includes(`codex-resumed-from: ${JSON.stringify(prior)}`));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 5: code-review --resume integration tests
// ---------------------------------------------------------------------------

test('resume happy path: code-review --resume <prev> spawns exec resume and writes resumed status', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-ok-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_RESUME_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-ok-out-'));
    try {
      const prior = path.join(outDir, '20260510-1015-vs-main.md');
      writePriorArtifact(prior, {
        mode: 'code-review',
        cwd: process.cwd(),
        'base-ref': 'main',
        'codex-thread-id': 'thread-cr-1',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'code-review', '--base', 'main', '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);
      assert.equal(json.resumeStatus, 'resumed');

      // argv shape: exec resume --json --output-last-message <tmp> -c sandbox_mode=read-only <threadId> -
      const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
      const argv = argvLog.split('\n').filter((l) => l.length > 0);
      assert.equal(argv[1], 'resume', `argv[1] should be resume, got: ${argv[1]}`);
      assert.equal(argv[7], 'thread-cr-1', `argv[7] (thread-id) should be thread-cr-1, got: ${argv[7]}`);

      // Parse new artifact frontmatter via parseFrontmatter helper.
      const outputContent = readFileSync(json.path, 'utf8');
      const fm = parseFrontmatter(outputContent);
      assert.equal(fm['codex-resume-status'], 'resumed', 'frontmatter codex-resume-status should be resumed');
      assert.equal(fm['codex-resumed-from'], prior, 'frontmatter codex-resumed-from should equal priorPath');

      // stdin.log assertions: substituted git command present, no placeholder, no codex exec review.
      const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');
      assert.ok(
        stdinLog.includes('git diff main...HEAD'),
        `stdin.log should contain "git diff main...HEAD", got: ${stdinLog.slice(0, 300)}`
      );
      assert.doesNotMatch(stdinLog, /\{\{[A-Z_]+\}\}/, 'stdin.log must have no leftover {{...}} placeholder');
      assert.ok(
        !stdinLog.includes('codex exec review'),
        `stdin.log must not contain "codex exec review", got: ${stdinLog.slice(0, 300)}`
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume explicit-path mismatch (base-ref differs) → ok:false, no new artifact written', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-mismatch-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-mismatch-out-'));
    try {
      const prior = path.join(outDir, '20260510-1015-vs-feature-x.md');
      writePriorArtifact(prior, {
        mode: 'code-review',
        cwd: process.cwd(),
        'base-ref': 'feature-x',
        'codex-thread-id': 'thread-cr-x',
        'codex-resume-status': 'fresh',
      });

      // Snapshot outDir contents before the bridge call.
      const beforeFiles = readdirSync(outDir).sort();

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'code-review', '--base', 'main', '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.match(json.error, /^resume rejected:/, `json.error should start with "resume rejected:", got: ${json.error}`);
      assert.equal(json.resumeStatus, 'fallback');

      // outDir must be unchanged — no new timestamped artifact written.
      const afterFiles = readdirSync(outDir).sort();
      assert.deepEqual(afterFiles, beforeFiles, 'outDir contents must be unchanged after mismatch rejection');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume auto with no candidate → fallback to fresh + stderr note + code-review status fallback', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-auto-none-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-auto-none-out-'));
    try {
      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'code-review', '--base', 'main', '--resume', 'auto', '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);
      assert.equal(json.resumeStatus, 'fallback', 'status should be fallback after auto miss');
      assert.match(result.stderr, /hyperclaude: resume fallback —/, 'stderr should contain resume fallback warning');

      // New artifact frontmatter should record fallback status.
      const outputContent = readFileSync(json.path, 'utf8');
      const fm = parseFrontmatter(outputContent);
      assert.equal(fm['codex-resume-status'], 'fallback', 'frontmatter codex-resume-status should be fallback');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume spawn fails (codex exits 7) → code-review status resume-failed, failure body written, ok:false', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-spawnfail-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_FAILURE);
    chmodSync(mockCodexPath, 0o755);

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-spawnfail-out-'));
    try {
      const prior = path.join(outDir, '20260510-1015-vs-main.md');
      writePriorArtifact(prior, {
        mode: 'code-review',
        cwd: process.cwd(),
        'base-ref': 'main',
        'codex-thread-id': 'thread-cr-fail',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'code-review', '--base', 'main', '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, false);
      assert.equal(json.resumeStatus, 'resume-failed');
      assert.ok(typeof json.path === 'string' && json.path.length > 0, 'failure should still record path');

      // Artifact body must contain the structured failure render.
      const outputContent = readFileSync(json.path, 'utf8');
      assert.ok(outputContent.includes('# (codex failed)'), 'failure body should be written');

      // Frontmatter should record resume-failed status (parsed, not raw text check).
      const fm = parseFrontmatter(outputContent);
      assert.equal(fm['codex-resume-status'], 'resume-failed', 'frontmatter codex-resume-status should be resume-failed');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('fresh code-review still works without --resume: resumeStatus fresh in JSON and frontmatter', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-cr-fresh-reg-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_REVIEW_SUCCESS);
    chmodSync(mockCodexPath, 0o755);

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-cr-fresh-reg-out-'));
    try {
      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'code-review', '--base', 'main', '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true, 'json.ok should be true');
      assert.ok(typeof json.path === 'string' && json.path.length > 0, 'json.path should be non-empty');
      assert.ok(typeof json.slug === 'string' && json.slug.length > 0, 'json.slug should be non-empty');
      assert.equal(json.resumeStatus, 'fresh', 'json.resumeStatus should be fresh');

      // Frontmatter via parseFrontmatter.
      const outputContent = readFileSync(json.path, 'utf8');
      const fm = parseFrontmatter(outputContent);
      assert.equal(fm['codex-resume-status'], 'fresh', 'frontmatter codex-resume-status should be fresh');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('resume preserves thread id when thread.started is omitted from codex output', () => {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-no-ts-'));
  try {
    const mockCodexPath = path.join(tmpdir, 'codex');
    writeFileSync(mockCodexPath, MOCK_CODEX_RESUME_NO_THREAD_STARTED);
    chmodSync(mockCodexPath, 0o755);

    const outDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-rs-cr-no-ts-out-'));
    try {
      const prior = path.join(outDir, '20260510-1015-vs-main.md');
      writePriorArtifact(prior, {
        mode: 'code-review',
        cwd: process.cwd(),
        'base-ref': 'main',
        'codex-thread-id': 'thread-cr-1',
        'codex-resume-status': 'fresh',
      });

      const result = spawnSync(
        process.execPath,
        [BRIDGE, 'code-review', '--base', 'main', '--resume', prior, '--out', outDir],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` },
        }
      );

      assert.equal(result.status, 0, `bridge stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.equal(json.ok, true);
      // The thread id from the prior artifact must be propagated even when thread.started is absent.
      assert.equal(json.threadId, 'thread-cr-1', `json.threadId should be thread-cr-1, got: ${json.threadId}`);

      // Frontmatter via parseFrontmatter.
      const outputContent = readFileSync(json.path, 'utf8');
      const fm = parseFrontmatter(outputContent);
      assert.equal(fm['codex-thread-id'], 'thread-cr-1', `frontmatter codex-thread-id should be thread-cr-1, got: ${fm['codex-thread-id']}`);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});
