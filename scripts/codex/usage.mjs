// Usage-based reviewer seat selection: turns a codex app-server rate-limits
// reply into a decision between the Codex reviewer seat (default) and an
// adversarial Claude reviewer (when usage is running ahead of the window's
// elapsed time). Pure math/parsing only — the app-server spawn that produces
// the reply text is readCodexRateLimits in codex.mjs.

// FLOOR_PCT: below this usage there is no signal to act on yet — stay codex
// even if a window's pace looks high (percentages are noisy at low usage).
export const FLOOR_PCT = 20;
// MARGIN: usage must exceed elapsed×MARGIN to count as "running ahead of pace".
export const MARGIN = 1.1;
// CEILING_PCT: at/above this usage, hand off to Claude regardless of pace —
// close to the window's cap is reason enough on its own.
export const CEILING_PCT = 90;

// parseRateLimitsReply: scans codex app-server stdout (JSON-RPC, one message
// per line) for the reply to OUR request (id 1) and returns its `result`.
// Non-JSON lines and JSON-RPC messages with a different id (notifications,
// other requests) are skipped, not treated as errors — the app-server may
// interleave other traffic before our reply arrives. JSON-RPC ids are per
// direction, so a server-to-client request can also carry id 1: only a
// message with no `method` member counts as our reply.
export function parseRateLimitsReply(stdoutText) {
  if (typeof stdoutText !== 'string' || stdoutText.length === 0) {
    return { ok: false, reason: 'empty stdout' };
  }
  const rawLines = stdoutText.split('\n');
  for (const raw of rawLines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (!evt || typeof evt !== 'object' || evt.id !== 1 || 'method' in evt) continue;
    if (evt.error) {
      const msg = typeof evt.error.message === 'string' ? evt.error.message : JSON.stringify(evt.error);
      return { ok: false, reason: `rate-limits RPC error: ${msg}` };
    }
    if (evt.result && typeof evt.result === 'object') {
      return { ok: true, result: evt.result };
    }
    return { ok: false, reason: 'rate-limits RPC reply missing result' };
  }
  return { ok: false, reason: 'no id:1 reply found in stdout' };
}

// monthlyWindowStart: same wall-clock time one calendar month earlier, day
// clamped into the shorter month (Mar 31 → Feb 28/29, not a Mar 3 rollover).
// Computed in UTC, not local calendar time: a BSD `date -v-1m` reference
// script would use local time, but tests need to be deterministic regardless
// of the machine's TZ, so this operates on UTC fields throughout.
export function monthlyWindowStart(resetsAtMs) {
  const d = new Date(resetsAtMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  const day = d.getUTCDate();
  let targetYear = year;
  let targetMonth = month - 1;
  if (targetMonth < 0) {
    targetMonth = 11;
    targetYear -= 1;
  }
  // Day 0 of the month after target = the last day of target's month.
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);
  return Date.UTC(
    targetYear, targetMonth, clampedDay,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  );
}

// windowName: labels a timed window from its duration in minutes.
function windowName(durationMins) {
  if (durationMins === 300) return '5h';
  if (durationMins === 10080) return 'weekly';
  if (typeof durationMins === 'number') return `${durationMins}m`;
  return 'window'; // no duration reported — shouldn't normally happen
}

// buildWindow: shared reset/pace-unknown/normal-elapsed logic for both timed
// windows (primary/secondary) and the derived monthly window — they differ
// only in how windowStartMs is computed (duration-back vs monthlyWindowStart).
function buildWindow(name, usedPercent, resetsAtMs, windowStartMs, nowMs) {
  if (typeof resetsAtMs !== 'number' || typeof windowStartMs !== 'number') {
    // No resetsAt (or nothing to derive a window start from): keep the usage
    // reading but no elapsed/pace signal — floor/ceiling rules still see it.
    return { name, usedPercent, elapsedPercent: null, note: 'pace unknown' };
  }
  if (resetsAtMs <= nowMs) {
    return { name, usedPercent: 0, elapsedPercent: 0, note: 'reset' };
  }
  const durationMs = resetsAtMs - windowStartMs;
  if (!(durationMs > 0)) {
    return { name, usedPercent, elapsedPercent: null, note: 'pace unknown' };
  }
  const raw = ((nowMs - windowStartMs) / durationMs) * 100;
  const elapsedPercent = Math.min(100, Math.max(0, raw));
  return { name, usedPercent, elapsedPercent, note: null };
}

// normalizeWindows: converts the app-server's rateLimits object (primary /
// secondary / individualLimit) into the kept usage windows this module
// reasons about. Unit boundary: resetsAt arrives in Unix SECONDS and
// windowDurationMins in MINUTES, while nowMs is Date.now() MILLISECONDS —
// both are converted to milliseconds right here so every downstream
// calculation (elapsed, reset test, monthlyWindowStart) is milliseconds-only.
export function normalizeWindows(rateLimits, nowMs) {
  const rl = rateLimits ?? {};
  const windows = [];

  for (const raw of [rl.primary, rl.secondary]) {
    if (!raw || typeof raw.usedPercent !== 'number') continue; // dropped
    const resetsAtMs = typeof raw.resetsAt === 'number' ? raw.resetsAt * 1000 : null;
    const durationMs = typeof raw.windowDurationMins === 'number' ? raw.windowDurationMins * 60_000 : null;
    const windowStartMs = (resetsAtMs !== null && durationMs !== null) ? resetsAtMs - durationMs : null;
    windows.push(buildWindow(windowName(raw.windowDurationMins), raw.usedPercent, resetsAtMs, windowStartMs, nowMs));
  }

  const il = rl.individualLimit;
  if (il) {
    let usedPercent = null;
    if (typeof il.remainingPercent === 'number') {
      usedPercent = 100 - il.remainingPercent;
    } else if (typeof il.used === 'number' && typeof il.limit === 'number' && il.limit > 0) {
      usedPercent = (100 * il.used) / il.limit;
    }
    if (typeof usedPercent === 'number') {
      const resetsAtMs = typeof il.resetsAt === 'number' ? il.resetsAt * 1000 : null;
      const windowStartMs = resetsAtMs !== null ? monthlyWindowStart(resetsAtMs) : null;
      windows.push(buildWindow('monthly', usedPercent, resetsAtMs, windowStartMs, nowMs));
    }
  }

  return windows;
}

