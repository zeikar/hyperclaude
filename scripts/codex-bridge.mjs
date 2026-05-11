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
import { getGitHead } from './codex/git.mjs';
import {
  loadTemplate, readTemplateFile, renderFileListBlock, renderDiffBaseBlock,
} from './codex/templates.mjs';
import { parseArgs } from './codex/args.mjs';
import { buildInvocation } from './codex/paths.mjs';
import { renderFailureBody } from './codex/failure.mjs';
import {
  getCodexVersion, parseCodexJsonl, runCodexExec, runCodexResume,
} from './codex/codex.mjs';
import {
  defaultModeDir, loadResumeContext, resolveResume, discoverResumeArtifact,
} from './codex/resume.mjs';

export {
  slugify, slugifyRef, extractSlugFromPlanFilename,
  fmString, renderFrontmatter, renderCodeReviewFrontmatter,
  renderDocsReviewFrontmatter, parseFrontmatter,
  getGitHead,
  loadTemplate, readTemplateFile, renderFileListBlock, renderDiffBaseBlock,
  parseArgs, buildInvocation,
  renderFailureBody,
  getCodexVersion, parseCodexJsonl, runCodexExec, runCodexResume,
  defaultModeDir, loadResumeContext, discoverResumeArtifact,
};

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
    // code-review has no prompt template and does not require codex on PATH for dry-run.
    if (args.mode !== 'code-review') {
      // Fail fast if the prompt template is missing — better to find out now.
      try {
        await readTemplateFile(args.mode);
      } catch (err) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: `failed to read prompt template: ${err.message}`,
        }) + '\n');
        process.exit(1);
      }
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

    // Step 6: load template (fresh vs resume).
    let templateText;
    try {
      templateText = await readTemplateFile(resumeContext ? 'docs-review-resumed' : 'docs-review');
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
      codexVersion: v.version,
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

  // code-review path: uses `codex exec review` subcommand, no prompt template.
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

    const targetFlags = [];
    if (args.reviewTarget === 'base') {
      targetFlags.push('--base', args.baseRef);
    } else if (args.reviewTarget === 'uncommitted') {
      targetFlags.push('--uncommitted');
    } else {
      targetFlags.push('--commit', args.commit);
    }
    const titleFlag = args.title ? ['--title', args.title] : [];

    const gitHead = getGitHead();

    // Spawn: resume path uses runCodexResume; fresh path uses runCodexExec.
    let result;
    if (resumeContext) {
      // Build TARGET_INSTRUCTION block for the resume template.
      let targetInstruction;
      if (args.reviewTarget === 'base') {
        targetInstruction = `Re-read the diff via:\n\n  git diff ${args.baseRef}...HEAD --name-status\n  git diff ${args.baseRef}...HEAD -- <file>   # per changed path`;
      } else if (args.reviewTarget === 'commit') {
        targetInstruction = `Re-read the commit via:\n\n  git show --format= --patch ${args.commit}`;
      } else {
        targetInstruction = `Re-read the working tree via:\n\n  git status --short\n  git diff           # unstaged\n  git diff --cached  # staged\n\nFor untracked files (paths starting with "??" in git status output), read their content directly — they have no diff.`;
      }
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
      const argv = ['exec', 'review', '-c', 'sandbox_mode=read-only', ...targetFlags, ...titleFlag];
      result = await runCodexExec(argv, null, args.timeout);
    }

    // Pick final resume status.
    if (resumeContext) {
      resumeStatus = result.ok ? 'resumed' : 'resume-failed';
    }

    await mkdir(inv.dir, { recursive: true });

    const fm = renderCodeReviewFrontmatter({
      slug: inv.slug,
      generated: new Date().toISOString(),
      codexVersion: v.version,
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

  // Review-only: try to resolve resume context before reading the plan, so
  // that an explicit-path validation failure short-circuits with a clean error.
  let resumeContext = null;
  let resumeFromPath = null;
  let resumeStatus = 'fresh';
  if (args.mode === 'review' && args.resumeFrom) {
    const r = await resolveResume('review', args);
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
  if (args.mode === 'review') {
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

  let templateText;
  try {
    const templateName = (args.mode === 'review' && resumeContext) ? 'review-resumed' : args.mode;
    templateText = await readTemplateFile(templateName);
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `failed to read prompt template: ${err.message}`,
    }) + '\n');
    process.exit(1);
  }

  let prompt;
  if (args.mode === 'review' && resumeContext) {
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
    /* review */ args.planPath;

  const fm = renderFrontmatter({
    mode: args.mode,
    task: subject,
    slug: inv.slug ?? '',
    generated: new Date().toISOString(),
    codexVersion: v.version,
    templateVersion: 1,
    planPath: args.mode === 'review' ? args.planPath : undefined,
    cwd: process.cwd(),
    gitHead: getGitHead(),
    codexThreadId: result.threadId,
    codexResumeStatus: resumeStatus,
    codexResumedFrom: resumeContext && result.ok ? resumeFromPath : undefined,
  });

  const heading = args.mode === 'research'
    ? `# Research: ${args.task}\n\n`
    : `# Review: ${path.basename(args.planPath)}\n\n`;

  const body = result.body;
  await writeFile(inv.outputPath, fm + heading + body, 'utf8');

  if (!result.ok) {
    const json = {
      ok: false,
      error: result.reason,
      path: inv.outputPath,
    };
    if (args.mode === 'review') {
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
  if (args.mode === 'review') {
    json.threadId = result.threadId;
    json.resumeStatus = resumeStatus;
  }
  process.stdout.write(JSON.stringify(json) + '\n');
}

// Run main only when invoked as a script.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
