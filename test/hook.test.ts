import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = (env: Record<string, string> = {}) =>
  spawnSync('node', ['hooks/deny-ask.mjs'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } }),
    encoding: 'utf8', env: { ...process.env, CB_ALLOW_ASK: '', ...env },
  });

test('AskUserQuestion is denied with a cb ask pointer', () => {
  const r = run();
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /cb ask/);
});

test('CB_ALLOW_ASK=1 lets it through', () => {
  const r = run({ CB_ALLOW_ASK: '1' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('SessionStart hint: a herdr session is told to run cb start; others hear nothing', () => {
  const hint = (env: Record<string, string>) =>
    spawnSync('node', ['hooks/session-start.mjs'], { input: '{"hook_event_name":"SessionStart"}', encoding: 'utf8', env: { ...process.env, ...env } });
  const r = hint({ HERDR_PANE_ID: 'w1:p3' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  assert.match(out.additionalContext, /^Claude Board: .*run `cb start`/);
  assert.equal(hint({ HERDR_PANE_ID: '' }).stdout, '');
});
