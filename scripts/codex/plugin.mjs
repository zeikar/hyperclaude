// Plugin self-identification for the bridge.
// getPluginVersion reads the plugin's OWN .claude-plugin/plugin.json, resolved
// relative to THIS file — so the version recorded in an artifact reflects the
// code that actually produced it (the loaded copy on disk), not whatever the
// repo working tree currently holds. Pure provenance: read failures degrade to
// 'unknown' rather than throwing, matching getCodexVersion's 'unknown' sentinel.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// scripts/codex/plugin.mjs → plugin root is two segments up.
const PLUGIN_JSON = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json',
);

export function getPluginVersion() {
  try {
    const { version } = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
    return typeof version === 'string' && version.length > 0 ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
