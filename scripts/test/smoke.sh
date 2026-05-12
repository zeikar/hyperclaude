#!/usr/bin/env bash
# hyperclaude v0.1 acceptance smoke checks.
# Run from repo root: bash scripts/test/smoke.sh
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

pass=0
fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
miss() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }

echo
echo "==> Unit tests"
if node --test tests/*.mjs > /tmp/hyperclaude-unit.log 2>&1; then
  ok "node --test tests/*.mjs — all passed"
else
  miss "node --test tests/*.mjs — failures (see /tmp/hyperclaude-unit.log)"
fi

echo
echo "==> Bridge dry-run"
if out=$(node scripts/codex-bridge.mjs research --task "smoke test task" --dry-run 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.ok && j.dryRun && j.slug === "smoke-test-task" ? 0 : 1);
  '; then
    ok "codex-bridge --dry-run produces expected JSON"
  else
    miss "codex-bridge --dry-run JSON shape unexpected: $out"
  fi
else
  miss "codex-bridge --dry-run failed: $out"
fi

echo
echo "==> Bridge code-review dry-run"
if out=$(node scripts/codex-bridge.mjs code-review --dry-run 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.ok && j.dryRun && j.slug === "vs-main" ? 0 : 1);
  '; then
    ok "codex-bridge code-review --dry-run produces expected JSON"
  else
    miss "codex-bridge code-review --dry-run JSON shape unexpected: $out"
  fi
else
  miss "codex-bridge code-review --dry-run failed: $out"
fi

echo
echo "==> Bridge docs-review --docs-path dry-run"
if out=$(node scripts/codex-bridge.mjs docs-review --docs-path README.md --dry-run 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.ok && j.dryRun && j.slug === "readme" ? 0 : 1);
  '; then
    ok "codex-bridge docs-review --docs-path --dry-run produces expected JSON"
  else
    miss "codex-bridge docs-review --docs-path --dry-run JSON shape unexpected: $out"
  fi
else
  miss "codex-bridge docs-review --docs-path --dry-run failed: $out"
fi

echo
echo "==> Bridge docs-review --docs-dir dry-run"
if out=$(node scripts/codex-bridge.mjs docs-review --docs-dir docs/ --dry-run 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.ok && j.dryRun && j.slug === "docs" ? 0 : 1);
  '; then
    ok "codex-bridge docs-review --docs-dir --dry-run produces expected JSON"
  else
    miss "codex-bridge docs-review --docs-dir --dry-run JSON shape unexpected: $out"
  fi
else
  miss "codex-bridge docs-review --docs-dir --dry-run failed: $out"
fi

echo
echo "==> Bridge code-review --resume auto dry-run"
if out=$(node scripts/codex-bridge.mjs code-review --resume auto --dry-run 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.ok && j.dryRun ? 0 : 1);
  '; then
    ok "codex-bridge code-review --resume auto --dry-run produces expected JSON"
  else
    miss "codex-bridge code-review --resume auto --dry-run JSON shape unexpected: $out"
  fi
else
  miss "codex-bridge code-review --resume auto --dry-run failed: $out"
fi

echo
echo "==> Plugin manifest validation"
if command -v claude >/dev/null 2>&1; then
  if claude plugin validate . > /tmp/hyperclaude-validate.log 2>&1; then
    ok "claude plugin validate ."
  else
    miss "claude plugin validate . failed (see /tmp/hyperclaude-validate.log)"
  fi
else
  printf '  \033[33m-\033[0m claude CLI not on PATH; skipping plugin validate.\n'
fi

echo
echo "==> Codex 0.130 capability probes"
if command -v codex >/dev/null 2>&1; then
  if codex exec review --help > /dev/null 2>&1; then
    ok "codex exec review available"
  else
    miss "codex exec review missing — upgrade codex-cli >= 0.130"
  fi
  if codex exec resume --help > /dev/null 2>&1; then
    ok "codex exec resume available"
  else
    miss "codex exec resume missing — upgrade codex-cli >= 0.130"
  fi
  if codex exec review --base HEAD -c sandbox_mode=read-only --help > /dev/null 2>&1; then
    ok "codex exec review --base HEAD -c sandbox_mode=read-only accepted"
  else
    miss "codex -c sandbox_mode=read-only rejected; codex too old?"
  fi
else
  printf '  \033[33m-\033[0m codex not on PATH; skipping Codex 0.130 capability probes.\n'
fi

echo
echo "==> Required files exist"
for f in \
  .claude-plugin/plugin.json \
  .claude-plugin/marketplace.json \
  scripts/codex-bridge.mjs \
  templates/codex/research.md \
  templates/codex/review.md \
  templates/codex/review-resumed.md \
  templates/codex/docs-review-resumed.md \
  templates/codex/code-review-resumed.md \
  templates/hooks/session-start-reminder.md \
  skills/hyper-research/SKILL.md \
  skills/hyper-plan/SKILL.md \
  skills/hyper-plan-review/SKILL.md \
  skills/hyper-tdd/SKILL.md \
  skills/hyper-debug/SKILL.md \
  skills/hyper-implement/SKILL.md \
  skills/hyper-code-review/SKILL.md \
  skills/hyper-docs-sync/SKILL.md \
  skills/hyper-docs-review/SKILL.md \
  agents/planner.md \
  agents/implementer.md \
  agents/verifier.md \
  agents/documenter.md \
  hooks/hooks.json \
  hooks/session-start-reminder.mjs
do
  if [ -f "$f" ]; then ok "$f"; else miss "$f missing"; fi
done

echo
echo "==> No shadowing commands/ files"
if [ -e commands ]; then
  miss "commands/ directory exists — drop it. /hyperclaude:* invocations resolve via skills/ alone."
else
  ok "no commands/ directory (skills/ provides slash invocations)"
fi

echo
echo "==> SessionStart hook"
if node --check hooks/session-start-reminder.mjs 2>/dev/null; then
  ok "node --check hooks/session-start-reminder.mjs"
else
  miss "hooks/session-start-reminder.mjs has syntax errors"
fi

if node -e '
  const { execSync } = require("child_process");
  const fs = require("fs");
  const raw = execSync(
    "printf \x27{\"session_id\":\"smoke\",\"source\":\"startup\"}\x27 | node hooks/session-start-reminder.mjs",
    { encoding: "utf8" }
  );
  const j = JSON.parse(raw);
  const additionalContext = j.hookSpecificOutput && j.hookSpecificOutput.additionalContext;
  const template = fs.readFileSync("templates/hooks/session-start-reminder.md", "utf8");
  const passed = j.continue === true &&
    j.hookSpecificOutput && j.hookSpecificOutput.hookEventName === "SessionStart" &&
    additionalContext === template;
  process.exit(passed ? 0 : 1);
' 2>/dev/null; then
  ok "SessionStart hook golden-path: additionalContext equals templates/hooks/session-start-reminder.md byte-for-byte"
else
  miss "SessionStart hook golden-path: additionalContext equals templates/hooks/session-start-reminder.md byte-for-byte"
fi

out=$(node <<'NODE_EOF' 2>&1
const plugin = JSON.parse(require("fs").readFileSync(".claude-plugin/plugin.json","utf8"));
const hooksConfig = JSON.parse(require("fs").readFileSync("hooks/hooks.json","utf8"));
const block = hooksConfig.hooks && hooksConfig.hooks.SessionStart &&
  hooksConfig.hooks.SessionStart[0];
const entry = block && block.hooks && block.hooks[0];
const expectedCmd = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-reminder.mjs"';
// hooks/hooks.json is auto-discovered from the standard plugin location;
// plugin.json should NOT carry a hooks field pointing back at the default
// path — that is redundant and triggers duplicate hook-file handling per the
// official plugins reference. Manifest should omit hooks entirely.
const passed = plugin.hooks === undefined &&
  Array.isArray(hooksConfig.hooks && hooksConfig.hooks.SessionStart) &&
  block && block.matcher === "startup|clear|compact" &&
  entry && entry.type === "command" &&
  entry.timeout === 5 &&
  entry.command === expectedCmd;
process.exit(passed ? 0 : 1);
NODE_EOF
)
if [ $? -eq 0 ]; then
  ok "manifest wiring: plugin.json omits redundant hooks field, hooks.json shape correct (matcher excludes resume, type/timeout/command exact)"
else
  miss "manifest wiring assertion failed: $out"
fi

if out=$(printf 'not json' | node hooks/session-start-reminder.mjs 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.continue === true && j.suppressOutput === true ? 0 : 1);
  '; then
    ok "SessionStart hook fail-open: invalid stdin JSON → suppressOutput"
  else
    miss "SessionStart hook fail-open: invalid stdin JSON → suppressOutput assertion failed: $out"
  fi
else
  miss "SessionStart hook fail-open: invalid stdin JSON → suppressOutput invocation failed: $out"
fi

if out=$(
  (
    tmp=$(mktemp -d -t sshr.XXXXXX)
    bak="$tmp/session-start-reminder.md"
    trap '[ -e "$bak" ] && mv "$bak" templates/hooks/session-start-reminder.md 2>/dev/null; rmdir "$tmp" 2>/dev/null' EXIT
    mv templates/hooks/session-start-reminder.md "$bak"
    printf '{"session_id":"smoke","source":"startup"}' \
      | node hooks/session-start-reminder.mjs \
      | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.continue===true && j.suppressOutput===true ? 0 : 1)'
  ) 2>&1
); then
  ok "SessionStart hook fail-open: missing template → suppressOutput"
else
  miss "SessionStart hook missing-template fail-open failed: $out"
fi

echo
echo "==> Summary"
echo "  passed: $pass"
echo "  failed: $fail"
echo
cat <<'NOTE'
====================================================================
REQUIRED MANUAL ACCEPTANCE BEFORE SHIPPING A RELEASE
--------------------------------------------------------------------
This script's automated checks alone are NOT sufficient to ship a
release. Before `git tag -a vX.Y.Z`, you MUST also:

  1. Install the plugin from a fresh Claude Code session:
       /plugin marketplace add <this repo URL or local path>
       /plugin install hyperclaude

  2. Inside the session, run:
       /hyperclaude:hyper-research add OAuth login to the API
     Verify a file appears under .hyperclaude/research/ with valid
     frontmatter and a Codex-generated body.

  3. Run:
       /hyperclaude:hyper-plan
     Verify the planner agent is dispatched and a plan file appears
     under .hyperclaude/plans/ with `## Task N:` sections and a slug
     matching the research artifact's.

  4. Run:
       /hyperclaude:hyper-plan-review
     Verify it auto-discovers the plan or prints the "no plan found"
     guidance.

  5. Run:
       /hyperclaude:hyper-code-review
     Verify it reviews the current branch vs main and writes a file
     under .hyperclaude/code-reviews/ with valid frontmatter and a
     Codex-generated body.
     Then run:
       /hyperclaude:hyper-code-review --resume
     Verify a second artifact appears with codex-resume-status: resumed
     and codex-resumed-from populated.

  6. Run:
       /hyperclaude:hyper-docs-sync uncommitted
     Verify mapping read, doc updates dispatched, summary reported.

  7. Run:
       /hyperclaude:hyper-docs-review
     Verify a file appears under .hyperclaude/docs-reviews/ with
     valid frontmatter.

If any of the above fails, STOP and fix before shipping.
====================================================================
NOTE

[ "$fail" -eq 0 ]
