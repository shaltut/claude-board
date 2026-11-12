# Multi-user sessions, phase 2: identity foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the board a checked identity chain (person → device → session) in the database, with nothing using it yet, so existing sessions behave exactly as today.

**Architecture:** Additive schema only: one new table (`cb.devices`), new nullable columns on `cb.users`, `cb.sessions` and `cb.events`, and five new `cb.*` functions. No HTTP route, no CLI command and no UI calls them in this phase; later phases (session API, authority rules, browser) build on the interfaces fixed here.

**Tech Stack:** Postgres 16 (plpgsql, pgcrypto in schema `public`), `node --test` against a real test database, TypeScript run directly by Node 24.

**Spec:** `docs/superpowers/specs/2026-11-12-multi-user-sessions-design.md` (sections 4.2, 4.6, 5, 7). Read it and the repo's `CLAUDE.md` before starting.

## Global Constraints

- **Run on Ahmed's PC or Mac, never on the VPS.** Tests need Postgres on `127.0.0.1:5434` and only `claude_board_test*` databases. On the PC follow `CLAUDE.md` "Tests" (memory check, `NODE_OPTIONS=--max-old-space-size=4096`, a timeout, `cb lock take db2`).
- Work on branch `multi-user-sessions` in a worktree. Never the live checkout, never `main`.
- No merge, deploy or restart: this plan ends at a green suite on the branch. Releasing is Ahmed's go.
- The schema stays idempotent: `create table if not exists`, `alter table ... add column if not exists`; every new function gets a `drop function if exists cb.<name> cascade;` line in the users drop block (`db/schema.sql` ~723-733).
- Every function body starts with `#variable_conflict use_variable` and qualifies table columns, like its neighbours.
- pgcrypto calls are written `public.digest`, `public.gen_random_bytes`.
- None of the new functions is added to `RPC_FUNCTIONS` in `server/rpc.ts`.
- A device token is returned once by `cb.device_add` and exists nowhere else: not in a table, an event, a notice or an error message. Only its SHA-256 hex is stored.
- Names containing `ahmed` stay reserved (`cb.ahmed_like`).
- Error messages say what to do next.
- Test command for this plan's file: `CB_TEST_DB=claude_board_test node --test --test-concurrency=1 test/devices.test.ts`

## Review Focus

1. A device label equal to one of Ahmed's machine names (`macbook`, `shaltoot`) would let a teammate's session be named `W1@macbook`: refused (Task 3).
2. A token for a revoked device, a removed person, or a person whose switch was turned off must stop authenticating at once (Tasks 3, 4).
3. The token leaking into History: no `cb.events` row may contain it (Task 3).
4. Re-running the schema on a database that already has devices and old sessions must change nothing (Task 5).
5. A person taken off a project: the next `device_auth` no longer lists it (Task 4).

## File Structure

| File | Change |
|---|---|
| `docs/guardrails.md` | Create: the tracked guardrail register |
| `db/schema.sql` | Modify: columns after the `cb.users` / `cb.sessions` / `cb.events` definitions; `cb.devices` and the five functions in the users section (after `cb.user_password`, ~1741); drop lines ~723-733; `cb.user_set_role` |
| `test/devices.test.ts` | Create: every test in this plan |
| `docs/users.md`, `docs/ops/README.md` | Modify: one short paragraph each (Task 5) |

---

### Task 1: The guardrail register

**Files:**
- Create: `docs/guardrails.md`

- [ ] **Step 1:** Create `docs/guardrails.md`: a two-line intro ("Every rule the board enforces and where. A change that touches one updates its row in the same commit."), then the table from spec section 7 copied verbatim with one added last column `State`, every row `planned`, and the spec's "Known weaknesses" paragraph under it.
- [ ] **Step 2:** Add a row to the "Where things are" table in `CLAUDE.md`: `` `docs/guardrails.md` | every guardrail and its state: update the row when you touch one ``.
- [ ] **Step 3:** Commit: `git commit -m "Guardrail register: every rule and what multi-user does to it"`.

---

### Task 2: The "can connect sessions" switch

**Files:**
- Modify: `db/schema.sql`
- Test: `test/devices.test.ts` (create; copy the header of `test/people.test.ts` lines 1-10 without the server imports: only `freshDb`, `onProject`, a `db()` helper and `after` closing clients)

**Interfaces:**
- Produces: column `cb.users.sessions_on boolean not null default false`; `cb.user_sessions(name text, allow boolean, actor text default null) returns void`.

