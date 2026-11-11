// Telegram answering (#683), against a local fake API: never the real bot.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.ts'; // sets CB_DATABASE_URL before the server's db client loads
import { fakeTelegram } from './fake-telegram.ts';

const { app, startBot } = await import('../server/main.ts');
const tg = await import('../server/telegram.ts');
const { sql: serverSql } = await import('../server/db.ts');

const fake = await fakeTelegram();
await startBot('123:test', fake.url);
const clients: any[] = [];
after(async () => { await tg.stopTelegram(); await fake.close(); await Promise.all([...clients.map((c) => c.end()), serverSql.end()]); });

const AHMED = 555, STRANGER = 777;
const PAGE = { 'sec-fetch-site': 'same-origin', host: 'localhost:4747', origin: 'http://localhost:4747' };
async function until<T>(f: () => T | Promise<T>, what: string, ms = 4000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const calls = (method: string) => fake.calls.filter((c) => c.method === method);
const sentFor = (qid: number) => calls('sendMessage').filter((c) => c.body.text?.startsWith(`Q${qid} `));
const text = (t: string, chat = AHMED, reply_to?: number) =>
  fake.push({ message: { message_id: Math.floor(Math.random() * 1e6), chat: { id: chat, type: 'private' }, from: { id: chat }, text: t,
    ...(reply_to ? { reply_to_message: { message_id: reply_to } } : {}) } });
const press = (message_id: number, data: string, chat = AHMED) =>
  fake.push({ callback_query: { id: String(Math.random()), from: { id: chat }, data, message: { message_id, chat: { id: chat, type: 'private' } } } });

/** A fresh board with Ahmed's chat paired through the dashboard's code. */
async function paired() {
  const sql = await freshDb(); clients.push(sql);
  fake.calls.length = 0;
  const r = await app.request('/api/telegram/connect', { method: 'POST', headers: PAGE });
  const { link } = await r.json();
  text(`/start ${new URL(link).searchParams.get('start')}`);
  await until(async () => (await (await app.request('/api/telegram', { headers: PAGE })).json()).paired, 'pairing');
  fake.calls.length = 0;
  return sql;
}
const ask = async (sql: any, body: string, more: Record<string, unknown> = {}) => Number((await sql`select cb.ask(project => 'demo',
  body => ${body}, options => ${(more.options ?? null) as any}::jsonb, context => ${(more.context ?? null) as any}, multi => ${!!more.multi},
  actor => 'W1', to_user => ${(more.to_user ?? null) as any}, parent => ${(more.parent ?? null) as any}, if_answer => ${(more.if_answer ?? null) as any}) as id`)[0].id);
// the test's own client returns bigint as text; Telegram sends numbers
const msgOf = async (sql: any, id: number) => Number((await sql`select message_id from cb.telegram_messages where question_id = ${id}`)[0].message_id);
const status = async (sql: any, id: number) => (await sql`select status, answer, answered_by, sent_back from cb.questions where id = ${id}`)[0];

test('compose: plain text, options as buttons, a send-back row, context cut to the 4096 limit and said so', () => {
  const q = { id: 7, project: 'demo', asked_by: 'W1', body: 'Ship it?', context: 'x'.repeat(5000), multi: false,
    options: [{ label: 'Yes (Recommended)', description: 'ship today' }, { label: 'No', description: null }] };
  const m = tg.compose(q as any);
  assert.ok(m.text.length <= 4096, `${m.text.length} chars`);
  assert.match(m.text, /^Q7 · demo · from W1/);
  assert.match(m.text, /Ship it\?/);
  assert.match(m.text, /Yes \(Recommended\) — ship today/);
  assert.match(m.text, /context cut/);
  const rows = m.reply_markup.inline_keyboard;
  assert.deepEqual(rows.slice(0, 2).map((r: any) => r[0].callback_data), ['o:7:0', 'o:7:1']);
  assert.deepEqual(rows.at(-1).map((b: any) => b.text), ['More details', 'Clarify', 'Simplify', 'Re-ask']);
  assert.deepEqual(rows.at(-1).map((b: any) => b.callback_data), ['b:7:details', 'b:7:clarify', 'b:7:simplify', 'b:7:reask']);

  const multi = tg.compose({ ...q, context: null, multi: true } as any, ['No']);
  assert.deepEqual(multi.reply_markup.inline_keyboard.slice(0, 3).map((r: any) => r[0].text), ['[ ] Yes (Recommended)', '[x] No', 'Send (1)']);
  assert.equal(multi.reply_markup.inline_keyboard[2][0].callback_data, 's:7');
  assert.doesNotMatch(multi.text, /context cut/);
});

test('compose: a Hand to row, one button per person on the project, above the send-back row (#1200)', () => {
  const q = { id: 7, project: 'demo', asked_by: 'W1', body: 'Ship it?', context: null, multi: false, options: [{ label: 'Yes', description: null }],
    hands: [{ name: 'iman', display: 'Iman' }, { name: 'omar', display: 'Omar' }] };
  const rows = tg.compose(q as any).reply_markup.inline_keyboard;
  assert.deepEqual(rows.at(-2).map((b: any) => [b.text, b.callback_data]), [['Hand to Iman', 'h:7:iman'], ['Hand to Omar', 'h:7:omar']]);
  assert.equal(rows.at(-1)[0].callback_data, 'b:7:details');
  assert.equal(tg.compose({ ...q, hands: [] } as any).reply_markup.inline_keyboard.length, 2, 'nobody on the project: no row');
  // review: Telegram refuses the whole message for a row over 8 buttons or callback_data over 64 bytes, and the question never arrives
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `user${i}`, display: `User ${i}` })).concat({ name: 'x'.repeat(60), display: 'Long' });
  const kb = tg.compose({ ...q, id: 1234567, hands: many } as any).reply_markup.inline_keyboard;
  const handRows = kb.filter((r: any) => r[0].callback_data.startsWith('h:'));
  assert.ok(handRows.every((r: any) => r.length <= 3), 'rows of at most 3');
  assert.equal(handRows.flat().length, 9, 'all nine fit; the name too long for a button is left to the dashboard');
  assert.ok(kb.flat().every((b: any) => Buffer.byteLength(b.callback_data) <= 64));
});

