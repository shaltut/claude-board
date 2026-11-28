// #4787: a seat is switched only when the quota words stand where its CLI prints its own limit message. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAdapter } from '../cli/agents/claude.ts';
import { codexAdapter } from '../cli/agents/codex.ts';
import { agyAdapter } from '../cli/agents/agy.ts';
import { opencodeAdapter } from '../cli/agents/opencode.ts';

const BOX = '> \n? for shortcuts';
const CASES = [
  { adapter: claudeAdapter,
    banners: [
      `Claude usage limit reached. Your limit will reset at 5pm.\n${BOX}`,
      `● Reading the files\n  ⎿  You've hit your limit · resets 3am\n     /upgrade to increase your usage limit.\n╭────╮\n│ > │\n╰────╯\n  ? for shortcuts`,
      `> fix the bug\n  ⎿  5-hour limit reached ∙ resets 3pm\n✻ Worked for 2m\n────\n❯ \n────\n  ⏵⏵ bypass permissions on`,
    ],
    not: [
      `● The test prints: Claude usage limit reached\n${BOX}`,
      `● Claude usage limit reached is the banner this reads.\n${BOX}`,
      `● The adapter matches this text.\n  It reads "usage limit reached" from the screen.\n${BOX}`,
      `Claude usage limit reached. Your limit will reset at 5pm.\n● Done: the fixture above is what the CLI prints.\n${BOX}`,
      `Claude usage limit reached\n> carry on\n● Carrying on.\n${BOX}`,
      `You've hit your limit · resets 3am\nline 1\nline 2\nline 3\nline 4\n${BOX}`,
      // a wrapped line of the agent's own answer is indented and has no mark of its own
      `● The line the adapter reads is\n  Claude usage limit reached.\n${BOX}`,
    ] },
  { adapter: codexAdapter,
    banners: ["■ You’ve hit your usage limit. Upgrade to Pro, or\ntry again in 2 hours 5 minutes.\n› Ask Codex to do something\n  100% context left"],
    not: ["• The error reads: You've hit your usage limit.\n› Ask Codex to do something", "■ Your workspace is out of credits.\n• Added credits, carrying on.\n› ",
      "• The line the adapter reads is\n  You've hit your usage limit.\n› "] },
  { adapter: agyAdapter,
    banners: [
      '  You have exhausted your quota on this model.\n  > ',
      '  generating and executing: transport error (ResourceExhausted, HTTP 429): Third-party quota reached. Please switch to Gemini models or upgrade your subscription.\n  > ',
      '  (ResourceExhausted, HTTP 429): Third-party quota\n  reached. Please switch to\n  Gemini models or upgrade\n> ',
      'AI: Out of credits\n> ',
    ],
    not: ['● agy says: You have exhausted your quota on this model.\n> ', 'You have exhausted your quota on this model.\n● Switched, carrying on.\n> '] },
  { adapter: opencodeAdapter,
    banners: ['Error: FreeUsageLimitError: Free usage exceeded, retry in 2 hours\n> ', 'AI_APICallError: You exceeded your current quota (insufficient_quota)\n> '],
    not: ['• the code throws FreeUsageLimitError\n> ', 'I handled the "quota exceeded" case in the client\n> '] },
];

for (const { adapter, banners, not } of CASES) {
  test(`#4787: ${adapter.kind}: its own limit message above the input area is its banner; the same words as output are not`, () => {
    for (const s of banners) assert.equal(adapter.atQuotaBanner(s), true, `a banner: ${JSON.stringify(s)}`);
    for (const s of not) assert.equal(adapter.atQuotaBanner(s), false, `not a banner: ${JSON.stringify(s)}`);
    assert.equal(adapter.atQuotaBanner(''), false);
  });
}