- [ ] **Step 1: Write the failing tests**

```ts
const asSession = (sql: any) => sql.begin(async (tx: any) => { await tx`set local application_name = 'psql'`; return tx`select cb.user_sessions('omar', true, 'W1@pc')`; });

test('sessions switch: off by default, only the dashboard turns it on, and History says what it means', async () => {
  const sql = await db();
  await sql`select cb.user_add('omar', 'Omar')`;
  assert.equal((await sql`select sessions_on from cb.users where name = 'omar'`)[0].sessions_on, false);
  await assert.rejects(asSession(sql), /only Ahmed can do this, on the Users page/);
  await sql`select cb.user_sessions('omar', true, 'ahmed')`;
  assert.equal((await sql`select sessions_on from cb.users where name = 'omar'`)[0].sessions_on, true);
  const [e] = await sql`select actor, summary, data from cb.events where kind = 'user' order by id desc limit 1`;
  assert.equal(e.actor, 'ahmed');
  assert.equal(e.summary, 'Omar (omar) may now connect sessions: work on their projects will reach their machine');
  assert.deepEqual(e.data, { user: 'omar', action: 'sessions_on' });
  await sql`select cb.user_sessions('omar', true, 'ahmed')`; // again: no second line
  assert.equal((await sql`select count(*)::int as n from cb.events where data ->> 'action' = 'sessions_on'`)[0].n, 1);
  await assert.rejects(sql`select cb.user_sessions('nobody', true, 'ahmed')`, /unknown user nobody: see cb users/);
});
```

- [ ] **Step 2:** Run the test command. Expected: FAIL, `column "sessions_on" does not exist`.
- [ ] **Step 3:** In `db/schema.sql`: add `alter table cb.users add column if not exists sessions_on boolean not null default false;` under the role column (~line 38) with a comment citing spec 4.6 (this switch is Ahmed's recorded OK for client work reaching that person's machine); add the drop line; implement `cb.user_sessions` after `cb.user_password`: `perform cb.dashboard_only('Users')`, then `cb.set_actor`, unknown-user error as in `cb.user_password`, no-op when unchanged, one `user` event. Off-summary: `'<Display> (<name>) may no longer connect sessions'`, action `sessions_off`.
- [ ] **Step 4:** Run the test command. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Users: the 'can connect sessions' switch (off by default, dashboard only)"`.

---

### Task 3: Devices: create and authenticate

**Files:**
- Modify: `db/schema.sql`
- Test: `test/devices.test.ts`

**Interfaces:**
- Consumes: `cb.users.sessions_on`, `cb.user_sessions` (Task 2).
- Produces:
  - table `cb.devices (id bigint generated always as identity primary key, user_name text not null references cb.users(name) on update cascade on delete cascade, label text not null unique, token_hash text not null unique, created_at timestamptz not null default now(), last_seen timestamptz, revoked_at timestamptz)`
  - `cb.device_add(name text, label text, actor text default null) returns text`: the token, `'cbd_'` + 64 hex characters (`public.gen_random_bytes(32)`).
  - `cb.device_auth(token text) returns jsonb`: `{"device": <id>, "user": "<name>", "label": "<label>", "role": "<role>", "projects": ["a","b"]}` (projects sorted), or SQL `null`.

- [ ] **Step 1: Write the failing tests**

