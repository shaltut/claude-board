import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortcutsOff } from '../web/src/lib/keys.ts';

// A stand-in element: its tag, and the roles of itself and its ancestors (what closest() would find).
const el = (tagName: string, roles: string[] = [], isContentEditable = false) => ({
  tagName, isContentEditable,
  closest: (sel: string) => roles.some((r) => sel.includes(`[role="${r}"]`)) || null,
});

test('shortcutsOff: on for typing, menus and select lists; off on the page and in dialogs', () => {
  assert.equal(shortcutsOff(null), false);
  assert.equal(shortcutsOff(el('BODY')), false);
  assert.equal(shortcutsOff(el('DIV', ['dialog'])), false); // 1-6 still switch views with the task panel open
  assert.equal(shortcutsOff(el('INPUT')), true);
  assert.equal(shortcutsOff(el('TEXTAREA')), true);
  assert.equal(shortcutsOff(el('SELECT')), true);
  assert.equal(shortcutsOff(el('DIV', [], true)), true);
  assert.equal(shortcutsOff(el('DIV', ['menuitemradio', 'menu'])), true); // the priority menu
  assert.equal(shortcutsOff(el('DIV', ['option', 'listbox'])), true); // a Select's list
});
