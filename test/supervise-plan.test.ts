import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pastSeatNames, planTick, type State, type Session, type TickInput } from '../cli/supervise-plan.ts';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const mach = (herdr: string | null) => ({ herdr, repo: '/r/sv', board: '/b' });
const squad = {
  machines: { shaltoot: mach(null), macbook: mach('macbook') },
  roles: {
    lead: { count: 1, model: 'opus', machine: 'shaltoot' },
    architect: { count: 1, model: 'opus', machine: 'macbook' },
    owner: { model: 'sonnet', machine: 'macbook' },
    builder: { count: 2, model: 'sonnet', machine: 'macbook' },
    reviewer: { count: 1, model: 'opus', machine: 'macbook' },
  },
  areas: ['claims', 'kb'], supervise: true,
};
const sess = (actor: string, role: string, o: Partial<Session> = {}): Session => ({ actor, role, area: null, machine: 'macbook', pane: 'p', live: true, repo: 'main',
  holds: 0, questions: 0, jobs: 0, asks: 0, last_event: ago(1), closing: false, last_restore: null, last_restore_failed: false, down_again_logged: false, down_again_since_bind: false, ...o });
const state = (o: { waiting?: Record<string, any>; sessions?: Session[]; supervised?: boolean } = {}): State => ({ project: 'sv', squad, supervised: o.supervised ?? true,
  waiting: { builder: { main: 0 }, reviewer: { main: 0 }, qa: 0, investigator: 0, architect: 0, owner: { claims: 0, kb: 0 }, ...o.waiting }, sessions: o.sessions ?? [] });
const tick = (st: State, o: Partial<TickInput> = {}) => planTick({ state: st, herdrLive: new Set(), herdrStatus: {}, herdrDown: new Set(), launched: new Set(), macLive: 0, startsLeft: 3, failedAt: new Map(), now: NOW, ...o });
const names = (l: { name: string }[]) => l.map((x) => x.name);

test('not supervised: empty plan', () => {
  assert.deepEqual(tick(state({ supervised: false, waiting: { builder: { main: 5 } } })), { restore: [], start: [], close: [], notes: [], leaving: [], restart: [], refused: [], settled: [] });
});

test('starts up to the count', () => {
  const p = tick(state({ waiting: { builder: { main: 5 } } }));
  assert.deepEqual(names(p.start), ['sv-B1@macbook', 'sv-B2@macbook']);
  assert.ok(p.start[0].prompt.endsWith('then cb next'));
  assert.equal(p.start[0].model, 'sonnet');
  assert.equal(p.start[0].settings, '/b/kit/permissions/builder.json');
});

test('idle sessions cancel waiting work; a closing one does not', () => {
  const idle = sess('sv-B1@macbook', 'builder');
  assert.equal(tick(state({ waiting: { builder: { main: 1 } }, sessions: [idle] })).start.length, 0);
  const p = tick(state({ waiting: { builder: { main: 1 } }, sessions: [{ ...idle, closing: true }] }));
  assert.deepEqual(names(p.start), ['sv-B2@macbook']);
});

test('a hand-started session counts and is never closed', () => {
  const foo = sess('foo@macbook', 'builder', { last_event: ago(30) });
  assert.equal(tick(state({ waiting: { builder: { main: 1 } }, sessions: [foo] })).start.length, 0);
  assert.deepEqual(tick(state({ sessions: [foo] })).close, []);
});

test('the Mac cap counts other projects', () => {
  assert.equal(tick(state({ waiting: { builder: { main: 5 } } }), { macLive: 7 }).start.length, 1);
});

test('3 starts per tick', () => {
  const p = tick(state({ waiting: { builder: { main: 5 }, reviewer: { main: 3 }, architect: 2 } }), { startsLeft: 3 });
  assert.equal(p.start.length, 3);
});

test('a name this run launched and the board does not see yet counts as started; any other herdr name does not', () => {
  const live = new Set(['sv-b1-macbook']); // in herdr, not live on the board
  const launched = new Set(['sv-B1@macbook']); // this supervisor started it last tick (still binding, or on a dialog)
  assert.equal(tick(state({ waiting: { builder: { main: 1 } } }), { herdrLive: live, launched }).start.length, 0);
  assert.deepEqual(names(tick(state({ waiting: { builder: { main: 2 } } }), { herdrLive: live, launched }).start), ['sv-B2@macbook']);
  const old = sess('sv-B1@macbook', 'builder', { live: false }); // an old board row, not live
  assert.equal(tick(state({ waiting: { builder: { main: 1 } }, sessions: [old] }), { herdrLive: live, launched }).start.length, 0);
  // not launched by this run: it cancels no waiting work, and the next number starts
  assert.deepEqual(names(tick(state({ waiting: { builder: { main: 1 } } }), { herdrLive: live }).start), ['sv-B2@macbook']);
});