test('pairing: a dashboard code pairs the chat once; other chats are ignored; unpair stops it', async () => {
  assert.equal((await app.request('/api/telegram', { headers: { host: 'localhost:4747' } })).status, 403, 'the dashboard page only');
  const sql = await paired();
  const st = await (await app.request('/api/telegram', { headers: PAGE })).json();
  assert.equal(st.configured, true);
  assert.equal(st.bot, 'test_board_bot');

  // a stranger with an old or made-up code gets nothing, and their buttons do nothing
  text('/start nope', STRANGER);
  press(1, 'o:1:0', STRANGER);
  const id = await ask(sql, 'Ship it?', { options: ['Yes', 'No'] });
  const [m] = await until(() => sentFor(id).length && sentFor(id), 'Q sent');
  assert.equal(m.body.chat_id, AHMED);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fake.calls.every((c) => c.body.chat_id !== STRANGER), 'never talks to the stranger');
  assert.equal((await status(sql, id)).status, 'open');

  assert.equal((await app.request('/api/telegram/disconnect', { method: 'POST', headers: PAGE })).status, 200);
  assert.equal((await (await app.request('/api/telegram', { headers: PAGE })).json()).paired, false);
  fake.calls.length = 0;
  await ask(sql, 'Another?');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls('sendMessage').length, 0, 'nothing goes out unpaired');
});

test('outgoing: a question for Ahmed goes out once; one for a guest does not; a follow-up goes when it opens', async () => {
  const sql = await paired();
  await sql`select cb.user_add('omar', 'Omar', 'ahmed')`;
  await sql`select cb.ensure_project('demo'), cb.user_project_add('omar', 'demo', 'ahmed')`;
  const p = await ask(sql, 'Parent?', { options: ['Yes', 'No'], context: 'some background' });
  const f = await ask(sql, 'Then which?', { parent: `Q${p}`, if_answer: 'Yes' });
  await ask(sql, 'For Omar?', { to_user: 'omar' });
  const [m] = await until(() => sentFor(p).length && sentFor(p), 'parent sent');
  assert.match(m.body.text, /some background/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sentFor(f).length, 0, 'dormant: not yet');
  assert.ok(!calls('sendMessage').some((c) => /For Omar/.test(c.body.text)), 'a guest question stays off Telegram');

  // a restart reconciles against the mapping: nothing re-sent
  await tg.reconcile();
  assert.equal(sentFor(p).length, 1);

  await sql`select cb.answer(${String(p)}, 'Yes')`;
  await until(() => sentFor(f).length, 'follow-up sent when it opens');
});

