import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_MS, holdEvent, holdStep, insertSpot, insertText, voiceOn, type Hold, type HoldEvent } from '../web/src/lib/voice.ts';

// Runs events through the reducer, returning the actions and the final state.
function run(events: HoldEvent[], s: Hold = { phase: 'idle' }) {
  const out: string[] = [];
  for (const e of events) { const [next, a] = holdStep(s, e); out.push(a.do + (a.remove ? `:${a.remove}` : '')); s = next; }
  return { out, s };
}
const down = (t: number, repeat = false): HoldEvent => ({ type: 'down', t, repeat, plain: true });

test('holdStep: a quick tap types a normal space', () => {
  const { out, s } = run([down(0), { type: 'up' }]);
  assert.deepEqual(out, ['type', 'none']);
  assert.equal(s.phase, 'idle');
});

test('holdStep: holding past HOLD_MS starts recording and removes the space it typed; release stops', () => {
  const { out, s } = run([down(0), { type: 'timer', t: HOLD_MS }, down(HOLD_MS + 30, true), { type: 'up' }]);
  assert.deepEqual(out, ['type', 'start:1', 'prevent', 'stop']);
  assert.equal(s.phase, 'idle');
});

test('holdStep: auto-repeat before the threshold types and counts; one past it starts without the timer', () => {
  const { out } = run([down(0), down(260, true), down(290, true), down(400, true), { type: 'up' }]);
  assert.deepEqual(out, ['type', 'type', 'type', 'start:3', 'stop']);
});

test('holdStep: an early timer does not start', () => {
  const { out, s } = run([down(0), { type: 'timer', t: HOLD_MS - 1 }]);
  assert.deepEqual(out, ['type', 'none']);
  assert.equal(s.phase, 'holding');
});

test('holdStep: Esc while recording cancels; the still-held Space types nothing until released', () => {
  const { out, s } = run([down(0), { type: 'timer', t: 400 }, { type: 'escape' }, down(450, true), { type: 'up' }]);
  assert.deepEqual(out, ['type', 'start:1', 'cancel', 'prevent', 'none']);
  assert.equal(s.phase, 'idle');
  assert.deepEqual(run([down(0), { type: 'up' }, down(10)]).out, ['type', 'none', 'type']); // and typing works again after
});

test('holdStep: Space with a modifier, or a repeat arriving with no hold in progress, is plain typing', () => {
  assert.deepEqual(run([{ type: 'down', t: 0, repeat: false, plain: false }, { type: 'timer', t: 400 }]).out, ['type', 'none']);
  assert.deepEqual(run([down(0, true), down(500, true)]).out, ['type', 'type']); // focus arrived mid-hold
});

test('holdStep: another key during the hold is fast typing, not a hold', () => {
  const { out, s } = run([down(0), { type: 'other' }, { type: 'timer', t: 400 }, { type: 'up' }]);
  assert.deepEqual(out, ['type', 'none', 'none', 'none']);
  assert.equal(s.phase, 'idle');
});

test('holdStep: recognition ending on its own, or the box losing focus, stops', () => {
  assert.deepEqual(run([down(0), { type: 'timer', t: 400 }, { type: 'ended' }, down(500, true), { type: 'up' }]).out,
    ['type', 'start:1', 'stop', 'prevent', 'none']);
  assert.deepEqual(run([down(0), { type: 'timer', t: 400 }, { type: 'blur' }]).out, ['type', 'start:1', 'stop']);
  assert.deepEqual(run([down(0), { type: 'blur' }, { type: 'timer', t: 400 }]).out, ['type', 'none', 'none']);
});

test('holdEvent: maps key events, ignores IME composition', () => {
  const k = (key: string, more: object = {}) => ({ key, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, ...more });
  assert.deepEqual(holdEvent('keydown', k(' '), 5), { type: 'down', t: 5, repeat: false, plain: true });
  assert.deepEqual(holdEvent('keydown', k(' ', { shiftKey: true, repeat: true }), 5), { type: 'down', t: 5, repeat: true, plain: false });
  assert.deepEqual(holdEvent('keyup', k(' '), 9), { type: 'up' });
  assert.deepEqual(holdEvent('keydown', k('Escape'), 9), { type: 'escape' });
  assert.deepEqual(holdEvent('keydown', k('a'), 9), { type: 'other' });
  assert.equal(holdEvent('keyup', k('a'), 9), null);
  assert.equal(holdEvent('keydown', k(' ', { isComposing: true }), 9), null);
  assert.equal(holdEvent('keydown', k('Process'), 9), null); // Chrome's key during IME input
});

test('insertText: at the caret, with a separating space only where needed', () => {
  assert.deepEqual(insertText('', 0, 0, ' hello '), { value: 'hello', caret: 5 });
  assert.deepEqual(insertText('ship it', 7, 7, 'today'), { value: 'ship it today', caret: 13 });
  assert.deepEqual(insertText('ship ', 5, 5, 'today'), { value: 'ship today', caret: 10 });
  assert.deepEqual(insertText('shipit', 4, 4, 'it'), { value: 'ship it it', caret: 7 });
  assert.deepEqual(insertText('a XX b', 2, 4, 'yes'), { value: 'a yes b', caret: 5 }); // replaces a selection
  assert.deepEqual(insertText('نعم', 3, 3, 'ابدأ'), { value: 'نعم ابدأ', caret: 8 });
  assert.deepEqual(insertText('keep', 4, 4, '   '), { value: 'keep', caret: 4 }); // nothing heard
});

test('holdStep: the box going off (disabled, or voice turned off) cancels a recording and resets the hold', () => {
  assert.deepEqual(run([down(0), { type: 'timer', t: 400 }, { type: 'off' }, down(450, true)]).out, ['type', 'start:1', 'cancel', 'type']);
  const held = run([down(0), { type: 'off' }, { type: 'timer', t: 400 }]);
  assert.deepEqual(held.out, ['type', 'none', 'none']);
  assert.equal(held.s.phase, 'idle');
  assert.equal(run([down(0), { type: 'timer', t: 400 }, { type: 'escape' }, { type: 'off' }]).s.phase, 'idle');
});

test('insertSpot: the snapshot range only while the text is unchanged; otherwise the current caret, nothing replaced', () => {
  const snap = { value: 'a XX b', start: 2, end: 4 };
  assert.deepEqual(insertSpot(snap, 'a XX b', 6), { start: 2, end: 4 });
  assert.deepEqual(insertSpot(snap, 'a XX bc', 7), { start: 7, end: 7 }); // typed after release: keep it, add at caret
  assert.deepEqual(insertSpot(snap, 'zz a XX b', 2), { start: 2, end: 2 }); // a fresh selection [1,2) is not replaced either: after it
});

test('voiceOn: only where the API exists, voice is allowed (not for guests) and the box is enabled', () => {
  assert.equal(voiceOn(true, true, false), true);
  assert.equal(voiceOn(false, true, false), false); // Firefox
  assert.equal(voiceOn(true, false, false), false); // guest
  assert.equal(voiceOn(true, true, true), false);   // disabled (answered)
});
