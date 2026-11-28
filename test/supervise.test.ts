import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { freshDb, TEST_URL } from './helpers.ts';
import { lockClient, locked, tick } from '../cli/supervise.ts';
import type { Runner } from '../cli/squad-up.ts';

// #4585: codex, opencode and agy are installed; their MCP gate is read from this process, unset here
delete process.env.CB_MCP_GATE_OK;

const clients: any[] = [];
// closed after each test: kept to the end of the file, they pass Postgres's connection limit
afterEach(() => Promise.all(clients.splice(0).map((c) => c.end())));
const conn = (name: string, max = 10) => { const c = postgres(TEST_URL, { onnotice: () => {}, max, connection: { application_name: name } }); clients.push(c); return c; };

const SQUAD = {
  machines: { macbook: { herdr: 'macbook', repo: '/Users/me/Work/sv', board: '/Users/me/board' } },
  roles: { lead: { count: 1, model: 'opus', machine: 'macbook' }, builder: { count: 2, model: 'sonnet', machine: 'macbook' } },
  areas: [], supervise: true,
};
async function setup(projects = ['sv']) {
  const sql = await freshDb(); clients.push(sql);
  for (const p of projects) {
    await sql`select cb.ensure_project(${p})`;
    await sql`select cb.project_pipeline(${p}, true, 'ahmed')`;
    await sql`select cb.squad_set(${p}, ${sql.json(SQUAD)}, 'ahmed')`;
  }
  return { sql, sup: conn('cb-supervisor/test') };
}
async function card(sql: any, o: { stage?: string; assignee?: string | null; status?: string; project?: string } = {}) {
  const [{ id }] = await sql`select cb.task_add(project => ${o.project ?? 'sv'}, title => 'c', type => 'bug', status => 'next', actor => 'orch@pc') as id`;
  await sql`update cb.tasks set stage = ${o.stage ?? 'build'}, stage_since = now(), assignee = ${o.assignee ?? null}, status = ${o.status ?? 'next'} where id = ${id}`;
  return Number(id);
}
const session = (sql: any, actor: string, role: string, o: { live?: boolean; startedMin?: number; agent?: string; model?: string } = {}) =>
  sql`insert into cb.sessions (machine, pane, actor, project, role, started_at, last_seen, agent, model)
      values ('macbook', ${actor}, ${actor}, 'sv', ${role}, now() - make_interval(mins => ${o.startedMin ?? 0}), now() - make_interval(mins => ${o.live === false ? 10 : 0}),
              ${o.agent ?? 'claude'}, ${o.model ?? null})`;
const events = async (sql: any, what: string) => (await sql`select * from cb.events where actor = 'supervisor' and data ->> 'what' = ${what}`) as any[];

// ---- a fake herdr: nothing real is started; `live` holds the herdr names it reports ----
type Call = { m: string | null; args: string[] };
const OK = { status: 0, stdout: '{}', stderr: '' };
const GONE = { status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_found"}}' };
const json = (o: unknown) => ({ status: 0, stdout: JSON.stringify(o), stderr: '' });
function fakeHerdr(o: { down?: string[]; status?: string; start?: (c: Call) => any; prompt?: (c: Call) => any; read?: (pane: string) => any } = {}) {
  const calls: Call[] = [], live = new Map<string, string>(); // herdr name → pane
  let panes = 0;
  const run: Runner = (m, args) => {
    const c = { m, args }; calls.push(c);
    const [a, b, x] = args;
    if (a === 'agent' && b === 'list') return o.down?.includes(m ?? 'local') ? { status: 1, stdout: '', stderr: 'machine unreachable' }
      : json({ id: 'cli:agent:list', result: { agents: [...live].map(([name, pane_id]) => ({ name, pane_id, agent: 'claude', agent_status: o.status ?? 'idle' })), type: 'agent_list' } });
    if (a === 'agent' && b === 'get') return live.has(x!) ? json({ result: { agent: { name: x, pane_id: live.get(x!) } } }) : GONE;
    if (a === 'tab' || (a === 'pane' && b === 'split')) return json({ result: { pane: { pane_id: `p${++panes}` } } });
    if (a === 'agent' && b === 'start') { const r = o.start?.(c); live.set(x!, args[args.indexOf('--pane') + 1]!); return r ?? OK; }
    if (a === 'agent' && b === 'prompt' && args[3] === '/exit') live.delete(x!);
    if (a === 'agent' && b === 'prompt') return o.prompt?.(c) ?? OK;
    if (a === 'pane' && b === 'read') return o.read?.(x!) ?? { status: 0, stdout: '', stderr: '' }; // plain text lines, no JSON
    return OK;
  };
  return { calls, run, live };
}
const has = (calls: Call[], ...a: string[]) => calls.some((c) => a.every((x, i) => c.args[i] === x));
const memory = () => ({ failedAt: new Map<string, number>(), blockedTold: new Set<string>(), launched: new Set<string>(), runnerToldAt: 0, runnerStartedAt: 0,
  closeSkipAt: new Map<string, number>(), elsewhereToldAt: new Map<string, number>(), leavingTold: new Map<string, string>(), restartTried: new Map<string, string>(),
  unreadTold: new Set<string>() });
// a fake clock: sleep moves it, so the close wait's 60 s pass at once
const deps = (sup: any, run: Runner, o: Partial<Parameters<typeof tick>[0]> = {}) => {
  let t = Date.now();
  return { sql: sup, run, dryRun: false, now: Date.now(), memory: memory(), runnerConfig: null, probe: async () => false,
    sleep: async (ms: number) => { t += ms; }, clock: () => t, ...o };
};
const tells = (sql: any, to = 'orch@macbook') => sql`select summary from cb.events where kind = 'message' and data ->> 'to' = ${to}` as Promise<any[]>;

test('a waiting build card starts a builder', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run));
  assert.ok(has(h.calls, 'tab', 'create'), out.join('\n'));
  const start = h.calls.find((c) => c.args[0] === 'agent' && c.args[1] === 'start');
  assert.ok(start, out.join('\n'));
  assert.equal(start.m, 'macbook');
  assert.equal(start.args[2], 'sv-b1-macbook');
  const native = start.args.slice(start.args.indexOf('--') + 1);
  // #4346: no MCP server is loaded in a seat (--strict-mcp-config with an empty config)
  assert.deepEqual(native, ['--model', 'sonnet', '--permission-mode', 'bypassPermissions', '--settings', '/Users/me/board/kit/permissions/builder.json',
    '--strict-mcp-config', '--mcp-config', '/Users/me/board/kit/mcp/none.json']);
  assert.ok(h.calls.some((c) => c.args[1] === 'prompt' && c.args[2] === 'sv-b1-macbook' && c.args[3]!.startsWith('cb iam sv-B1@macbook sv --role builder')));
  assert.ok(!h.calls.some((c) => c.args[1] === 'start' && c.args[2] === 'sv-b2-macbook')); // one card, one builder
  const ev = await events(sql, 'start');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.session, 'sv-B1@macbook');
  assert.equal(ev[0].project, 'sv');
});

