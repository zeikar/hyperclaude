#!/usr/bin/env node
// Codex bridge — see docs/architecture.md "The bridge" section.

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------- leaf modules ----------
// Re-exported here so existing importers (tests, smoke scripts) keep working
// while we incrementally split the bridge into focused modules.

import {
  slugify, slugifyRef, extractSlugFromPlanFilename,
} from './codex/slug.mjs';
import {
  fmString, renderFrontmatter, renderCodeReviewFrontmatter,
  renderDocsReviewFrontmatter, parseFrontmatter,
} from './codex/frontmatter.mjs';
import { getGitHead, verifyReviewTarget } from './codex/git.mjs';
import {
  loadTemplate, readTemplateFile, readTemplateWithVersion,
  splitTemplateFrontmatter, renderFileListBlock, renderDiffBaseBlock,
} from './codex/templates.mjs';
import { parseArgs } from './codex/args.mjs';
import { buildInvocation } from './codex/paths.mjs';
import { renderFailureBody } from './codex/failure.mjs';
import {
  getCodexVersion, parseCodexJsonl, runCodexExec, runCodexResume,
} from './codex/codex.mjs';
import { getPluginVersion } from './codex/plugin.mjs';
import {
  defaultModeDir, loadResumeContext, resolveResume, discoverResumeArtifact,
} from './codex/resume.mjs';

export {
  slugify, slugifyRef, extractSlugFromPlanFilename,
  fmString, renderFrontmatter, renderCodeReviewFrontmatter,
  renderDocsReviewFrontmatter, parseFrontmatter,
  getGitHead, verifyReviewTarget,
  loadTemplate, readTemplateFile, readTemplateWithVersion,
  splitTemplateFrontmatter, renderFileListBlock, renderDiffBaseBlock,
  parseArgs, buildInvocation,
  renderFailureBody,
  getCodexVersion, parseCodexJsonl, runCodexExec, runCodexResume,
  getPluginVersion,
  defaultModeDir, loadResumeContext, discoverResumeArtifact,
  buildTargetInstruction,
};

// The hyperclaude plugin version of the LOADED copy producing this artifact.
// Resolved once from this module's own .claude-plugin/plugin.json (see
// getPluginVersion); recorded as `plugin-version` in every artifact's
// frontmatter so a reader can tell which plugin build actually ran.
const PLUGIN_VERSION = getPluginVersion();

// ---------- code-review target instruction ----------

// Builds the git-command block that tells Codex what to review and how to read
// it. Dispatch-local (not a pure leaf): shared by both the fresh and resumed
// code-review spawn paths so the command set has a single source of truth.
function buildTargetInstruction(args) {
  if (args.reviewTarget === 'base') {
    return [
      `Re-read the change via:`,
      ``,
      `  git diff ${args.baseRef}...HEAD --name-status   # changed paths since base (R=rename, D=delete)`,
      `  git diff ${args.baseRef}...HEAD                  # committed diff vs base`,
      `  git diff                                         # unstaged local fixes`,
      `  git diff --cached                                # staged local fixes`,
      `  git ls-files --others --exclude-standard         # untracked files — read each listed file's content directly (no diff)`,
      ``,
      `Review the EFFECTIVE worktree state vs base: the changes committed since ` +
        `${args.baseRef} PLUS any uncommitted local fixes (unstaged, staged, untracked). ` +
        `Read changed files from the WORKING TREE, not HEAD. ` +
        `Rationale: hyper-implement-loop re-runs \`code-review --base ${args.baseRef} --resume auto\` ` +
        `after the fixer leaves edits UNCOMMITTED, so a HEAD-only base review would skip ` +
        `the fix-round changes it must validate.`,
      ``,
      `Quote paths that contain spaces or special characters. A failed git read ` +
        `MUST NOT be treated as a review blocker — note it and continue.`,
    ].join('\n');
  }
  if (args.reviewTarget === 'commit') {
    return [
      `Re-read the commit via:`,
      ``,
      `  git show --name-status ${args.commit}        # changed paths (R=rename, D=delete)`,
      `  git show --format= --patch ${args.commit}    # the patch`,
      ``,
      `Read each changed path's post-image at this commit with ` +
        `\`git show ${args.commit}:'<path>'\` (NOT the working tree). ` +
        `Quote paths — they may contain spaces or special characters. ` +
        `For deleted/renamed/binary/space-containing paths, use ` +
        `\`git show --name-status ${args.commit}\` for discovery and ` +
        `\`git show ${args.commit}:'<path>'\` for the post-image, falling back to ` +
        `the parent/preimage \`git show ${args.commit}^:'<path>'\` for deletions. ` +
        `For binary files, note "binary, content not shown" and review by path/metadata. ` +
        `A failed \`git show\` read MUST NOT be treated as a review blocker — note it and continue.`,
    ].join('\n');
  }
  // uncommitted
  return [
    `Re-read the working tree via:`,
    ``,
    `  git status --short --untracked-files=all   # changed + untracked paths`,
    `  git diff                                   # unstaged`,
    `  git diff --cached                          # staged`,
    `  git ls-files --others --exclude-standard   # untracked files — read each file's content directly (no diff)`,
    ``,
    `Quote paths — they may contain spaces or special characters. ` +
      `For deleted paths, review by status/metadata; for binary files, note ` +
      `"binary, content not shown" and review by path/metadata. ` +
      `A failed git read MUST NOT be treated as a review blocker — note it and continue.`,
  ].join('\n');
}