test('a button answers as Ahmed through the dashboard path, edits the message, and a second press says so', async () => {
  const sql = await paired();
  const id = await ask(sql, 'Ship it?', { options: ['Yes (Recommended)', 'No'] });
  await until(() => sentFor(id).length, 'sent');
  const msg = await msgOf(sql, id);
  press(msg, `o:${id}:0`);
  await until(async () => (await status(sql, id)).status === 'answered', 'answered');
  const s = await status(sql, id);
  assert.equal(s.answer, 'Yes', 'the label without (Recommended), as the dashboard sends it');
  assert.equal(s.answered_by, 'ahmed');
  const [e] = await until(() => calls('editMessageText').filter((c) => c.body.message_id === msg).length
    && calls('editMessageText').filter((c) => c.body.message_id === msg), 'edited');
  assert.match(e.body.text, /Answered: Yes/);
  assert.deepEqual(e.body.reply_markup, { inline_keyboard: [] });

  press(msg, `o:${id}:1`);
  const a = await until(() => calls('answerCallbackQuery').find((c) => /already/i.test(c.body.text ?? '')), 'already');
  assert.match(a.body.text, /already answered/i);
  assert.equal((await status(sql, id)).answer, 'Yes', 'not answered twice');
});

test('multi-select: toggles, then Send answers with the raw labels joined as the dashboard does', async () => {
  const sql = await paired();
  const id = await ask(sql, 'Which?', { options: ['A', 'B (Recommended)', 'C'], multi: true });
  await until(() => sentFor(id).length, 'sent');
  const msg = await msgOf(sql, id);
  press(msg, `t:${id}:1`);
  press(msg, `t:${id}:0`);
  await until(async () => (await sql`select picked from cb.telegram_messages where question_id = ${id}`)[0].picked.length === 2, 'toggled');
  const marks = calls('editMessageReplyMarkup').at(-1)!.body.reply_markup.inline_keyboard;
  assert.equal(marks[0][0].text, '[x] A');
  press(msg, `s:${id}`);
  await until(async () => (await status(sql, id)).status === 'answered', 'answered');
  assert.equal((await status(sql, id)).answer, 'B (Recommended); A');
});

test('a text reply answers as typed; with picks on a multi it is the note', async () => {
  const sql = await paired();
  const id = await ask(sql, 'Name it?');
  const multi = await ask(sql, 'Which?', { options: ['A', 'B'], multi: true });
  await until(() => sentFor(id).length && sentFor(multi).length, 'sent');
  const m1 = await msgOf(sql, id);
  const m2 = await msgOf(sql, multi);
  text('Call it Atlas', AHMED, m1);
  await until(async () => (await status(sql, id)).answer === 'Call it Atlas', 'typed answer');
  press(m2, `t:${multi}:1`);
  await until(async () => (await sql`select picked from cb.telegram_messages where question_id = ${multi}`)[0].picked.length === 1, 'toggled');
  text('only B for now', AHMED, m2);
  await until(async () => (await status(sql, multi)).answer === 'B — only B for now', 'picks with a note');

  text('hello there'); // not a reply: told how to answer
  await until(() => calls('sendMessage').some((c) => /Reply to a question/.test(c.body.text)), 'hint');
});