test('dry run acts on nothing', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run, { dryRun: true }));
  assert.ok(out.includes('would start sv-B1@macbook (builder, sonnet) on macbook'), out.join('\n'));
  assert.ok(h.calls.every((c) => c.args[0] === 'agent' && (c.args[1] === 'list' || c.args[1] === 'get')), JSON.stringify(h.calls));
  assert.equal((await sql`select count(*)::int as n from cb.events where actor = 'supervisor'`)[0].n, 0);
  assert.equal((await sql`select count(*)::int as n from cb.sessions where closing_at is not null`)[0].n, 0);
});

test('herdr unreachable: no start, no restore', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  await session(sql, 'sv-B2@macbook', 'builder', { live: false });
  await card(sql, { assignee: 'sv-B2@macbook', status: 'in_progress' }); // B2 is down and holds a card
  const h = fakeHerdr({ down: ['macbook'] });
  const out = await tick(deps(sup, h.run));
  assert.ok(!h.calls.some((c) => ['start', 'prompt'].includes(c.args[1]!) || c.args[0] === 'tab'), out.join('\n'));
  assert.equal((await sql`select count(*)::int as n from cb.events where actor = 'supervisor'`)[0].n, 0);
});

test('a down session holding a card is restored with cb resume', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B2@macbook', 'builder', { live: false });
  await card(sql, { assignee: 'sv-B2@macbook', status: 'in_progress' });
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run));
  assert.ok(h.calls.some((c) => c.args[1] === 'prompt' && c.args[2] === 'sv-b2-macbook' && c.args[3]!.endsWith('then cb resume')));
  assert.equal((await events(sql, 'restore')).length, 1);
  assert.ok(out.some((l) => l.endsWith('restored sv-B2@macbook')), out.join('\n'));
});

test('close sequence: an idle 21-minute squad session is sent /exit and its pane closed', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  const out = await tick(deps(sup, h.run));
  assert.ok(has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.ok(has(h.calls, 'pane', 'close', 'w1:p9'), out.join('\n'));
  assert.ok(out.includes('closed sv-B1@macbook'), out.join('\n'));
  assert.equal((await events(sql, 'close')).length, 1);
  assert.notEqual((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null); // fenced until it lapses or the name binds again
});

test('#4806: with no stages the supervisor restores a down holder and closes a dropped seat, and starts nothing for a card', async () => {
  const { sql, sup } = await setup();
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles, builder: { count: 4, model: 'sonnet', machine: 'macbook' } } })}, 'ahmed')`;
  await sql`select cb.squad_set('sv', ${sql.json(SQUAD)}, 'ahmed')`;
  await sql`select cb.project_pipeline('sv', false, 'ahmed')`;
  await card(sql); // nobody holds it
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 }); // a seat the squad names: stays open
  await session(sql, 'sv-B2@macbook', 'builder', { live: false });
  await card(sql, { assignee: 'sv-B2@macbook', status: 'in_progress' });
  await session(sql, 'sv-B3@macbook', 'builder', { startedMin: 21 }); // dropped from the squad: closed
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p7'); h.live.set('sv-b3-macbook', 'w1:p8');
  const out = await tick(deps(sup, h.run));
  assert.ok(out.some((l) => l.endsWith('restored sv-B2@macbook')), out.join(String.fromCharCode(10)));
  assert.ok(out.includes('closed sv-B3@macbook'), out.join(String.fromCharCode(10)));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join(String.fromCharCode(10)));
  assert.equal((await events(sql, 'start')).length, 0);
});

// #3770: the squad file's builder count was 4 and is 2 now, so B3 and B4 are seats it no longer generates
test('seats the squad file dropped: the idle one closes while work waits, the busy one is said once and kept', async () => {
  const { sql, sup } = await setup();
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles, builder: { count: 4, model: 'sonnet', machine: 'macbook' } } })}, 'ahmed')`;
  await sql`select cb.squad_set('sv', ${sql.json(SQUAD)}, 'ahmed')`;
  await card(sql); // build work waits
  await session(sql, 'sv-B3@macbook', 'builder', { startedMin: 21 });
  await session(sql, 'sv-B4@macbook', 'builder', { startedMin: 21 });
  await card(sql, { assignee: 'sv-B4@macbook', status: 'in_progress' });
  const h = fakeHerdr();
  h.live.set('sv-b3-macbook', 'w1:p8'); h.live.set('sv-b4-macbook', 'w1:p9');
  const dry = await tick(deps(sup, h.run, { dryRun: true }));
  assert.ok(dry.includes('would close sv-B3@macbook'), dry.join('\n'));
  assert.ok(dry.some((l) => l.startsWith('would keep sv-B4@macbook open (left the squad file): it holds work')), dry.join('\n'));
  const memory = deps(sup, h.run).memory;
  const out = await tick(deps(sup, h.run, { memory }));
  assert.ok(out.includes('closed sv-B3@macbook'), out.join('\n'));
  assert.ok(out.some((l) => l.includes('started sv-B1@macbook')), out.join('\n')); // B3 and B4 took none of the two slots
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b4-macbook', '/exit'), out.join('\n'));
  assert.equal(out.filter((l) => l.startsWith('sv-B4@macbook left the squad file but stays open')).length, 1, out.join('\n'));
  const again = await tick(deps(sup, h.run, { memory }));
  assert.ok(!again.some((l) => l.startsWith('sv-B4@macbook left')), again.join('\n')); // said once per reason
});

// #4002: the agent running in the seat judges and closes it; one with no adapter yet is never closed
test('closeOne delegates through Claude adapter and safely skips unregistered agent', async () => {
  const closingAt = async (sql: any) => (await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at;
  { // claude: its adapter's /exit, then the pane closed
    const { sql, sup } = await setup();
    await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21, agent: 'claude' });
    const h = fakeHerdr();
    h.live.set('sv-b1-macbook', 'w1:p9');
    const out = await tick(deps(sup, h.run));
    assert.ok(has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
    assert.equal(h.calls.find((c) => c.args[3] === '/exit')!.m, 'macbook');
    assert.ok(out.includes('closed sv-B1@macbook'), out.join('\n'));
  }
  { // a seat bound as codex whose MCP check is not confirmed here (#4585: installed, CB_MCP_GATE_OK unset): never planned for a close, never marked
    const { sql, sup } = await setup();
    await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21, agent: 'codex' });
    const h = fakeHerdr();
    h.live.set('sv-b1-macbook', 'w1:p9');
    const out = await tick(deps(sup, h.run));
    assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
    assert.ok(!has(h.calls, 'pane', 'close'), out.join('\n'));
    assert.equal(await closingAt(sql), null);
    assert.equal((await events(sql, 'close')).length, 0);
    const dry = await tick(deps(sup, h.run, { dryRun: true }));
    assert.ok(!dry.some((l) => /close/.test(l)), dry.join('\n'));
  }
  { // planned as claude, but the seat runs codex by the time it is closed (bound again between): the fresh row decides
    const { sql, sup } = await setup();
    await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21, agent: 'claude' });
    const h = fakeHerdr();
    h.live.set('sv-b1-macbook', 'w1:p9');
    const hooked = new Proxy(sup, {
      apply(t, self, args: any[]) {
        const q = Reflect.apply(t, self, args);
        if (!/supervise_mark\(.*, true\)/.test(String(args[0]?.join?.('?')))) return q;
        return q.then(async (r: any) => { await sql`update cb.sessions set agent = 'codex' where actor = 'sv-B1@macbook'`; return r; });
      },
    });
    const out = await tick(deps(hooked, h.run));
    assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
    assert.ok(!has(h.calls, 'pane', 'close'), out.join('\n'));
    assert.ok(out.some((l) => l.startsWith('skip closing sv-B1@macbook: agent "codex" cannot start a seat with MCP off for one run')), out.join('\n'));
    assert.equal(await closingAt(sql), null, 'the mark is cleared');
    assert.equal((await events(sql, 'close')).length, 0);
  }
});

