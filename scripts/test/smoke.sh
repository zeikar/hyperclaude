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
echo "==> setup-doctor probe"
if out=$(node scripts/setup-doctor.mjs 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    // Cross-check mirror: these names MUST match scripts/setup-doctor.mjs exactly.
    // Duplication is intentional — a rename in the doctor with no smoke update is a test failure.
    const expectedNames = [
      "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1",
      "Node.js >= 18",
      "codex-cli >= 0.130.0 (version floor only)",
      "codex --search (global flag, pre-subcommand)",
      "git on PATH"
    ].sort();
    const actualNames = j.checks.map(c => c.name).sort();
    const namesMatch = JSON.stringify(actualNames) === JSON.stringify(expectedNames);
    const passed =
      typeof j.ok === "boolean" &&
      Array.isArray(j.checks) &&
      j.checks.length === 5 &&
      j.checks.every(c => c.detected) &&
      namesMatch;
    process.exit(passed ? 0 : 1);
  '; then
    ok "setup-doctor probe: shape ok, 5 checks, all detected, names match"
  else
    miss "setup-doctor probe: JSON shape unexpected: $out"
  fi
else
  miss "setup-doctor probe failed: $out"
fi

echo
echo "==> hyper-setup command file content"
if node -e '
  const fs = require("fs");
  const text = fs.readFileSync("commands/hyper-setup.md", "utf8");
  const passed =
    text.includes("node \"\${CLAUDE_PLUGIN_ROOT}/scripts/setup-doctor.mjs\"") &&
    text.includes("Prerequisite probe could not complete:") &&
    text.includes("hyperclaude prerequisites are UNKNOWN");
  process.exit(passed ? 0 : 1);
' 2>/dev/null; then
  ok "hyper-setup command file: probe invocation + fallback sentences present"
else
  miss "hyper-setup command file: missing expected content in commands/hyper-setup.md"
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
  if codex exec resume --help > /dev/null 2>&1; then
    ok "codex exec resume available"
  else
    miss "codex exec resume missing — upgrade codex-cli >= 0.130"
  fi
  if codex exec resume --help -c sandbox_mode=read-only > /dev/null 2>&1; then
    ok "codex exec resume -c sandbox_mode=read-only accepted"
  else
    miss "codex -c sandbox_mode=read-only rejected; codex too old?"
  fi
  if codex --search exec --help > /dev/null 2>&1; then
    ok "codex --search exec --help accepted (global --search flag + before-subcommand placement valid)"
  else
    miss "codex --search exec --help rejected — --search global flag unavailable or wrong placement"
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
  templates/codex/plan-review.md \
  templates/codex/plan-review-resumed.md \
  templates/codex/docs-review-resumed.md \
  templates/codex/code-review.md \
  templates/codex/code-review-resumed.md \
  templates/hooks/session-start-reminder.md \
  templates/hooks/session-start-reminder-loop.md \
  skills/hyper-interview/SKILL.md \
  skills/hyper-research/SKILL.md \
  skills/hyper-plan/SKILL.md \
  skills/hyper-plan-loop/SKILL.md \
  skills/hyper-plan-loop/references/failure-protocol.md \
  skills/hyper-plan-review/SKILL.md \
  skills/hyper-tdd/SKILL.md \
  skills/hyper-debug/SKILL.md \
  skills/hyper-implement/SKILL.md \
  skills/hyper-implement-loop/SKILL.md \
  skills/hyper-auto/SKILL.md \
  skills/hyper-code-review/SKILL.md \
  skills/hyper-docs-sync/SKILL.md \
  skills/hyper-docs-review/SKILL.md \
  skills/hyper-docs-loop/SKILL.md \
  skills/hyper-docs-loop/references/failure-protocol.md \
  agents/documenter.md \
  agents/fixer.md \
  agents/implementer.md \
  agents/planner.md \
  agents/researcher.md \
  agents/verifier.md \
  hooks/hooks.json \
  hooks/session-start-reminder.mjs \
  hooks/stamp-artifact.mjs \
  commands/hyper-setup.md \
  scripts/setup-doctor.mjs
do
  if [ -f "$f" ]; then ok "$f"; else miss "$f missing"; fi
done

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
  // Pin agent-teams off so the default (manual-first) router is selected,
  // independent of the developer'"'"'s ambient env.
  const env = { ...process.env };
  delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  const raw = execSync(
    "printf \x27{\"session_id\":\"smoke\",\"source\":\"startup\"}\x27 | node hooks/session-start-reminder.mjs",
    { encoding: "utf8", env }
  );
  const j = JSON.parse(raw);
  const additionalContext = j.hookSpecificOutput && j.hookSpecificOutput.additionalContext;
  const template = fs.readFileSync("templates/hooks/session-start-reminder.md", "utf8");
  // additionalContext must start with the template byte-for-byte. Anything
  // after the template is a dynamic .hyperclaude/ snapshot footer (optional;
  // only present when the project has artifacts under .hyperclaude/).
  const passed = j.continue === true &&
    j.hookSpecificOutput && j.hookSpecificOutput.hookEventName === "SessionStart" &&
    typeof additionalContext === "string" &&
    additionalContext.startsWith(template);
  process.exit(passed ? 0 : 1);
' 2>/dev/null; then
  ok "SessionStart hook golden-path (agent-teams off): additionalContext starts with session-start-reminder.md byte-for-byte"
else
  miss "SessionStart hook golden-path (agent-teams off): additionalContext starts with session-start-reminder.md byte-for-byte"
fi

# Env-aware router selection: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 → loop-first variant.
if node -e '
  const { execSync } = require("child_process");
  const fs = require("fs");
  const env = { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" };
  const raw = execSync(
    "printf \x27{\"session_id\":\"smoke\",\"source\":\"startup\"}\x27 | node hooks/session-start-reminder.mjs",
    { encoding: "utf8", env }
  );
  const j = JSON.parse(raw);
  const additionalContext = j.hookSpecificOutput && j.hookSpecificOutput.additionalContext;
  const template = fs.readFileSync("templates/hooks/session-start-reminder-loop.md", "utf8");
  const passed = typeof additionalContext === "string" && additionalContext.startsWith(template);
  process.exit(passed ? 0 : 1);
' 2>/dev/null; then
  ok "SessionStart hook env-aware: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 → loop-first router (session-start-reminder-loop.md)"
else
  miss "SessionStart hook env-aware: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 → loop-first router selection failed"
fi

# Snapshot footer is dynamic — it should appear iff .hyperclaude/ has artifacts.
if node -e '
  const { execSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  // Pin agent-teams off so template.length matches session-start-reminder.md
  // (footer behavior is identical across both router variants).
  const env = { ...process.env };
  delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  const raw = execSync(
    "printf \x27{\"session_id\":\"smoke\",\"source\":\"startup\"}\x27 | node hooks/session-start-reminder.mjs",
    { encoding: "utf8", env }
  );
  const j = JSON.parse(raw);
  const additionalContext = j.hookSpecificOutput.additionalContext;
  const template = fs.readFileSync("templates/hooks/session-start-reminder.md", "utf8");
  const footer = additionalContext.slice(template.length);

  // Determine whether .hyperclaude/ currently holds any artifacts.
  const sections = ["plans", "epics", "specs", "research", "plan-reviews", "code-reviews", "docs-reviews"];
  let hasArtifacts = false;
  for (const s of sections) {
    const dir = path.join(".hyperclaude", s);
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      if (files.length > 0) { hasArtifacts = true; break; }
    } catch {}
  }

  let passed;
  if (hasArtifacts) {
    passed = footer.includes("## .hyperclaude/ snapshot") &&
      footer.includes(".hyperclaude/");
  } else {
    passed = footer.length === 0;
  }
  process.exit(passed ? 0 : 1);
' 2>/dev/null; then
  ok "SessionStart hook snapshot footer: present iff .hyperclaude/ has artifacts"
else
  miss "SessionStart hook snapshot footer: missing or malformed"
fi

out=$(node <<'NODE_EOF' 2>&1
const plugin = JSON.parse(require("fs").readFileSync(".claude-plugin/plugin.json","utf8"));
const hooksConfig = JSON.parse(require("fs").readFileSync("hooks/hooks.json","utf8"));
const h = hooksConfig.hooks || {};

// hooks/hooks.json is auto-discovered from the standard plugin location;
// plugin.json should NOT carry a hooks field pointing back at the default
// path — that is redundant and triggers duplicate hook-file handling per the
// official plugins reference. Manifest should omit hooks entirely.
function checkEntry(block, expectedMatcher, expectedCmd) {
  if (!block) return false;
  if (block.matcher !== expectedMatcher) return false;
  const entry = block.hooks && block.hooks[0];
  return entry && entry.type === "command" && entry.timeout === 5 && entry.command === expectedCmd;
}

const sessionStartCmd = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-reminder.mjs"';
const stampCmd = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stamp-artifact.mjs"';

const passed = plugin.hooks === undefined &&
  Array.isArray(h.SessionStart) && checkEntry(h.SessionStart[0], "startup|clear|compact", sessionStartCmd) &&
  Array.isArray(h.PostToolUse) && checkEntry(h.PostToolUse[0], "Write", stampCmd) &&
  h.UserPromptExpansion === undefined &&
  h.Stop === undefined;
process.exit(passed ? 0 : 1);
NODE_EOF
)
if [ $? -eq 0 ]; then
  ok "manifest wiring: plugin.json omits redundant hooks field, hooks.json shape correct (SessionStart + PostToolUse stamp; no UserPromptExpansion/Stop)"
else
  miss "manifest wiring assertion failed: $out"
fi

if out=$(printf 'not json' | node hooks/session-start-reminder.mjs 2>/dev/null); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.continue === true && j.suppressOutput === true ? 0 : 1);
  '; then
    ok "SessionStart hook fail-open: invalid stdin JSON → suppressOutput (stdout intact; diagnostic on stderr)"
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
    # Pin agent-teams off so the moved-away default template is the one selected.
    printf '{"session_id":"smoke","source":"startup"}' \
      | env -u CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS node hooks/session-start-reminder.mjs \
      | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(j.continue===true && j.suppressOutput===true ? 0 : 1)'
  ) 2>&1
); then
  ok "SessionStart hook fail-open: missing template → suppressOutput"
