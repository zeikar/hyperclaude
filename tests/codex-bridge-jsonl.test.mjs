import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexJsonl, parseCodexDoctorConfigModel, parseCodexCatalogDefault } from '../scripts/codex-bridge.mjs';

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

// parseCodexDoctorConfigModel is a pure parser over `codex doctor --json`
// stdout. `config.load` is a LITERAL key in the top-level `checks` object,
// NOT a nesting `checks.config.load`.

test('parseCodexDoctorConfigModel: real-shaped report — literal "config.load" key returns the model string', () => {
  const stdout = JSON.stringify({ checks: { 'config.load': { details: { model: 'gpt-6-astra' } } } });
  assert.equal(parseCodexDoctorConfigModel(stdout), 'gpt-6-astra');
});

test('parseCodexDoctorConfigModel: <default> placeholder returned verbatim', () => {
  const stdout = JSON.stringify({ checks: { 'config.load': { details: { model: '<default>' } } } });
  assert.equal(parseCodexDoctorConfigModel(stdout), '<default>');
});

test('parseCodexDoctorConfigModel: nested checks.config.load (wrong shape) returns null', () => {
  const stdout = JSON.stringify({ checks: { config: { load: { details: { model: 'gpt-6-astra' } } } } });
  assert.equal(parseCodexDoctorConfigModel(stdout), null);
});

test('parseCodexDoctorConfigModel: missing model returns null', () => {
  const stdout = JSON.stringify({ checks: { 'config.load': { details: {} } } });
  assert.equal(parseCodexDoctorConfigModel(stdout), null);
});

test('parseCodexDoctorConfigModel: non-string model returns null', () => {
  const stdout = JSON.stringify({ checks: { 'config.load': { details: { model: 42 } } } });
  assert.equal(parseCodexDoctorConfigModel(stdout), null);
});

test('parseCodexDoctorConfigModel: non-JSON input returns null', () => {
  assert.equal(parseCodexDoctorConfigModel('not json'), null);
});

test('parseCodexDoctorConfigModel: empty input returns null', () => {
  assert.equal(parseCodexDoctorConfigModel(''), null);
});

// parseCodexCatalogDefault is a pure parser over `codex debug models` stdout —
// mirrors codex-rs's default_model_from_available + mark_default_by_picker_visibility:
// sort by priority ascending (stable), first visibility==="list" wins, else the
// first entry.

test('parseCodexCatalogDefault: unsorted catalog picks the priority-5 "list" slug', () => {
  const stdout = JSON.stringify({
    models: [
      { slug: 'mock-other', priority: 9, visibility: 'list' },
      { slug: 'mock-hidden', priority: 0, visibility: 'hide' },
      { slug: 'mock-default', priority: 5, visibility: 'list' },
    ],
  });
  assert.equal(parseCodexCatalogDefault(stdout), 'mock-default');
});

test('parseCodexCatalogDefault: no "list" entries falls back to the lowest-priority slug', () => {
  const stdout = JSON.stringify({
    models: [
      { slug: 'mock-other', priority: 9, visibility: 'hide' },
      { slug: 'mock-hidden', priority: 0, visibility: 'hide' },
    ],
  });
  assert.equal(parseCodexCatalogDefault(stdout), 'mock-hidden');
});

test('parseCodexCatalogDefault: empty models array returns null', () => {
  assert.equal(parseCodexCatalogDefault(JSON.stringify({ models: [] })), null);
});

test('parseCodexCatalogDefault: non-array models returns null', () => {
  assert.equal(parseCodexCatalogDefault(JSON.stringify({ models: 'nope' })), null);
});

test('parseCodexCatalogDefault: non-JSON input returns null', () => {
  assert.equal(parseCodexCatalogDefault('not json'), null);
});

test('parseCodexCatalogDefault: a malformed entry is dropped, valid entries still pick a default', () => {
  // Mixes an entry missing `slug` and one with a non-numeric `priority` in
  // among two valid entries — distinguishes "drop the bad unit, keep going"
  // (the actual rule) from "any malformed entry nulls the whole catalog".
  const stdout = JSON.stringify({
    models: [
      { priority: 1, visibility: 'list' },              // missing slug
      { slug: 'mock-bad-priority', priority: 'high', visibility: 'list' }, // non-numeric priority
      { slug: 'mock-other', priority: 9, visibility: 'list' },
      { slug: 'mock-default', priority: 5, visibility: 'list' },
    ],
  });
  assert.equal(parseCodexCatalogDefault(stdout), 'mock-default');
});