// #4332 (Q2970): builders run sonnet now; B1, idle 6 minutes, still runs opus
test('an idle seat on an old model is closed and started on the new one, said on the board, once per setting', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 6, model: 'opus' });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  const dry = await tick(deps(sup, h.run, { dryRun: true }));
  assert.ok(dry.includes('would restart sv-B1@macbook (opus to sonnet)'), dry.join('\n'));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), dry.join('\n'));
  const memory = deps(sup, h.run).memory;
  const out = await tick(deps(sup, h.run, { memory }));
  assert.ok(has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.ok(has(h.calls, 'pane', 'close', 'w1:p9'), out.join('\n'));
  const start = h.calls.find((c) => c.args[0] === 'agent' && c.args[1] === 'start' && c.args[2] === 'sv-b1-macbook');
  assert.ok(start && start.args.slice(start.args.indexOf('--') + 1).join(' ').startsWith('--model sonnet'), out.join('\n'));
  assert.ok(h.calls.some((c) => c.args[1] === 'prompt' && c.args[2] === 'sv-b1-macbook' && c.args[3]!.includes('--model sonnet')), out.join('\n'));
  assert.deepEqual((await events(sql, 'restart')).map((e) => e.summary), ['restart sv-B1@macbook (opus to sonnet)']);
  assert.equal((await events(sql, 'close')).length, 1);
  assert.equal((await events(sql, 'start')).length, 1);
  // the old row still reads live on opus for up to 90 s: the next tick does not close the new seat
  const exits = h.calls.filter((c) => c.args[3] === '/exit').length;
  const again = await tick(deps(sup, h.run, { memory }));
  assert.equal(h.calls.filter((c) => c.args[3] === '/exit').length, exits, again.join('\n'));
  assert.equal((await events(sql, 'restart')).length, 1);
});

test('a seat whose new agent cannot start here is kept running, refused once on the board, never closed', async () => {
  const { sql, sup } = await setup();
  // the stored squad is edited as cb.squad_set saves a codex seat (#4585); CB_MCP_GATE_OK is unset here, so codex cannot start
  await sql`update cb.projects set squad = jsonb_set(squad, '{roles,builder,seats}', ${sql.json({ 1: { agent: 'codex', model: 'gpt-6.1-sol' } })}) where slug = 'sv'`;
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 6, model: 'sonnet' });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  const memory = deps(sup, h.run).memory;
  const out = await tick(deps(sup, h.run, { memory }));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.ok(out.some((l) => l.startsWith('sv-B1@macbook runs an older setting than its seat, but codex/gpt-6.1-sol cannot start here')), out.join('\n'));
  assert.deepEqual((await events(sql, 'restart')).map((e) => e.summary), ['restart sv-B1@macbook (refused, codex/gpt-6.1-sol cannot start: agent "codex" cannot start a seat with MCP off for one run)']);
  const again = await tick(deps(sup, h.run, { memory }));
  assert.ok(!again.some((l) => l.includes('cannot start here')), again.join('\n'));
  assert.equal((await events(sql, 'restart')).length, 1);
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'));
});

test('a working seat is never marked closing: the tick reads its herdr status', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21, agent: 'claude' }); // idle on the board long enough to be a close candidate
  const h = fakeHerdr({ status: 'working' });
  h.live.set('sv-b1-macbook', 'w1:p9');
  const marks: string[] = [];
  const spy = new Proxy(sup, {
    apply(t, self, args: any[]) { marks.push(String(args[0]?.join?.('?'))); return Reflect.apply(t, self, args); },
  });
  const out = await tick(deps(spy, h.run));
  assert.ok(!marks.some((q) => /supervise_mark\(.*, true\)/.test(q)), 'never marked closing');
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null);
});

test('a claim between mark and re-check stops the close', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  // a held card lands right after the mark committed, before the re-check
  const hooked = new Proxy(sup, {
    apply(t, self, args: any[]) {
      const q = Reflect.apply(t, self, args);
      if (!/supervise_mark\(.*, true\)/.test(String(args[0]?.join?.('?')))) return q;
      return q.then(async (r: any) => { await card(sql, { assignee: 'sv-B1@macbook', status: 'in_progress' }); return r; });
    },
  });
  const out = await tick(deps(hooked, h.run));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null);
  assert.equal((await events(sql, 'close')).length, 0);
});

test('a session that will not exit in 60 s keeps its pane and its mark, which lapses by itself', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const base = fakeHerdr();
  base.live.set('sv-b1-macbook', 'w1:p9');
  let t = 0, gets = 0;
  const run: Runner = (m, args) => {
    if (args[1] === 'prompt') return OK; // /exit ignored
    if (args[1] === 'get') { gets++; t += 35_000; } // each agent get takes 35 s
    return base.run(m, args);
  };
  const out = await tick(deps(sup, run, { clock: () => t, sleep: async (ms: number) => { t += ms; } }));
  assert.ok(gets <= 3, `${gets} agent gets: the wait is bounded by the clock, not by the number of polls`);
  assert.ok(out.includes('could not close sv-B1@macbook'), out.join('\n'));
  assert.ok(!has(base.calls, 'pane', 'close'));
  assert.notEqual((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null); // it may still be exiting
  assert.equal((await events(sql, 'close')).length, 0);
});

test('blocked start tells the lead once', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  await session(sql, 'orch@macbook', 'lead');
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready","message":"blocked during startup"}}' }) });
  const d = deps(sup, h.run);
  await tick(d);
  await tick({ ...d, now: Date.now() }); // herdr now reports the blocked agent live
  assert.equal(h.calls.filter((c) => c.args[1] === 'start').length, 1);
  assert.ok(!h.calls.some((c) => c.args[1] === 'prompt'));
  assert.equal((await events(sql, 'blocked')).length, 1);
  assert.equal((await events(sql, 'blocked'))[0].data.note, 'p1');
  const tells = await sql`select summary from cb.events where kind = 'message' and data ->> 'to' = 'orch@macbook'`;
  assert.equal(tells.length, 1);
  assert.match(tells[0].summary, /sv-B1@macbook .*pane p1 on macbook.*herdr --machine macbook agent prompt sv-b1-macbook/);
});

