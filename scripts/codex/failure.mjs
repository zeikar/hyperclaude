// Failure body renderer for the codex bridge.
// Produces the human-readable body we write into the output file when the
// codex run did not complete successfully — folds in the JSONL parser
// diagnostics, last message text, stderr, and the exit shape.

export function renderFailureBody({ parseDiagnostics, lastMessageText, stderr, exit }) {
  const d = parseDiagnostics || {};
  const errors = Array.isArray(d.topLevelErrors) ? d.topLevelErrors : [];
  const lastThree = errors.slice(-3);
  const errorsLine = lastThree.length > 0
    ? `${errors.length} (last ${lastThree.length} messages: ${lastThree.map((m) => JSON.stringify(m)).join(', ')})`
    : `${errors.length}`;

  const threadStarted = d.threadId
    ? `yes, thread_id ${d.threadId}`
    : 'no';
  const turnCompleted = d.hasTurnCompleted ? 'yes' : 'no';
  const turnFailed = d.turnFailedMessage
    ? `yes, message ${JSON.stringify(d.turnFailedMessage)}`
    : 'no';
  const malformed = typeof d.malformedLines === 'number' ? d.malformedLines : 0;

  const lastMsgBody = (typeof lastMessageText === 'string' && lastMessageText.length > 0)
    ? lastMessageText
    : '(empty)';
  const stderrBody = typeof stderr === 'string' ? stderr : '';

  const ex = exit || {};
  const status = (ex.status === undefined || ex.status === null) ? 'null' : String(ex.status);
  const signal = (ex.signal === undefined || ex.signal === null) ? 'null' : String(ex.signal);
  const timedOut = ex.timedOut ? 'true' : 'false';

  return [
    '# (codex failed)',
    '',
    '## JSONL parser report',
    `- thread.started: ${threadStarted}`,
    `- turn.completed: ${turnCompleted}`,
    `- turn.failed: ${turnFailed}`,
    `- top-level error events: ${errorsLine}`,
    `- malformed lines: ${malformed}`,
    '',
    '## Last message (from --output-last-message)',
    lastMsgBody,
    '',
    '## stderr',
    stderrBody,
    '',
    '## Exit',
    `status=${status}, signal=${signal}, timed-out=${timedOut}`,
    '',
  ].join('\n');
}
