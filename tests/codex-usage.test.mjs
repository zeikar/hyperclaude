// Unit tests: usage-based reviewer seat selection — parseRateLimitsReply,
// monthlyWindowStart, normalizeWindows, decideWindow, decideSeat,
// formatUsageSummary, buildUsageEnvelope — plus the app-server probe
// (readCodexRateLimits) and the
// bridge's `usage` CLI mode, both driven by a mock `codex` on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import {
  FLOOR_PCT, MARGIN, CEILING_PCT,
  parseRateLimitsReply, monthlyWindowStart, normalizeWindows,
  decideWindow, decideSeat, formatUsageSummary, buildUsageEnvelope,
} from '../scripts/codex-bridge.mjs';
import { BRIDGE } from './helpers/fixtures.mjs';

// ── parseRateLimitsReply ─────────────────────────────────────────────────────

test('parseRateLimitsReply: picks the JSON-RPC reply whose id is 1, skipping other lines', () => {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', method: 'session/notification', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { irrelevant: true } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { rateLimits: { primary: null, secondary: null, individualLimit: null } } }),
  ].join('\n');
  const r = parseRateLimitsReply(lines);
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { rateLimits: { primary: null, secondary: null, individualLimit: null } });
});

test('parseRateLimitsReply: a server-to-client request carrying id 1 is not our reply', () => {
  // JSON-RPC ids are per direction; only a message without `method` is a reply.
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'item/tool/requestUserInput', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { rateLimits: { planType: 'plus' } } }),
  ].join('\n');
  const r = parseRateLimitsReply(lines);
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { rateLimits: { planType: 'plus' } });
});

test('parseRateLimitsReply: JSON-RPC error reply yields ok:false', () => {
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } });
  const r = parseRateLimitsReply(line);
  assert.equal(r.ok, false);
  assert.match(r.reason, /boom/);
});

test('parseRateLimitsReply: empty stdout yields ok:false', () => {
  const r = parseRateLimitsReply('');
  assert.equal(r.ok, false);
});

test('parseRateLimitsReply: no id:1 line in stdout yields ok:false', () => {
  const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/notification', params: {} });
  const r = parseRateLimitsReply(line);
  assert.equal(r.ok, false);
});

// ── monthlyWindowStart ───────────────────────────────────────────────────────

test('monthlyWindowStart: Mar 31 clamps to Feb 28 in a non-leap year', () => {
  const resetsAtMs = Date.UTC(2026, 2, 31, 12, 0, 0); // 2026 is not a leap year
  const got = monthlyWindowStart(resetsAtMs);
  assert.equal(got, Date.UTC(2026, 1, 28, 12, 0, 0));
});

test('monthlyWindowStart: Mar 31 clamps to Feb 29 in a leap year', () => {
  const resetsAtMs = Date.UTC(2028, 2, 31, 12, 0, 0); // 2028 is a leap year
  const got = monthlyWindowStart(resetsAtMs);
  assert.equal(got, Date.UTC(2028, 1, 29, 12, 0, 0));
});

test('monthlyWindowStart: Jan 15 rolls back to Dec 15 of the prior year', () => {
  const resetsAtMs = Date.UTC(2026, 0, 15, 9, 30, 0);
  const got = monthlyWindowStart(resetsAtMs);
  assert.equal(got, Date.UTC(2025, 11, 15, 9, 30, 0));
});

// ── normalizeWindows ─────────────────────────────────────────────────────────

test('normalizeWindows: Plus-plan fixture — seconds/minutes units convert correctly to ms', () => {
  // Raw captured RPC values (seconds / minutes), NOT milliseconds.
  const rateLimits = {
    primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 1790592447 },
    secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1791110872 },
    individualLimit: null,
  };
  const nowMs = 1790592447 * 1000 - 2 * 60 * 60 * 1000; // 2h before primary's resetsAt
  const windows = normalizeWindows(rateLimits, nowMs);
  assert.equal(windows.length, 2);
  const [primary, secondary] = windows;
  assert.equal(primary.name, '5h');
  assert.equal(primary.usedPercent, 38);
  // If resetsAt (seconds) were compared against nowMs (ms) without the ×1000
  // conversion, this would be wildly wrong (or NaN) instead of exactly 60.
  assert.equal(primary.elapsedPercent, 60);
  assert.notEqual(primary.note, 'reset');
  assert.equal(secondary.name, 'weekly');
  assert.equal(secondary.usedPercent, 81);
  assert.notEqual(secondary.note, 'reset');
  assert.equal(typeof secondary.elapsedPercent, 'number');
});

