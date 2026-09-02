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
echo "==> Bridge docs-review repeated --docs-path dry-run"
if out=$(node scripts/codex-bridge.mjs docs-review --docs-path README.md --docs-path docs/architecture.md --dry-run 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.ok && j.dryRun && j.slug === "readme-plus-1" ? 0 : 1);
  '; then
    ok "codex-bridge docs-review repeated --docs-path --dry-run produces expected JSON"
  else
    miss "codex-bridge docs-review repeated --docs-path --dry-run JSON shape unexpected: $out"
  fi
else
  miss "codex-bridge docs-review repeated --docs-path --dry-run failed: $out"
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
echo "==> Bridge code-review --background dry-run"
if out=$(node scripts/codex-bridge.mjs code-review --background "neutral summary" --dry-run 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.ok && j.dryRun && j.slug === "vs-main" ? 0 : 1);
  '; then
    ok "codex-bridge code-review --background --dry-run produces expected JSON"
  else
    miss "codex-bridge code-review --background --dry-run JSON shape unexpected: $out"
  fi
else
  miss "codex-bridge code-review --background --dry-run failed: $out"
fi

echo
echo "==> Bridge code-review --background + --resume mutual-exclusion"
if out=$(node scripts/codex-bridge.mjs code-review --background "x" --resume auto --dry-run 2>&1); then
  miss "codex-bridge code-review --background + --resume should exit non-zero but exited 0: $out"
else
  ok "codex-bridge code-review --background + --resume exits non-zero (mutual-exclusion enforced)"
fi

echo
echo "==> Bridge code-review --review-brief + --resume (deliberately allowed, unlike --background)"
if out=$(node scripts/codex-bridge.mjs code-review --review-brief "user asked for X" --resume auto --dry-run 2>&1); then
  ok "codex-bridge code-review --review-brief + --resume exits zero (allowed alongside --resume)"
else
  miss "codex-bridge code-review --review-brief + --resume should exit zero but failed: $out"
fi

echo
echo "==> Bridge code-review unknown-flag rejection"
if out=$(node scripts/codex-bridge.mjs code-review --bogus-flag --dry-run 2>&1); then
  miss "codex-bridge code-review --bogus-flag should exit non-zero but exited 0: $out"
else
  ok "codex-bridge code-review --bogus-flag exits non-zero (unknown-flag rejection unchanged)"
fi