else
  miss "SessionStart hook missing-template fail-open failed: $out"
fi

echo
echo "==> PostToolUse stamp hook"
if node --check hooks/stamp-artifact.mjs 2>/dev/null; then
  ok "node --check hooks/stamp-artifact.mjs"
else
  miss "hooks/stamp-artifact.mjs has syntax errors"
fi

# End-to-end: a Write under .hyperclaude/ gets plugin-version injected exactly
# once (idempotent on re-fire); a Write outside .hyperclaude/ is left untouched.
if node -e '
  const { execSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8"));
  const hook = path.resolve("hooks/stamp-artifact.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stamp-"));
  const fire = (fp) => execSync("node " + JSON.stringify(hook), {
    input: JSON.stringify({ cwd: tmp, tool_name: "Write", tool_input: { file_path: fp } }),
    encoding: "utf8",
  });
  // (a) artifact under .hyperclaude/ → stamped, exactly once.
  const planPath = path.join(tmp, ".hyperclaude", "plans", "p.md");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, "# Plan: x\n\n- [ ] a\n");
  const out1 = JSON.parse(fire(planPath));
  fire(planPath); // re-fire must not duplicate
  const stamped = fs.readFileSync(planPath, "utf8");
  const count = (stamped.match(/^plugin-version:/gm) || []).length;
  const stampedOk = out1.continue === true && out1.suppressOutput === true &&
    stamped.startsWith("---\nplugin-version: " + plugin.version + "\n") && count === 1;
  // (b) file outside .hyperclaude/ → byte-for-byte unchanged.
  const outsidePath = path.join(tmp, "o.md");
  const original = "# not an artifact\n";
  fs.writeFileSync(outsidePath, original);
  fire(outsidePath);
  const outsideUnchanged = fs.readFileSync(outsidePath, "utf8") === original;
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(stampedOk && outsideUnchanged ? 0 : 1);
' 2>/dev/null; then
  ok "stamp hook: injects plugin-version into .hyperclaude/ artifact (idempotent), skips files outside .hyperclaude/"