test('a recently failed name is skipped, the next number is used', () => {
  const p = tick(state({ waiting: { builder: { main: 1 } } }), { failedAt: new Map([['sv-B1@macbook', NOW - 5 * 60_000]]) });
  assert.deepEqual(names(p.start), ['sv-B2@macbook']);
  assert.deepEqual(names(tick(state({ waiting: { builder: { main: 1 } } }), { failedAt: new Map([['sv-B1@macbook', NOW - 11 * 60_000]]) }).start), ['sv-B1@macbook']);
});

test('close rules', () => {
  const c = (s: Session, w = {}) => tick(state({ sessions: [s], waiting: w }), { herdrStatus: { 'sv-b1-macbook': 'idle' } }).close;
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21) })), ['sv-B1@macbook']);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(19) })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), holds: 1 })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), questions: 1 })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), jobs: 1 })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), asks: 1 })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21), closing: true })), []);
  assert.deepEqual(c(sess('sv-B1@macbook', 'builder', { last_event: ago(21) }), { builder: { main: 1 } }), []);
  assert.deepEqual(c(sess('orch@shaltoot', 'lead', { last_event: ago(90) })), []);
});

test('owners per area; architect only from waiting.architect', () => {
  const p = tick(state({ waiting: { owner: { claims: 0, kb: 2 }, architect: 0 } }));
  assert.deepEqual(names(p.start), ['sv-O-kb@macbook']);
  assert.equal(p.start[0].area, 'kb');
  assert.deepEqual(names(tick(state({ waiting: { architect: 1 } })).start), ['sv-A1@macbook']);
});

test('restore, down_again, herdr down, and no reuse of a holding name', () => {
  const down = sess('sv-B1@macbook', 'builder', { live: false, holds: 1 });
  const p = tick(state({ sessions: [down] }));
  assert.deepEqual(names(p.restore), ['sv-B1@macbook']);
  assert.ok(p.restore[0].prompt.endsWith('then cb resume'));
  const again = tick(state({ sessions: [{ ...down, last_restore: ago(10) }] }));
  assert.deepEqual([again.restore, again.notes], [[], [{ what: 'down_again', session: 'sv-B1@macbook' }]]);
  assert.deepEqual(tick(state({ sessions: [{ ...down, last_restore: ago(10), down_again_logged: true }] })).notes, []);
  assert.equal(tick(state({ sessions: [{ ...down, last_restore: ago(31) }] })).restore.length, 1);
  assert.deepEqual(tick(state({ sessions: [down] }), { herdrDown: new Set(['macbook']) }), { restore: [], start: [], close: [], notes: [], leaving: [], restart: [], refused: [], settled: [] });
  const quiet = sess('sv-B2@macbook', 'builder', { last_event: ago(21) });
  const idleB2 = { herdrStatus: { 'sv-b2-macbook': 'idle' } };
  assert.deepEqual(tick(state({ sessions: [quiet] }), { ...idleB2, herdrDown: new Set(['macbook']) }).close, []);
  assert.deepEqual(tick(state({ sessions: [quiet] }), idleB2).close, ['sv-B2@macbook']);
  assert.equal(tick(state({ sessions: [down] }), { herdrLive: new Set(['sv-b1-macbook']) }).restore.length, 0);
  assert.deepEqual(names(tick(state({ sessions: [down], waiting: { builder: { main: 2 } } })).start), ['sv-B2@macbook']);
});

test('a holding name is not reused for a start even when its restore is held back', () => {
  const down = sess('sv-B1@macbook', 'builder', { live: false, holds: 1, last_restore: ago(10), down_again_logged: true });
  assert.deepEqual(names(tick(state({ sessions: [down], waiting: { builder: { main: 2 } } })).start), ['sv-B2@macbook']);
});

test('restores use up startsLeft', () => {
  const down = sess('sv-R1@macbook', 'reviewer', { live: false, holds: 1 });
  const p = tick(state({ sessions: [down], waiting: { builder: { main: 5 } } }), { startsLeft: 2 });
  assert.equal(p.restore.length, 1);
  assert.equal(p.start.length, 1);
});

test('close only when herdr reports the agent ready for input (idle, or done: unfocused panes stay done)', () => {
  const quiet = state({ sessions: [sess('sv-B1@macbook', 'builder', { last_event: ago(21) })] });
  for (const st of ['idle', 'done']) assert.deepEqual(tick(quiet, { herdrStatus: { 'sv-b1-macbook': st } }).close, ['sv-B1@macbook'], st);
  for (const st of ['working', 'blocked', 'unknown']) assert.deepEqual(tick(quiet, { herdrStatus: { 'sv-b1-macbook': st } }).close, [], st);
  assert.deepEqual(tick(quiet).close, [], 'not in herdr: no close');
});