test('a blocked start with no live lead tells nobody and is not marked told', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready"}}' }) });
  const d = deps(sup, h.run);
  const out = await tick(d);
  assert.ok(!out.some((l) => l.startsWith('could not tell')), out.join('\n'));
  assert.equal((await sql`select count(*)::int as n from cb.events where kind = 'message'`)[0].n, 0);
  assert.equal((await events(sql, 'blocked')).length, 1); // the digest's blocked line is the fallback
  assert.equal(d.memory.blockedTold.size, 0);
});

test('the lead told is the live lead session of the project, whatever its name', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  await session(sql, 'boss@macbook', 'lead');
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready"}}' }) });
  const out = await tick(deps(sup, h.run));
  assert.equal((await tells(sql, 'boss@macbook')).length, 1, out.join('\n'));
  assert.equal((await tells(sql)).length, 0);
});

test('a started session whose first prompt failed is blocked: the lead gets the command once', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  await session(sql, 'orch@macbook', 'lead');
  const h = fakeHerdr({ prompt: (c) => (c.args[3]!.startsWith('cb iam') ? { status: 1, stdout: '', stderr: 'agent_blocked' } : undefined) });
  const d = deps(sup, h.run);
  await tick(d);
  await tick({ ...d, now: Date.now() + 60_000 });
  assert.equal(h.calls.filter((c) => c.args[1] === 'start').length, 1);
  const b = await events(sql, 'blocked');
  assert.equal(b.length, 1);
  assert.match(b[0].data.note, /prompt not sent/);
  assert.equal((await events(sql, 'failed')).length, 0);
  const t = await tells(sql);
  assert.equal(t.length, 1);
  // PR 117 S2: both sends may have landed, so the lead checks the pane before sending
  assert.match(t[0].summary, /sv-B1@macbook .*first prompt may not have landed: check the pane, then send it if it is not there: herdr --machine macbook agent prompt sv-b1-macbook "cb iam sv-B1@macbook sv/);
  assert.ok(!d.memory.failedAt.has('sv-B1@macbook'));
});

test('two supervised projects in one tick share the 3 starts and the Mac count', async () => {
  const { sql, sup } = await setup(['sv', 'sw']);
  for (const project of ['sv', 'sv', 'sw', 'sw']) await card(sql, { project });
  let h = fakeHerdr();
  await tick(deps(sup, h.run));
  assert.equal(h.calls.filter((c) => c.args[1] === 'start').length, 3, 'one budget of 3 across projects');
  // 6 sessions already live on the Mac: room for 2 in all, not 2 per project
  await sql`delete from cb.events`;
  await sql`insert into cb.sessions (machine, pane, actor, last_seen) select 'macbook', 'o' || i, 'other-B' || i || '@macbook', now() from generate_series(1, 6) i`;
  h = fakeHerdr();
  await tick(deps(sup, h.run));
  assert.equal(h.calls.filter((c) => c.args[1] === 'start').length, 2, 'the Mac cap of 8 counts the starts planned for the first project');
});

test('a name that failed to start is not retried for 10 minutes', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: 'model missing' }) });
  const d = deps(sup, h.run);
  await tick(d);
  h.live.clear();
  await tick({ ...d, now: Date.now() + 60_000 });
  assert.equal(h.calls.filter((c) => c.args[1] === 'start' && c.args[2] === 'sv-b1-macbook').length, 1); // B2 is tried instead
  const f = (await events(sql, 'failed')).filter((e) => e.data.session === 'sv-B1@macbook');
  assert.equal(f.length, 1);
  assert.equal(f[0].data.note, 'start failed'); // herdr's error text stays in the PC log only
  assert.ok(d.memory.failedAt.has('sv-B1@macbook'));
});

function runnerJson() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-sup-'));
  const cfg = { ...JSON.parse(readFileSync('docs/ops/runner.example.json', 'utf8')), name: 'pc-test' };
  writeFileSync(join(dir, 'runner.json'), JSON.stringify(cfg));
  return join(dir, 'runner.json');
}

test('runner: no beat and its port free, it is started in a herdr tab', async () => {
  const { sql, sup } = await setup();
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run, { runnerConfig: runnerJson(), probe: async () => false }));
  const tab = h.calls.find((c) => c.args[0] === 'tab');
  assert.ok(tab, out.join('\n'));
  assert.equal(tab.m, null);
  assert.deepEqual(tab.args.slice(4), ['--label', 'runner', '--no-focus']);
  assert.ok(has(h.calls, 'pane', 'run', 'p1', 'cb runner'));
  const ev = await events(sql, 'runner');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].project, null);
  assert.equal(ev[0].data.note, 'started');
});

// #3902: the supervisor validates runner.json with the recipes.ts it loaded at start. After the slots cap went to 10 it
// refused the new config ("slots: must be an integer 1-4") and so could not restart a dead runner. A config it refuses
// still names the runner and its port; the runner, started fresh, checks the file with current code itself.
test('runner: a runner.json this supervisor refuses still gets a dead runner restarted, and says why it was refused', async () => {
  const { sup } = await setup();
  const file = runnerJson();
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), slots: 999, futureKey: { x: 1 } }));
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run, { runnerConfig: file, probe: async () => false }));
  assert.ok(out.some((l) => /^runner config: .*(?:slots|futureKey).*the runner checks it again with current code/.test(l)), out.join('\n'));
  assert.ok(has(h.calls, 'pane', 'run', 'p1', 'cb runner'), out.join('\n'));
  // not JSON at all: nothing to go on, nothing started
  writeFileSync(file, '{ nope');
  const h2 = fakeHerdr();
  const out2 = await tick(deps(sup, h2.run, { runnerConfig: file, probe: async () => false }));
  assert.ok(out2.some((l) => l.startsWith('runner config: ')), out2.join('\n'));
  assert.ok(!h2.calls.some((c) => c.args[0] === 'tab'));
});

// #4261 review I1: a tick abandoned at its deadline must not keep acting (start or close seats with its log writes
// failing). An aborted tick stops at its next step: no herdr call, no board write.
test('a tick whose signal is aborted acts on nothing: no herdr call, no supervise_log row', async () => {
  const { sql, sup } = await setup();
  const h = fakeHerdr();
  await assert.rejects(tick(deps(sup, h.run, { runnerConfig: runnerJson(), probe: async () => false, signal: AbortSignal.abort() })), /abort/i);
  assert.deepEqual(h.calls.filter((c) => c.args[0] !== 'agent' || c.args[1] !== 'list'), []);
  assert.equal((await sql`select count(*)::int n from cb.events where kind in ('supervisor', 'runner')`)[0].n, 0);
});