else
  miss "stamp hook: stamping / idempotency / out-of-scope-skip assertion failed"
fi

if out=$(printf 'not json' | node hooks/stamp-artifact.mjs 2>/dev/null); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.continue === true && j.suppressOutput === true ? 0 : 1);
  '; then
    ok "stamp hook fail-open: invalid stdin JSON → continue+suppressOutput"
  else
    miss "stamp hook fail-open: invalid stdin JSON assertion failed: $out"
  fi
else
  miss "stamp hook fail-open: invalid stdin JSON invocation failed: $out"
fi

echo
echo "==> hyper-plan-loop static content assertions"
skill_file="skills/hyper-plan-loop/SKILL.md"
fp_file="skills/hyper-plan-loop/references/failure-protocol.md"

if ! grep -q "### Step 7a" "$skill_file" 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: legacy Step 7a section header absent (loop is sibling-loop parity, no Minor-cleanup branch)"
else
  miss "hyper-plan-loop SKILL.md: legacy Step 7a section header still present (should be removed)"
fi

if grep -q "10 total reviews" "$skill_file" 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: '10 total reviews' cap wording present"
else
  miss "hyper-plan-loop SKILL.md: '10 total reviews' cap wording missing"
fi

if ! grep -q "10 severity-gated reviews" "$skill_file" 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: stale '10 severity-gated reviews' wording absent"
else
  miss "hyper-plan-loop SKILL.md: stale '10 severity-gated reviews' wording still present"