// #4002: the supervisor asks each session's agent adapter whether it may close, and hands the answers in per session
test('planTick respects precomputed safeToClose per session', () => {
  const quiet = state({ sessions: [sess('sv-B1@macbook', 'builder', { last_event: ago(21), agent: 'claude' }), sess('sv-B2@macbook', 'builder', { last_event: ago(21), agent: 'codex' })] });
  const idle = { 'sv-b1-macbook': 'idle', 'sv-b2-macbook': 'idle' };
  // the adapter's answer decides, not herdr's status: B2's agent has no adapter (false), B1's says yes
  assert.deepEqual(tick(quiet, { herdrStatus: idle, safeToClose: { 'sv-B1@macbook': true, 'sv-B2@macbook': false } }).close, ['sv-B1@macbook']);
  // an adapter may call a session safe that herdr shows working (one whose own status reader knows better)
  assert.deepEqual(tick(quiet, { herdrStatus: { 'sv-b1-macbook': 'working' }, safeToClose: { 'sv-B1@macbook': true } }).close, ['sv-B1@macbook']);
  // given, a session it does not name is never closed
  assert.deepEqual(tick(quiet, { herdrStatus: idle, safeToClose: {} }).close, []);
  // omitted: herdr's ready statuses, as before
  assert.deepEqual(tick(quiet, { herdrStatus: idle }).close, ['sv-B1@macbook', 'sv-B2@macbook']);
  // safe to close never overrides the rest of the close rules (held work, a closing mark, under 20 minutes)
  const busy = state({ sessions: [sess('sv-B1@macbook', 'builder', { last_event: ago(21), holds: 1 }), sess('sv-B2@macbook', 'builder', { last_event: ago(5) })] });
  assert.deepEqual(tick(busy, { herdrStatus: idle, safeToClose: { 'sv-B1@macbook': true, 'sv-B2@macbook': true } }).close, []);
});

test('a session with an open ask is not idle: it cancels no waiting work', () => {
  const asked = sess('sv-B1@macbook', 'builder', { asks: 1 });
  assert.deepEqual(names(tick(state({ waiting: { builder: { main: 1 } }, sessions: [asked] })).start), ['sv-B2@macbook']);
});

test('down again since it last bound: never restored again until it binds', () => {
  const down = sess('sv-B1@macbook', 'builder', { live: false, holds: 1, last_restore: ago(31), down_again_logged: true, down_again_since_bind: true });
  const p = tick(state({ sessions: [down] }));
  assert.deepEqual([p.restore, p.notes], [[], []]);
  assert.equal(tick(state({ sessions: [{ ...down, down_again_since_bind: false }] })).restore.length, 1);
});

test('a restore that did not start is tried again after 10 minutes and is never down again', () => {
  const down = sess('sv-B1@macbook', 'builder', { live: false, holds: 1, last_restore_failed: true });
  const soon = tick(state({ sessions: [{ ...down, last_restore: ago(5) }] }));
  assert.deepEqual([soon.restore, soon.notes], [[], []]);
  assert.deepEqual(names(tick(state({ sessions: [{ ...down, last_restore: ago(11) }] })).restore), ['sv-B1@macbook']);
  // this run's own memory of the failure holds it back too
  assert.equal(tick(state({ sessions: [{ ...down, last_restore: ago(11) }] }), { failedAt: new Map([['sv-B1@macbook', NOW - 5 * 60_000]]) }).restore.length, 0);
});

// several repos (#3703): builders and reviewers start, count and close per repo, each in its repo's folder
const ZED: any = {
  machines: { shaltoot: { herdr: null, board: '/b' }, macbook: { herdr: 'macbook', board: '/b' } },
  repos: { api: { home: true, paths: { shaltoot: '/q/api', macbook: '/m/api' } }, dashboard: { home: false, paths: { shaltoot: '/q/dash', macbook: '/m/dash' } } },
  areas: [{ name: 'api', repo: 'api' }, { name: 'dashboard', repo: 'dashboard' }],
  roles: { lead: { count: 1, model: 'opus', machine: 'shaltoot' }, owner: { model: 'opus', machine: 'shaltoot' },
           builder: { count: { api: 2, dashboard: 1 }, model: 'sonnet', machine: 'macbook' },
           reviewer: { count: { api: 1, dashboard: 1 }, model: 'opus', machine: 'macbook' } },
  supervise: true,
};
const zed = (builder: Record<string, number>, sessions: Session[] = []): State => ({ project: 'zed', squad: ZED, supervised: true, sessions,
  waiting: { builder, reviewer: { api: 0, dashboard: 0 }, qa: 0, investigator: 0, architect: 0, owner: { api: 0, dashboard: 0 } } });

