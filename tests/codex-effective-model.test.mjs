// Direct coverage of getCodexEffectiveModel(): the doctor-then-catalog probe
// resolver behind the (not-yet-wired) `codex-model-effective` frontmatter key.
// Uses MOCK_CODEX_SUCCESS's shared MOCK_CODEX_PROBES branches (see
// helpers/fixtures.mjs) to answer `codex doctor --json` / `codex debug models`
// on PATH; env vars steer their output. Scope: the resolver itself only — Task
// 2 covers end-to-end artifact/frontmatter wiring separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { getCodexEffectiveModel } from '../scripts/codex-bridge.mjs';
import { MOCK_CODEX_SUCCESS } from './helpers/fixtures.mjs';

function withMockCodex(envOverrides, fn) {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-effective-model-'));
  const mockCodexPath = path.join(tmpdir, 'codex');
  writeFileSync(mockCodexPath, MOCK_CODEX_SUCCESS);
  chmodSync(mockCodexPath, 0o755);

  const origPath = process.env.PATH;
  const origEnv = {};
  for (const k of Object.keys(envOverrides)) origEnv[k] = process.env[k];
  process.env.PATH = `${tmpdir}:${origPath}`;
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  try {
    return fn(tmpdir);
  } finally {
    process.env.PATH = origPath;
    for (const k of Object.keys(envOverrides)) {
      if (origEnv[k] === undefined) delete process.env[k];
      else process.env[k] = origEnv[k];
    }
    rmSync(tmpdir, { recursive: true, force: true });
  }
}

test('getCodexEffectiveModel: doctor reports a concrete model — returned verbatim, catalog never probed', () => {
  withMockCodex({ MOCK_CODEX_CONFIG_MODEL: 'pinned-model' }, (tmpdir) => {
    const model = getCodexEffectiveModel();
    assert.equal(model, 'pinned-model');
    const probeLog = readFileSync(path.join(tmpdir, 'probe.log'), 'utf8');
    assert.ok(probeLog.includes('doctor'), 'doctor probe should have run');
    assert.ok(!probeLog.includes('debug'), 'catalog probe must NOT run once doctor resolves a concrete model');
  });
});

test('getCodexEffectiveModel: doctor reports <default> — falls through to the catalog default', () => {
  withMockCodex({}, () => {
    // Default mock env: doctor -> <default>, catalog -> mock-default (priority 5, list).
    const model = getCodexEffectiveModel();
    assert.equal(model, 'mock-default');
  });
});

test('getCodexEffectiveModel: doctor probe fails — returns null, catalog never probed', () => {
  withMockCodex({ MOCK_CODEX_PROBE_FAIL: '1' }, (tmpdir) => {
    const model = getCodexEffectiveModel();
    assert.equal(model, null);
    const probeLog = readFileSync(path.join(tmpdir, 'probe.log'), 'utf8');
    assert.ok(!probeLog.includes('debug'), 'catalog probe must NOT run after an unreadable doctor call');
  });
});
