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