test('normalizeWindows: Business-shaped fixture (both windows null) yields one monthly window via remainingPercent', () => {
  const resetsAt = 1790592447; // seconds
  const resetsAtMs = resetsAt * 1000;
  const windowStartMs = monthlyWindowStart(resetsAtMs);
  const nowMs = windowStartMs + (resetsAtMs - windowStartMs) / 2; // halfway through the month
  const rateLimits = {
    primary: null,
    secondary: null,
    individualLimit: { limit: 1000, used: 300, remainingPercent: 70, resetsAt },
  };
  const windows = normalizeWindows(rateLimits, nowMs);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].name, 'monthly');
  assert.equal(windows[0].usedPercent, 30); // 100 - remainingPercent
  assert.ok(windows[0].elapsedPercent > 45 && windows[0].elapsedPercent < 55);
  assert.equal(windows[0].note, null);
});

test('normalizeWindows: individualLimit falls back to 100×used/limit when remainingPercent is absent', () => {
  const rateLimits = {
    primary: null,
    secondary: null,
    individualLimit: { limit: 400, used: 100, resetsAt: 1790592447 },
  };
  const windows = normalizeWindows(rateLimits, 0);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 25);
});

test('normalizeWindows: a resetsAt at/before nowMs is reported as reset (used 0, elapsed 0)', () => {
  const resetsAt = 1790592447; // seconds
  const nowMs = (resetsAt + 3600) * 1000; // one hour AFTER resetsAt → reset already happened
  const rateLimits = {
    primary: { usedPercent: 77, windowDurationMins: 300, resetsAt },
    secondary: null,
    individualLimit: null,
  };
  const windows = normalizeWindows(rateLimits, nowMs);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 0);
  assert.equal(windows[0].elapsedPercent, 0);
  assert.equal(windows[0].note, 'reset');
});

test('normalizeWindows: resetsAt 0 is a number, not "missing" — treated as already reset', () => {
  const rateLimits = {
    primary: { usedPercent: 77, windowDurationMins: 300, resetsAt: 0 },
    secondary: null,
    individualLimit: null,
  };
  const windows = normalizeWindows(rateLimits, Date.now());
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 0);
  assert.equal(windows[0].elapsedPercent, 0);
  assert.equal(windows[0].note, 'reset');
});

test('normalizeWindows: keeps a window with usedPercent but null resetsAt, marked pace unknown', () => {
  const rateLimits = {
    primary: { usedPercent: 92, windowDurationMins: 300, resetsAt: null },
    secondary: null,
    individualLimit: null,
  };
  const windows = normalizeWindows(rateLimits, Date.now());
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 92);
  assert.equal(windows[0].elapsedPercent, null);
  assert.equal(windows[0].note, 'pace unknown');
});

test('normalizeWindows: keeps a window with usedPercent when resetsAt is absent entirely', () => {
  const rateLimits = {
    primary: { usedPercent: 50, windowDurationMins: 300 },
    secondary: null,
    individualLimit: null,
  };
  const windows = normalizeWindows(rateLimits, Date.now());
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 50);
  assert.equal(windows[0].elapsedPercent, null);
  assert.equal(windows[0].note, 'pace unknown');
});

test('normalizeWindows: keeps a window when resetsAt is non-numeric', () => {
  const rateLimits = {
    primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 'soon' },
    secondary: null,
    individualLimit: null,
  };
  const windows = normalizeWindows(rateLimits, Date.now());
  assert.equal(windows.length, 1);
  assert.equal(windows[0].usedPercent, 15);
  assert.equal(windows[0].elapsedPercent, null);
});

test('normalizeWindows: drops a window whose usedPercent is non-numeric', () => {
  const rateLimits = {
    primary: { usedPercent: '38', windowDurationMins: 300, resetsAt: 1790592447 },
    secondary: null,
    individualLimit: null,
  };
  const windows = normalizeWindows(rateLimits, Date.now());
  assert.equal(windows.length, 0);
});