test('runner: a beating runner is left alone; a held port is reported at most hourly', async () => {
  const { sql, sup } = await setup();
  const cfg = runnerJson();
  await sql`insert into cb.runners (name, last_seen) values ('pc-test', now())`;
  const h = fakeHerdr();
  await tick(deps(sup, h.run, { runnerConfig: cfg }));
  assert.equal(h.calls.filter((c) => c.args[0] !== 'agent').length, 0);
  await sql`update cb.runners set last_seen = now() - interval '4 minutes'`;
  const d = deps(sup, h.run, { runnerConfig: cfg, probe: async () => true });
  await tick(d);
  await tick({ ...d, now: Date.now() + 60_000 });
  assert.ok(!h.calls.some((c) => c.args[0] === 'tab' || c.args[0] === 'pane'));
  const ev = await events(sql, 'runner');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.note, 'not beating but its port is held');
});

test('runner: a start that does not beat is not retried for 10 minutes; the lead is told hourly', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'orch@macbook', 'lead');
  const h = fakeHerdr();
  const d = deps(sup, h.run, { runnerConfig: runnerJson(), probe: async () => false });
  await tick(d);
  const out = await tick({ ...d, now: d.now + 60_000 });
  await tick({ ...d, now: d.now + 120_000 });
  assert.equal(h.calls.filter((c) => c.args[0] === 'tab').length, 1, 'no second runner tab within 10 minutes');
  assert.ok(out.includes('runner started 1 min ago and still not beating'), out.join('\n'));
  assert.equal((await tells(sql)).length, 1);
  await tick({ ...d, now: d.now + 11 * 60_000 });
  const tabs = h.calls.filter((c) => c.args[0] === 'tab');
  assert.equal(tabs.length, 2, 'started again after 10 minutes');
  // the dead runner tab it opened before is closed first: that pane only
  const closes = h.calls.filter((c) => c.args[0] === 'pane' && c.args[1] === 'close');
  assert.deepEqual(closes.map((c) => c.args[2]), ['p1']);
  assert.ok(h.calls.indexOf(closes[0]!) < h.calls.indexOf(tabs[1]!));
});

test('runner: a held port is told to the lead, hourly', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'orch@macbook', 'lead');
  const d = deps(sup, fakeHerdr().run, { runnerConfig: runnerJson(), probe: async () => true });
  await tick(d);
  await tick({ ...d, now: d.now + 60_000 });
  const t = await tells(sql);
  assert.equal(t.length, 1);
  assert.match(t[0].summary, /runner pc-test is not beating but its port is held/);
});

test('the hold re-check runs after herdr finds the pane, right before /exit', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  let found = false;
  const run: Runner = (m, args) => { if (args[1] === 'get') found = true; return h.run(m, args); };
  // a card lands while herdr is asked for the pane: the next state read must see it
  const hooked = new Proxy(sup, {
    apply(t, self, args: any[]) {
      if (!found || !/supervise_state/.test(String(args[0]?.join?.('?')))) return Reflect.apply(t, self, args);
      found = false;
      return card(sql, { assignee: 'sv-B1@macbook', status: 'in_progress' }).then(() => Reflect.apply(t, self, args));
    },
  });
  const out = await tick(deps(hooked, run));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null);
});

test('herdr shows the agent working right before /exit: no /exit, the mark is cleared', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  const run: Runner = (m, args) => args[1] === 'get' && h.live.has(args[2]!)
    ? json({ result: { agent: { name: args[2], pane_id: 'w1:p9', agent_status: 'working' } } }) : h.run(m, args);
  const out = await tick(deps(sup, run));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.ok(out.some((l) => /herdr shows it working/.test(l)), out.join('\n'));
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null);
});

test('a name herdr lists but cannot find is not tried again for 10 minutes', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  let gets = 0;
  const run: Runner = (m, args) => (args[1] === 'get' ? (gets++, GONE) : h.run(m, args));
  const d = deps(sup, run);
  const out = await tick(d);
  assert.ok(out.includes('could not close sv-B1@macbook: herdr does not show it'), out.join('\n'));
  await tick({ ...d, now: d.now + 60_000 });
  assert.equal(gets, 1);
  await tick({ ...d, now: d.now + 11 * 60_000 });
  assert.equal(gets, 2);
});

test('a restore that fails writes a restore event, is not down again next tick, and is tried again after 10 minutes', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B2@macbook', 'builder', { live: false });
  await card(sql, { assignee: 'sv-B2@macbook', status: 'in_progress' });
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: 'model missing' }) });
  const d = deps(sup, h.run);
  await tick(d);
  const r = await events(sql, 'restore');
  assert.equal(r.length, 1);
  assert.equal(r[0].data.note, 'start failed');
  assert.equal((await events(sql, 'failed')).length, 1);
  const starts = () => h.calls.filter((c) => c.args[1] === 'start' && c.args[2] === 'sv-b2-macbook').length;
  h.live.clear(); // the failed start left nothing running
  const out = await tick({ ...d, now: d.now + 60_000 });
  assert.equal((await events(sql, 'down_again')).length, 0, out.join('\n'));
  assert.equal(starts(), 1);
  h.live.clear();
  await tick({ ...d, now: d.now + 11 * 60_000 });
  assert.equal(starts(), 2);
  assert.equal((await events(sql, 'down_again')).length, 0);
});

test('one bad project does not stop the others', async () => {
  const { sql, sup } = await setup(['sv', 'sw']);
  await card(sql, { project: 'sw' });
  await sql`update cb.projects set squad = '{"supervise": true}' where slug = 'sv'`;
  const h = fakeHerdr();
  const out = await tick(deps(sup, h.run));
  assert.ok(out.some((l) => l.startsWith('sv: ')), out.join('\n'));
  assert.ok(h.calls.some((c) => c.args[1] === 'start' && c.args[2] === 'sw-b1-macbook'), out.join('\n'));
});