fi

if ! grep -q "Treating Minor findings as blocking" "$skill_file" 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: stale fragment 'Treating Minor findings as blocking' absent"
else
  miss "hyper-plan-loop SKILL.md: stale fragment 'Treating Minor findings as blocking' still present"
fi

if ! grep -q "Only Blocker/Major gate the loop" "$skill_file" 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: stale fragment 'Only Blocker/Major gate the loop' absent"
else
  miss "hyper-plan-loop SKILL.md: stale fragment 'Only Blocker/Major gate the loop' still present"
fi

if ! grep -q "Treating Minor findings as blocking" "$fp_file" 2>/dev/null; then
  ok "hyper-plan-loop failure-protocol.md: stale fragment 'Treating Minor findings as blocking' absent"
else
  miss "hyper-plan-loop failure-protocol.md: stale fragment 'Treating Minor findings as blocking' still present"
fi

if ! grep -q "Only Blocker/Major gate the loop" "$fp_file" 2>/dev/null; then
  ok "hyper-plan-loop failure-protocol.md: stale fragment 'Only Blocker/Major gate the loop' absent"
else
  miss "hyper-plan-loop failure-protocol.md: stale fragment 'Only Blocker/Major gate the loop' still present"
fi

if ! grep -q "Treating an actionable Minor" "$fp_file" 2>/dev/null; then
  ok "hyper-plan-loop failure-protocol.md: legacy 'Treating an actionable Minor' anti-pattern absent (replaced with non-blocking-findings rule)"
else
  miss "hyper-plan-loop failure-protocol.md: legacy 'Treating an actionable Minor' anti-pattern still present"
fi

if grep -q "Treating non-blocking findings as revise targets" "$fp_file" 2>/dev/null; then
  ok "hyper-plan-loop failure-protocol.md: new 'Treating non-blocking findings as revise targets' anti-pattern present"
else
  miss "hyper-plan-loop failure-protocol.md: new 'Treating non-blocking findings as revise targets' anti-pattern missing"
fi

echo
echo "==> shared loop-protocol static content assertions"

shared_proto="references/loop-protocol.md"

if [ -f "$shared_proto" ]; then
  ok "shared loop-protocol: file exists at references/loop-protocol.md"
else
  miss "shared loop-protocol: file missing at references/loop-protocol.md"
fi

if grep -q "PHASE 1" "$shared_proto" 2>/dev/null; then
  ok "shared loop-protocol: 'PHASE 1' marker present"
else
  miss "shared loop-protocol: 'PHASE 1' marker missing"
fi

if grep -q "PHASE 2" "$shared_proto" 2>/dev/null; then
  ok "shared loop-protocol: 'PHASE 2' marker present"
else
  miss "shared loop-protocol: 'PHASE 2' marker missing"
fi

if grep -q "stale-recovery" "$shared_proto" 2>/dev/null; then
  ok "shared loop-protocol: 'stale-recovery' marker present"
else
  miss "shared loop-protocol: 'stale-recovery' marker missing"
fi

if grep -q "awaiting_reply" "$shared_proto" 2>/dev/null; then
  ok "shared loop-protocol: 'awaiting_reply' field name present"
else
  miss "shared loop-protocol: 'awaiting_reply' field name missing"
fi

if ! grep -q "WROTE:" "$shared_proto" 2>/dev/null; then
  ok "shared loop-protocol: 'WROTE:' token absent (binding-hole invariant)"
