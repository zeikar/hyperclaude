// Unit tests: prompt templates — placeholder substitution, template-version frontmatter, resumed prompts, render blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTemplate, renderFailureBody, renderFileListBlock, renderDiffBaseBlock, readTemplateFile, readTemplateWithVersion, splitTemplateFrontmatter, buildTargetInstruction } from '../scripts/codex-bridge.mjs';

test('loadTemplate: substitutes placeholders', () => {
  const tpl = 'Hello {{NAME}}, you have {{COUNT}} items.';
  assert.equal(
    loadTemplate(tpl, { NAME: 'world', COUNT: '3' }),
    'Hello world, you have 3 items.'
  );
});

test('loadTemplate: leaves unknown placeholders untouched', () => {
  const tpl = 'Hello {{NAME}}, {{UNKNOWN}}.';
  assert.equal(
    loadTemplate(tpl, { NAME: 'world' }),
    'Hello world, {{UNKNOWN}}.'
  );
});
// ── splitTemplateFrontmatter / readTemplateWithVersion ───────────────────────

test('splitTemplateFrontmatter: extracts version and body', () => {
  const text = '---\ntemplate-version: 7\n---\nbody line\nsecond line';
  const { version, body } = splitTemplateFrontmatter(text);
  assert.equal(version, 7);
  assert.equal(body, 'body line\nsecond line');
});

test('splitTemplateFrontmatter: throws when missing frontmatter', () => {
  assert.throws(() => splitTemplateFrontmatter('no frontmatter here'), /missing leading frontmatter/);
});

test('splitTemplateFrontmatter: throws when template-version missing', () => {
  assert.throws(
    () => splitTemplateFrontmatter('---\nother-key: 1\n---\nbody'),
    /missing 'template-version/
  );
});

test('splitTemplateFrontmatter: tolerates CRLF (Windows / Git autocrlf checkouts)', () => {
  const text = '---\r\ntemplate-version: 3\r\n---\r\nbody line\r\nsecond line';
  const { version, body } = splitTemplateFrontmatter(text);
  assert.equal(version, 3);
  assert.equal(body, 'body line\nsecond line');
});

test('splitTemplateFrontmatter: throws when template-version is not a positive integer', () => {
  assert.throws(
    () => splitTemplateFrontmatter('---\ntemplate-version: abc\n---\nbody'),
    /missing 'template-version/
  );
  assert.throws(
    () => splitTemplateFrontmatter('---\ntemplate-version: 0\n---\nbody'),
    /must be a positive integer/
  );
});

test('readTemplateWithVersion: actual templates declare positive-integer versions', async () => {
  // Sanity-check the templates shipped with the plugin — every fresh template
  // must declare template-version so the artifact frontmatter is filled.
  for (const name of ['research', 'plan-review', 'code-review', 'docs-review']) {
    const { version, body } = await readTemplateWithVersion(name);
    assert.ok(Number.isInteger(version) && version >= 1, `${name}: version must be positive integer, got ${version}`);
    assert.ok(body.length > 0 && !body.startsWith('---\n'), `${name}: body must follow the frontmatter`);
  }
});
// ── renderFailureBody ─────────────────────────────────────────────────────────