echo
echo "==> setup-doctor probe"
if out=$(node scripts/setup-doctor.mjs 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    // Cross-check mirror: these names MUST match scripts/setup-doctor.mjs exactly.
    // Duplication is intentional — a rename in the doctor with no smoke update is a test failure.
    const expectedNames = [
      "Claude Code >= 2.1.232 (loop transport floor)",
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
echo "==> hyper-setup skill file content"
if node -e '
  const fs = require("fs");
  const text = fs.readFileSync("skills/hyper-setup/SKILL.md", "utf8");
  const passed =
    text.includes("disable-model-invocation: true") &&
    text.includes("node \"\${CLAUDE_PLUGIN_ROOT}/scripts/setup-doctor.mjs\"") &&
    text.includes("Prerequisite probe could not complete:") &&
    text.includes("hyperclaude prerequisites are UNKNOWN");
  process.exit(passed ? 0 : 1);
' 2>/dev/null; then
  ok "hyper-setup skill file: invoke-only flag + probe invocation + fallback sentences present"
else
  miss "hyper-setup skill file: missing expected content in skills/hyper-setup/SKILL.md"
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
  skills/hyper-implement-loop/references/failure-protocol.md \
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
  skills/hyper-setup/SKILL.md \
  scripts/setup-doctor.mjs \
  scripts/memory/extract.mjs \
  skills/hyper-memory/SKILL.md \
  skills/hyper-recap/SKILL.md
do
  if [ -f "$f" ]; then ok "$f"; else miss "$f missing"; fi
done

echo
echo "==> hyper-memory extract dry-run"
if node --check scripts/memory/extract.mjs 2>/dev/null; then
  ok "node --check scripts/memory/extract.mjs"
else
  miss "scripts/memory/extract.mjs has syntax errors"
fi

if out=$(node scripts/memory/extract.mjs --dry-run 2>&1); then
  if printf '%s' "$out" | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(j.ok === true && typeof j.scanned === "number" && j.written === 0 ? 0 : 1);
  '; then
    ok "hyper-memory extract --dry-run produces expected JSON (ok, scanned numeric, written 0)"
  else
    miss "hyper-memory extract --dry-run JSON shape unexpected: $out"
  fi
else
  miss "hyper-memory extract --dry-run failed: $out"
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
  // additionalContext must start with the template byte-for-byte. Anything
  // after the template is a dynamic .hyperclaude/ snapshot footer (optional;
  // only present when the project has artifacts under .hyperclaude/).
  const passed = j.continue === true &&
    j.hookSpecificOutput && j.hookSpecificOutput.hookEventName === "SessionStart" &&
    typeof additionalContext === "string" &&
    additionalContext.startsWith(template);
  process.exit(passed ? 0 : 1);
' 2>/dev/null; then
  ok "SessionStart hook golden-path: additionalContext starts with session-start-reminder.md byte-for-byte"
else
  miss "SessionStart hook golden-path: additionalContext starts with session-start-reminder.md byte-for-byte"
fi

# Snapshot footer is dynamic — it should appear iff .hyperclaude/ has artifacts.
if node -e '
  const { execSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const raw = execSync(
    "printf \x27{\"session_id\":\"smoke\",\"source\":\"startup\"}\x27 | node hooks/session-start-reminder.mjs",
    { encoding: "utf8" }
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

echo
echo "==> shared bridge-review-calls reference"

if [ -f "references/bridge-review-calls.md" ]; then
  ok "shared bridge-review-calls: file exists at references/bridge-review-calls.md"
else
  miss "shared bridge-review-calls: file missing at references/bridge-review-calls.md"
fi

# Binding-hole invariant: the loop-agnostic loop-protocol.md must stay free of
# any loop-specific reply token (e.g. plan-loop's 'WROTE:') — those belong only
# in each loop's local failure-protocol.md. The complement — each loop's own
# files DO carry their reply token — is asserted in the reply-token binding
# block below.
if ! grep -q "WROTE:" "$shared_proto" 2>/dev/null; then
  ok "shared loop-protocol: 'WROTE:' token absent (binding-hole invariant)"
else
  miss "shared loop-protocol: 'WROTE:' token present (binding-hole invariant violated)"
fi

# hyper-plan-loop drives its planner through the planner bridge (a persistent
# `claude -p` session, 1h cache bucket), NOT the Agent-tool transport. These
# assert the replacement rather than the thing it replaced.
if grep -q "scripts/planner-bridge.mjs" skills/hyper-plan-loop/SKILL.md 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: drives the planner through the planner bridge"
else
  miss "hyper-plan-loop SKILL.md: no planner-bridge invocation"
fi

if grep -qE "agent_id|SendMessage\\(" skills/hyper-plan-loop/SKILL.md 2>/dev/null; then
  miss "hyper-plan-loop SKILL.md: stale Agent-tool transport reference (agent_id / SendMessage)"
else
  ok "hyper-plan-loop SKILL.md: no stale Agent-tool transport reference"
fi

if grep -q -- "--end" skills/hyper-plan-loop/SKILL.md 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: discards the planner session at the terminal step"
else
  miss "hyper-plan-loop SKILL.md: never ends the planner session (--end missing)"
fi

# Planner turns must be backgrounded: measured on a real repo, a planner turn
# outran the Bash tool 600s FOREGROUND ceiling and was killed mid-write.
pb_calls=$(grep -c 'planner-bridge.mjs" .*--prompt-file' skills/hyper-plan-loop/SKILL.md 2>/dev/null)
pb_bg=$(grep -c "run_in_background: true" skills/hyper-plan-loop/SKILL.md 2>/dev/null)
if [ "$pb_calls" -eq 2 ] && [ "$pb_bg" -ge 4 ]; then
  ok "hyper-plan-loop SKILL.md: planner AND codex turns all run in background"
else
  miss "hyper-plan-loop SKILL.md: a planner-bridge turn still runs foreground (calls=$pb_calls background=$pb_bg)"
fi

# A STOP after a failed --start must not run --end: on a key collision the
# session belongs to another live run, and --end cannot check ownership.
if grep -q "never runs \`--end\`" skills/hyper-plan-loop/references/failure-protocol.md 2>/dev/null; then
  ok "hyper-plan-loop failure-protocol.md: a failed --start skips the STOP --end"
else
  miss "hyper-plan-loop failure-protocol.md: missing the failed---start --end exception"
fi

# Sessions key on the plan-file stem, not the slug: two tasks can derive the
# same slug and would then resume each other's planner conversation.
if grep -q -- "--workflow" skills/hyper-plan-loop/SKILL.md 2>/dev/null && ! grep -q -- "planner-bridge.mjs --slug" skills/hyper-plan-loop/SKILL.md 2>/dev/null; then
  ok "hyper-plan-loop SKILL.md: keys the planner session on --workflow, not the collidable slug"
else
  miss "hyper-plan-loop SKILL.md: planner session keyed on the slug (workflows can collide)"
fi

echo
echo "==> hyper-implement-loop shared loop-protocol reference"

il_skill="skills/hyper-implement-loop/SKILL.md"

if grep -q '\${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md' "$il_skill" 2>/dev/null; then
  ok "hyper-implement-loop SKILL.md: references shared loop-protocol at Step 0"
else
  miss "hyper-implement-loop SKILL.md: does not reference shared loop-protocol"
fi

echo
echo "==> hyper-docs-loop shared loop-protocol reference"

dl_skill="skills/hyper-docs-loop/SKILL.md"

if grep -q '\${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md' "$dl_skill" 2>/dev/null; then
  ok "hyper-docs-loop SKILL.md: references shared loop-protocol at Step 0"
else
  miss "hyper-docs-loop SKILL.md: does not reference shared loop-protocol"
fi

echo
echo "==> no-name agentId spawn invariants"

# Each loop spawns its agent by subagent_type with NO `name:` field, then
# addresses every later round by the returned agentId. A named spawn makes the
# agent a team member and the harness drops the plugin agent definition (tools:
# allowlist lost, ~18KB skill listing re-attached per round, prompt cache
# invalidated). The paired PRESENT/ABSENT checks catch a regression in either
# direction: losing the subagent_type spawn, or reintroducing `name:`.
# hyper-plan-loop is deliberately absent: its planner runs as a planner-bridge
# session, asserted above.
for pair in \
  "skills/hyper-implement-loop/SKILL.md:fixer" \
  "skills/hyper-docs-loop/SKILL.md:documenter"
do
  loop_skill="${pair%:*}"
  loop_role="${pair##*:}"
  if grep -q "subagent_type: \"hyperclaude:$loop_role\"" "$loop_skill" 2>/dev/null; then
    ok "$loop_skill: spawns subagent_type \"hyperclaude:$loop_role\""
  else
    miss "$loop_skill: missing subagent_type \"hyperclaude:$loop_role\" spawn"
  fi
  # Quoted or unquoted. Not vacuous: each SKILL's own frontmatter carries a
  # `name: hyper-*-loop` line, which this role-scoped pattern never matches.
  if ! grep -qE "name:[[:space:]]*\"?$loop_role\"?" "$loop_skill" 2>/dev/null; then
    ok "$loop_skill: no 'name: $loop_role' spawn field (agent is not a team member)"
  else
    miss "$loop_skill: 'name: $loop_role' present — a named spawn drops the agent definition"
  fi
  # The other half of the transport: later rounds MUST address the captured id.
  # Without this, deleting every `to: "<agent_id>"` send would still pass the
  # two checks above while breaking multi-round context reuse entirely.
  if grep -q 'to: "<agent_id>"' "$loop_skill" 2>/dev/null; then
    ok "$loop_skill: later rounds SendMessage to the captured agent_id"
  else
    miss "$loop_skill: no 'to: \"<agent_id>\"' send — later rounds cannot reach the agent"
  fi
done

# The agent-teams machinery these loops were converted off must stay deleted:
# the AGENT_TEAMS env gate, the [DEGRADE] override block, the shutdown/teardown
# step, the request-id handshake counters, and bare-`teammate_name` mailbox
# addressing. Every `§` in these files was a cross-reference into those deleted
# sections, so a stray § means old protocol text came back with it.
for f in \
  skills/hyper-plan-loop/SKILL.md \
  skills/hyper-plan-loop/references/failure-protocol.md \
  skills/hyper-implement-loop/SKILL.md \
  skills/hyper-implement-loop/references/failure-protocol.md \
  skills/hyper-docs-loop/SKILL.md \
  skills/hyper-docs-loop/references/failure-protocol.md \
  references/loop-protocol.md
do
  if ! grep -qE 'AGENT_TEAMS|\[DEGRADE\]|shutdown_request|request_id_counter|solicit_sent_at|teammate_name|request-id:' "$f" 2>/dev/null; then
    ok "$f: no agent-teams machinery tokens (AGENT_TEAMS/[DEGRADE]/shutdown_request/counters/teammate_name/request-id:)"
  else
    miss "$f: agent-teams machinery token reintroduced: $(grep -oE 'AGENT_TEAMS|\[DEGRADE\]|shutdown_request|request_id_counter|solicit_sent_at|teammate_name|request-id:' "$f" 2>/dev/null | sort -u | tr '\n' ' ')"
  fi
  if ! grep -q '§' "$f" 2>/dev/null; then
    ok "$f: no '§' section references (deleted protocol sections stay deleted)"
  else
    miss "$f: '§' section reference present — points at a deleted protocol section"
  fi
done

# The reply transport is the spawned task's notification <result>, not a mailbox
# read. The shared protocol is the one place that names it.
if grep -q 'notification `<result>`' "$shared_proto" 2>/dev/null; then
  ok "shared loop-protocol: names the task-notification \`<result>\` reply transport"
else
  miss "shared loop-protocol: does not name the task-notification \`<result>\` reply transport"
fi

echo
echo "==> loop reply-token binding invariants"

# Complement of the binding-hole check above: the token the shared protocol must
# NOT carry is exactly the token each loop's own SKILL + failure-protocol pair
# MUST carry, so the loop-bound reply shape has a home.
for f in \
  skills/hyper-plan-loop/SKILL.md \
  skills/hyper-plan-loop/references/failure-protocol.md
do
  if grep -q "WROTE:" "$f" 2>/dev/null; then
    ok "$f: carries the plan-loop 'WROTE:' reply token"
  else
    miss "$f: missing the plan-loop 'WROTE:' reply token"
  fi
done

for f in \
  skills/hyper-implement-loop/SKILL.md \
  skills/hyper-implement-loop/references/failure-protocol.md \
  skills/hyper-docs-loop/SKILL.md \
  skills/hyper-docs-loop/references/failure-protocol.md
do
  if grep -q "files-changed:" "$f" 2>/dev/null; then
    ok "$f: carries the structured-schema 'files-changed:' reply field"
  else
    miss "$f: missing the structured-schema 'files-changed:' reply field"
  fi
done

echo
echo "==> Summary"
echo "  passed: $pass"
echo "  failed: $fail"
echo
cat <<'NOTE'
====================================================================
POST-RELEASE DOGFOODING CHECKLIST
--------------------------------------------------------------------
The checks above cover structure, not behavior. Behavioral acceptance
happens by dogfooding the RELEASED plugin — so these are the flows to
exercise after `git tag -a vX.Y.Z`, not a pre-tag gate:

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

  5b. With a completed cycle present (a plans/done/ entry), run:
       /hyperclaude:hyper-recap
     Verify it recaps the newest plans/done/ plan and writes
     .hyperclaude/recaps/<timestamp>[-<slug>].md with `mode: recap`, a
     `context: live|artifacts-only` marker, a double-quoted `plan:`
     value, and a hook-stamped `plugin-version` line, and that the run
     REPORTS the exact written `.hyperclaude/recaps/<...>.md` path
     (collision suffix included).
     Then, with plans/done/ temporarily emptied (move entries aside),
     run again: verify it reports "nothing to recap" (stating the
     reason and claiming NO path) and writes nothing.
     Then create a timestamp-only done-plan fixture
     (.hyperclaude/plans/done/<YYYYMMDD-HHMM>.md) and run
     /hyperclaude:hyper-recap: verify a timestamp-only recap filename
     (no dangling `-`), a bare empty `slug: `, and skipped
     research/spec linkage.
     Then create a collision-suffixed fixture
     (<timestamp>-<slug>-2.md) and run again: verify research/spec
     linkage is marked unavailable, not matched to the un-suffixed
     slug.
     Confirm NO Codex spawn and NO agent dispatch throughout.

  6. Run:
       /hyperclaude:hyper-docs-sync uncommitted
     Verify mapping read, doc updates dispatched, summary reported.

  7. Run:
       /hyperclaude:hyper-docs-review
     Verify a file appears under .hyperclaude/docs-reviews/ with
     valid frontmatter.

  8. Run:
       /hyperclaude:hyper-plan-loop <small task>
     Verify Step 2 starts the planner through
     `scripts/planner-bridge.mjs --workflow <plan-file stem> --start`,
     that a session id appears at
     .hyperclaude/planner-sessions/<that stem>.id, and that the plan
     file is written BY THE PLANNER itself at the lead-resolved path
     under .hyperclaude/plans/ (the lead never Writes it), with the
     envelope body `WROTE: <path>`-only — no plan body echoed, no
     preamble.
     Verify each later revise round calls the bridge with the SAME
     --workflow key and comes back with "resumed":true, that the
     planner still holds its planning context (it revises in place
     without being re-sent the task or the research), that at least
     one Codex plan-review runs, and that the loop reaches a terminal
     state (clean exit, review cap, or controlled failure) bounded by
     the 10-review cap.
     Verify the terminal step runs `--end` and the session id file is
     gone afterwards, and that a STOP on a failed --start does NOT
     run --end. Ctrl-C mid-round should leave no session file behind.

  9. Run:
       /hyperclaude:hyper-implement-loop <path-to-plan>
     Verify that after `hyper-implement` completes ALL plan tasks, the
     bridge is invoked once for a Codex `code-review --base main`, and
     that the fixer is spawned by `subagent_type` with NO `name:` field
     — lazily, only on the FIRST round carrying blocking findings (a run
     Codex clears on iteration 1 spawns no fixer at all). Verify the
     fixer applies Codex findings via a semantic finding-map (not a raw
     diff) and that its reply arrives as that task's `<result>` carrying
     the structured per-finding schema (`finding:` / `status:` /
     `files-changed:` / `verification:` / `notes:`).
     Verify each later fix round goes out as a `SendMessage` to the
     returned agentId with the fixer's context retained, that the loop
     is bounded by the 6-review cap, that it reaches a terminal state
     (clean exit on no blocking findings, or the cap), and that NO
     shutdown or teardown message is sent.
     If a transport failure STOPs the loop after `hyper-implement` ran,
     verify the already-committed implementation is preserved and
     reported (that STOP is not a clean no-op).

  9b. Run:
       /hyperclaude:hyper-docs-loop docs/
     Verify Codex docs-review runs against `--docs-dir docs/` on each
     iteration, that ONLY blocking `### Findings` items drive fix rounds
     (Gaps / Broken Or Suspect Links / Cross-Doc Inconsistencies are
     reported but never sent to the documenter), and that the documenter
     is spawned by `subagent_type` with NO `name:` field — lazily, only
     on the first round carrying blocking findings.
     Verify its reply arrives as that task's `<result>` carrying the
     per-finding structured schema (`finding:` / `status:` /
     `files-changed:` / `verification:` / `notes:`), that each later
     round goes out as a `SendMessage` to the returned agentId with
     context retained, that the loop reaches a terminal state bounded by
     the 6-review cap, and that NO shutdown or teardown message is
     sent.

  10. Run:
       /hyperclaude:hyper-auto <small task description>
     Verify that the skill chains hyper-plan-loop → hyper-implement-loop
     in one gesture — plan-loop runs to terminal state first, and ONLY a
     clean exit (no blocking findings) advances into implement-loop with
     the canonical plan path.
     Verify the safety boundary: artificially induce or simulate
     a plan-loop non-clean terminal (cap-reached with blocking still
     open, bridge failure, etc.) and confirm implement-loop is NOT
     invoked.
     Verify the final report relays both phases' final-report facts (no
     invented fields), with the composed-flow exception: plan-loop's
     clean-exit "Next step: /hyperclaude:hyper-implement <plan path>"
     recommendation is suppressed (implement already ran in Step 3) so
     the surfaced next-step is the implement-loop's own guidance.
     On a clean composed exit (plan-loop clean AND implement-loop
     Step-7 `fix(review):` convergence commit succeeded/skipped with a
     clean tree), verify hyper-auto invokes /hyperclaude:hyper-recap
     with the canonical plan path (NOT no-arg) BEFORE its final report,
     that the report carries the actual written recap path, and that
     the implement-loop's recap-recommendation bullet is no longer
     relayed. On a FAILED Step-7 convergence commit, verify NO recap
     file is written, the report makes no recap-path claim, it emits
     the explicit `auto-recap skipped (<reason>)` line, and it does NOT
     relay the standalone recommendation. On either loop's cap/failure,
     verify no recap runs.

  11. Run (in a fresh Claude Code session):
       /hyperclaude:hyper-setup
     Verify it runs the doctor probe, renders a per-prerequisite
     pass/fail table with remediation lines for any non-PASS check,
     and writes NO file under .hyperclaude/ (report-only, not a gate).

Whatever a dogfood run turns up is input to the next cycle.
====================================================================
NOTE

[ "$fail" -eq 0 ]