else
  miss "shared loop-protocol: 'WROTE:' token present (binding-hole invariant violated)"
fi

if grep -q "loop-bound" "$shared_proto" 2>/dev/null; then
  ok "shared loop-protocol: 'loop-bound' binding-hole markers present"
else
  miss "shared loop-protocol: 'loop-bound' binding-hole markers missing"
fi

if grep -q '\${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md' skills/hyper-plan-loop/SKILL.md 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: references shared loop-protocol at Step 0"
else
  miss "hyper-plan-loop SKILL.md: does not reference shared loop-protocol"
fi

echo
echo "==> hyper-implement-loop reqid promotion assertions"

il_skill="skills/hyper-implement-loop/SKILL.md"
il_fp="skills/hyper-implement-loop/references/failure-protocol.md"

if grep -q '\${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md' "$il_skill" 2>/dev/null; then
  ok "hyper-implement-loop SKILL.md: references shared loop-protocol at Step 0"
else
  miss "hyper-implement-loop SKILL.md: does not reference shared loop-protocol"
fi

if grep -q 'request_id_counter' "$il_skill" 2>/dev/null; then
  ok "hyper-implement-loop SKILL.md: 'request_id_counter' run-state field present"
else
  miss "hyper-implement-loop SKILL.md: 'request_id_counter' run-state field missing"
fi

if grep -q 'awaiting_reply' "$il_skill" 2>/dev/null; then
  ok "hyper-implement-loop SKILL.md: 'awaiting_reply' field name present"
else
  miss "hyper-implement-loop SKILL.md: 'awaiting_reply' field name missing"
fi

if ! grep -q 'awaiting_planner_reply' "$il_skill" 2>/dev/null; then
  ok "hyper-implement-loop SKILL.md: stale 'awaiting_planner_reply' field name absent"
else
  miss "hyper-implement-loop SKILL.md: stale 'awaiting_planner_reply' field name present"
fi

if grep -q 'expected_request_id' "$il_skill" 2>/dev/null; then
  ok "hyper-implement-loop SKILL.md: 'expected_request_id' field present"
else
  miss "hyper-implement-loop SKILL.md: 'expected_request_id' field missing"
fi

if grep -q 'solicit_sent_at' "$il_skill" 2>/dev/null; then
  ok "hyper-implement-loop SKILL.md: 'solicit_sent_at' field present"
else
  miss "hyper-implement-loop SKILL.md: 'solicit_sent_at' field missing"
fi

if grep -q 'request-id:' "$il_skill" 2>/dev/null; then
  ok "hyper-implement-loop SKILL.md: 'request-id:' fixer spawn-prompt prefix present"
else
  miss "hyper-implement-loop SKILL.md: 'request-id:' fixer spawn-prompt prefix missing"
fi

if grep -q 'request-id:' "$il_fp" 2>/dev/null; then
  ok "hyper-implement-loop failure-protocol.md: 'request-id:' gate binding present"
else
  miss "hyper-implement-loop failure-protocol.md: 'request-id:' gate binding missing"
fi

if grep -q 'request_id_counter' "$il_fp" 2>/dev/null; then
  ok "hyper-implement-loop failure-protocol.md: 'request_id_counter' field reference present"
else
  miss "hyper-implement-loop failure-protocol.md: 'request_id_counter' field reference missing"
fi

if grep -q 'expected_request_id' "$il_fp" 2>/dev/null; then
  ok "hyper-implement-loop failure-protocol.md: 'expected_request_id' field reference present"
else
  miss "hyper-implement-loop failure-protocol.md: 'expected_request_id' field reference missing"
fi

if grep -q 'awaiting_reply' "$il_fp" 2>/dev/null; then
  ok "hyper-implement-loop failure-protocol.md: 'awaiting_reply' field reference present"
else
  miss "hyper-implement-loop failure-protocol.md: 'awaiting_reply' field reference missing"
fi
# Note: solicit_sent_at is intentionally NOT checked in failure-protocol.md.
# It's a shared-§E-only field used inside the stale-idle guard pseudo-code;
# the local binding routes through §E without needing to reference it by name.
# SKILL.md does reference solicit_sent_at (in the Step 7 mint paragraph) and
# that assertion is above ('hyper-implement-loop SKILL.md: solicit_sent_at field present').

if ! grep -q 'request-id:' agents/fixer.md 2>/dev/null; then
  ok "agents/fixer.md: 'request-id:' NOT encoded in general agent (loop-injected only)"