test('a project whose own machine (herdr null) is not this machine is skipped, said once an hour', async () => {
  const { sql, sup } = await setup();
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, machines: { ...SQUAD.machines, 'not-this-pc': { herdr: null, repo: '/r', board: '/b' } } })}, 'ahmed')`;
  await card(sql);
  const h = fakeHerdr();
  const d = deps(sup, h.run);
  const out = [...await tick(d), ...await tick({ ...d, now: d.now + 60_000 })];
  assert.equal(h.calls.length, 0, JSON.stringify(h.calls));
  assert.equal(out.filter((l) => l.includes('not-this-pc')).length, 1, out.join('\n'));
  assert.equal((await sql`select count(*)::int as n from cb.events where actor = 'supervisor'`)[0].n, 0);
});

test('a second supervisor exits', async () => {
  await freshDb().then((s) => clients.push(s)); // empty board: nothing a stray tick could act on
  const holder = await conn('cb-supervisor/test', 1).reserve();
  try {
    assert.equal((await holder`select pg_try_advisory_lock(hashtext('cb-supervisor')) as ok`)[0].ok, true);
    const home = mkdtempSync(join(tmpdir(), 'cb-sup-'));
    const r = spawnSync('node', ['cli/supervise.ts', '--once'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_RUNNER_CONFIG: join(home, 'none.json'), CB_SUPERVISOR_HOME: home },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout + r.stderr, /another supervisor is running/);
    const dry = spawnSync('node', ['cli/supervise.ts', '--dry-run'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, CB_DATABASE_URL: TEST_URL, CB_RUNNER_CONFIG: join(home, 'none.json'), CB_SUPERVISOR_HOME: home },
    });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr); // a dry run writes nothing: it previews while a supervisor runs
  } finally {
    await holder`select pg_advisory_unlock_all()`;
    holder.release();
  }
});

test('the lock survives a dropped board connection: the next check takes it again, nothing throws', { timeout: 30_000 }, async () => {
  const sql = await freshDb(); clients.push(sql);
  const lock = lockClient('cb-supervisor/test');
  try {
    assert.equal(await locked(lock), true);
    const [{ pid }] = await lock`select pg_backend_pid() as pid`;
    await sql`select pg_terminate_backend(${pid})`; // this client's own backend only: other test runs share the server
    for (let i = 0; i < 50 && (await sql`select 1 from pg_stat_activity where pid = ${pid}`).length; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300)); // the client sees its socket close: the next check runs on a dead connection
    assert.equal(await locked(lock), true);
    const [{ pid: again }] = await lock`select pg_backend_pid() as pid`;
    assert.notEqual(again, pid);
    const other = await conn('cb-supervisor/test', 1).reserve();
    try { assert.equal((await other`select pg_try_advisory_lock(hashtext('cb-supervisor')) as ok`)[0].ok, false); } finally { other.release(); }
  } finally {
    await lock`select pg_advisory_unlock_all()`.catch(() => {});
    await lock.end();
  }
});

test('a throw between the mark and /exit clears the mark', async () => {
  const { sql, sup } = await setup();
  await session(sql, 'sv-B1@macbook', 'builder', { startedMin: 21 });
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  let found = false;
  const run: Runner = (m, args) => { if (args[1] === 'get') found = true; return h.run(m, args); };
  // the re-check after herdr found the pane fails (the board dropped the connection)
  const hooked = new Proxy(sup, {
    apply(t, self, args: any[]) {
      if (found && /supervise_state/.test(String(args[0]?.join?.('?')))) return Promise.reject(new Error('connection lost'));
      return Reflect.apply(t, self, args);
    },
  });
  const out = await tick(deps(hooked, run));
  assert.ok(out.some((l) => /sv: tick failed: connection lost/.test(l)), out.join('\n'));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.equal((await sql`select closing_at from cb.sessions where actor = 'sv-B1@macbook'`)[0].closing_at, null);
});

test('a name blocked again after its blocked agent is gone tells the lead again', async () => {
  const { sql, sup } = await setup();
  await card(sql);
  await session(sql, 'orch@macbook', 'lead');
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready"}}' }) });
  const d = deps(sup, h.run);
  await tick(d);
  assert.ok(d.memory.blockedTold.has('sv-B1@macbook'));
  h.live.clear(); // a person closed the blocked pane
  const out = await tick({ ...d, now: d.now + 60_000 });
  assert.equal(h.calls.filter((c) => c.args[1] === 'start' && c.args[2] === 'sv-b1-macbook').length, 2, out.join('\n'));
  assert.equal((await tells(sql)).length, 2);
});

test('a launch whose prompt lists repo folders: the lead is told the command is in the PC log, the board keeps no path', async () => {
  const { sql, sup } = await setup();
  const RQ = {
    machines: { macbook: { herdr: 'macbook', board: '/Users/me/board' } },
    repos: { api: { home: true, paths: { macbook: '/Users/me/Work/rq/api' } }, web: { paths: { macbook: '/Users/me/Work/rq/web' } } },
    areas: [], supervise: true,
    roles: { lead: { count: 1, model: 'opus', machine: 'macbook' }, qa: { count: 1, model: 'sonnet', machine: 'macbook' },
             builder: { count: { api: 1, web: 1 }, model: 'sonnet', machine: 'macbook' }, reviewer: { count: { api: 1, web: 1 }, model: 'opus', machine: 'macbook' } },
  };
  await sql`select cb.ensure_project('rq'), cb.project_pipeline('rq', true, 'ahmed')`;
  await sql`select cb.squad_set('rq', ${sql.json(RQ)}, 'ahmed')`;
  await sql`insert into cb.sessions (machine, pane, actor, project, role, last_seen) values ('macbook', 'pl', 'orch@macbook', 'rq', 'lead', now())`;
  await card(sql, { project: 'rq', stage: 'qa' });
  await card(sql, { project: 'rq', stage: 'build' }); // no repos named: nobody's, so no builder starts
  const h = fakeHerdr({ start: () => ({ status: 1, stdout: '', stderr: '{"error":{"code":"agent_not_ready"}}' }) });
  const out = await tick(deps(sup, h.run));
  const t = await tells(sql);
  assert.equal(t.length, 1, out.join('\n'));
  assert.match(t[0].summary, /^supervisor: rq-Q1@macbook waits on a startup dialog in herdr pane p\d+ on macbook\. Answer it there, then run the prompt command the supervisor printed in the PC log\.$/);
  assert.ok(!/\/Users\//.test(t[0].summary));
  // the full command, repo folders included, is in the PC log
  assert.ok(out.some((l) => l.includes('herdr --machine macbook agent prompt rq-q1-macbook "cb iam rq-Q1@macbook rq --role qa') && l.includes('Repos: api /Users/me/Work/rq/api, web /Users/me/Work/rq/web')), out.join('\n'));
});

// ---------------- #4559 slice 3 (Q3018): disable winds the seats down, enable restores the holders
test('a disabled project: its idle holder is closed and keeps its card; enable restores it, even after a recent restore', async () => {
  const { sql, sup } = await setup();
  const B1 = 'sv-B1@macbook';
  await session(sql, B1, 'builder', { startedMin: 30 });
  const id = await card(sql, { assignee: B1, status: 'in_progress' });
  await sql`update cb.events set at = now() - interval '30 minutes' where actor = ${B1}`;
  // restored 5 minutes ago: without the enable, a seat down again now would be left for a person
  await sup`select cb.supervise_log('sv', 'restore', ${B1}, 'builder')`;
  await sql`update cb.events set at = now() - interval '5 minutes' where actor = 'supervisor' and data ->> 'what' = 'restore'`;
  const held = async () => (await sup`select cb.supervise_mark(${B1}, true) as ok`)[0].ok;
  assert.equal(await held(), false, 'an enabled project: a holder is never closed');

  await sql`select cb.project_state('sv', 'disabled', 'ahmed')`;
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  assert.deepEqual((await tick(deps(sup, h.run))).filter((l) => /clos/.test(l)), [], 'just disabled: it has 10 minutes');
  await sql`update cb.projects set state_at = now() - interval '11 minutes' where slug = 'sv'`;
  await sql`update cb.events set at = now() - interval '30 minutes' where actor = ${B1}`;
  const out = await tick(deps(sup, h.run));
  assert.ok(has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.ok(out.includes(`closed ${B1}`), out.join('\n'));
  assert.equal((await sql`select assignee from cb.tasks where id = ${id}`)[0].assignee, B1, 'the card stays its');
  assert.deepEqual((await events(sql, 'close')).map((e: any) => e.data.note), ['project disabled']);
  assert.ok(!h.calls.some((c) => c.args[0] === 'agent' && c.args[1] === 'start'), 'nothing starts in a disabled project');

  await sql`select cb.project_state('sv', 'enabled', 'ahmed')`;
  await sql`update cb.sessions set last_seen = now() - interval '10 minutes' where actor = ${B1}`;
  const back = fakeHerdr();
  const again = await tick(deps(sup, back.run));
  assert.ok(again.some((l) => l.endsWith(`restored ${B1}`)), again.join('\n'));
});

test('a project enabled again between the plan and the close keeps its holder', async () => {
  const { sql, sup } = await setup();
  const B1 = 'sv-B1@macbook';
  await session(sql, B1, 'builder', { startedMin: 30 });
  await card(sql, { assignee: B1, status: 'in_progress' });
  await sql`select cb.project_state('sv', 'disabled', 'ahmed')`;
  await sql`update cb.projects set state_at = now() - interval '11 minutes' where slug = 'sv'`;
  await sql`update cb.events set at = now() - interval '30 minutes' where actor = ${B1}`;
  const h = fakeHerdr();
  h.live.set('sv-b1-macbook', 'w1:p9');
  // Ahmed enables it right after the supervisor has marked the seat closing, before it sends /exit
  let marked = false;
  const gated = (text: TemplateStringsArray, ...values: any[]) => {
    const query = sup(text, ...values);
    if (marked || !text.join('?').includes('supervise_mark')) return query;
    marked = true;
    return query.then(async (rows: any) => { await sql`select cb.project_state('sv', 'enabled', 'ahmed')`; return rows; });
  };
  const out = await tick(deps(gated, h.run));
  assert.ok(marked, out.join('\n'));
  assert.ok(!has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), out.join('\n'));
  assert.ok(out.includes(`skip closing ${B1}: sv is enabled again`), out.join('\n'));
  assert.equal((await sql`select closing_at from cb.sessions where actor = ${B1}`)[0].closing_at, null, 'the mark is cleared');
});

test('a disabled project: two closes a tick, and a seat the board will not close takes no place from the others', async () => {
  const { sql, sup } = await setup();
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles, builder: { ...SQUAD.roles.builder, count: 4 } } })}, 'ahmed')`;
  const seats = [1, 2, 3, 4].map((n) => `sv-B${n}@macbook`);
  const h = fakeHerdr();
  for (const [i, s] of seats.entries()) { await session(sql, s, 'builder', { startedMin: 30 }); h.live.set(`sv-b${i + 1}-macbook`, `w1:p${i + 1}`); }
  await sql`select cb.ensure_project('other')`;
  await card(sql, { project: 'other', assignee: seats[0], status: 'in_progress' }); // a card of an enabled project
  await sql`update cb.events set at = now() - interval '30 minutes' where actor = any(${seats})`;
  await sql`select cb.project_state('sv', 'disabled', 'ahmed')`;
  await sql`update cb.projects set state_at = now() - interval '11 minutes' where slug = 'sv'`;
  const d = deps(sup, h.run);
  const closed = (out: string[]) => out.filter((l) => l.startsWith('closed '));
  const first = await tick(d);
  assert.deepEqual(closed(first), [`closed ${seats[1]}`, `closed ${seats[2]}`], first.join('\n'));
  assert.ok(first.includes(`skip closing ${seats[0]}: it holds work or has no session`), first.join('\n'));
  const second = await tick(d);
  assert.deepEqual(closed(second), [`closed ${seats[3]}`], second.join('\n'));
  assert.ok(!second.some((l) => l.includes(seats[0]!)), 'the refusal is not repeated every tick');
});