// decideWindow: attaches `pace` and `decision` to a normalized window.
// Order: floor → ceiling → pace-vs-margin (only when elapsedPercent is
// known) → codex (pace unknown, usage between floor and ceiling — no
// evidence of over-pace).
export function decideWindow(window) {
  const { usedPercent, elapsedPercent } = window;
  // elapsed 0 with usage already above the floor is unbounded pace (nonzero
  // usage in ZERO elapsed time); pace stays null (no finite ratio) but the
  // margin check below still treats elapsedPercent 0 as a KNOWN value, so it
  // flags the window over pace via `usedPercent > 0`.
  const pace = (typeof elapsedPercent === 'number' && elapsedPercent > 0)
    ? usedPercent / elapsedPercent
    : null;
  let decision;
  if (usedPercent < FLOOR_PCT) {
    decision = 'codex';
  } else if (usedPercent >= CEILING_PCT) {
    decision = 'claude';
  } else if (typeof elapsedPercent === 'number') {
    decision = usedPercent > elapsedPercent * MARGIN ? 'claude' : 'codex';
  } else {
    decision = 'codex';
  }
  return { ...window, pace, decision };
}

// decideSeat: takes windows already run through decideWindow. Any window
// deciding claude hands off the whole reviewer seat to claude. Zero kept
// windows means no usage signal at all, not "usage looked fine" — reported
// separately as usage:'unknown' so a caller can log why it fell back. This is
// the genuinely-unknown case (RPC error, empty reply, no usable window) —
// seating codex on it is a guess, but an informed one: codex answered, just
// not usefully. A probe failure the spawn layer flagged `unavailable: true`
// (codex.mjs; today only ENOENT — the CLI is missing, so every later spawn
// this run would fail too) never reaches this function — buildUsageEnvelope
// seats claude for it directly, keyed on that flag rather than reason text.
export function decideSeat(windows) {
  if (windows.length === 0) return { seat: 'codex', usage: 'unknown' };
  const seat = windows.some((w) => w.decision === 'claude') ? 'claude' : 'codex';
  return { seat, usage: 'known' };
}

// formatPercent: display-only rounding (whole number when integral, else one
// decimal) — the window objects themselves keep unrounded floats, since
// those feed decideWindow and the JSON envelope.
function formatPercent(n) {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

// formatUsageSummary: the human one-liner recorded alongside the seat
// decision. `windows` are decideWindow output (carry pace/decision already).
export function formatUsageSummary(windows, seat, reason) {
  if (windows.length === 0) {
    return `usage unknown (${reason}) ⇒ seat codex`;
  }
  const parts = windows.map((w) => {
    const used = formatPercent(w.usedPercent);
    const elapsed = typeof w.elapsedPercent === 'number' ? `${formatPercent(w.elapsedPercent)}%` : '?';
    const pace = typeof w.pace === 'number' ? `${w.pace.toFixed(2)}x` : '?';
    return `${w.name}: used ${used}% elapsed ${elapsed} pace ${pace} → ${w.decision}`;
  });
  return `${parts.join('; ')} ⇒ seat ${seat}`;
}

// buildUsageEnvelope: the bridge's `usage` stdout answer, built from a
// readCodexRateLimits() result. Always ok:true — a failed probe is an answer,
// not a bridge error, so a loop can read the seat without a failure branch.
// Reason precedence: probe/RPC failure, then a reply with no rateLimits, then
// a rateLimits object that yields no usable window. `reason` is carried only
// when usage is unknown or unavailable. `reply.unavailable` (set by
// readCodexRateLimits only for a failure that reliably means codex cannot run
// at all — today just ENOENT) seats claude directly; every OTHER failure
// (RPC error, timeout, malformed reply, no usable window) seats codex as
// genuinely unknown — the seat is keyed on that structured flag, never on
// reason text.
export function buildUsageEnvelope(probe, nowMs) {
  const reply = probe.ok ? parseRateLimitsReply(probe.stdout) : probe;
  const unavailable = !reply.ok && reply.unavailable === true;
  let rateLimits = null;
  let reason = null;
  if (!reply.ok) {
    reason = reply.reason;
  } else if (reply.result.rateLimits && typeof reply.result.rateLimits === 'object') {
    rateLimits = reply.result.rateLimits;
  } else {
    reason = 'rate-limits reply missing rateLimits';
  }
  const windows = (!unavailable && rateLimits) ? normalizeWindows(rateLimits, nowMs).map(decideWindow) : [];
  if (!unavailable && rateLimits && windows.length === 0) reason = 'no usage windows reported';
  const { seat, usage } = unavailable ? { seat: 'claude', usage: 'unavailable' } : decideSeat(windows);
  const summary = unavailable
    ? `codex unavailable (${reason}) ⇒ seat claude`
    : formatUsageSummary(windows, seat, reason);
  return {
    ok: true,
    seat,
    usage,
    summary,
    windows,
    plan: rateLimits?.planType ?? null,
    ...(usage === 'unknown' || usage === 'unavailable' ? { reason } : {}),
  };
}