else
  miss "agents/fixer.md: 'request-id:' encoded in general agent (Major #3 invariant violated)"
fi

echo
echo "==> hyper-docs-loop binding assertions"

dl_skill="skills/hyper-docs-loop/SKILL.md"
dl_fp="skills/hyper-docs-loop/references/failure-protocol.md"

if grep -q '\${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md' "$dl_skill" 2>/dev/null; then
  ok "hyper-docs-loop SKILL.md: references shared loop-protocol at Step 0"
else
  miss "hyper-docs-loop SKILL.md: does not reference shared loop-protocol"
fi

if grep -q 'request_id_counter' "$dl_skill" 2>/dev/null; then
  ok "hyper-docs-loop SKILL.md: 'request_id_counter' run-state field present"
else
  miss "hyper-docs-loop SKILL.md: 'request_id_counter' run-state field missing"
fi

if grep -q 'awaiting_reply' "$dl_skill" 2>/dev/null; then
  ok "hyper-docs-loop SKILL.md: 'awaiting_reply' field name present"
else
  miss "hyper-docs-loop SKILL.md: 'awaiting_reply' field name missing"
fi

if grep -q 'expected_request_id' "$dl_skill" 2>/dev/null; then
  ok "hyper-docs-loop SKILL.md: 'expected_request_id' field present"
else
  miss "hyper-docs-loop SKILL.md: 'expected_request_id' field missing"
fi

if grep -q 'solicit_sent_at' "$dl_skill" 2>/dev/null; then
  ok "hyper-docs-loop SKILL.md: 'solicit_sent_at' field present"
else
  miss "hyper-docs-loop SKILL.md: 'solicit_sent_at' field missing"
fi

if grep -q 'request-id:' "$dl_skill" 2>/dev/null; then
  ok "hyper-docs-loop SKILL.md: 'request-id:' documenter spawn-prompt prefix present"
else
  miss "hyper-docs-loop SKILL.md: 'request-id:' documenter spawn-prompt prefix missing"
fi

if grep -q '"documenter"' "$dl_skill" 2>/dev/null; then
  ok "hyper-docs-loop SKILL.md: documenter is the teammate role"
else
  miss "hyper-docs-loop SKILL.md: documenter teammate role binding missing"
fi

if grep -q 'request-id:' "$dl_fp" 2>/dev/null; then
  ok "hyper-docs-loop failure-protocol.md: 'request-id:' gate binding present"
else
  miss "hyper-docs-loop failure-protocol.md: 'request-id:' gate binding missing"
fi

if grep -q 'documenter' "$dl_fp" 2>/dev/null; then
  ok "hyper-docs-loop failure-protocol.md: documenter role binding present"
else
  miss "hyper-docs-loop failure-protocol.md: documenter role binding missing"
fi

if ! grep -q 'request-id:' agents/documenter.md 2>/dev/null; then
  ok "agents/documenter.md: 'request-id:' NOT encoded in general agent (loop-injected only)"
else
  miss "agents/documenter.md: 'request-id:' encoded in general agent (loop-agnostic invariant violated)"
fi

echo
echo "==> agent-teams v2.1.178 contract assertions"

for f in \
  skills/hyper-plan-loop/SKILL.md \
  skills/hyper-implement-loop/SKILL.md \
  skills/hyper-docs-loop/SKILL.md \
  references/loop-protocol.md \
  skills/hyper-plan-loop/references/failure-protocol.md \
  skills/hyper-implement-loop/references/failure-protocol.md \
  skills/hyper-docs-loop/references/failure-protocol.md; do
  for tok in TeamCreate TeamDelete team_name; do
    if grep -q "$tok" "$f" 2>/dev/null; then
      miss "$f: contains deprecated $tok"
    else
      ok "$f: no $tok"
    fi
  done
done

for f in \
  skills/hyper-plan-loop/SKILL.md \
  skills/hyper-implement-loop/SKILL.md \
  skills/hyper-docs-loop/SKILL.md; do
  if grep -qF '[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]' "$f" 2>/dev/null; then
    ok "$f: contains env probe for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"
  else
    miss "$f: missing env probe for CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"
  fi
done