test('starts per repo', () => {
  const p = tick(zed({ api: 0, dashboard: 2 }));
  assert.deepEqual(names(p.start), ['zed-dashboard-B1@macbook']); // the dashboard count is 1; never an api builder
  assert.equal(p.start[0].cwd, '/m/dash');
  assert.ok(p.start[0].prompt.includes('--repo dashboard'));
  // an idle api builder does not cancel dashboard work; an idle dashboard builder does
  const apiIdle = sess('zed-B1@macbook', 'builder', { repo: 'api' });
  assert.deepEqual(names(tick(zed({ api: 0, dashboard: 1 }, [apiIdle])).start), ['zed-dashboard-B1@macbook']);
  assert.deepEqual(names(tick(zed({ api: 1, dashboard: 0 }, [apiIdle])).start), []);
  assert.deepEqual(names(tick(zed({ api: 2, dashboard: 0 }, [apiIdle])).start), ['zed-B2@macbook']);
  // close rules apply per repo group: the api builder closes while dashboard work waits, never the dashboard one
  const quiet = (n: string, repo: string) => sess(n, 'builder', { repo, last_event: ago(21) });
  const ready = { herdrStatus: { 'zed-b1-macbook': 'idle', 'zed-dashboard-b1-macbook': 'idle' } };
  const both = [quiet('zed-B1@macbook', 'api'), quiet('zed-dashboard-B1@macbook', 'dashboard')];
  assert.deepEqual(tick(zed({ api: 0, dashboard: 1 }, both), ready).close, ['zed-B1@macbook']);
  assert.deepEqual(tick(zed({ api: 1, dashboard: 0 }, both), ready).close, ['zed-dashboard-B1@macbook']);
});

test('3 starts per tick and the Mac cap hold across repo groups', () => {
  const both = (o: Partial<TickInput>) => tick(zed({ api: 2, dashboard: 1 }), o).start;
  assert.deepEqual(names(both({ startsLeft: 3 })), ['zed-B1@macbook', 'zed-B2@macbook', 'zed-dashboard-B1@macbook']);
  assert.deepEqual(names(both({ startsLeft: 2 })), ['zed-B1@macbook', 'zed-B2@macbook']);
  assert.deepEqual(names(both({ startsLeft: 3, macLive: 6 })), ['zed-B1@macbook', 'zed-B2@macbook']);
  assert.deepEqual(names(both({ startsLeft: 3, macLive: 7 })), ['zed-B1@macbook']);
  // reviewers of both repos share the same budget
  const st = zed({ api: 2, dashboard: 1 }); st.waiting.reviewer = { api: 1, dashboard: 1 };
  assert.equal(tick(st, { startsLeft: 3 }).start.length, 3);
  assert.equal(tick(st, { startsLeft: 5 }).start.length, 5);
});

// #3770: the lead moved the reviewers from the PC to the Mac in the squad file; the PC seats are leaving. Leaving means a
// name an earlier saved version of the squad generated (pastSeats), never just a seat-like name
const old = { ...squad, machines: { ...squad.machines, oldbox: mach('oldbox') }, roles: { ...squad.roles, reviewer: { count: 3, model: 'opus', machine: 'shaltoot' }, builder: { count: 3, model: 'sonnet', machine: 'macbook' } } };
const older = { ...old, roles: { ...old.roles, reviewer: { count: 2, model: 'opus', machine: 'oldbox' } } };
const past = pastSeatNames('sv', [old, older]);
const ptick = (st: State, o: Partial<TickInput> = {}) => tick(st, { pastSeats: past, ...o });

test('seats the squad file no longer generates: counted nowhere, closed once idle whatever waits, listed while busy or down', () => {
  const moved = { ...squad, roles: { ...squad.roles, reviewer: { count: 2, model: 'opus', machine: 'macbook' } } };
  const st = (sessions: Session[]): State => ({ ...state({ sessions, waiting: { reviewer: { main: 2 } } }), squad: moved });
  const busy = sess('sv-R1@shaltoot', 'reviewer', { machine: 'shaltoot', holds: 1 });
  const quiet = sess('sv-R2@shaltoot', 'reviewer', { machine: 'shaltoot', last_event: ago(21) });
  const ready = { herdrStatus: { 'sv-r1-shaltoot': 'idle', 'sv-r2-shaltoot': 'idle', 'sv-r3-shaltoot': 'idle' } };
  const p = ptick(st([busy, quiet]), ready);
  assert.deepEqual(names(p.start), ['sv-R1@macbook', 'sv-R2@macbook']); // the old seats take none of the new machine's slots
  assert.deepEqual(p.close, ['sv-R2@shaltoot']); // idle and ready: closed though review work waits
  assert.deepEqual(p.leaving, [{ session: 'sv-R1@shaltoot', why: 'busy' }]); // holds a card: never closed, a visible step
  // no saved version generated them (pastSeats omitted): counted and kept, as before
  assert.deepEqual([tick(st([busy, quiet]), ready).close, tick(st([busy, quiet]), ready).leaving], [[], []]);
  // idle under 20 minutes, or herdr shows it working: not closed yet, and not listed (nothing for a person to do)
  assert.deepEqual([ptick(st([{ ...quiet, last_event: ago(5) }]), ready).close, ptick(st([quiet]), { herdrStatus: { 'sv-r2-shaltoot': 'working' } }).close], [[], []]);
  // at most 2 leaving closes a tick: the third idle one waits for the next tick, unlisted
  const three = ptick(st([quiet, { ...quiet, actor: 'sv-R1@shaltoot' }, { ...quiet, actor: 'sv-R3@shaltoot' }]), ready);
  assert.deepEqual([three.close.length, three.leaving], [2, []]);
  // down holding a card: never restored under its old name, listed; a dead row holding nothing: ignored
  const down = ptick(st([{ ...busy, live: false }, { ...quiet, live: false }]), ready);
  assert.deepEqual([down.restore, down.close, down.leaving], [[], [], [{ session: 'sv-R1@shaltoot', why: 'down' }]]);
  // its machine left the squad file too: its herdr is unknown, so it is listed, never closed
  const gone = ptick(st([{ ...quiet, actor: 'sv-R2@oldbox', machine: 'oldbox' }]), { herdrStatus: { 'sv-r2-oldbox': 'idle' } });
  assert.deepEqual([gone.close, gone.leaving], [[], [{ session: 'sv-R2@oldbox', why: 'machine' }]]);
  // a lowered count: B3 at count 2 (3 before) is leaving; it cancels no waiting build work and closes while it waits
  const b3 = sess('sv-B3@macbook', 'builder', { last_event: ago(21) });
  const low = ptick(state({ sessions: [b3], waiting: { builder: { main: 1 } } }), { herdrStatus: { 'sv-b3-macbook': 'idle' } });
  assert.deepEqual([names(low.start), low.close], [['sv-B1@macbook'], ['sv-B3@macbook']]);
});