// ── decideWindow ─────────────────────────────────────────────────────────────

test('decideWindow: floor override — used below FLOOR_PCT stays codex regardless of pace', () => {
  assert.ok(15 < FLOOR_PCT);
  const w = decideWindow({ name: '5h', usedPercent: 15, elapsedPercent: 5 });
  assert.equal(w.decision, 'codex');
});

test('decideWindow: ceiling override — used at/above CEILING_PCT hands off to claude', () => {
  assert.ok(92 >= CEILING_PCT);
  const w = decideWindow({ name: '5h', usedPercent: 92, elapsedPercent: 95 });
  assert.equal(w.decision, 'claude');
});

test('decideWindow: usedPercent exactly at FLOOR_PCT is NOT floored — the pace rule applies', () => {
  // Floor is exclusive (`usedPercent < FLOOR_PCT`), so 20 falls through to the
  // pace rule: 20 > 5 × 1.1 = 5.5 → claude.
  const w = decideWindow({ name: '5h', usedPercent: FLOOR_PCT, elapsedPercent: 5 });
  assert.equal(w.decision, 'claude');
});

test('decideWindow: usedPercent exactly at CEILING_PCT is claude even when pace alone would say codex', () => {
  // 90 > 95 × 1.1 = 104.5 is false, so the pace rule alone would say codex —
  // the ceiling check must win by running first.
  const w = decideWindow({ name: '5h', usedPercent: CEILING_PCT, elapsedPercent: 95 });
  assert.equal(w.decision, 'claude');
});

test('decideWindow: margin boundary — exactly at margin stays codex, just above flips to claude', () => {
  const elapsedPercent = 40; // 40 × 1.1 = 44, between FLOOR_PCT and CEILING_PCT
  const atMargin = decideWindow({ name: '5h', usedPercent: elapsedPercent * MARGIN, elapsedPercent });
  assert.equal(atMargin.decision, 'codex');
  const aboveMargin = decideWindow({ name: '5h', usedPercent: elapsedPercent * MARGIN + 0.01, elapsedPercent });
  assert.equal(aboveMargin.decision, 'claude');
});

test('decideWindow: pace unknown between floor and ceiling stays codex (no evidence of over-pace)', () => {
  const w = decideWindow({ name: '5h', usedPercent: 50, elapsedPercent: null });
  assert.equal(w.decision, 'codex');
  assert.equal(w.pace, null);
});

test('decideWindow: pace-unknown ceiling still applies', () => {
  const w = decideWindow({ name: '5h', usedPercent: 92, elapsedPercent: null });
  assert.equal(w.decision, 'claude');
});

test('decideWindow: pace is used/elapsed, null when elapsed is 0', () => {
  const w = decideWindow({ name: '5h', usedPercent: 38, elapsedPercent: 38 });
  assert.equal(w.pace, 1);
  const zeroElapsed = decideWindow({ name: '5h', usedPercent: 10, elapsedPercent: 0 });
  assert.equal(zeroElapsed.pace, null);
});

// ── decideSeat ───────────────────────────────────────────────────────────────

test('decideSeat: multi-window disagreement — one claude decision seats claude', () => {
  const five = decideWindow({ name: '5h', usedPercent: 38, elapsedPercent: 38 });
  const weekly = decideWindow({ name: 'weekly', usedPercent: 81, elapsedPercent: 65 });
  assert.equal(five.decision, 'codex');
  assert.equal(weekly.decision, 'claude');
  const r = decideSeat([five, weekly]);
  assert.deepEqual(r, { seat: 'claude', usage: 'known' });
});

test('decideSeat: a kept window with unknown pace still counts as usage known', () => {
  const w = decideWindow({ name: '5h', usedPercent: 50, elapsedPercent: null });
  const r = decideSeat([w]);
  assert.deepEqual(r, { seat: 'codex', usage: 'known' });
});

test('decideSeat: zero kept windows → usage unknown, seat codex', () => {
  const r = decideSeat([]);
  assert.deepEqual(r, { seat: 'codex', usage: 'unknown' });
});