# Positive: teammate_id contract — every SKILL.md, failure-protocol.md, and the
# shared loop-protocol must carry the 'teammate_id' run-state field name.
for f in \
  skills/hyper-plan-loop/SKILL.md \
  skills/hyper-implement-loop/SKILL.md \
  skills/hyper-docs-loop/SKILL.md \
  skills/hyper-plan-loop/references/failure-protocol.md \
  skills/hyper-implement-loop/references/failure-protocol.md \
  skills/hyper-docs-loop/references/failure-protocol.md \
  references/loop-protocol.md; do
  if grep -q 'teammate_id' "$f" 2>/dev/null; then
    ok "$f: contains 'teammate_id' (id-resolution contract)"
  else
    miss "$f: missing 'teammate_id' (id-resolution contract)"
  fi
done

# Negative: no literal lead→teammate name sends remain (to: "planner" / "fixer" / "documenter").
# loop-protocol.md is EXEMPT — it retains the abstract <teammate-name> alias by design.
for f in \
  skills/hyper-plan-loop/SKILL.md \
  skills/hyper-implement-loop/SKILL.md \
  skills/hyper-docs-loop/SKILL.md \
  skills/hyper-plan-loop/references/failure-protocol.md \
  skills/hyper-implement-loop/references/failure-protocol.md \
  skills/hyper-docs-loop/references/failure-protocol.md; do
  if grep -qE 'to:[[:space:]]*"(planner|fixer|documenter)"' "$f" 2>/dev/null; then
    miss "$f: contains literal lead→teammate role-name send (to: \"planner\"/\"fixer\"/\"documenter\") — must use teammate_id"
  else
    ok "$f: no literal lead→teammate role-name send (id-only addressing)"
  fi
done

# No-wait teardown: loop-protocol.md §C must contain 'best-effort' AND must NOT
# contain the old rejected-shutdown recovery phrase ('approve: false').
if grep -q 'best-effort' references/loop-protocol.md 2>/dev/null; then
  ok "references/loop-protocol.md §C: 'best-effort' no-wait teardown wording present"
else
  miss "references/loop-protocol.md §C: 'best-effort' no-wait teardown wording missing"
fi

if ! grep -q 'approve: false' references/loop-protocol.md 2>/dev/null; then
  ok "references/loop-protocol.md §C: old rejected-shutdown recovery phrase ('approve: false') absent"