test('hand-started seats no saved squad generated, and the lead, are never leaving', () => {
  // sv-B5: beyond any count the squad ever had; sv-hotfix-B1: a word where no repo is; foo: no squad shape at all
  const hand = ['sv-B5@macbook', 'sv-hotfix-B1@macbook', 'foo@macbook'].map((n) => sess(n, 'builder', { last_event: ago(30) }));
  const status = { herdrStatus: { 'sv-b5-macbook': 'idle', 'sv-hotfix-b1-macbook': 'idle', 'foo-macbook': 'idle', 'orch-shaltoot': 'idle' } };
  const idle = ptick(state({ sessions: [...hand, sess('orch@shaltoot', 'lead', { last_event: ago(90) })] }), status);
  assert.deepEqual([idle.close, idle.leaving], [[], []]);
  // they still count toward the builders' slots: two waiting cards start nobody past the count of 2
  assert.deepEqual(names(ptick(state({ sessions: hand.slice(0, 2), waiting: { builder: { main: 2 } } }), status).start), []);
});

test('a squad with no seats besides the lead (a bad save) closes nothing: every leaving seat is listed', () => {
  const leadOnly = { ...squad, roles: { lead: squad.roles.lead } };
  const seats = ['sv-B1@macbook', 'sv-B2@macbook', 'sv-R1@shaltoot'].map((n) => sess(n, n.includes('-R') ? 'reviewer' : 'builder', { last_event: ago(30) }));
  const status = { herdrStatus: { 'sv-b1-macbook': 'idle', 'sv-b2-macbook': 'idle', 'sv-r1-shaltoot': 'idle' } };
  for (const sq of [leadOnly, { ...squad, roles: {} }]) {
    const p = ptick({ ...state({ sessions: seats }), squad: sq }, status);
    assert.deepEqual([p.close, p.leaving.map((l) => l.why)], [[], ['empty', 'empty', 'empty']]);
  }
});

test('pastSeatNames: every non-lead name the saved versions generated; one it cannot read is skipped', () => {
  const n = pastSeatNames('sv', [{}, old]);
  assert.ok(n.has('sv-R3@shaltoot') && n.has('sv-B3@macbook') && n.has('sv-O-kb@macbook') && n.has('sv-A1@macbook'));
  assert.ok(!n.has('orch@shaltoot') && !n.has('sv-B4@macbook'));
});

// #4332 (Q2970): the squad changed a seat's model or agent; the supervisor restarts the idle seats still on the old one
const restarts = (p: { restart: { launch: { name: string } }[] }) => p.restart.map((r) => r.launch.name);
const readyAll = { herdrStatus: { 'sv-b1-macbook': 'idle', 'sv-b2-macbook': 'idle', 'sv-r1-macbook': 'idle', 'orch-shaltoot': 'idle', 'foo-macbook': 'idle', 'sv-b3-macbook': 'idle' } };