// ---------------- #4787: a seat stopped by its model's quota
const BANNER = 'Claude usage limit reached. Your limit will reset at 5pm.\n> \n? for shortcuts';
const paneReads = (calls: Call[]) => calls.filter((c) => c.args[0] === 'pane' && c.args[1] === 'read');
const screen = (text: string) => () => ({ status: 0, stdout: text, stderr: '' });
// the pane with this id shows the banner, every other one an empty prompt
const onPane = (id: string, text = BANNER) => (pane: string) => ({ status: 0, stdout: pane === id ? text : '> ', stderr: '' });
// a lead and one builder holding a card (so the planner closes nothing), both running in herdr
async function stopSetup() {
  const { sql, sup } = await setup();
  await session(sql, 'orch@macbook', 'lead');
  await session(sql, 'sv-B1@macbook', 'builder');
  await card(sql, { assignee: 'sv-B1@macbook', status: 'in_progress' });
  return { sql, sup };
}
const running = (h: ReturnType<typeof fakeHerdr>) => { h.live.set('orch-macbook', 'w1:p1'); h.live.set('sv-b1-macbook', 'w1:p9'); };

test("#4787: an idle seat showing its CLI's limit message tells the lead once per stop", async () => {
  const { sql, sup } = await stopSetup();
  const h = fakeHerdr({ read: onPane('w1:p9') });
  running(h);
  const d = deps(sup, h.run);
  const out = await tick(d);
  const read = paneReads(h.calls).find((c) => c.args[2] === 'w1:p9');
  assert.ok(read, out.join('\n'));
  assert.deepEqual([read.m, read.args.slice(3)], ['macbook', ['--source', 'recent-unwrapped', '--lines', '40', '--format', 'text']]);
  const told = await tells(sql);
  assert.equal(told.length, 1, out.join('\n'));
  assert.match(told[0].summary, /sv-B1@macbook looks stopped by its model's quota/);
  assert.match(told[0].summary, /herdr pane w1:p9 on macbook/);
  assert.match(told[0].summary, /holds 1 card/);
  assert.ok(!told[0].summary.includes('reset at 5pm'), 'no pane text on the board');
  assert.deepEqual((await events(sql, 'quota')).map((e: any) => [e.data.session, e.data.note, e.project]), [['sv-B1@macbook', 'herdr pane w1:p9', 'sv']]);
  assert.ok(out.some((l) => l.startsWith('sv-B1@macbook looks stopped by its quota')), out.join('\n'));
  assert.ok(!h.calls.some((c) => c.args[0] === 'pane' && c.args[1] === 'close') && !has(h.calls, 'agent', 'prompt', 'sv-b1-macbook', '/exit'), 'nothing is closed');

  await tick(d);
  await tick(deps(sup, h.run)); // a restarted supervisor: the board remembers it
  assert.equal((await tells(sql)).length, 1, 'said once');
  assert.equal((await events(sql, 'quota')).length, 1);

  // the seat did something on the board, then stopped again: a new stop
  await sql`insert into cb.events (actor, project, kind, summary) values ('sv-B1@macbook', 'sv', 'note', 'working again')`;
  await tick(d);
  assert.equal((await tells(sql)).length, 2);
  assert.equal((await events(sql, 'quota')).length, 2);
});

test('#4787: a working seat is not read; a rate limit, ordinary output and text far above the last lines are no stop', async () => {
  const { sql, sup } = await stopSetup();
  const working = fakeHerdr({ status: 'working', read: screen(BANNER) });
  running(working);
  await tick(deps(sup, working.run));
  assert.deepEqual(paneReads(working.calls), []);
  const far = `${BANNER.split('\n')[0]}\n\n${Array.from({ length: 30 }, (_, i) => `later line ${i}`).join('\n')}`;
  for (const text of ['API Error: 429 rate limit exceeded\n> ', 'all fine here\n> ', far, '']) {
    const h = fakeHerdr({ read: screen(text) });
    running(h);
    await tick(deps(sup, h.run));
    assert.ok(paneReads(h.calls).length > 0, 'an idle seat is read');
  }
  assert.equal((await tells(sql)).length, 0);
  assert.equal((await events(sql, 'quota')).length, 0);
});

test('#4787: a stopped lead is logged for the digest, not told', async () => {
  const { sql, sup } = await stopSetup();
  const h = fakeHerdr({ read: onPane('w1:p1') });
  running(h);
  await tick(deps(sup, h.run));
  assert.deepEqual((await events(sql, 'quota')).map((e: any) => e.data.session), ['orch@macbook']);
  assert.equal((await tells(sql)).length, 0);
});

test("#4787: another agent's seat is judged by its own adapter; the retry time and the seat's backups are named", async () => {
  const { sql, sup } = await stopSetup();
  const fallback = [{ agent: 'claude', model: 'haiku' }];
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, roles: { ...SQUAD.roles, builder: { ...SQUAD.roles.builder, fallback } } })}, 'ahmed')`;
  await sql`update cb.sessions set agent = 'codex' where actor = 'sv-B1@macbook'`;
  process.env.CB_MCP_GATE_OK = 'codex';
  try {
    const h = fakeHerdr({ read: onPane('w1:p9', 'You’ve hit your usage limit. Try again in 2 hours 5 minutes.\n> ') });
    running(h);
    await tick(deps(sup, h.run));
  } finally { delete process.env.CB_MCP_GATE_OK; }
  const [told] = await tells(sql);
  assert.match(told!.summary, /retry in about 125 min/);
  assert.match(told!.summary, /Backups named for the seat: haiku/);
});

test('#4787: a dry run reads panes, says what it would say and writes nothing', async () => {
  const { sql, sup } = await stopSetup();
  const h = fakeHerdr({ read: onPane('w1:p9') });
  running(h);
  const out = await tick(deps(sup, h.run, { dryRun: true }));
  assert.ok(out.includes('would say sv-B1@macbook looks stopped by its quota'), out.join('\n'));
  assert.equal((await tells(sql)).length, 0);
  assert.equal((await events(sql, 'quota')).length, 0);
});

// every project with a squad is checked, supervised or not
for (const [name, off] of [
  ['a squad with no stages and supervise off', async (sql: any) => { await sql`select cb.project_pipeline('sv', false, 'ahmed')`;
    await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, supervise: false })}, 'ahmed')`; }],
  ['a squad with supervise off', (sql: any) => sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, supervise: false })}, 'ahmed')`],
] as const) {
  test(`#4787: ${name} has its stopped seat told; nothing is started, restored or closed`, async () => {
    const { sql, sup } = await stopSetup();
    await off(sql);
    await card(sql); // waiting work: a supervised squad would start a builder for it
    await session(sql, 'sv-B2@macbook', 'builder', { live: false });
    await card(sql, { assignee: 'sv-B2@macbook', status: 'in_progress' }); // down and holding: it would restore it
    const h = fakeHerdr({ read: onPane('w1:p9') });
    running(h);
    const d = deps(sup, h.run);
    await tick(d);
    const out = await tick(d);
    assert.deepEqual((await events(sql, 'quota')).map((e: any) => e.data.session), ['sv-B1@macbook'], out.join('\n'));
    assert.equal((await tells(sql)).length, 1);
    assert.ok(h.calls.every((c) => (c.args[0] === 'agent' && c.args[1] === 'list') || (c.args[0] === 'pane' && c.args[1] === 'read')), JSON.stringify(h.calls));
    assert.equal((await sql`select count(*)::int as n from cb.events where actor = 'supervisor' and data ->> 'what' <> 'quota'`)[0].n, 0);
  });
}