else
  miss "references/loop-protocol.md §C: old rejected-shutdown recovery phrase ('approve: false') still present"
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

  1b. Inside the session, run:
       /hyperclaude:hyper-interview <a deliberately vague idea>
     Verify it asks ONE question at a time (AskUserQuestion), enforces
     the HARD-GATE (no implementation before spec approval), writes a
     file under .hyperclaude/specs/ with `mode: interview` / `idea` /
     `slug` / `type` frontmatter PLUS a hook-stamped `plugin-version`
     line, and that the handoff passes the ORIGINAL idea text (so a
     later /hyperclaude:hyper-plan derives the same slug and the trace
     stays linked).

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

  8. Run:
       /hyperclaude:hyper-plan-loop <small task>
     If agent teams are available: verify the plan file is written BY
     THE PLANNER itself at the lead-resolved path under
     .hyperclaude/plans/ (the lead never Writes it), that planner
     replies are `WROTE: <reqid> <path>`-only (the planner echoes the
     lead-supplied id verbatim, the id increments across revise and
     corrective rounds) with no plan body echoed and no
     "RESEND:"/duplicate-body churn between revise rounds, that at
     least one Codex plan-review runs, and the loop reaches a terminal
     state (clean exit, iteration cap, or controlled failure) bounded
     by the review cap, ending after a best-effort `shutdown_request`
     to the captured `agent_id` (the loop does NOT wait for shutdown
     confirmation; the teammate is auto-cleaned on session exit).
     Confirm lead→teammate messages address the spawn-captured
     `agent_id` (id-only, not the role name "planner"); confirm any
     degrade (agentId missing, or returned but teammate lacks
     SendMessage, or a send not-addressable) deterministically STOPs
     with the loop's documented fallback — no notification-reply
     proceed; a degrade with no addressable teammate STOPs without
     a teardown attempt.
     If agent teams are unavailable: verify it prints the documented
     graceful-fallback message and leaves no team behind.
     One branch always applies — this check is required either way.

  9. Run:
       /hyperclaude:hyper-implement-loop <path-to-plan>
     If agent teams are available: verify that after `hyper-implement`
     completes ALL plan tasks, the bridge is invoked once for a Codex
     `code-review --base main`, then the fixer↔code-review loop runs,
     that the fixer agent applies Codex findings via a semantic
     finding-map (not a raw diff), that the loop is bounded by the
     review cap (6 total Codex reviews maximum), and that the loop
     reaches a terminal state (clean exit on no blocking findings, or
     the 6-review cap reached), ending after a best-effort
     `shutdown_request` to the captured `agent_id` (the loop does NOT
     wait for shutdown confirmation; the teammate is auto-cleaned on
     session exit). If degrade happens AFTER `hyper-implement` ran,
     verify the already-committed implementation is preserved (degrade
     is not a clean no-op in that case). Confirm lead→teammate messages
     address the spawn-captured `agent_id` (id-only, not the role name
     "fixer"); confirm any degrade deterministically STOPs — no
     notification-reply proceed; a degrade with no addressable teammate
     STOPs without a teardown attempt.
     If agent teams are unavailable: verify it prints the documented
     graceful-fallback message and leaves no team behind.
     One branch always applies — this check is required either way.

  9b. Run:
       /hyperclaude:hyper-docs-loop docs/
     If agent teams are available: verify the documenter is spawned
     once as a teammate, that Codex docs-review runs against
     `--docs-dir docs/` on each iteration, that ONLY blocking
     `### Findings` items drive fix rounds (Gaps / Broken Or Suspect
     Links / Cross-Doc Inconsistencies are reported but never sent to
     the documenter), that documenter replies are prefixed with
     `request-id: <integer>` and carry the per-finding structured
     schema (`finding:` / `status:` / `files-changed:` / `verification:`
     / `notes:`), and that the loop reaches a terminal state bounded by
     the 6-review cap, ending after a best-effort `shutdown_request` to
     the captured `agent_id` (the loop does NOT wait for shutdown
     confirmation; the teammate is auto-cleaned on session exit).
     Confirm lead→teammate messages address the spawn-captured
     `agent_id` (id-only, not the role name "documenter"); confirm any
     degrade deterministically STOPs — no notification-reply proceed;
     a degrade with no addressable teammate STOPs without a teardown
     attempt.
     If agent teams are unavailable: verify it prints the documented
     graceful-fallback message and leaves no team behind.
     One branch always applies — this check is required either way.

  10. Run:
       /hyperclaude:hyper-auto <small task description>
     If agent teams are available: verify that the skill chains
     hyper-plan-loop → hyper-implement-loop in one gesture — plan-loop
     runs to terminal state first, and ONLY a clean exit (no blocking
     findings) advances into implement-loop with the canonical plan
     path. Verify the safety boundary: artificially induce or simulate
     a plan-loop non-clean terminal (cap-reached with blocking still
     open, bridge failure, etc.) and confirm implement-loop is NOT
     invoked.
     Verify the final report relays both phases' Step 9 facts (no
     invented fields), with the composed-flow exception: plan-loop's
     clean-exit "Next step: /hyperclaude:hyper-implement <plan path>"
     recommendation is suppressed (implement already ran in Step 3) so
     the surfaced next-step is the implement-loop's own guidance.
     If agent teams are unavailable: verify the inherited graceful
     fallback fires before any inner loop spawns a team.

  11. Run (in a fresh Claude Code session):
       /hyperclaude:hyper-setup
     Verify it runs the doctor probe, renders a per-prerequisite
     pass/fail table with remediation lines for any non-PASS check,
     and writes NO file under .hyperclaude/ (report-only, not a gate).

If any of the above fails, STOP and fix before shipping.
====================================================================
NOTE

echo
echo "==> manual acceptance recommended for Phase B reqid promotion"
echo "   1. Author a tiny throwaway plan (one task) under .hyperclaude/plans/"
echo "   2. Run /hyperclaude:hyper-implement-loop <that-plan-path> in a fresh Claude Code session"
echo "      with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1."
echo "   3. Confirm: every fixer reply (visible in the agent-teams mailbox) begins with"
echo "      'request-id: <integer>'; the integer matches the lead's most recent findings id."
echo "   4. Confirm: the loop reaches Step 9 final report without an unsolicited-message escalation."
echo "   5. If anything diverges, the deferred implement-loop-reqid-followup race is not fully resolved."

[ "$fail" -eq 0 ]