test('a seat on an old model restarts on the new one once idle 5 minutes; busy or not ready, it waits', () => {
  const old = sess('sv-B1@macbook', 'builder', { model: 'opus', last_event: ago(6) }); // builders run sonnet now
  const p = tick(state({ sessions: [old] }), readyAll);
  assert.deepEqual([restarts(p), p.close, p.refused], [['sv-B1@macbook'], [], []]);
  assert.deepEqual([p.restart[0]!.from, p.restart[0]!.to, p.restart[0]!.launch.model], ['opus', 'sonnet', 'sonnet']);
  assert.ok(p.restart[0]!.launch.prompt.includes('--model sonnet') && p.restart[0]!.launch.prompt.endsWith('then cb next'));
  const none = (o: Partial<Session>, t: Partial<TickInput> = readyAll) => assert.deepEqual(restarts(tick(state({ sessions: [{ ...old, ...o }] }), t)), [], JSON.stringify(o));
  none({ last_event: ago(4) }); // under the 5-minute grace
  for (const k of ['holds', 'questions', 'jobs', 'asks'] as const) none({ [k]: 1 }); // holds work: waits until idle
  none({ closing: true });
  none({ live: false });
  none({}, { herdrStatus: { 'sv-b1-macbook': 'working' } }); // mid-turn
  none({}, { ...readyAll, herdrDown: new Set(['macbook']) });
  none({}, { ...readyAll, launched: new Set(['sv-B1@macbook']) });
  none({ model: 'claude-sonnet-4-6' }); // a full model id that names the seat's model: on the right one
  none({ model: 'SONNET' });
  none({ model: null }); // no model known: not judged
  // already restarted (or refused) for this setting in this run: never again; for an older setting: yes
  none({}, { ...readyAll, restartTried: new Map([['sv-B1@macbook', 'sonnet']]) });
  assert.deepEqual(restarts(tick(state({ sessions: [old] }), { ...readyAll, restartTried: new Map([['sv-B1@macbook', 'haiku']]) })), ['sv-B1@macbook']);
  // seen on its seat's setting again (bound anew on sonnet): settled, so the supervisor forgets it and a later change
  // back to a setting it was restarted for is acted on; still on the old one, or never tried: not settled
  const tried = { ...readyAll, restartTried: new Map([['sv-B1@macbook', 'sonnet']]) };
  assert.deepEqual(tick(state({ sessions: [{ ...old, model: 'sonnet' }] }), tried).settled, ['sv-B1@macbook']);
  assert.deepEqual(tick(state({ sessions: [old] }), tried).settled, []);
  assert.deepEqual(tick(state({ sessions: [{ ...old, model: 'sonnet' }] }), readyAll).settled, []);
  // idle 20 minutes with no waiting work: the idle close wins (its next start runs the new model); with work waiting it restarts
  const quiet = { ...old, last_event: ago(21) };
  const closed = tick(state({ sessions: [quiet] }), readyAll);
  assert.deepEqual([closed.close, restarts(closed)], [['sv-B1@macbook'], []]);
  assert.deepEqual(restarts(tick(state({ sessions: [quiet], waiting: { builder: { main: 1 } } }), readyAll)), ['sv-B1@macbook']);
  assert.deepEqual(restarts(tick(state({ supervised: false, sessions: [old] }), readyAll)), []);
});

test('an agent change restarts too; a setting this machine cannot start is refused, said once, and makes no loop', () => {
  const codexB1 = { ...squad, roles: { ...squad.roles, builder: { ...squad.roles.builder, seats: { '1': { agent: 'codex' as const, model: 'gpt-6.1-sol' } } } } };
  const st = (o: Partial<Session> = {}): State => ({ ...state({ sessions: [sess('sv-B1@macbook', 'builder', { model: 'sonnet', agent: 'claude', last_event: ago(6), ...o })] }), squad: codexB1 });
  const p = tick(st(), readyAll);
  assert.deepEqual([restarts(p), p.restart[0]?.from, p.restart[0]?.to, p.restart[0]?.launch.agent], [['sv-B1@macbook'], 'sonnet', 'codex/gpt-6.1-sol', 'codex']);
  // a session row with no agent named runs claude: the same restart
  assert.deepEqual(restarts(tick(st({ agent: null, model: null }), readyAll)), ['sv-B1@macbook']);
  const notInstalled = (l: { agent: string }) => (l.agent === 'codex' ? 'agent "codex" is not installed yet' : null);
  const r = tick(st(), { ...readyAll, startProblem: notInstalled });
  assert.deepEqual([restarts(r), r.refused], [[], [{ session: 'sv-B1@macbook', to: 'codex/gpt-6.1-sol', why: 'agent "codex" is not installed yet' }]]);
  // said at once even while busy (nothing is closed either way)
  assert.equal(tick(st({ holds: 1 }), { ...readyAll, startProblem: notInstalled }).refused.length, 1);
  // once refused (restartTried), nothing more: no restart, no second refusal
  const again = tick(st(), { ...readyAll, startProblem: notInstalled, restartTried: new Map([['sv-B1@macbook', 'codex/gpt-6.1-sol']]) });
  assert.deepEqual([restarts(again), again.refused], [[], []]);
  // the right agent and model: nothing
  assert.deepEqual(restarts(tick(st({ agent: 'codex', model: 'gpt-6.1-sol' }), readyAll)), []);
});