// ── formatUsageSummary ───────────────────────────────────────────────────────

test('formatUsageSummary: renders per-window used/elapsed/pace/decision joined with ⇒ seat', () => {
  const five = decideWindow({ name: '5h', usedPercent: 38, elapsedPercent: 38 });
  const weekly = decideWindow({ name: 'weekly', usedPercent: 81, elapsedPercent: 65 });
  const { seat } = decideSeat([five, weekly]);
  const summary = formatUsageSummary([five, weekly], seat, null);
  assert.equal(
    summary,
    '5h: used 38% elapsed 38% pace 1.00x → codex; weekly: used 81% elapsed 65% pace 1.25x → claude ⇒ seat claude',
  );
});

test('formatUsageSummary: rounds non-integer usedPercent/elapsedPercent for display (window objects stay unrounded)', () => {
  const usedPercent = 45.666666;
  const elapsedPercent = 59.79376111111111; // real division-result shape (e.g. 59.79376111111111%)
  const w = decideWindow({ name: '5h', usedPercent, elapsedPercent });
  // The window itself keeps the unrounded floats — they feed decisions/the JSON envelope.
  assert.equal(w.usedPercent, usedPercent);
  assert.equal(w.elapsedPercent, elapsedPercent);
  const summary = formatUsageSummary([w], 'codex', null);
  assert.equal(summary, '5h: used 45.7% elapsed 59.8% pace 0.76x → codex ⇒ seat codex');
});

test('formatUsageSummary: a pace-unknown window renders elapsed ? pace ?', () => {
  const w = decideWindow({ name: '5h', usedPercent: 50, elapsedPercent: null, note: 'pace unknown' });
  const summary = formatUsageSummary([w], 'codex', null);
  assert.equal(summary, '5h: used 50% elapsed ? pace ? → codex ⇒ seat codex');
});

test('formatUsageSummary: zero windows renders usage unknown with the given reason', () => {
  const summary = formatUsageSummary([], 'codex', 'timeout');
  assert.equal(summary, 'usage unknown (timeout) ⇒ seat codex');
});

// ── buildUsageEnvelope ───────────────────────────────────────────────────────

test('buildUsageEnvelope: a reply without rateLimits → usage unknown with that reason', () => {
  const probe = { ok: true, stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { accountId: 'x' } }) + '\n' };
  const e = buildUsageEnvelope(probe, Date.now());
  assert.deepEqual(e, {
    ok: true,
    seat: 'codex',
    usage: 'unknown',
    summary: 'usage unknown (rate-limits reply missing rateLimits) ⇒ seat codex',
    windows: [],
    plan: null,
    reason: 'rate-limits reply missing rateLimits',
  });
});

test('buildUsageEnvelope: rateLimits with no usable window → usage unknown, plan still reported', () => {
  const reply = {
    jsonrpc: '2.0',
    id: 1,
    result: { rateLimits: { primary: null, secondary: null, individualLimit: null, planType: 'plus' } },
  };
  const e = buildUsageEnvelope({ ok: true, stdout: JSON.stringify(reply) + '\n' }, Date.now());
  assert.deepEqual(e, {
    ok: true,
    seat: 'codex',
    usage: 'unknown',
    summary: 'usage unknown (no usage windows reported) ⇒ seat codex',
    windows: [],
    plan: 'plus',
    reason: 'no usage windows reported',
  });
});

test('buildUsageEnvelope: probe failure carrying unavailable:true → seat claude, usage unavailable', () => {
  const probe = { ok: false, reason: 'codex CLI not found on PATH', unavailable: true };
  const e = buildUsageEnvelope(probe, Date.now());
  assert.deepEqual(e, {
    ok: true,
    seat: 'claude',
    usage: 'unavailable',
    summary: 'codex unavailable (codex CLI not found on PATH) ⇒ seat claude',
    windows: [],
    plan: null,
    reason: 'codex CLI not found on PATH',
  });
});