test('renderFailureBody: shape with all fields populated', () => {
  const body = renderFailureBody({
    parseDiagnostics: {
      threadId: 'abc-123',
      hasTurnCompleted: false,
      turnFailedMessage: 'rate limited',
      topLevelErrors: ['e1', 'e2', 'e3', 'e4'],
      malformedLines: 2,
    },
    lastMessageText: 'partial body content',
    stderr: 'mock stderr line',
    exit: { status: 7, signal: null, timedOut: false },
  });
  assert.match(body, /^# \(codex failed\)\n/);
  assert.match(body, /## JSONL parser report/);
  assert.match(body, /- thread\.started: yes, thread_id abc-123/);
  assert.match(body, /- turn\.completed: no/);
  assert.match(body, /- turn\.failed: yes, message "rate limited"/);
  // top-level error events: count + last 3 messages.
  assert.match(body, /- top-level error events: 4 \(last 3 messages: "e2", "e3", "e4"\)/);
  assert.match(body, /- malformed lines: 2/);
  assert.match(body, /## Last message \(from --output-last-message\)\npartial body content/);
  assert.match(body, /## stderr\nmock stderr line/);
  assert.match(body, /## Exit\nstatus=7, signal=null, timed-out=false/);
});

test('renderFailureBody: empty lastMessage renders "(empty)"', () => {
  const body = renderFailureBody({
    parseDiagnostics: {
      threadId: null,
      hasTurnCompleted: false,
      turnFailedMessage: null,
      topLevelErrors: [],
      malformedLines: 0,
    },
    lastMessageText: '',
    stderr: '',
    exit: { status: null, signal: 'SIGTERM', timedOut: true },
  });
  assert.match(body, /- thread\.started: no/);
  assert.match(body, /- turn\.failed: no/);
  assert.match(body, /- top-level error events: 0\n/);
  assert.match(body, /## Last message \(from --output-last-message\)\n\(empty\)/);
  assert.match(body, /## Exit\nstatus=null, signal=SIGTERM, timed-out=true/);
});

// ── Task 3: plan-review-resumed.md template ───────────────────────────────────────

test('template plan-review-resumed.md: loads and substitutes {{PLAN_PATH}}', async () => {
  const text = await readTemplateFile('plan-review-resumed');
  assert.ok(typeof text === 'string' && text.length > 0, 'template should be non-empty');
  const rendered = loadTemplate(text, { PLAN_PATH: '/some/path/plan.md' });
  assert.ok(
    !rendered.includes('{{PLAN_PATH}}'),
    'rendered text should not contain literal {{PLAN_PATH}}'
  );
  assert.ok(
    rendered.includes('/some/path/plan.md'),
    'rendered text should include the substituted path'
  );
  // Must reference the review structure expected by the spec
  assert.ok(rendered.includes('Issues'), 'template should reference Issues section');
  assert.ok(rendered.includes('Verdict'), 'template should reference Verdict section');
});

// ── Task 3: docs-review-resumed.md template ──────────────────────────────────

test('template docs-review-resumed.md: loads and substitutes all three placeholders', async () => {
  const text = await readTemplateFile('docs-review-resumed');
  assert.ok(typeof text === 'string' && text.length > 0, 'template should be non-empty');
  const rendered = loadTemplate(text, {
    DOCS_TARGET: 'docs/',
    FILE_LIST_BLOCK: 'Files reviewed:\n  1. docs/api.md\n',
    DIFF_BASE_BLOCK: 'Also re-check `git diff main...HEAD`.\n',
  });
  assert.ok(!rendered.includes('{{DOCS_TARGET}}'), 'DOCS_TARGET should be substituted');
  assert.ok(!rendered.includes('{{FILE_LIST_BLOCK}}'), 'FILE_LIST_BLOCK should be substituted');
  assert.ok(!rendered.includes('{{DIFF_BASE_BLOCK}}'), 'DIFF_BASE_BLOCK should be substituted');
  assert.ok(rendered.includes('docs/'), 'rendered text should include the docs target');
  assert.ok(rendered.includes('docs/api.md'), 'rendered text should include the file list');
  assert.ok(rendered.includes('git diff main...HEAD'), 'rendered text should include diff ref');
  // Must reference the docs-review structure
  assert.ok(rendered.includes('Findings'), 'template should reference Findings section');
  assert.ok(rendered.includes('Verdict'), 'template should reference Verdict section');
});

test('template docs-review-resumed.md: empty blocks produce clean prompt (no dangling "Also re-check")', async () => {
  const text = await readTemplateFile('docs-review-resumed');
  const rendered = loadTemplate(text, {
    DOCS_TARGET: 'docs/api.md',
    FILE_LIST_BLOCK: '',
    DIFF_BASE_BLOCK: '',
  });
  assert.ok(
    !rendered.includes('Also re-check'),
    'rendered text should not contain "Also re-check" when DIFF_BASE_BLOCK is empty'
  );
  assert.ok(
    !rendered.includes('Files reviewed:'),
    'rendered text should not contain "Files reviewed:" when FILE_LIST_BLOCK is empty'
  );
});

// ── Task 3: code-review-resumed.md template ─────────────────────────────────

test('template code-review-resumed.md: loads and substitutes {{TARGET_INSTRUCTION}}', async () => {
  const text = await readTemplateFile('code-review-resumed');
  assert.ok(typeof text === 'string' && text.length > 0, 'template should be non-empty');
  assert.ok(text.includes('{{TARGET_INSTRUCTION}}'), 'template should contain {{TARGET_INSTRUCTION}} placeholder');

  const targetInstruction = 'Re-read the diff via:\n  git diff main...HEAD --name-status\n  git diff main...HEAD -- <file>';
  const rendered = loadTemplate(text, { TARGET_INSTRUCTION: targetInstruction });

  assert.ok(
    !rendered.includes('{{TARGET_INSTRUCTION}}'),
    'rendered text should not contain literal {{TARGET_INSTRUCTION}}'
  );
  assert.ok(
    rendered.includes(targetInstruction),
    'rendered text should include the substituted TARGET_INSTRUCTION block'
  );

  // Must reference the code-review structure expected by the spec (Findings/Verdict contract)
  assert.ok(rendered.includes('Findings'), 'template should reference Findings section');
  assert.ok(rendered.includes('Blocker'), 'template should reference Blocker severity');
  assert.ok(rendered.includes('Major'), 'template should reference Major severity');
  assert.ok(rendered.includes('Minor'), 'template should reference Minor severity');
  assert.ok(rendered.includes('Verdict'), 'template should reference Verdict section');

  // Regression: target-instruction block must be separated from "Then provide..." by a blank line
  // (previously the placeholder ran into the next sentence, e.g. `# per changed pathThen provide...`).
  assert.match(
    rendered,
    /<file>\n\nThen provide/,
    'rendered text should have a blank-line boundary between the substituted block and the "Then provide" sentence'
  );
});

// ── Task 3: renderFileListBlock ───────────────────────────────────────────────

test('renderFileListBlock: empty array returns empty string', () => {
  assert.equal(renderFileListBlock([]), '');
});

test('renderFileListBlock: null returns empty string', () => {
  assert.equal(renderFileListBlock(null), '');
});

test('renderFileListBlock: undefined returns empty string', () => {
  assert.equal(renderFileListBlock(undefined), '');
});

test('renderFileListBlock: non-empty array returns numbered "Files reviewed:" block', () => {
  const result = renderFileListBlock(['docs/api.md', 'docs/guide.md']);
  assert.ok(result.startsWith('Files reviewed:\n'), 'should start with "Files reviewed:\\n"');
  assert.ok(result.includes('  1. docs/api.md'), 'should include first file');
  assert.ok(result.includes('  2. docs/guide.md'), 'should include second file');
  assert.ok(result.endsWith('\n'), 'should end with newline');
});

test('renderFileListBlock: preserves order of files', () => {
  const files = ['z.md', 'a.md', 'm.md'];
  const result = renderFileListBlock(files);
  const pos1 = result.indexOf('z.md');
  const pos2 = result.indexOf('a.md');
  const pos3 = result.indexOf('m.md');
  assert.ok(pos1 < pos2 && pos2 < pos3, 'files should appear in the original order');
});

test('renderFileListBlock: single file produces numbered entry', () => {
  const result = renderFileListBlock(['docs/README.md']);
  assert.equal(result, 'Files reviewed:\n  1. docs/README.md\n');
});

// ── Task 3: renderDiffBaseBlock ───────────────────────────────────────────────

test('renderDiffBaseBlock: empty string returns empty string', () => {
  assert.equal(renderDiffBaseBlock(''), '');
});

test('renderDiffBaseBlock: null returns empty string', () => {
  assert.equal(renderDiffBaseBlock(null), '');
});

test('renderDiffBaseBlock: undefined returns empty string', () => {
  assert.equal(renderDiffBaseBlock(undefined), '');
});

test('renderDiffBaseBlock: truthy ref returns formatted line', () => {
  const result = renderDiffBaseBlock('main');
  assert.equal(result, 'Also re-check `git diff main...HEAD`.\n');
});

test('renderDiffBaseBlock: truthy ref with slash preserved', () => {
  const result = renderDiffBaseBlock('origin/main');
  assert.equal(result, 'Also re-check `git diff origin/main...HEAD`.\n');
});
// ── Task 5: buildTargetInstruction command-set unit tests ────────────────────

test('buildTargetInstruction: base target emits base...HEAD + uncommitted-overlay commands', () => {
  const block = buildTargetInstruction({ reviewTarget: 'base', baseRef: 'main' });
  assert.ok(block.includes('git diff main...HEAD --name-status'), 'base name-status');
  assert.ok(block.includes('git diff main...HEAD'), 'base committed diff');
  assert.ok(block.includes('git diff'), 'unstaged overlay');
  assert.ok(block.includes('git diff --cached'), 'staged overlay');
  assert.ok(block.includes('git ls-files --others --exclude-standard'), 'untracked overlay');
});

test('buildTargetInstruction: commit target emits show name-status/patch + reviewed-revision read + guidance', () => {
  const block = buildTargetInstruction({ reviewTarget: 'commit', commit: 'abc1234f' });
  assert.ok(block.includes('git show --name-status abc1234f'), 'show name-status');
  assert.ok(block.includes('git show --format= --patch abc1234f'), 'show patch');
  assert.ok(block.includes("git show abc1234f:"), 'reviewed-revision post-image read');
  assert.ok(/deleted\/renamed\/binary/.test(block), 'deleted/renamed/binary guidance');
  assert.ok(block.includes('Quote paths'), 'quote-path guidance');
  assert.ok(
    block.includes('MUST NOT be treated as a review blocker'),
    'failed git read does not block guidance'
  );
});

test('buildTargetInstruction: uncommitted target emits status/diff/cached/ls-files', () => {
  const block = buildTargetInstruction({ reviewTarget: 'uncommitted' });
  assert.ok(block.includes('git status --short --untracked-files=all'), 'status');
  assert.ok(block.includes('git diff'), 'unstaged');
  assert.ok(block.includes('git diff --cached'), 'staged');
  assert.ok(block.includes('git ls-files --others --exclude-standard'), 'untracked');
});

// implement-loop (Step-7) regression: hyper-implement-loop re-runs
// `code-review --base main --resume auto` AFTER the fixer leaves edits
// UNCOMMITTED. A HEAD-only base review would skip those fix-round changes,
// so the base prompt must carry the uncommitted-overlay commands too.
test('buildTargetInstruction: implement-loop scenario — base prompt surfaces committed AND uncommitted fixer edits', () => {
  const block = buildTargetInstruction({ reviewTarget: 'base', baseRef: 'main' });
  assert.ok(block.includes('git diff main...HEAD'), 'committed diff vs base');
  assert.ok(block.includes('git diff'), 'uncommitted unstaged fixer edits');
  assert.ok(block.includes('git diff --cached'), 'uncommitted staged fixer edits');
  assert.ok(
    block.includes('git ls-files --others --exclude-standard'),
    'untracked fixer edits'
  );
});

// ── Task 5: rendered-prompt snapshot-style tests (focused render) ─────────────

test('rendered fresh code-review prompt (base): no placeholders, command block + reviewed-revision semantics', async () => {
  const tpl = await readTemplateFile('code-review');
  const rendered = loadTemplate(tpl, { TARGET_INSTRUCTION: buildTargetInstruction({ reviewTarget: 'base', baseRef: 'main' }), REVIEW_BACKGROUND: '' });
  assert.doesNotMatch(rendered, /\{\{[A-Z_]+\}\}/, 'no leftover {{...}} placeholders');
  assert.ok(rendered.includes('git diff main...HEAD'), 'base command block present');
  assert.ok(rendered.includes('git diff --cached'), 'base overlay command present');
  assert.match(rendered, /reviewed revision|EFFECTIVE worktree state/i, 'reviewed-revision semantics phrase present');
});

test('rendered fresh code-review prompt (commit): no placeholders, command block + reviewed-revision read', async () => {
  const tpl = await readTemplateFile('code-review');
  const rendered = loadTemplate(tpl, { TARGET_INSTRUCTION: buildTargetInstruction({ reviewTarget: 'commit', commit: 'abc1234f' }), REVIEW_BACKGROUND: '' });
  assert.doesNotMatch(rendered, /\{\{[A-Z_]+\}\}/, 'no leftover {{...}} placeholders');
  assert.ok(rendered.includes('git show --name-status abc1234f'), 'commit command block present');
  assert.ok(rendered.includes("git show abc1234f:"), 'commit reviewed-revision read present');
  assert.match(rendered, /reviewed revision/i, 'reviewed-revision semantics phrase present');
});

test('rendered fresh code-review prompt (uncommitted): no placeholders, command block present', async () => {
  const tpl = await readTemplateFile('code-review');
  const rendered = loadTemplate(tpl, { TARGET_INSTRUCTION: buildTargetInstruction({ reviewTarget: 'uncommitted' }), REVIEW_BACKGROUND: '' });
  assert.doesNotMatch(rendered, /\{\{[A-Z_]+\}\}/, 'no leftover {{...}} placeholders');
  assert.ok(rendered.includes('git status --short --untracked-files=all'), 'uncommitted command block present');
});