test('send-back: a reason button sends it back; Clarify takes the next reply as the note', async () => {
  const sql = await paired();
  const a = await ask(sql, 'Vague?', { options: ['Yes', 'No'] });
  const b = await ask(sql, 'Unclear?', { options: ['Yes', 'No'] });
  await until(() => sentFor(a).length && sentFor(b).length, 'sent');
  const ma = await msgOf(sql, a);
  const mb = await msgOf(sql, b);
  press(ma, `b:${a}:simplify`);
  await until(async () => (await status(sql, a)).status === 'sent_back', 'sent back');
  assert.equal((await status(sql, a)).sent_back.reason, 'simplify');
  await until(() => calls('editMessageText').some((c) => c.body.message_id === ma && /Sent back: simplify/.test(c.body.text)), 'edited');

  press(mb, `b:${b}:clarify`);
  const prompt = await until(() => calls('sendMessage').find((c) => /Reply with your question/.test(c.body.text)), 'prompt');
  assert.equal(prompt.body.reply_markup.force_reply, true);
  assert.equal((await status(sql, b)).status, 'open', 'not yet: it needs the note');
  const pid = Number((await sql`select prompt_id from cb.telegram_messages where question_id = ${b}`)[0].prompt_id);
  text('Which environment do you mean?', AHMED, pid);
  await until(async () => (await status(sql, b)).status === 'sent_back', 'clarified');
  assert.deepEqual([(await status(sql, b)).sent_back.reason, (await status(sql, b)).sent_back.note], ['clarify', 'Which environment do you mean?']);

  // the rewrite comes back as a new message
  await sql`select cb.reask(${String(a)}, 'Ship today?', actor => 'W1')`;
  await until(() => sentFor(a).length === 2, 'rewritten question re-sent');
  assert.match(sentFor(a)[1].body.text, /Ship today\?/);
});

test('answered or withdrawn on the web: the Telegram message follows', async () => {
  const sql = await paired();
  const a = await ask(sql, 'Web answers this?', { options: ['Yes', 'No'] });
  const b = await ask(sql, 'Withdrawn?');
  await until(() => sentFor(a).length && sentFor(b).length, 'sent');
  const ma = await msgOf(sql, a);
  const mb = await msgOf(sql, b);
  await sql`select cb.answer(${String(a)}, 'No')`;
  await sql`select cb.withdraw(${String(b)}, 'W1')`;
  await until(() => calls('editMessageText').some((c) => c.body.message_id === ma && /Answered: No/.test(c.body.text)), 'answer shown');
  await until(() => calls('editMessageText').some((c) => c.body.message_id === mb && /Withdrawn/.test(c.body.text)), 'withdrawal shown');
  // a reply to it now says so instead of answering twice
  text('Yes after all', AHMED, ma);
  await until(() => calls('sendMessage').some((c) => /already answered/i.test(c.body.text)), 'already');
  assert.equal((await status(sql, a)).answer, 'No');
});

test('network trouble never crashes: an unreachable API backs off and stops cleanly', async () => {
  await tg.stopTelegram();
  const logged: string[] = [], orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    tg.startTelegram({ token: '123:test', api: 'http://127.0.0.1:9' }); // nothing listens there
    await until(() => logged.some((l) => /telegram getMe: 0 network error; retrying/.test(l)), 'a logged retry');
    assert.ok(logged.every((l) => !l.includes('123:test')), 'the token never reaches a log line');
    await tg.stopTelegram();
  } finally { console.error = orig; tg.startTelegram({ token: '123:test', api: fake.url }); } // back on the fake for what follows
});

test('handed to a guest and back: the message says so, then gets its buttons back without a second message', async () => {
  const sql = await paired();
  await sql`select cb.user_add('omar', 'Omar', 'ahmed')`;
  await sql`select cb.ensure_project('demo'), cb.user_project_add('omar', 'demo', 'ahmed')`;
  const id = await ask(sql, 'Who takes this?', { options: ['Me', 'You'] });
  await until(() => sentFor(id).length, 'sent');
  const msg = await msgOf(sql, id);
  await sql`select cb.question_assign(${String(id)}, 'omar')`;
  await until(() => calls('editMessageText').some((c) => c.body.message_id === msg && /Handed to omar/.test(c.body.text)), 'handed on');
  await sql`select cb.question_assign(${String(id)}, null)`;
  const back = await until(() => calls('editMessageText').find((c) => c.body.message_id === msg && c.body.reply_markup.inline_keyboard.length), 'buttons back');
  assert.equal(back.body.reply_markup.inline_keyboard[0][0].callback_data, `o:${id}:0`);
  assert.equal(sentFor(id).length, 1, 'the same message, not a new one');
  press(msg, `o:${id}:1`);
  await until(async () => (await status(sql, id)).answer === 'You', 'answerable again');
});