test('buildUsageEnvelope: same reason text WITHOUT the unavailable flag still seats codex as unknown', () => {
  // The seat is keyed on the structured `unavailable` flag, never on reason
  // text — a probe failure that merely happens to share the ENOENT wording
  // (or any other reason) but did not set the flag must not seat claude.
  const probe = { ok: false, reason: 'codex CLI not found on PATH' };
  const e = buildUsageEnvelope(probe, Date.now());
  assert.equal(e.seat, 'codex');
  assert.equal(e.usage, 'unknown');
  assert.equal(e.summary, 'usage unknown (codex CLI not found on PATH) ⇒ seat codex');
});

test('buildUsageEnvelope: a probe failure with a different reason and no flag still seats codex as unknown', () => {
  const probe = { ok: false, reason: 'timeout after 15000ms' };
  const e = buildUsageEnvelope(probe, Date.now());
  assert.equal(e.seat, 'codex');
  assert.equal(e.usage, 'unknown');
  assert.equal(e.summary, 'usage unknown (timeout after 15000ms) ⇒ seat codex');
});

// ── readCodexRateLimits + `usage` CLI (mock codex app-server on PATH) ────────

// Mock `codex`: logs its argv to argv.log; on an `app-server` argv it reads
// JSON-RPC lines from stdin until EOF (like the real server), answers the
// initialize request (id 0), emits a notification and a server-to-client
// request that also carries id 1 — so the probe must pick the id:1 REPLY, not
// the first line or the first id:1 — then prints reply.json (when present)
// for the id:1 request.
// With MOCK_GRANDCHILD set it also backgrounds a `sleep` that inherits the
// stdout pipe, standing in for an npm-wrapper descendant that outlives it.
const MOCK_APP_SERVER = `#!/usr/bin/env bash
dir="$(dirname "$0")"
printf '%s\\n' "$@" > "$dir/argv.log"
is_app=""
for a in "$@"; do
  if [ "$a" = "app-server" ]; then is_app=1; fi
done
if [ -z "$is_app" ]; then exit 1; fi
if [ -n "$MOCK_GRANDCHILD" ]; then
  sleep 30 &
  echo $! > "$dir/grandchild.pid"
fi
while IFS= read -r line; do
  case "$line" in
    *'"id":0'*)
      printf '%s\\n' '{"id":0,"result":{"userAgent":"mock"}}'
      printf '%s\\n' '{"method":"account/updated","params":{"planType":"plus"}}'
      printf '%s\\n' '{"id":1,"method":"item/tool/requestUserInput","params":{}}'
      ;;
    *'"id":1'*)
      if [ -f "$dir/reply.json" ]; then cat "$dir/reply.json"; fi
      ;;
  esac
done
`;

// Raw captured Plus-plan reply: resetsAt in Unix seconds, durations in minutes.
const PLUS_REPLY = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    rateLimits: {
      primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 1790592447 },
      secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1791110872 },
      individualLimit: null,
      planType: 'plus',
    },
  },
};

function withMockAppServer(reply, fn) {
  const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-usage-'));
  const mockCodexPath = path.join(tmpdir, 'codex');
  writeFileSync(mockCodexPath, MOCK_APP_SERVER);
  chmodSync(mockCodexPath, 0o755);
  if (reply !== null) writeFileSync(path.join(tmpdir, 'reply.json'), JSON.stringify(reply) + '\n');
  try {
    return fn({ tmpdir, env: { ...process.env, PATH: `${tmpdir}:${process.env.PATH}` } });
  } finally {
    rmSync(tmpdir, { recursive: true, force: true });
  }
}

// `timeout` turns a process held open by the probe's pipes into a test
// failure (signal set) instead of a hung `node --test`.
function runUsageCli(env) {
  return spawnSync(process.execPath, [BRIDGE, 'usage'], { encoding: 'utf8', env, timeout: 10000 });
}

function parseSingleLine(stdout) {
  assert.ok(stdout.endsWith('\n'), `stdout must end with a newline: ${JSON.stringify(stdout)}`);
  const lines = stdout.slice(0, -1).split('\n');
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}