test('restarts: 2 a tick from the shared start budget, after starts; never the lead, a hand-started seat or a leaving one', () => {
  const onHaiku = (n: string, role = 'builder') => sess(n, role, { model: 'haiku', last_event: ago(6) });
  const three = [onHaiku('sv-B1@macbook'), onHaiku('sv-B2@macbook'), onHaiku('sv-R1@macbook', 'reviewer')];
  assert.deepEqual(restarts(tick(state({ sessions: three }), readyAll)), ['sv-B1@macbook', 'sv-B2@macbook']);
  assert.deepEqual(restarts(tick(state({ sessions: three }), { ...readyAll, startsLeft: 1 })), ['sv-B1@macbook']);
  assert.deepEqual(restarts(tick(state({ sessions: three }), { ...readyAll, startsLeft: 0 })), []);
  // waiting work starts first: the one start left goes to the architect
  const first = tick(state({ sessions: three, waiting: { architect: 1 } }), { ...readyAll, startsLeft: 1 });
  assert.deepEqual([names(first.start), restarts(first)], [['sv-A1@macbook'], []]);
  // the Mac at its cap: a restart frees its own slot, so it still goes ahead
  assert.deepEqual(restarts(tick(state({ sessions: [three[0]!] }), { ...readyAll, macLive: 8 })), ['sv-B1@macbook']);
  // the lead on the wrong model, idle and holding nothing; a hand-started builder; a seat the squad dropped (B3 at count 2)
  const lead = sess('orch@shaltoot', 'lead', { machine: 'shaltoot', model: 'sonnet', last_event: ago(90) });
  const p = tick(state({ sessions: [lead, onHaiku('foo@macbook'), onHaiku('sv-B3@macbook')] }), { ...readyAll, pastSeats: past });
  assert.deepEqual([restarts(p), p.refused], [[], []]);
});

// #4593 review 100 F1: a card kept for an agent (for: label) counts only for seats of that agent. A seat of another agent
// neither cancels it nor is kept open for it; the planner starts a seat of the agent named.
const mixed = { ...squad, roles: { ...squad.roles, builder: { count: 2, model: 'sonnet', machine: 'macbook', seats: { '2': { agent: 'codex', model: 'gpt-5.1-codex' } } } } };
const mixedState = (o: { waiting?: Record<string, any>; kept?: Record<string, any>; sessions?: Session[] }) =>
  ({ ...state({ waiting: o.waiting, sessions: o.sessions }), squad: mixed as any, kept: { builder: {}, reviewer: {}, qa: {}, investigator: {}, architect: {}, owner: {}, ...o.kept } });

test('F1: an idle Claude builder does not cancel a card kept for Codex: the Codex seat is started', () => {
  const b1 = sess('sv-B1@macbook', 'builder', { agent: 'claude' });
  const p = tick(mixedState({ waiting: { builder: { main: 1 } }, kept: { builder: { main: { codex: 1 } } }, sessions: [b1] }));
  assert.deepEqual(names(p.start), ['sv-B2@macbook']);
  assert.equal(p.start[0].agent, 'codex');
});

test('F1: with both builders down, only the seat of the agent named is started for a kept card', () => {
  const p = tick(mixedState({ waiting: { builder: { main: 1 } }, kept: { builder: { main: { codex: 1 } } } }));
  assert.deepEqual(names(p.start), ['sv-B2@macbook']);
  const any = tick(mixedState({ waiting: { builder: { main: 2 } }, kept: { builder: { main: { codex: 1 } } } }));
  assert.deepEqual(names(any.start).sort(), ['sv-B1@macbook', 'sv-B2@macbook'], 'one kept, one for anyone: both');
});

test('F1: a quiet Claude builder is closed though a card kept for Codex waits; the Codex seat stays for it', () => {
  const b1 = sess('sv-B1@macbook', 'builder', { agent: 'claude', last_event: ago(30) });
  const b2 = sess('sv-B2@macbook', 'builder', { agent: 'codex', last_event: ago(30) });
  const p = tick(mixedState({ waiting: { builder: { main: 1 } }, kept: { builder: { main: { codex: 1 } } }, sessions: [b1, b2] }),
    { safeToClose: { 'sv-B1@macbook': true, 'sv-B2@macbook': true } });
  assert.deepEqual(p.close, ['sv-B1@macbook']);
  assert.deepEqual(p.start, []);
});

test('F1: a card kept for several agents is cancelled by an idle seat of any of them', () => {
  const b2 = sess('sv-B2@macbook', 'builder', { agent: 'codex' });
  assert.deepEqual(tick(mixedState({ waiting: { builder: { main: 1 } }, kept: { builder: { main: { 'agy,codex': 1 } } }, sessions: [b2] })).start, []);
});