test('a stale button on a rewritten question is refused, not read against the new options', async () => {
  const sql = await paired();
  const id = await ask(sql, 'Pick?', { options: ['A', 'B'] });
  await until(() => sentFor(id).length, 'sent');
  const old = await msgOf(sql, id);
  // hold the mapping row so reconcile can't mark the old message superseded yet: the press lands in that gap
  let release!: () => void, locked!: () => void;
  const held = new Promise<void>((r) => { release = r; }), isLocked = new Promise<void>((r) => { locked = r; });
  const holder = sql.begin(async (t: any) => { await t`select 1 from cb.telegram_messages where question_id = ${id} for update`; locked(); await held; });
  await isLocked;
  await sql`select cb.reask(${String(id)}, 'Pick again?', '["X", "Y"]'::jsonb, actor => 'W1')`;
  await until(() => calls('editMessageReplyMarkup').some((c) => c.body.message_id === old), 'reconcile reached the old message');
  press(old, `o:${id}:1`);
  await new Promise((r) => setTimeout(r, 400));
  const mid = await status(sql, id);
  release(); await holder;
  assert.equal(mid.status, 'open', `the old "B" must not answer the new question (got ${mid.answer})`);
  await until(() => calls('answerCallbackQuery').some((c) => /rewritten/.test(c.body.text)), 'told it was rewritten');
});

test('after Clarify, a reply to the question itself answers it; only a reply to the prompt is the note', async () => {
  const sql = await paired();
  const id = await ask(sql, 'Go ahead?', { options: ['Yes', 'No'] });
  await until(() => sentFor(id).length, 'sent');
  const m = await msgOf(sql, id);
  press(m, `b:${id}:clarify`);
  await until(() => calls('sendMessage').some((c) => /Reply with your question/.test(c.body.text)), 'prompt');
  text('Yes', AHMED, m);
  await until(async () => (await status(sql, id)).status !== 'open', 'handled');
  assert.deepEqual([(await status(sql, id)).status, (await status(sql, id)).answer], ['answered', 'Yes']);
});

test('Hand to: one tap gives the question to that person; only people on its project are offered or accepted (#1200)', async () => {
  const sql = await paired();
  await sql`select cb.ensure_project('demo')`;
  await sql`select cb.user_add('omar', 'Omar', 'ahmed'), cb.user_add('iman', 'Iman', 'ahmed')`;
  await sql`select cb.user_project_add('omar', 'demo', 'ahmed')`; // iman is not on demo
  const id = await ask(sql, 'Who reviews the import?', { options: ['Me', 'Omar'] });
  const [sent] = await until(() => sentFor(id).length && sentFor(id), 'sent');
  const hands = sent.body.reply_markup.inline_keyboard.flat().filter((b: any) => b.callback_data.startsWith('h:'));
  assert.deepEqual(hands.map((b: any) => b.text), ['Hand to Omar'], 'only people on the project');
  const msg = await msgOf(sql, id);

  press(msg, `h:${id}:iman`); // a forged button for someone off the project: refused, nothing changes
  await until(() => calls('answerCallbackQuery').some((c) => /not on project/.test(c.body.text ?? '')), 'refused');
  assert.equal((await sql`select assigned_to from cb.questions where id = ${id}`)[0].assigned_to, null);

  press(msg, `h:${id}:omar`);
  await until(async () => (await sql`select assigned_to from cb.questions where id = ${id}`)[0].assigned_to === 'omar', 'handed');
  assert.equal((await status(sql, id)).status, 'open', 'still open: now Omar answers it');
  await until(() => calls('editMessageText').some((c) => c.body.message_id === msg && /Handed to omar/.test(c.body.text) && !c.body.reply_markup.inline_keyboard.length), 'message closed');
  await until(() => calls('answerCallbackQuery').some((c) => c.body.text === 'Handed to Omar.'), 'toast');
});