```ts
async function omar(sql: any) {
  await sql`select cb.user_add('omar', 'Omar')`;
  await onProject(sql, 'omar', 'ihop');
  await sql`select cb.user_sessions('omar', true, 'ahmed')`;
}
const add = async (sql: any, label: string, name = 'omar') => (await sql`select cb.device_add(${name}, ${label}, 'ahmed') as t`)[0].t as string;
const auth = async (sql: any, t: string | null) => (await sql`select cb.device_auth(${t}) as r`)[0].r;

test('device: the token is shown once, stored only as a hash, and never reaches History', async () => {
  const sql = await db(); await omar(sql);
  const t = await add(sql, 'omar-laptop');
  assert.match(t, /^cbd_[0-9a-f]{64}$/);
  const [d] = await sql`select * from cb.devices`;
  assert.equal(d.token_hash, (await sql`select encode(public.digest(${t}, 'sha256'), 'hex') as h`)[0].h);
  assert.doesNotMatch(JSON.stringify(await sql`select * from cb.devices`), new RegExp(t));
  assert.doesNotMatch(JSON.stringify(await sql`select * from cb.events`), new RegExp(t));
  const [e] = await sql`select summary, data from cb.events where kind = 'user' order by id desc limit 1`;
  assert.equal(e.summary, 'device omar-laptop added for Omar (omar)');
  assert.deepEqual(e.data, { user: 'omar', action: 'device_add', device: Number(d.id), label: 'omar-laptop' });
});

test('device: authenticates to its person and their projects, and to nothing else', async () => {
  const sql = await db(); await omar(sql);
  const t = await add(sql, 'omar-laptop');
  const [d] = await sql`select id from cb.devices`;
  assert.deepEqual(await auth(sql, t), { device: Number(d.id), user: 'omar', label: 'omar-laptop', role: 'member', projects: ['ihop'] });
  for (const bad of [null, '', 'cbd_' + '0'.repeat(64), t.slice(0, -1), t.toUpperCase()]) assert.equal(await auth(sql, bad), null, String(bad));
  assert.ok((await sql`select last_seen from cb.devices`)[0].last_seen, 'a successful auth records last_seen');
});

test('device: who may have one, and what it may be called', async () => {
  const sql = await db(); await omar(sql);
  await sql`select cb.user_add('iman', 'Iman')`;
  await assert.rejects(add(sql, 'iman-pc', 'iman'), /iman can't connect sessions yet: turn it on for them on the Users page/);
  await assert.rejects(add(sql, 'x', 'nobody'), /unknown user nobody: see cb users/);
  for (const bad of ['', 'A', 'Omar Laptop', '9lives', 'a', 'x'.repeat(32), 'ahmed-pc', 'has_underscore', 'orch'])
    await assert.rejects(add(sql, bad), /device name: 2 to 31 lowercase letters, digits or -, starting with a letter|reserved/, bad);
  // a machine one of Ahmed's own sessions already uses can't be a teammate's device: W1@macbook must stay his
  await sql`select cb.ensure_project('ihop'), cb.iam('MacBook', 'p1', 'W1@macbook', 'ihop')`;
  await assert.rejects(add(sql, 'macbook'), /macbook is already a machine on the board: pick another device name/);
  await add(sql, 'omar-laptop');
  await assert.rejects(add(sql, 'omar-laptop'), /omar-laptop is taken: pick another device name/);
  await sql`select cb.user_sessions('iman', true, 'ahmed')`;
  await assert.rejects(add(sql, 'omar-laptop', 'iman'), /omar-laptop is taken/, 'labels are unique across people');
  const notDash = sql.begin(async (tx: any) => { await tx`set local application_name = 'psql'`; return tx`select cb.device_add('omar', 'second', 'W1@pc')`; });
  await assert.rejects(notDash, /only Ahmed can do this, on the Users page/);
  for (let i = 0; i < 9; i++) await add(sql, `omar-d${i}`);
  await assert.rejects(add(sql, 'omar-eleventh'), /omar has 10 devices: revoke one first/);
});
```