test('cli usage: mock app-server Plus reply → one-line known envelope, exits 0 on its own', () => {
  withMockAppServer(PLUS_REPLY, ({ tmpdir, env }) => {
    const r = runUsageCli(env);
    assert.equal(r.signal, null, `bridge was held open past the timeout; stderr: ${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    const j = parseSingleLine(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.usage, 'known');
    assert.equal(j.windows.length, 2);
    assert.deepEqual(j.windows.map((w) => w.name), ['5h', 'weekly']);
    assert.ok(['codex', 'claude'].includes(j.seat), `unexpected seat: ${j.seat}`);
    assert.equal(typeof j.summary, 'string');
    assert.equal(j.plan, 'plus');
    assert.equal('reason' in j, false, 'reason is only carried when usage is unknown');
    // Pinned spawn shape: app-server honors only `-c` overrides (root -s/-a never
    // reach it), so read-only + approvals-never must ride as -c pairs.
    const argv = readFileSync(path.join(tmpdir, 'argv.log'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(argv, ['-c', 'sandbox_mode=read-only', '-c', 'approval_policy=never', 'app-server']);
  });
});

test('cli usage: JSON-RPC error reply → usage unknown, seat codex, reason set, exit 0', () => {
  const errorReply = { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'not logged in' } };
  withMockAppServer(errorReply, ({ env }) => {
    const r = runUsageCli(env);
    assert.equal(r.signal, null, `bridge was held open past the timeout; stderr: ${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    const j = parseSingleLine(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.usage, 'unknown');
    assert.equal(j.seat, 'codex');
    assert.match(j.reason, /not logged in/);
    assert.deepEqual(j.windows, []);
    assert.equal(j.summary, `usage unknown (${j.reason}) ⇒ seat codex`);
  });
});

test('cli usage: codex not on PATH (ENOENT) → seat claude, usage unavailable, exit 0', () => {
  // PATH pinned to an empty dir (no fallback to the real environment PATH) so
  // spawn('codex', ...) ENOENTs deterministically regardless of what's
  // installed on the test machine.
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'hyperclaude-usage-nopath-'));
  try {
    const r = runUsageCli({ ...process.env, PATH: emptyDir });
    assert.equal(r.signal, null, `bridge was held open past the timeout; stderr: ${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    const j = parseSingleLine(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.usage, 'unavailable');
    assert.equal(j.seat, 'claude');
    assert.equal(j.reason, 'codex CLI not found on PATH');
    assert.deepEqual(j.windows, []);
    assert.equal(j.summary, 'codex unavailable (codex CLI not found on PATH) ⇒ seat claude');
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('readCodexRateLimits: a server that never replies times out fast and leaves nothing holding the process open', () => {
  withMockAppServer(null, ({ tmpdir, env }) => {
    // Runs in a child process so "not held open" is observable: the child must
    // exit on its own (no forced exit) even though the mock's backgrounded
    // grandchild still holds the stdout pipe for 30 s.
    const script = [
      `import { readCodexRateLimits } from ${JSON.stringify(pathToFileURL(BRIDGE).href)};`,
      `const t0 = Date.now();`,
      `const r = await readCodexRateLimits({ clientVersion: 'test', timeoutMs: 300 });`,
      `process.stdout.write(JSON.stringify({ ...r, elapsedMs: Date.now() - t0 }) + '\\n');`,
    ].join('\n');
    const pidPath = path.join(tmpdir, 'grandchild.pid');
    let pid = null;
    try {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...env, MOCK_GRANDCHILD: '1' },
        timeout: 5000,
      });
      // Guard against a vacuous pass: the pipe-holding grandchild must exist and
      // still be alive, or "exited on its own" proves nothing about the teardown.
      assert.ok(existsSync(pidPath), 'mock never forked its pipe-holding grandchild');
      pid = Number(readFileSync(pidPath, 'utf8'));
      assert.ok(Number.isInteger(pid) && pid > 0, `bad grandchild pid: ${pid}`);
      assert.doesNotThrow(() => process.kill(pid, 0), 'pipe-holding grandchild already exited');
      assert.equal(r.signal, null, `probe process was held open past the timeout; stderr: ${r.stderr}`);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.match(out.reason, /timeout/);
      assert.ok(out.elapsedMs < 2000, `probe took ${out.elapsedMs} ms to time out`);
    } finally {
      // The backgrounded sleep would otherwise outlive the test by 30 s.
      if (pid) {
        try {
          process.kill(pid);
        } catch (err) {
          if (err.code !== 'ESRCH') throw err; // already gone
        }
      }
    }
  });
});
