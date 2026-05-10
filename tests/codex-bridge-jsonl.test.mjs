import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexJsonl } from '../scripts/codex-bridge.mjs';

// parseCodexJsonl is a pure function over the codex `--json` stdout stream.
// It tallies the events the bridge cares about: thread.started, turn.completed,
// turn.failed (with message), top-level error events, and malformed lines (kept-going).
// `usage` from the LAST `turn.completed` wins.

test('parseCodexJsonl: success path — captures thread_id, hasTurnCompleted, usage', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"abc-123"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"item_type":"agent_message","text":"hello"}}',
    '{"type":"turn.completed","usage":{"input_tokens":42,"output_tokens":7}}',
  ].join('\n');
  const r = parseCodexJsonl(lines);
  assert.equal(r.threadId, 'abc-123');
  assert.equal(r.hasTurnCompleted, true);
  assert.equal(r.turnFailedMessage, null);
  assert.deepEqual(r.topLevelErrors, []);
  assert.equal(r.malformedLines, 0);
  assert.deepEqual(r.usage, { input_tokens: 42, output_tokens: 7 });
});

test('parseCodexJsonl: multiple agent_message items still parsed (last usage wins via turn.completed)', () => {
  // Codex sometimes emits multiple item.completed events; the parser should
  // tolerate them and the final usage should come from the LAST turn.completed.
  const lines = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"item_type":"agent_message","text":"first"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}',
    '{"type":"item.completed","item":{"item_type":"agent_message","text":"second"}}',
    '{"type":"turn.completed","usage":{"input_tokens":99,"output_tokens":11}}',
  ].join('\n');
  const r = parseCodexJsonl(lines);
  assert.equal(r.threadId, 't1');
  assert.equal(r.hasTurnCompleted, true);
  assert.deepEqual(r.usage, { input_tokens: 99, output_tokens: 11 });
});

test('parseCodexJsonl: turn.failed captured with nested error.message', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.failed","error":{"message":"model rate-limited"}}',
  ].join('\n');
  const r = parseCodexJsonl(lines);
  assert.equal(r.threadId, 't1');
  assert.equal(r.hasTurnCompleted, false);
  assert.equal(r.turnFailedMessage, 'model rate-limited');
});

test('parseCodexJsonl: turn.failed captured with top-level message', () => {
  const lines = '{"type":"turn.failed","message":"something broke"}';
  const r = parseCodexJsonl(lines);
  assert.equal(r.turnFailedMessage, 'something broke');
});

test('parseCodexJsonl: top-level error events accumulate in topLevelErrors', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"error","message":"first error"}',
    '{"type":"error","message":"second error"}',
    '{"type":"turn.completed"}',
  ].join('\n');
  const r = parseCodexJsonl(lines);
  assert.deepEqual(r.topLevelErrors, ['first error', 'second error']);
  assert.equal(r.hasTurnCompleted, true);
});

test('parseCodexJsonl: malformed JSON line counted, parser continues', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"t1"}',
    'this is not json',
    '{"type":"turn.started"}',
    '{"type":"turn.completed"}',
  ].join('\n');
  const r = parseCodexJsonl(lines);
  assert.equal(r.threadId, 't1');
  assert.equal(r.hasTurnCompleted, true);
  assert.equal(r.malformedLines, 1);
});

test('parseCodexJsonl: missing thread.started → threadId is null', () => {
  const lines = [
    '{"type":"turn.started"}',
    '{"type":"turn.completed"}',
  ].join('\n');
  const r = parseCodexJsonl(lines);
  assert.equal(r.threadId, null);
  assert.equal(r.hasTurnCompleted, true);
});

test('parseCodexJsonl: missing turn.completed → hasTurnCompleted false', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.started"}',
  ].join('\n');
  const r = parseCodexJsonl(lines);
  assert.equal(r.threadId, 't1');
  assert.equal(r.hasTurnCompleted, false);
});

test('parseCodexJsonl: CRLF input parses identically to LF', () => {
  const lf = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ].join('\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = parseCodexJsonl(lf);
  const b = parseCodexJsonl(crlf);
  assert.deepEqual(b, a);
});

test('parseCodexJsonl: blank separator lines are ignored', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"t1"}',
    '',
    '',
    '{"type":"turn.completed"}',
    '',
  ].join('\n');
  const r = parseCodexJsonl(lines);
  assert.equal(r.threadId, 't1');
  assert.equal(r.hasTurnCompleted, true);
  assert.equal(r.malformedLines, 0);
});

test('parseCodexJsonl: empty / non-string input returns empty diagnostics', () => {
  const empty = parseCodexJsonl('');
  assert.equal(empty.threadId, null);
  assert.equal(empty.hasTurnCompleted, false);
  assert.equal(empty.malformedLines, 0);
  // Non-string defensively returns the same shape.
  const nullish = parseCodexJsonl(null);
  assert.equal(nullish.threadId, null);
  assert.equal(nullish.hasTurnCompleted, false);
});
