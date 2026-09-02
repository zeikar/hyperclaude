// Shared fixtures for the codex-bridge test files: the bridge entry path and
// the inline mock `codex` scripts placed on PATH by the spawn tests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
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
export const MOCK_CODEX_SUCCESS = `#!/usr/bin/env bash
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
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":5,"reasoning_output_tokens":1}}'
exit 0
`;

// Mock codex script for `exec` failure: exits 7 with stderr; no turn.completed.
export const MOCK_CODEX_FAILURE = `#!/usr/bin/env bash
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
export const MOCK_CODEX_REVIEW_SUCCESS = `#!/usr/bin/env bash
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
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":8,"cached_input_tokens":3,"output_tokens":4,"reasoning_output_tokens":2}}'
exit 0
`;

// Mock codex script for `codex exec review` failure: JSONL shape, no turn.completed.
export const MOCK_CODEX_REVIEW_FAILURE = `#!/usr/bin/env bash
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
export const MOCK_CODEX_DOCS_REVIEW_SUCCESS = `#!/usr/bin/env bash
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
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":4,"output_tokens":3,"reasoning_output_tokens":0}}'
exit 0
`;

// Mock codex script for docs-review failure (uses `codex exec`): no turn.completed.
export const MOCK_CODEX_DOCS_REVIEW_FAILURE = `#!/usr/bin/env bash
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


// ---------------------------------------------------------------------------
// Planner bridge fixtures.
//
// The planner bridge spawns `claude` (not codex) with an argv array and
// HYPERCLAUDE_ROLE=planner in the child env. Each mock records argv (one per
// line) plus the role env, then emits a `--output-format json` envelope.
// ---------------------------------------------------------------------------

export const PLANNER_BRIDGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'planner-bridge.mjs'
);

export const MOCK_CLAUDE_SUCCESS = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
printf '%s\\n' "\${HYPERCLAUDE_ROLE:-<unset>}" > "$(dirname "$0")/role.log"
sid=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$arg"; fi
  prev="$arg"
done
printf '{"type":"result","is_error":false,"session_id":"%s","result":"## Task 1: do the thing"}\\n' "$sid"
`;

export const MOCK_CLAUDE_IS_ERROR = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
printf '{"type":"result","is_error":true,"result":"planner hit a permission denial"}\\n'
`;

export const MOCK_CLAUDE_NONZERO = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
echo 'claude: fatal: something broke' >&2
exit 7
`;

// Sleeps so the harness can signal the bridge mid-run, and records that it was
// asked to stop. `trap` fires on the forwarded SIGTERM.
export const MOCK_CLAUDE_SLOW = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
sleep 30 &
sleep_pid=$!
# Kill the backgrounded sleep too. Leaving it alive would orphan a process that
# still holds this script's stdout pipe, so the parent's 'close' would not fire
# until the sleep ended -- the same shape as the codex npm-wrapper kill bug.
trap 'printf killed > "$(dirname "$0")/killed.log"; kill "$sleep_pid" 2>/dev/null; exit 143' TERM INT
printf ready > "$(dirname "$0")/ready.log"
wait "$sleep_pid"
`;

// Records whether the workflow's session file already existed when claude was
// spawned — proving the key is reserved BEFORE the child runs, not after.
export const MOCK_CLAUDE_RESERVATION_CHECK = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$(dirname "$0")/argv.log"
cat > "$(dirname "$0")/stdin.log"
if ls .hyperclaude/planner-sessions/*.id >/dev/null 2>&1; then
  printf reserved > "$(dirname "$0")/reservation.log"
else
  printf absent > "$(dirname "$0")/reservation.log"
fi
printf '{"type":"result","is_error":false,"session_id":"sid-from-claude","result":"## Task 1: ok"}\\n'
`;