// ---------------- #4559 slice 3 (Q3018): a project that gets no work winds its seats down
const winding = (sessions: Session[], o: Partial<State> = {}): State => ({ ...state({ supervised: false, sessions, waiting: { builder: { main: 5 } } }), winding_down: true, state_at: ago(60), ...o });
const ready = (...n: string[]) => ({ herdrStatus: Object.fromEntries(n.map((x) => [x.replace('@', '-').toLowerCase(), 'idle'])) });
const B1 = 'sv-B1@macbook', B2 = 'sv-B2@macbook', R1 = 'sv-R1@macbook';

test('winding down: a squad seat idle 10 minutes is closed, one holding a card too; nothing is started or restored', () => {
  const p = tick(winding([sess(B1, 'builder', { holds: 2, questions: 1, jobs: 1, asks: 1, last_event: ago(11) }),
    sess(B2, 'builder', { live: false, holds: 1, last_event: ago(90) })]), ready(B1, B2));
  assert.deepEqual(p.close, [B1]);
  assert.deepEqual([p.start, p.restore, p.restart, p.notes, p.leaving], [[], [], [], [], []]);
});

test('winding down: a working seat, a busy herdr, a running job, a close under way or a down machine waits', () => {
  const quiet = (o: Partial<Session> = {}) => winding([sess(B1, 'builder', { holds: 1, last_event: ago(30), ...o })]);
  assert.deepEqual(tick(quiet(), ready(B1)).close, [B1], 'the control');
  assert.deepEqual(tick(quiet({ last_event: ago(9) }), ready(B1)).close, [], 'quiet 9 minutes');
  assert.deepEqual(tick(quiet(), { herdrStatus: { 'sv-b1-macbook': 'working' } }).close, [], 'herdr says working');
  assert.deepEqual(tick(quiet(), { ...ready(B1), safeToClose: { [B1]: false } }).close, [], 'its adapter says no');
  assert.deepEqual(tick(quiet({ jobs_running: 1 }), ready(B1)).close, [], 'a job of its own is running');
  assert.deepEqual(tick(quiet({ closing: true }), ready(B1)).close, []);
  assert.deepEqual(tick(quiet({ bound: 'other' }), ready(B1)).close, [], 'moved to another project');
  assert.deepEqual(tick(quiet({ bound: 'sv' }), ready(B1)).close, [B1]);
  assert.deepEqual(tick(quiet(), { ...ready(B1), herdrDown: new Set(['macbook']) }).close, []);
});

test('winding down: the 10 minutes count from the disable at the earliest, so every seat has them to reach a safe point', () => {
  const st = (since: number) => winding([sess(B1, 'builder', { holds: 1, last_event: ago(300) })], { state_at: ago(since) });
  assert.deepEqual(tick(st(9), ready(B1)).close, []);
  assert.deepEqual(tick(st(10), ready(B1)).close, [B1]);
});

test('winding down: never the lead or a hand-started session; a seat an earlier squad named is closed too', () => {
  const old = (actor: string, role: string) => sess(actor, role, { last_event: ago(30) });
  const all = [old('sv-orch@shaltoot', 'lead'), old('foo@macbook', 'builder'), old('sv-B7@macbook', 'builder'), old(B1, 'builder'), old(B2, 'builder'), old(R1, 'reviewer')];
  const p = tick(winding(all), { ...ready(...all.map((s) => s.actor)), pastSeats: new Set(['sv-B7@macbook']) });
  // every one that qualifies is planned: the supervisor stops after two closes a tick
  assert.deepEqual([...p.close].sort(), [B1, B2, 'sv-B7@macbook', R1].sort());
});

test('#4806: with no stages a configured seat stays open when idle; restores, leaving closes and restarts go on', () => {
  const plain = (sessions: Session[]): State => ({ ...state({ sessions }), pipeline: false });
  const status = { 'sv-b1-macbook': 'idle', 'sv-b9-macbook': 'idle' };
  const idle = sess('sv-B1@macbook', 'builder', { last_event: ago(120), model: 'sonnet' });
  const dropped = sess('sv-B9@macbook', 'builder', { last_event: ago(120) });
  const p = tick(plain([idle, dropped]), { herdrStatus: status, pastSeats: new Set(['sv-B9@macbook']) });
  assert.deepEqual([p.close, p.start], [['sv-B9@macbook'], []], 'only the seat the squad no longer names');
  // the same seats in a pipeline: both close
  assert.deepEqual(tick(state({ sessions: [idle, dropped] }), { herdrStatus: status, pastSeats: new Set(['sv-B9@macbook']) }).close.sort(), ['sv-B1@macbook', 'sv-B9@macbook']);
  const down = tick(plain([sess('sv-B2@macbook', 'builder', { live: false, holds: 1 })]));
  assert.deepEqual(names(down.restore), ['sv-B2@macbook']);
  const old = tick(plain([{ ...idle, model: 'haiku' }]), { herdrStatus: status });
  assert.deepEqual(old.restart.map((r) => r.launch.name), ['sv-B1@macbook']);
});