test('#4787: a disabled project that the supervisor does not run is left alone', async () => {
  const { sql, sup } = await stopSetup();
  await sql`select cb.squad_set('sv', ${sql.json({ ...SQUAD, supervise: false })}, 'ahmed')`;
  await sql`select cb.project_state('sv', 'disabled', 'ahmed')`;
  const h = fakeHerdr({ read: onPane('w1:p9') });
  running(h);
  await tick(deps(sup, h.run));
  assert.deepEqual(h.calls, []);
  assert.equal((await events(sql, 'quota')).length, 0);
});

test('#4787: a pane that cannot be read is said once, until it reads again', async () => {
  const { sql, sup } = await stopSetup();
  let broken = true;
  const h = fakeHerdr({ read: () => (broken ? { status: 1, stdout: '', stderr: 'no such pane' } : { status: 0, stdout: '> ', stderr: '' }) });
  h.live.set('sv-b1-macbook', 'w1:p9');
  const d = deps(sup, h.run);
  const said = (out: string[]) => out.filter((l) => l.startsWith('cannot check sv-B1@macbook for a quota stop')).length;
  assert.equal(said(await tick(d)), 1);
  assert.equal(said(await tick(d)), 0);
  broken = false;
  await tick(d);
  broken = true;
  assert.equal(said(await tick(d)), 1);
});

test('#4806: the supervisor says which projects it acts on, at its first tick and when the list changes', async () => {
  const { sql, sup } = await setup(['sv', 'two']);
  await sql`select cb.project_pipeline('two', false, 'ahmed')`;
  const d = deps(sup, fakeHerdr().run);
  const named = async () => (await tick(d)).filter((l) => l.startsWith('acts on'));
  assert.deepEqual(await named(), ['acts on: sv, two']);
  assert.deepEqual(await named(), [], 'said once');
  await sql`select cb.project_state('two', 'disabled', 'ahmed')`;
  assert.deepEqual(await named(), ['acts on: sv, two (winding down)']);
  for (const p of ['sv', 'two']) await sql`select cb.squad_set(${p}, ${sql.json({ ...SQUAD, supervise: false })}, 'ahmed')`;
  assert.deepEqual(await named(), ['acts on: no project (no squad has supervise on)']);
});