// ---------- CLI entry ----------

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    process.exit(2);
  }
  if (args.taskFile) {
    try {
      args.task = (await readFile(args.taskFile, 'utf8')).trim();
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `cannot read task file: ${args.taskFile} (${err.message})`,
      }) + '\n');
      process.exit(1);
    }
    if (!args.task) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `task file is empty: ${args.taskFile}`,
      }) + '\n');
      process.exit(1);
    }
  }
  const inv = buildInvocation({ args });
  if (args.dryRun) {
    // Fail fast if the prompt template is missing OR its frontmatter is
    // malformed — better to find out at dry-run time than after spawning Codex.
    try {
      await readTemplateWithVersion(args.mode);
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `failed to read prompt template: ${err.message}`,
      }) + '\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      dryRun: true,
      mode: args.mode,
      slug: inv.slug,
      outputPath: inv.outputPath,
      timestamp: inv.timestamp,
    }) + '\n');
    return;
  }

  // docs-review path: reads docs file/dir, checks size, builds prompt, spawns codex exec.
  if (args.mode === 'docs-review') {
    // Step 1: read docs content. `aggregatedFiles` mirrors the markers we
    // emit so the resume prompt can re-list what was reviewed.
    let docsContent;
    let aggregatedFiles = [];
    if (args.docsPath) {
      try {
        // Prefix with file marker so Codex can attribute findings to the path
        // (mirrors the per-file marker in --docs-dir mode; the docs-review template
        // requires findings to cite "<doc path>:<line-or-section>").
        const raw = await readFile(args.docsPath, 'utf8');
        docsContent = `## File: ${args.docsPath}\n\n${raw}`;
        aggregatedFiles = [args.docsPath];
      } catch (err) {
        let errMsg;
        if (err.code === 'ENOENT') {
          errMsg = `docs file not found: ${args.docsPath}`;
        } else if (err.code === 'EISDIR') {
          errMsg = `--docs-path is a directory, use --docs-dir: ${args.docsPath}`;
        } else {
          errMsg = `cannot read docs file: ${args.docsPath} (${err.code})`;
        }
        process.stdout.write(JSON.stringify({ ok: false, error: errMsg }) + '\n');
        process.exit(1);
      }
    } else {
      // args.docsDir
      let entries;
      try {
        entries = await readdir(args.docsDir, { withFileTypes: true });
      } catch (err) {
        let errMsg;
        if (err.code === 'ENOENT') {
          errMsg = `docs dir not found: ${args.docsDir}`;
        } else {
          errMsg = `cannot read docs dir: ${args.docsDir} (${err.code})`;
        }
        process.stdout.write(JSON.stringify({ ok: false, error: errMsg }) + '\n');
        process.exit(1);
      }
      const mdFiles = entries
        .filter(dirent => dirent.isFile() && dirent.name.endsWith('.md'))
        .map(dirent => dirent.name)
        .sort();
      if (mdFiles.length === 0) {
        process.stdout.write(JSON.stringify({ ok: false, error: `no .md files in ${args.docsDir}` }) + '\n');
        process.exit(1);
      }
      const parts = [];
      for (const name of mdFiles) {
        const filePath = path.join(args.docsDir, name);
        const text = await readFile(filePath, 'utf8');
        parts.push(`## File: ${name}\n\n${text}`);
      }
      docsContent = parts.join('\n\n');
      // Resume prompt asks Codex to re-read these files from disk, so the list
      // must be cwd-relative paths (Codex's cwd = project root, not args.docsDir).
      aggregatedFiles = mdFiles.map((name) => path.join(args.docsDir, name));
    }

    // Step 2: 200KB docs guard.
    const docsBytes = Buffer.byteLength(docsContent, 'utf8');
    if (docsBytes > 204800) {
      const baseMsg = 'docs payload exceeds 200KB; narrow scope with --docs-path or a smaller directory';
      process.stdout.write(JSON.stringify({
        ok: false,
        error: args.resumeFrom ? `resume rejected: ${baseMsg}` : baseMsg,
        totalBytes: docsBytes,
        ...(args.resumeFrom ? { resumeStatus: 'fallback', threadId: null } : {}),
      }) + '\n');
      process.exit(1);
    }

    // Step 3: codex version check.
    const v = getCodexVersion();
    if (!v.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: v.reason,
        hint: 'Install or upgrade codex-cli (>= 0.130.0). See: https://github.com/openai/codex',
      }) + '\n');
      process.exit(1);
    }

    // Step 4 (resume): try to resolve a prior thread when --resume is set.
    // On 'auto' miss → fall back to fresh + stderr note. On explicit failure → fail hard.
    let resumeContext = null;       // { threadId, frontmatter } when valid
    let resumeFromPath = null;      // resolved prior artifact path (for codexResumedFrom)
    let resumeStatus = 'fresh';
    if (args.resumeFrom) {
      const r = await resolveResume('docs-review', args);
      if (r.ok) {
        resumeContext = r.context;
        resumeFromPath = r.prevPath;
      } else if (r.fatal) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `resume rejected: ${r.error}`,
          path: null,
          resumeStatus: 'fallback',
          threadId: null,
        }) + '\n');
        process.exit(1);
      } else {
        // 'auto' fell back: warn, run fresh.
        process.stderr.write(`hyperclaude: resume fallback — ${r.error}\n`);
        resumeStatus = 'fallback';
      }
    }

    // Step 5: optional diff context (always re-run for resume too, since the
    // template references the diff and we need to enforce the 500KB guard).
    let diffOutput = null;
    if (args.diffBase) {
      const r = spawnSync('git', ['diff', `${args.diffBase}...HEAD`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (r.error || r.status !== 0) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `git diff failed: ${r.stderr || r.error?.message}`,
          ...(args.resumeFrom ? { resumeStatus: 'fallback', threadId: null } : {}),
        }) + '\n');
        process.exit(1);
      }
      if (Buffer.byteLength(r.stdout, 'utf8') > 512000) {
        const baseMsg = 'git diff exceeds 500KB; narrow --diff-base scope';
        process.stdout.write(JSON.stringify({
          ok: false,
          error: args.resumeFrom ? `resume rejected: ${baseMsg}` : baseMsg,
          diffBytes: Buffer.byteLength(r.stdout, 'utf8'),
          ...(args.resumeFrom ? { resumeStatus: 'fallback', threadId: null } : {}),
        }) + '\n');
        process.exit(1);
      }
      diffOutput = r.stdout;
    }

    // Step 6: load template (fresh vs resume). The fresh template's frontmatter
    // is the canonical source for `template-version`, recorded in the artifact
    // regardless of resume/fresh path; the *-resumed.md body has no frontmatter.
    let templateText;
    let templateVersion;
    try {
      const fresh = await readTemplateWithVersion('docs-review');
      templateVersion = fresh.version;
      templateText = resumeContext
        ? await readTemplateFile('docs-review-resumed')
        : fresh.body;
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `failed to read prompt template: ${err.message}`,
      }) + '\n');
      process.exit(1);
    }

    // Step 7: build prompt.
    let prompt;
    if (resumeContext) {
      prompt = loadTemplate(templateText, {
        DOCS_TARGET: args.docsPath || args.docsDir,
        FILE_LIST_BLOCK: renderFileListBlock(aggregatedFiles),
        DIFF_BASE_BLOCK: renderDiffBaseBlock(args.diffBase),
      });
    } else {
      const vars = { DOCS: docsContent };
      if (diffOutput !== null) vars.DIFF = diffOutput;
      prompt = loadTemplate(templateText, vars);
    }

    // Step 8: spawn codex.
    let result;
    if (resumeContext) {
      result = await runCodexResume(resumeContext.threadId, prompt, args.timeout);
    } else {
      result = await runCodexExec(['exec', '--sandbox', 'read-only', '-'], prompt, args.timeout);
    }

    // Step 9: pick final resume status.
    if (resumeContext) {
      resumeStatus = result.ok ? 'resumed' : 'resume-failed';
    }
    // Else stays 'fresh' or 'fallback' (set above).

    // Step 10: ensure output dir exists.
    await mkdir(inv.dir, { recursive: true });

    // Step 11: build output file content.
    const fm = renderDocsReviewFrontmatter({
      slug: inv.slug,
      generated: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      codexVersion: v.version,
      templateVersion,
      docsTarget: args.docsPath ?? args.docsDir,
      diffBase: args.diffBase,
      cwd: process.cwd(),
      gitHead: getGitHead(),
      codexThreadId: result.threadId,
      codexResumeStatus: resumeStatus,
      codexResumedFrom: resumeContext && result.ok ? resumeFromPath : undefined,
    });
    const heading = `# Docs review: ${path.basename(args.docsPath ?? args.docsDir)}`;
    const body = result.body;

    // Step 12: write file.
    await writeFile(inv.outputPath, fm + heading + '\n\n' + body, 'utf8');

    // Step 13: emit result JSON.
    if (!result.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: result.reason,
        path: inv.outputPath,
        resumeStatus,
        threadId: result.threadId,
      }) + '\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      path: inv.outputPath,
      slug: inv.slug,
      threadId: result.threadId,
      resumeStatus,
    }) + '\n');
    return;
  }

  // code-review path: fresh uses `codex exec --sandbox read-only -` with the
  // code-review prompt template; resumed uses runCodexResume.
  if (args.mode === 'code-review') {
    const v = getCodexVersion();
    if (!v.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: v.reason,
        hint: 'Install or upgrade codex-cli (>= 0.130.0). See: https://github.com/openai/codex',
      }) + '\n');
      process.exit(1);
    }

    // Resume resolution: try to resolve a prior thread when --resume is set.
    // On 'auto' miss → fall back to fresh + stderr note. On explicit failure → fail hard.
    let resumeContext = null;       // { threadId, frontmatter } when valid
    let resumeFromPath = null;      // resolved prior artifact path (for codexResumedFrom)
    let resumeStatus = 'fresh';
    if (args.resumeFrom) {
      const r = await resolveResume('code-review', args);
      if (r.ok) {
        resumeContext = r.context;
        resumeFromPath = r.prevPath;
      } else if (r.fatal) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `resume rejected: ${r.error}`,
          path: null,
          resumeStatus: 'fallback',
          threadId: null,
        }) + '\n');
        process.exit(1);
      } else {
        // 'auto' fell back: warn, run fresh.
        process.stderr.write(`hyperclaude: resume fallback — ${r.error}\n`);
        resumeStatus = 'fallback';
      }
    }

    const gitHead = getGitHead();

    // Preflight the review target BEFORE spawning Codex. Runs for BOTH the
    // resumed and fresh spawn paths. Dry-run never reaches here — the
    // `if (args.dryRun)` block (~line 136) returns earlier in the file.
    const tgt = verifyReviewTarget(args);
    if (!tgt.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `code-review target not resolvable: ${tgt.reason}`,
        path: null,
        resumeStatus,
        threadId: resumeContext ? resumeContext.threadId : null,
      }) + '\n');
      process.exit(1);
    }

    const targetInstruction = buildTargetInstruction(args);

    // Load the fresh template upfront for `template-version` (recorded in the
    // artifact regardless of resume/fresh path); resume path swaps the body for
    // the *-resumed.md continuation prompt (frontmatter-less by design).
    let templateVersion;
    let freshBody;
    try {
      const fresh = await readTemplateWithVersion('code-review');
      templateVersion = fresh.version;
      freshBody = fresh.body;
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `failed to read prompt template: ${err.message}`,
      }) + '\n');
      process.exit(1);
    }

    let result;
    if (resumeContext) {
      let resumeTemplateText;
      try {
        resumeTemplateText = await readTemplateFile('code-review-resumed');
      } catch (err) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `failed to read prompt template: ${err.message}`,
        }) + '\n');
        process.exit(1);
      }
      const prompt = loadTemplate(resumeTemplateText, { TARGET_INSTRUCTION: targetInstruction });
      result = await runCodexResume(resumeContext.threadId, prompt, args.timeout);
    } else {
      const prompt = loadTemplate(freshBody, { TARGET_INSTRUCTION: targetInstruction });
      const argv = ['exec', '--sandbox', 'read-only', '-'];
      result = await runCodexExec(argv, prompt, args.timeout);
    }

    // Pick final resume status.
    if (resumeContext) {
      resumeStatus = result.ok ? 'resumed' : 'resume-failed';
    }

    await mkdir(inv.dir, { recursive: true });

    const fm = renderCodeReviewFrontmatter({
      slug: inv.slug,
      generated: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      codexVersion: v.version,
      templateVersion,
      gitHead,
      reviewTarget: args.reviewTarget,
      baseRef: args.baseRef,
      commit: args.commit,
      title: args.title,
      cwd: process.cwd(),
      codexThreadId: result.threadId,
      codexResumeStatus: resumeStatus,
      codexResumedFrom: resumeContext && result.ok ? resumeFromPath : undefined,
    });

    let heading;
    if (args.title) {
      heading = `# Code review: ${args.title}`;
    } else if (args.reviewTarget === 'base') {
      heading = `# Code review: vs ${args.baseRef}`;
    } else if (args.reviewTarget === 'uncommitted') {
      heading = `# Code review: uncommitted`;
    } else {
      heading = `# Code review: commit ${args.commit.slice(0, 7)}`;
    }

    const body = result.ok
      ? result.body
      : renderFailureBody({
          parseDiagnostics: result.parseDiagnostics,
          lastMessageText: result.lastMessageText,
          stderr: result.stderr,
          exit: result.exit,
        });

    await writeFile(inv.outputPath, fm + heading + '\n\n' + body, 'utf8');

    if (!result.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: result.reason,
        path: inv.outputPath,
        resumeStatus,
        threadId: result.threadId,
      }) + '\n');
      process.exit(1);
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      path: inv.outputPath,
      slug: inv.slug,
      threadId: result.threadId,
      resumeStatus,
    }) + '\n');
    return;
  }

  // Real path: version-check codex, load template, build prompt, spawn, write file.
  const v = getCodexVersion();
  if (!v.ok) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: v.reason,
      hint: 'Install or upgrade codex-cli (>= 0.130.0). See: https://github.com/openai/codex',
    }) + '\n');
    process.exit(1);
  }

  // Plan-review-only: try to resolve resume context before reading the plan, so
  // that an explicit-path validation failure short-circuits with a clean error.
  let resumeContext = null;
  let resumeFromPath = null;
  let resumeStatus = 'fresh';
  if (args.mode === 'plan-review' && args.resumeFrom) {
    const r = await resolveResume('plan-review', args);
    if (r.ok) {
      resumeContext = r.context;
      resumeFromPath = r.prevPath;
    } else if (r.fatal) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `resume rejected: ${r.error}`,
        path: null,
        resumeStatus: 'fallback',
        threadId: null,
      }) + '\n');
      process.exit(1);
    } else {
      process.stderr.write(`hyperclaude: resume fallback — ${r.error}\n`);
      resumeStatus = 'fallback';
    }
  }

  let plan = '';
  if (args.mode === 'plan-review') {
    try {
      plan = await readFile(args.planPath, 'utf8');
    } catch (err) {
      // For resume, this is a precondition failure — fail with fallback shape.
      if (args.resumeFrom) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `resume rejected: cannot read plan file: ${args.planPath} (${err.message})`,
          path: null,
          resumeStatus: 'fallback',
          threadId: null,
        }) + '\n');
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `cannot read plan file: ${args.planPath} (${err.message})`,
      }) + '\n');
      process.exit(1);
    }
  }

  // Fresh template carries the canonical template-version in its frontmatter;
  // it's recorded in the artifact even on the resume path (the *-resumed.md
  // body is frontmatter-less by design and continues the fresh prompt).
  let templateText;
  let templateVersion;
  try {
    const fresh = await readTemplateWithVersion(args.mode);
    templateVersion = fresh.version;
    templateText = (args.mode === 'plan-review' && resumeContext)
      ? await readTemplateFile('plan-review-resumed')
      : fresh.body;
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `failed to read prompt template: ${err.message}`,
    }) + '\n');
    process.exit(1);
  }

  let prompt;
  if (args.mode === 'plan-review' && resumeContext) {
    prompt = loadTemplate(templateText, { PLAN_PATH: args.planPath });
  } else {
    prompt = loadTemplate(templateText, {
      TASK: args.task ?? '',
      PLAN: plan,
    });
  }

  let result;
  if (resumeContext) {
    result = await runCodexResume(resumeContext.threadId, prompt, args.timeout);
  } else {
    result = await runCodexExec(['exec', '--sandbox', 'read-only', '-'], prompt, args.timeout);
  }
  await mkdir(inv.dir, { recursive: true });

  if (resumeContext) {
    resumeStatus = result.ok ? 'resumed' : 'resume-failed';
  }

  const subject =
    args.mode === 'research' ? args.task :
    /* plan-review */ args.planPath;

  const fm = renderFrontmatter({
    mode: args.mode,
    task: subject,
    slug: inv.slug ?? '',
    generated: new Date().toISOString(),
    pluginVersion: PLUGIN_VERSION,
    codexVersion: v.version,
    templateVersion,
    planPath: args.mode === 'plan-review' ? args.planPath : undefined,
    cwd: process.cwd(),
    gitHead: getGitHead(),
    codexThreadId: result.threadId,
    codexResumeStatus: resumeStatus,
    codexResumedFrom: resumeContext && result.ok ? resumeFromPath : undefined,
  });

  const heading = args.mode === 'research'
    ? `# Research: ${args.task}\n\n`
    : `# Plan review: ${path.basename(args.planPath)}\n\n`;

  const body = result.body;
  await writeFile(inv.outputPath, fm + heading + body, 'utf8');

  if (!result.ok) {
    const json = {
      ok: false,
      error: result.reason,
      path: inv.outputPath,
    };
    if (args.mode === 'plan-review') {
      json.resumeStatus = resumeStatus;
      json.threadId = result.threadId;
    }
    process.stdout.write(JSON.stringify(json) + '\n');
    process.exit(1);
  }

  const json = {
    ok: true,
    path: inv.outputPath,
    slug: inv.slug,
  };
  if (args.mode === 'plan-review') {
    json.threadId = result.threadId;
    json.resumeStatus = resumeStatus;
  }
  process.stdout.write(JSON.stringify(json) + '\n');
}

// Run main only when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
