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

// Mock codex script for code-review success: records argv one-per-line, captures stdin,
// returns a fake review body.
const MOCK_CODEX_REVIEW_SUCCESS = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.128.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
printf '## Findings\\n- none\\n'
exit 0
`;

// Mock codex script for code-review failure: exits 7 with partial stdout and stderr.
const MOCK_CODEX_REVIEW_FAILURE = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.128.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
printf 'partial review output'
printf 'mock review failure' >&2
exit 7
`;

// Mock codex script for docs-review success: records argv one-per-line, captures stdin,
// returns a fake docs-review body.
const MOCK_CODEX_DOCS_REVIEW_SUCCESS = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.128.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
printf '### Findings\\n- none\\n'
exit 0
`;

// Mock codex script for docs-review failure: exits 7 with partial stdout and stderr.
const MOCK_CODEX_DOCS_REVIEW_FAILURE = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.128.0'
  exit 0
fi
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
printf 'partial docs output'
printf 'mock docs failure' >&2
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

test('mock codex: code-review --base main spawns argv [review, --base, main] with no stdin', () => {
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

    // argv.log is one arg per line; split and trim trailing empty entry.
    const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
    const argv = argvLog.split('\n').filter((l) => l.length > 0);
    assert.deepEqual(argv, ['review', '--base', 'main']);

    // stdin.log must be empty — codex review takes no stdin.
    const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');
    assert.equal(stdinLog.length, 0, 'stdin.log should be empty (bridge must not pipe stdin to codex review)');

    // Output file checks.
    const outputPath = json.path;
    assert.ok(existsSync(outputPath), `output file should exist at ${outputPath}`);
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.startsWith('---\n'), 'output should start with YAML frontmatter');
    assert.ok(outputContent.includes('mode: code-review'), 'frontmatter should contain mode: code-review');
    assert.ok(outputContent.includes('codex-subcommand: review'), 'frontmatter should contain codex-subcommand: review');
    assert.ok(outputContent.includes('base-ref: "main"'), 'frontmatter should contain base-ref: "main"');
    assert.ok(outputContent.includes('## Findings'), 'body should include fake review output');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review --uncommitted spawns argv [review, --uncommitted]', () => {
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
    assert.deepEqual(argv, ['review', '--uncommitted']);

    assert.equal(json.slug, 'uncommitted', 'slug should be "uncommitted"');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review --commit abc1234f spawns argv [review, --commit, abc1234f]', () => {
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
    assert.deepEqual(argv, ['review', '--commit', 'abc1234f']);

    const outputPath = json.path;
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.includes('commit: "abc1234f"'), 'frontmatter should contain commit: "abc1234f"');
    assert.equal(json.slug, 'commit-abc1234', 'slug should be "commit-abc1234"');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review --title appended last', () => {
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
    assert.deepEqual(argv, ['review', '--base', 'main', '--title', 'My Review']);

    const outputPath = json.path;
    const outputContent = readFileSync(outputPath, 'utf8');
    assert.ok(outputContent.includes('title: "My Review"'), 'frontmatter should contain title: "My Review"');
    assert.ok(outputContent.includes('# Code review: My Review'), 'body should have titled heading');
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('mock codex: code-review failure (exit 7) writes file and reports error', () => {
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
    assert.ok(outputContent.includes('partial review output'), 'output file should include partial stdout');
    assert.ok(outputContent.includes('mock review failure'), 'output file should include stderr');
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

      // argv.log must be one-arg-per-line: ['exec', '--sandbox', 'read-only', '-']
      const argvLog = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8');
      const argv = argvLog.split('\n').slice(0, -1); // trim trailing empty from final \n
      assert.deepEqual(argv, ['exec', '--sandbox', 'read-only', '-']);

      // stdin.log must contain the doc content
      const stdinLog = readFileSync(path.join(tmpdir, 'stdin.log'), 'utf8');
      assert.ok(
        stdinLog.includes('Hello from test-doc.'),
        `stdin.log should contain doc content, got: ${stdinLog.slice(0, 200)}`
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