- [ ] **Step 2:** Run the test command. Expected: FAIL, `function cb.device_add(...) does not exist`.
- [ ] **Step 3:** Implement in `db/schema.sql`, users section. Table as in Interfaces, with `devices_notify` statement trigger on `cb.notify()` like `users_notify`. `cb.device_add`: `dashboard_only('Users')`, `set_actor`; label is `lower(trim(label))`, must match `^[a-z][a-z0-9-]{1,30}$`; reserved when `cb.ahmed_like(label)` or label in (`orch`, `relay`, `board`, `github`, `unknown`, `vps`): message `'<label> is reserved: pick another device name'`; refused when `exists (select 1 from cb.sessions s where s.machine = label and s.user_name is null)` (this needs Task 5's column: add `alter table cb.sessions add column if not exists user_name ...` now, see Task 5 Interfaces, and leave its tests to Task 5); the 10-device cap counts rows with `revoked_at is null`; a revoked device keeps its label (the unique constraint stays total, so an old History line never points at a new machine). `cb.device_auth`: `volatile`, no dashboard check, no actor, no event; joins device → user, returns null unless `revoked_at is null and sessions_on`; updates `last_seen` only when it is null or older than one minute.
- [ ] **Step 4:** Run the test command. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Devices: a person's machine gets a one-time token, stored as a hash"`.

---

### Task 4: Devices: list, revoke, and the ways access ends

**Files:**
- Modify: `db/schema.sql` (new functions; `cb.user_sessions`; `cb.user_set_role`)
- Test: `test/devices.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  - `cb.device_revoke(id bigint, actor text default null) returns void`
  - `cb.devices_list(name text default null) returns jsonb`: array of `{"id", "user", "label", "created_at", "last_seen", "revoked_at"}`, live first, then by id; never `token_hash`.
  - internal `cb._devices_revoke(n text) returns int` (revokes every live device of a person, returns how many).

- [ ] **Step 1: Write the failing tests**

```ts
test('device: revoked means refused at once; the row and its label stay', async () => {
  const sql = await db(); await omar(sql);
  const t = await add(sql, 'omar-laptop');
  const [d] = await sql`select id from cb.devices`;
  await sql`select cb.device_revoke(${d.id}, 'ahmed')`;
  assert.equal(await auth(sql, t), null);
  await sql`select cb.device_revoke(${d.id}, 'ahmed')`; // twice is harmless
  assert.equal((await sql`select count(*)::int as n from cb.events where data ->> 'action' = 'device_revoke'`)[0].n, 1);
  await assert.rejects(add(sql, 'omar-laptop'), /omar-laptop is taken/);
  await assert.rejects(sql`select cb.device_revoke(999, 'ahmed')`, /device 999 not found: see the Users page/);
  const list = (await sql`select cb.devices_list('omar') as r`)[0].r;
  assert.deepEqual(Object.keys(list[0]).sort(), ['created_at', 'id', 'label', 'last_seen', 'revoked_at', 'user']);
  assert.ok(list[0].revoked_at);
});

test('device: every way a person loses access ends their devices', async () => {
  const sql = await db(); await omar(sql);
  const off = await add(sql, 'omar-a');
  await sql`select cb.user_sessions('omar', false, 'ahmed')`;
  assert.equal(await auth(sql, off), null, 'switch off');
  await sql`select cb.user_sessions('omar', true, 'ahmed')`;
  assert.equal(await auth(sql, off), null, 'switching back on does not revive an old token');

  const role = await add(sql, 'omar-b');
  await sql`select cb.user_set_role('omar', 'admin', 'ahmed')`;
  assert.equal(await auth(sql, role), null, 'a role change ends every sign-in, devices included');
  await sql`select cb.user_set_role('omar', 'member', 'ahmed')`;

  const proj = await add(sql, 'omar-c');
  await onProject(sql, 'omar', 'evicare');
  assert.deepEqual((await auth(sql, proj)).projects, ['evicare', 'ihop']);
  await sql`select cb.user_project_remove('omar', 'ihop', 'ahmed')`;
  assert.deepEqual((await auth(sql, proj)).projects, ['evicare'], 'taken off a project: gone from the next auth');

  await sql`select cb.user_remove('omar', 'ahmed')`;
  assert.equal(await auth(sql, proj), null, 'removed');
  assert.equal((await sql`select count(*)::int as n from cb.devices`)[0].n, 0);
});

test('device: listing is the dashboard\'s', async () => {
  const sql = await db(); await omar(sql); await add(sql, 'omar-laptop');
  const notDash = sql.begin(async (tx: any) => { await tx`set local application_name = 'psql'`; return tx`select cb.devices_list()`; });
  await assert.rejects(notDash, /only Ahmed can do this, on the Users page/);
  assert.equal((await sql`select cb.devices_list() as r`)[0].r.length, 1);
});
```

- [ ] **Step 2:** Run the test command. Expected: FAIL, `function cb.device_revoke(...) does not exist`.
- [ ] **Step 3:** Implement. `cb.device_revoke`: `dashboard_only('Users')`, `set_actor`; sets `revoked_at = now()` where null; `delete from cb.sessions where device_id = id`; one event `'device <label> revoked for <Display> (<name>)'`, data `{user, action: 'device_revoke', device, label}`, only when it changed. `cb._devices_revoke(n)`: the same update and session delete for all of a person's live devices, no event. Call it from `cb.user_sessions` when turning off (append `': N device(s) revoked'` to the summary when N > 0) and from `cb.user_set_role` beside the token rotation. `cb.user_remove` needs no change: the foreign key cascades.
- [ ] **Step 4:** Run the test command. Expected: PASS.
- [ ] **Step 5:** Commit: `git commit -m "Devices: revoke and list; switch off, role change and removal end them"`.

---

### Task 5: Whose session, whose event; upgrade safety; docs

**Files:**
- Modify: `db/schema.sql`, `docs/users.md`, `docs/ops/README.md`, `docs/guardrails.md`
- Test: `test/devices.test.ts`

**Interfaces:**
- Produces (for phases 4 and 5):
  - `cb.sessions.user_name text references cb.users(name) on update cascade on delete cascade` (null = one of Ahmed's direct sessions) and `cb.sessions.device_id bigint references cb.devices(id) on delete cascade`.
  - `cb.events.owner text` (no foreign key: History outlives the person), filled by trigger `events_owner` (before insert) from the transaction setting `cb.owner` when it is non-empty.
  - Convention for phase 4: the session API runs `select set_config('cb.owner', <user>, true)` in the same transaction as the call.

- [ ] **Step 1: Write the failing tests**

```ts
import { execFileSync } from 'node:child_process';

test('events: a write made for a person records them; everything else is unchanged', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('ihop')`;
  await sql`select cb.log(project => 'ihop', summary => 'direct', actor => 'W1@pc')`;
  await sql.begin(async (tx: any) => {
    await tx`select set_config('cb.owner', 'omar', true)`;
    await tx`select cb.log(project => 'ihop', summary => 'for omar', actor => 'W1@omar-laptop')`;
  });
  await sql`select cb.log(project => 'ihop', summary => 'after', actor => 'W1@pc')`;
  const rows = await sql`select summary, owner from cb.events where kind = 'note' order by id`;
  assert.deepEqual(rows.map((r: any) => [r.summary, r.owner]), [['direct', null], ['for omar', 'omar'], ['after', null]]);
});

test('sessions: an existing binding has no person; iam still works as before', async () => {
  const sql = await db();
  await sql`select cb.ensure_project('ihop'), cb.iam('PC', 'p1', 'W1@pc', 'ihop')`;
  const [s] = await sql`select actor, user_name, device_id from cb.sessions`;
  assert.deepEqual({ ...s }, { actor: 'W1@pc', user_name: null, device_id: null });
});

test('schema: re-running setup keeps devices, switches and old sessions', async () => {
  const sql = await db(); await omar(sql);
  const t = await add(sql, 'omar-laptop');
  await sql`select cb.iam('PC', 'p1', 'W1@pc', 'ihop')`;
  execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
  execFileSync('node', ['db/setup.ts', '--test'], { stdio: 'pipe' });
  assert.equal((await auth(sql, t)).user, 'omar');
  assert.equal((await sql`select count(*)::int as n from cb.sessions where user_name is null`)[0].n, 1);
});

test('none of this is reachable over HTTP yet', async () => {
  const { RPC_FUNCTIONS } = await import('../server/rpc.ts');
  for (const fn of ['user_sessions', 'device_add', 'device_auth', 'device_revoke', 'devices_list']) assert.ok(!RPC_FUNCTIONS.includes(fn), fn);
});
```

(The last test imports `server/rpc.ts`, which opens the server's db client: add `const { sql: serverSql } = await import('../server/db.ts')` and close it in `after`, as `test/people.test.ts` does.)

- [ ] **Step 2:** Run the test command. Expected: FAIL on `column "owner" does not exist`.
- [ ] **Step 3:** Implement: the three columns (the `cb.sessions.user_name` one was added in Task 3; add `device_id` and `cb.events.owner`), `create index if not exists events_owner on cb.events (owner) where owner is not null`, the `cb.events_owner()` trigger function with its drop line and `create or replace trigger events_owner before insert on cb.events`.
- [ ] **Step 4:** Run the test command. Expected: PASS.
- [ ] **Step 5:** Docs. `docs/users.md`: a section "Sessions from a teammate's machine (not yet available)" of 4-6 lines: the switch, what turning it on means (spec 4.6), devices and Revoke, and that nothing uses them until the session API ships. `docs/ops/README.md` "Security, in one place": one bullet, "A device token is shown once and stored only as a SHA-256 hash; backups hold the hashes." `docs/guardrails.md`: set `State` to `in place (phase 2)` on the phase-2 parts of rows 4, 5, 18 and 28, each with one line saying which function enforces it.
- [ ] **Step 6: The whole suite.** Run `CB_TEST_DB=claude_board_test NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test`. Expected: every existing test passes unchanged (this phase alters no existing behaviour), plus `test/devices.test.ts`. A failure in an existing file means a change leaked: fix the schema, not the old test.
- [ ] **Step 7:** Commit: `git commit -m "Identity: sessions and events can carry their person; docs and register updated"`, then push the branch.

---

## Out of this plan (later phases, per the spec)

The session HTTP API and CLI transport, the raw-read refactor, authority rules (principal, question routing, relay wording, orchestrator grant, hand-back of tasks held by a person's sessions), all UI, CLI distribution, the pilot. Each gets its own plan once this one is merged.
