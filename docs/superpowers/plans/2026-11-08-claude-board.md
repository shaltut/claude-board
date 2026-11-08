# Claude Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local kanban + backlog + questions inbox + history board for Claude sessions, backed by Postgres, with a polished React UI and a one-line CLI for Claude.

**Architecture:** All logic lives in Postgres (`schema cb`: tables, triggers that write history, SQL functions). Three thin doors call the same functions: `psql`, the `cb` CLI (direct DB), and a Hono HTTP server (`/api/rpc/<fn>`) that also serves the UI and streams `LISTEN cb` notifications as SSE. The React UI renders only what the DB returns.

**Tech Stack:** Postgres 16 · Node 24 (native TS type stripping) · `postgres@3.4.9` · Hono + `@hono/node-server` · Vite + React 19 + TypeScript · Tailwind v4 (`@tailwindcss/vite`) · shadcn/ui (radix) · dnd-kit · cmdk · TanStack Query · lucide-react · `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-08-claude-board-design.md`

## Global Constraints

- Postgres 16 **private cluster** in `.pgdata/` (gitignored), made with the installed PG16 binaries (`C:\Program Files\PostgreSQL\16\bin`): `initdb -U cb --auth=trust`, port **5434**, `listen_addresses=127.0.0.1`. Already initialised. `DATABASE_URL=postgres://cb@127.0.0.1:5434/claude_board`; tests use `claude_board_test`. The existing PG15/16 services are not used.
- `db/pg.ts` exports `ensurePg(): void` — `pg_ctl -D .pgdata status`; if stopped, `pg_ctl -D .pgdata -o "-p 5434 -c listen_addresses=127.0.0.1" -l .pgdata/server.log start`. Called by `setup`, `start`, test helpers, and the CLI (on connection refused, then retry once).
- Server listens on `127.0.0.1:4747` (`HOST`, `PORT` env override).
- No auth, no TLS, no Docker for the app, no ORM, no migration framework. One idempotent `db/schema.sql`.
- Server/CLI TypeScript is **erasable syntax only** (Node 24 type stripping): no enums, no parameter properties, no namespaces. Imports use `.ts` extensions.
- Every SQL function body starts with `#variable_conflict use_variable`. Parameter names are unprefixed and equal the JSON keys used by RPC/CLI.
- Every `cb.*` function takes `actor text default null`; effective actor = `coalesce(actor, current_setting('cb.actor', true), 'unknown')`, and the function does `perform set_config('cb.actor', <effective>, true)` so triggers see it.
- `.env` is located relative to the code file (`import.meta.dirname`), never `process.cwd()`.
- Synthetic data only in seeds and tests.
- Dark theme first; dense, keyboard-friendly, Linear-like. Light theme via `prefers-color-scheme` + toggle.

## Review Focus

1. **Claude passes sloppy input** (`"WIP"`, `"#12"`, `" done "`, unknown project slug, `P1` vs `p1`): must normalize or fail with a readable message naming the valid values, never a raw Postgres error. Test: Task 2 `aliases` + `bad status message`.
2. **Two sessions claim at once:** must never get the same task. Test: Task 2 `claim is exclusive` (two concurrent connections).
3. **Re-running `pnpm run setup` on a live DB:** no error, no data loss. Test: Task 1 `setup twice keeps rows`.
4. **Live update arrives while Ahmed is typing an answer:** draft text and the Today timeline anchor must survive refetches. Test: Task 7 Playwright step (type, trigger a DB write via CLI, assert textarea value unchanged and timeline still shows old events).
5. **Server down, CLI still used:** CLI talks to Postgres directly and works. Test: Task 5 runs with the server stopped.

---

## File Structure

```
claude-board/
  package.json              scripts: setup, start, dev, build, test, seed
  .env.example
  db/schema.sql             all tables, triggers, functions (idempotent)
  db/setup.ts               create DBs if missing, apply schema.sql; --test flag targets claude_board_test; adds bin/ to user PATH
  db/seed.ts                synthetic demo data
  server/db.ts              sql client from .env; callFn(name, args)
  server/rpc.ts             RPC whitelist + error mapping
  server/queries.ts         read queries for the UI
  server/main.ts            Hono app: /api/*, SSE, static dist
  cli/cb.ts                 the CLI
  bin/cb.cmd                Windows shim -> node cli/cb.ts %*
  test/helpers.ts           fresh test DB per file
  test/tasks.test.ts  test/questions.test.ts  test/server.test.ts  test/cli.test.ts
  web/                      Vite root (index.html, vite.config.ts, src/...)
  prompts/session.md  prompts/orchestrator.md  prompts/claude-md-snippet.md
  README.md
```

---

### Task 1: Project skeleton, tables, setup script

**Files:**
- Create: `package.json`, `.env.example`, `db/pg.ts`, `db/schema.sql` (tables part), `db/setup.ts`, `server/db.ts`, `test/helpers.ts`, `test/tasks.test.ts`

**Interfaces:**
- Produces:
  - Tables in schema `cb`: `projects(slug pk, name, repo_path, color, archived bool default false, created_at)`, `tasks(...)`, `questions(...)`, `events(...)`, `settings(key pk, value jsonb)` — columns exactly as in the spec's Data model, plus `questions.reply_to jsonb`.
  - `tasks.status` check: `backlog|next|in_progress|blocked|review|done|cancelled`. `priority` check `P0|P1|P2|P3`. `questions.status` check `open|answered|delivered|withdrawn`. `events.kind` check: `task_created|moved|updated|done|note|asked|answered|delivered|withdrawn`.
  - Indexes: `tasks(project, status, rank)`, `events(at desc)`, `events(task_id)`, `questions(status)`.
  - `server/db.ts`: `export const sql` (postgres client from `DATABASE_URL`, overridable by `CB_DATABASE_URL` env); `export function connect(url: string)`.
  - `test/helpers.ts`: `export async function freshDb(): Promise<Sql>` — runs setup against `claude_board_test`, truncates all `cb` tables `restart identity cascade`, returns a client.
  - `package.json` scripts: `"setup": "node db/setup.ts"`, `"test": "node --test --test-concurrency=1 test/*.test.ts"`.

- [ ] **Step 1:** `pnpm init`; add deps `postgres@3.4.9`, `hono`, `@hono/node-server`; dev deps `typescript`, `@types/node`. `.env.example` with the Global Constraints URL. Copy to `.env`.
- [ ] **Step 2: Write the failing test** in `test/tasks.test.ts`:

```ts
test('setup twice keeps rows', async () => {
  const sql = await freshDb();
  await sql`insert into cb.projects(slug, name) values ('demo','Demo')`;
  execFileSync('node', ['db/setup.ts', '--test']);           // second run
  const [r] = await sql`select count(*)::int n from cb.projects`;
  assert.equal(r.n, 1);
});
```
- [ ] **Step 3:** Run `pnpm test` → FAIL (no setup.ts).
- [ ] **Step 4:** Write `db/schema.sql` tables with `create schema if not exists cb` / `create table if not exists` (note in a comment: `if not exists` never alters; column changes need a manual `alter`). Write `db/setup.ts`: connect to the `postgres` DB, create `claude_board` (or `claude_board_test` with `--test`) if missing, apply `schema.sql` with `sql.file()`. Without `--test`, also add `<repo>\bin` to the **user** PATH if absent (`setx` is lossy; read `HKCU\Environment\Path` via `reg query` and write with `reg add ... /f`), print a note to restart terminals.
- [ ] **Step 5:** `pnpm test` → PASS. `pnpm run setup` twice → no error.
- [ ] **Step 6:** Commit `feat: schema tables and setup`.

---

### Task 2: Task functions, history triggers, notify

**Files:**
- Modify: `db/schema.sql` (functions + triggers section)
- Test: `test/tasks.test.ts`

**Interfaces:**
- Consumes: tables from Task 1.
- Produces (SQL; precede each with `drop function if exists cb.<name> cascade;` so signature changes re-apply):
  - `cb.norm_status(s text) returns text` — trims, lowercases, maps aliases, raises `unknown status "<s>"; use one of backlog, next, in_progress, blocked, review, done, cancelled` otherwise.
  - `cb.norm_id(id text) returns bigint` — accepts `12`, `"12"`, `"#12"`.
  - `cb.ensure_project(project text) returns text` — lowercase slug, inserts `(slug, name=initcap(slug))` if missing.
  - `cb.task_add(project text, title text, body text default '', status text default 'backlog', priority text default 'P2', labels text[] default '{}', links jsonb default '{}', assignee text default null, actor text default null) returns bigint`
  - `cb.task_move(id text, status text, note text default null, actor text default null) returns void`
  - `cb.task_update(id text, fields jsonb, actor text default null) returns void` — allowed keys: `title, body, priority, assignee, labels, links, project, rank`; unknown key → raise listing allowed keys. `links` is merged (`||`), not replaced.
  - `cb.task_done(id text, summary text, links jsonb default '{}', actor text default null) returns void`
  - `cb.log(project text, summary text, task_id text default null, data jsonb default '{}', actor text default null) returns bigint`
  - `cb.task_claim(project text default null, actor text default null) returns setof cb.tasks` — `select ... where status='next' [and project=...] order by rank limit 1 for update skip locked`; sets `in_progress`, `assignee=actor`. Empty set when nothing to claim.
  - `cb.mine(actor text) returns setof cb.tasks` — tasks with `assignee=actor` and status not in (`done`,`cancelled`), plus tasks assigned to actor that changed in the last 24h (so a cancelled/reassigned task is seen once).
- Rules:
  - Aliases (exact): `todo→next`, `ready→next`, `wip→in_progress`, `doing→in_progress`, `progress→in_progress`, `in-progress→in_progress`, `inprogress→in_progress`, `active→in_progress`, `block→blocked`, `waiting→blocked`, `pr→review`, `reviewing→review`, `complete→done`, `completed→done`, `closed→done`, `finished→done`, `cancel→cancelled`, `canceled→cancelled`, `dropped→cancelled`, `later→backlog`, `icebox→backlog`. Priority: case-insensitive, `0..3` accepted.
  - Rank on entering a status (insert or status change): `P0` → `min(rank)-1024`, else `max(rank)+1024` within `(project, status)`; empty column → `0`. Only `task_update(rank)` (Ahmed's drag) reorders otherwise.
  - `done_at` set when status becomes `done`, cleared when it leaves.
  - Trigger `tasks_history` (after insert/update on `cb.tasks`) writes `cb.events`: insert → `task_created`; status change → `moved` (or `done` when new status is `done`), `data={from,to}`, summary = `current_setting('cb.note', true)` or `"<from> → <to>"`; other field change → `updated` with `data` = changed keys. **Rank-only updates write no event.** `task_move`/`task_done` set `cb.note` with `set_config(..., true)` to pass their note/summary; `task_done` also puts `links` into `data`.
  - Statement-level triggers on `tasks`, `questions`, `events` → `pg_notify('cb', tg_table_name)`.

- [ ] **Step 1: Write failing tests** (names and assertions):
  - `add creates project and history` — `task_add('Demo','T1', actor=>'W1@mac')` returns id 1; `cb.projects` has `demo`; one event `task_created`, actor `W1@mac`.
  - `aliases` — `task_move('#1','WIP')` → status `in_progress`; `task_move('1',' Done ')` → `done`, `done_at` not null; `task_add(..., priority=>'p1')` → `P1`.
  - `bad status message` — `task_move('1','nope')` rejects with message containing `use one of backlog, next`.
  - `moved event carries note` — `task_move('1','review','opened PR #9')` → latest event kind `moved`, summary `opened PR #9`, `data->>'from'='in_progress'`.
  - `done with links` — `task_done('1','merged',{"pr":"#9"})` → event kind `done`, `data->'links'->>'pr'='#9'`.
  - `rank-only update is silent` — `task_update('1','{"rank":5}')` adds no event; `task_update('1','{"title":"x"}')` adds an `updated` event.
  - `P0 jumps to top of next` — add A, B (P2) and C (P0) in `next`; ordered by rank = C, A, B.
  - `claim takes top of next` — claim returns C with `in_progress`, `assignee='W1'`; claim on empty project returns no rows.
  - `claim is exclusive` — two separate connections each `begin; select cb.task_claim('demo','Wx')` concurrently with one `next` task → exactly one gets a row.
  - `mine sees cancellation once` — task assigned to W1 moved to `cancelled` still appears in `mine('W1')`.
- [ ] **Step 2:** `pnpm test` → those FAIL.
- [ ] **Step 3:** Implement the functions and triggers in `db/schema.sql`.
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat: task functions, history triggers, notify`.

---

### Task 3: Question functions, brief, last-seen

**Files:**
- Modify: `db/schema.sql`
- Test: `test/questions.test.ts`

**Interfaces:**
- Consumes: `norm_id`, `ensure_project`, task functions (Task 2).
- Produces:
  - `cb.ask(project text, body text, options text[] default null, blocking boolean default false, task_id text default null, context text default null, reply_to jsonb default null, actor text default null) returns bigint` — if `blocking` and `task_id`: task → `blocked`, `blocked_on = q.id`.
  - `cb.answer(id text, answer text, actor text default 'ahmed') returns void` — allowed when `open` or `answered` (editable until delivered); sets `answered`, `answered_at`. Raises on `delivered`/`withdrawn`.
  - `cb.withdraw(id text, actor text default null) returns void`.
  - `cb.answers_pending(project text default null) returns setof cb.questions` — status `answered`, oldest first.
  - `cb.answer_delivered(id text, delivered_to text default null, actor text default null) returns void` — idempotent (second call no-op, no second event); on first call: `delivered`, `delivered_at`; any task with `blocked_on = id` and status `blocked` → `next`, `blocked_on=null`.
  - `cb.brief(project text default null) returns jsonb` — `{in_progress:[...], next:[top 10], blocked:[...], open_questions:[...], answered_pending:[...]}`; each task as `{id,project,title,priority,assignee,updated_at}`.
  - `cb.seen(at timestamptz default now()) returns void` — upsert `settings('owner_last_seen_at')`.
  - `cb.last_seen() returns timestamptz` — stored value or `now() - interval '24 hours'` if unset.
  - Trigger `questions_history` → events `asked` / `answered` / `delivered` / `withdrawn` with `question_id`, `task_id`, summary = first 120 chars of body (asked) or answer (answered).

- [ ] **Step 1: Write failing tests:**
  - `blocking ask blocks task` — task 1 in progress; `ask('demo','Rotate?',['now','friday'],true,'1', reply_to=>{"machine":"shaltoot","pane":"p3"})` → task `blocked`, `blocked_on=q`.
  - `answer is editable until delivered` — `answer(q,'now')` then `answer(q,'friday')` → `answer='friday'`; after delivered, `answer` rejects with message containing `already delivered`.
  - `pending then delivered unblocks` — `answers_pending()` has q (with `reply_to->>'pane'='p3'`); `answer_delivered(q,'W1')` → q `delivered`, task `next`, `blocked_on` null; `answers_pending()` empty.
  - `delivered is idempotent` — second `answer_delivered(q)` → still one `delivered` event.
  - `brief shape` — keys `in_progress,next,blocked,open_questions,answered_pending` all present as arrays.
  - `last_seen default and set` — unset → within 24h ± 1 min of now; after `seen('2026-01-01')` → that value.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: questions, brief, last-seen`.

---

### Task 4: HTTP server (RPC, reads, SSE, static)

**Files:**
- Create: `server/rpc.ts`, `server/queries.ts`, `server/main.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: all `cb.*` functions; `sql` from `server/db.ts`.
- Produces (the UI depends on these exactly):
  - `RPC_FUNCTIONS = ['task_add','task_move','task_update','task_done','log','task_claim','mine','ask','answer','withdraw','answers_pending','answer_delivered','brief','seen']`
  - `POST /api/rpc/:fn` body = JSON object of named args → `select * from cb.<fn>(k1 => $1, ...)` (keys validated `^[a-z_]+$`; arrays/objects passed as `sql.json` / `sql.array`). Response `{ok:true, result}` where scalar-returning functions give the scalar, set-returning give an array. Unknown fn → 404 `{ok:false,error:"unknown function <fn>; available: ..."}`. Postgres `raise exception` → 400 `{ok:false,error:<message>}`.
  - `GET /api/projects` → `[{slug,name,color,open_count,question_count}]`
  - `GET /api/tasks?project=&status=` → tasks ordered by `status, rank` (Done limited to last 7 days unless `status=done`).
  - `GET /api/tasks/:id` → `{task, events:[...], questions:[...]}`
  - `GET /api/questions?project=&status=` → questions, blocking first then oldest.
  - `GET /api/events?project=&actor=&kind=&since=&before=&limit=100` → events desc.
  - `GET /api/today?project=&since=` → `{since, counts:{done,active,blocked}, events:[...]}` (counts: done since `since`, active = in_progress now, blocked = blocked now).
  - `GET /api/last-seen` → `{at}`.
  - `GET /api/stream` → SSE; one long-lived `sql.listen('cb', ...)` fans out `event: change\ndata: <table>\n\n` to all clients; heartbeat comment every 25 s.
  - Static: serve `web/dist` with SPA fallback to `index.html`.
  - `server/main.ts` exports `app` (Hono) and only calls `serve()` when run directly.

- [ ] **Step 1: Write failing tests** using `app.request()` against the test DB (`CB_DATABASE_URL` set to test URL before import):
  - `rpc task_add returns id` → `{ok:true,result:1}`.
  - `rpc error is 400 with message` — `task_move` bad status → 400, `error` contains `use one of`.
  - `unknown rpc is 404 listing functions`.
  - `task detail has history` — after add+move, `/api/tasks/1` has 2 events.
  - `today counts` — one done, one in_progress → `{done:1,active:1,blocked:0}`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Manual: `node server/main.ts`, `curl -N localhost:4747/api/stream` in one shell, `curl -X POST localhost:4747/api/rpc/log -d '{"project":"demo","summary":"hi"}' -H 'content-type: application/json'` in another → stream prints `event: change`.
- [ ] **Step 6:** Commit `feat: http server with rpc, reads, sse`.

---

### Task 5: `cb` CLI

**Files:**
- Create: `cli/cb.ts`, `bin/cb.cmd`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `cb.*` functions via `sql` (direct DB, no server). Reads `.env` from `import.meta.dirname/../.env`; `CB_DATABASE_URL` overrides.
- Produces — commands (exact names; flags parsed with `node:util` `parseArgs`):

| Command | Calls |
|---|---|
| `cb add <project> "<title>" [-b body] [-s status] [-p P1] [-l a,b] [--link k=v]...` | `task_add` → prints `#<id>` |
| `cb move <id> <status> ["note"]` | `task_move` |
| `cb done <id> "summary" [--pr x] [--commit x] [--branch x] [--link k=v]...` | `task_done` |
| `cb edit <id> --title/--body/--priority/--assignee/--project ...` | `task_update` |
| `cb log <project> "summary" [-t id]` | `log` |
| `cb next [project]` | `task_claim` → prints `#id title` + body, or `nothing to claim` |
| `cb mine` | `mine` |
| `cb ask <project> "question" [-o "a,b"] [--blocking] [-t id] [-c context]` | `ask`; `reply_to = {machine: os.hostname(), pane: $HERDR_PANE_ID}` when the env var exists |
| `cb pending [project]` / `cb delivered <qid> [to]` | `answers_pending` / `answer_delivered` |
| `cb brief [project]` | `brief` → compact text (sections with one line per item) |
| `cb help` | usage |
- Actor: `--as <name>` > `CB_ACTOR` env > `<HERDR_PANE_ID or "session">@<hostname>`.
- Output is plain text, one line per item, `#id [status] P1 title (assignee)`; `--json` on any command prints raw JSON. Errors: message to stderr, exit 1.
- `bin/cb.cmd`: `@node "%~dp0..\cli\cb.ts" %*`

- [ ] **Step 1: Write failing tests** (spawn `node cli/cb.ts ...` with `CB_DATABASE_URL` = test DB, **no server running**):
  - `add prints id` → stdout `#1`.
  - `next claims and prints` → stdout starts `#1`, DB status `in_progress`.
  - `ask captures pane` — env `HERDR_PANE_ID=p7` → `reply_to->>'pane'='p7'`.
  - `bad status exits 1 with message` → exit code 1, stderr contains `use one of`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Manual: new terminal, `cb help` works from `F:\Work` (PATH from Task 1).
- [ ] **Step 6:** Commit `feat: cb cli`.

---

### Task 6: Web shell (Vite, Tailwind v4, shadcn, layout, live data)

**Files:**
- Create: `web/` (Vite react-ts), `web/vite.config.ts`, `web/src/lib/api.ts`, `web/src/lib/live.ts`, `web/src/App.tsx`, `web/src/components/TopBar.tsx`, `web/src/components/ProjectSwitcher.tsx`, `web/src/components/CommandMenu.tsx`, `db/seed.ts`
- Modify: root `package.json` scripts: `"dev"` (server + vite concurrently, or two commands documented), `"build": "pnpm -C web build"`, `"start": "node server/main.ts"` (build first if `web/dist` missing), `"seed": "node db/seed.ts"`.

**Interfaces:**
- Consumes: HTTP API from Task 4.
- Produces:
  - `api.ts`: `rpc<T>(fn: string, args: object): Promise<T>` (throws `Error(error)` on `ok:false`), `get<T>(path: string): Promise<T>`.
  - `live.ts`: `useLive()` — one `EventSource('/api/stream')`; on `change`, `queryClient.invalidateQueries()` (all; the DB is small). Shows a small "live / reconnecting" dot in TopBar.
  - Routing: hash routes `#/today`, `#/board`, `#/backlog`, `#/history`, `#/task/:id` (opens panel over current view). Project in query `?p=<slug>`; empty = All. No router lib needed; `useHashRoute()` hook in `App.tsx`.
  - `ProjectSwitcher`: shadcn `Select`/`Popover` with All + projects (open counts), `color` dot.
  - `CommandMenu` (cmdk via shadcn `Command`): ⌘K / Ctrl+K — jump to task (search title/#id), switch project, go to tab, "New task in <project>".
  - Keyboard: `1–4` switch tabs, `/` focuses search, `Esc` closes panels.
- Setup: `pnpm create vite web --template react-ts`; add `tailwindcss @tailwindcss/vite`, `@/` alias per shadcn Vite docs; `pnpm dlx shadcn@latest init -b radix -y --no-monorepo` inside `web` — **if it prompts, Ctrl-C and write `components.json` by hand** (style new-york, baseColor zinc, cssVariables true, aliases `@/components`, `@/lib/utils`). Add components: `button badge card select popover command dialog sheet textarea input tabs tooltip separator scroll-area dropdown-menu sonner`. Fonts: Inter + JetBrains Mono (ids, timestamps) via Google Fonts or fontsource. Vite `server.proxy['/api'] = 'http://127.0.0.1:4747'`.
- `db/seed.ts`: 3 synthetic projects (`demo-api`, `demo-web`, `demo-ml`), ~25 tasks across statuses, 4 questions (2 blocking, 1 answered pending), ~40 events spread over the last 18h, actors like `W1@macbook`, `orch@shaltoot`.

- [ ] **Step 1:** Scaffold, install, configure as above. `pnpm build` passes.
- [ ] **Step 2:** Implement shell, switcher, command menu, live hook. Placeholder views.
- [ ] **Step 3:** `pnpm run seed`, `pnpm start`, Playwright MCP: open `http://localhost:4747/#/today`, screenshot; press Ctrl+K, screenshot menu; switch project → URL has `?p=demo-api`.
- [ ] **Step 4:** Live check: with page open, `cb log demo-api "live test"` → network shows SSE `change`, no page reload.
- [ ] **Step 5:** Commit `feat: web shell with live updates`.

---

### Task 7: Today view

**Files:**
- Create: `web/src/views/Today.tsx`, `web/src/components/QuestionCard.tsx`, `web/src/components/Timeline.tsx`

**Interfaces:**
- Consumes: `/api/questions`, `/api/today`, `/api/last-seen`, `rpc('answer')`, `rpc('seen')`, `rpc('withdraw')`.
- Behavior (Claude's call, pinned):
  - On mount, fetch `/api/last-seen` **once** into component state (`anchor`); never refetch it during the visit. Timeline/counts query `/api/today?since=<anchor>`.
  - Marker advances (`rpc('seen')`) when navigating away from Today inside the app and on **Mark caught up** (which also sets `anchor=now`). No `beforeunload`; closing the tab just means a longer timeline next time.
  - Left column **Waiting on you · N**: open questions, blocking first then oldest; card shows `Q<id>`, project chip, asker, age, body, collapsible context (markdown), option buttons, textarea (⌘/Ctrl+Enter sends; clicking an option sends it immediately with an undo toast for 5 s that re-opens the card for editing). Draft text kept in a per-question `useState` keyed by id so refetches don't clear it.
  - Below: **Answered — waiting for pickup** (status `answered`; editable) and collapsed **Delivered today**.
  - Right column: counts tiles (done / active / blocked), timeline grouped by hour, each row `time · actor chip · summary · task #id link`.
  - Empty state: "Nothing waiting on you." with a calm illustration-free message.
  - **All questions** link at the bottom of the left column → full list (any status) with status filter chips and text search; same `QuestionCard` in read-only mode for delivered/withdrawn.
- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `pnpm build` passes.
- [ ] **Step 3: Playwright check (Review Focus 4):** open Today with seed data; type "draft text" in a blocking question's textarea; from shell run `cb log demo-api "noise"`; assert textarea still has "draft text" and the timeline's first rendered event is unchanged. Answer a question via option button → card moves to "waiting for pickup"; `cb pending` lists it. Screenshot light + dark.
- [ ] **Step 4:** Commit `feat: today view`.

---

### Task 8: Board view + task panel

**Files:**
- Create: `web/src/views/Board.tsx`, `web/src/components/TaskCard.tsx`, `web/src/components/TaskPanel.tsx`, `web/src/components/NewTask.tsx`

**Interfaces:**
- Consumes: `/api/tasks`, `/api/tasks/:id`, `rpc('task_move'|'task_update'|'task_add')`.
- Behavior:
  - Columns: Next · In progress · Blocked · Review · Done (Done = last 7 days, collapsible). Header shows count.
  - dnd-kit (`@dnd-kit/core` + `@dnd-kit/sortable`): drag across columns → `task_move(id, status, actor 'ahmed')`; drag within column → `task_update(id, {rank})` with rank = midpoint of neighbours (top: first−1024, bottom: last+1024). Optimistic move, then invalidate; the DB result wins.
  - Card: `#id` (mono), title, priority badge (P0 red, P1 amber, P2 neutral, P3 muted), assignee chip, project chip (All only), relative updated time, link icons (PR/commit), "blocked on Q7" for blocked.
  - TaskPanel: shadcn `Sheet` from right, URL `#/task/:id`. Editable title/body (markdown preview via `react-markdown`), priority/assignee/status selects, links list, linked questions, task history (events) newest first.
  - `NewTask`: `c` key or button → dialog (project, title, priority, status default `next`).
- [ ] **Step 1:** Implement. **Step 2:** `pnpm build` passes.
- [ ] **Step 3:** Playwright: drag a card Next → In progress; `cb brief demo-api` lists it under in_progress; panel shows a `moved` event by `ahmed`. Screenshot.
- [ ] **Step 4:** Commit `feat: board and task panel`.

---

### Task 9: Backlog and History views

**Files:**
- Create: `web/src/views/Backlog.tsx`, `web/src/views/History.tsx`

**Interfaces:**
- Consumes: `/api/tasks?status=backlog`, `/api/events`, `rpc('task_move'|'task_update'|'task_add')`, `TaskPanel` (Task 8).
- Behavior:
  - Backlog: one ordered list (by rank), dnd-kit sortable reorder (same rank-midpoint rule), checkbox multi-select → "Move to Next" / "Cancel"; inline quick-add row at top (Enter adds to backlog in current project; in All, requires a project picker). Also shows the **Next** queue above it (compact, sortable) since its order decides what sessions claim — label it "Next up (sessions take from the top)".
  - History: events newest first, grouped by day; filters: project (from switcher), actor, kind (multi), text search on summary; infinite scroll with `before=<last at>`. Row: time, actor chip, kind icon, summary, task link, link chips from `data.links`.
- [ ] **Step 1:** Implement. **Step 2:** `pnpm build` passes.
- [ ] **Step 3:** Playwright: reorder Next queue, then `cb next demo-api` claims the task now at top. Filter History by actor. Screenshot both.
- [ ] **Step 4:** Commit `feat: backlog and history`.

---

### Task 10: Prompts, README, final pass

**Files:**
- Create: `prompts/session.md`, `prompts/orchestrator.md`, `prompts/claude-md-snippet.md`, `README.md`

**Interfaces:**
- Consumes: CLI commands from Task 5 (prompts use `cb ...` only, never `psql`).
- Content requirements:
  - `session.md` (≤40 lines): set `CB_ACTOR` if not set; start with `cb brief <project>`; register everything in hand (`cb add ... -s in_progress`) and known next work (`-s next`/`backlog`); take work with `cb next <project>`; between steps run `cb mine` and obey moves/cancels; `cb move`/`cb done` with PR/commit links; `cb log` for notable findings; when unsure, `cb ask` (non-blocking by default, `--blocking --task` only if truly stuck) and **keep working on something else — never stop to wait**.
  - `orchestrator.md`: everything above, plus: between steps run `cb pending`, deliver each answer to `reply_to` via herdr (load the `herdr` skill), then `cb delivered <qid> <session>`; record on behalf of remote workers with `--as <session>@<machine>`; keep the Next queue in the order Ahmed set.
  - `claude-md-snippet.md`: 6–8 lines to paste into a project's CLAUDE.md.
  - `README.md`: `pnpm i && pnpm run setup && pnpm start`, URL, CLI table, psql examples, HTTP example, troubleshooting (PATH restart, port in use).
- [ ] **Step 1:** Write the files.
- [ ] **Step 2:** Dry run: in a fresh terminal from `F:\Work`, follow `session.md` literally against seed data (add, next, ask, done) → all commands succeed and show on the board live.
- [ ] **Step 3:** `pnpm test` all PASS; `pnpm build` passes.
- [ ] **Step 4:** Commit `docs: prompts and readme`.

---

## Addendum (2026-11-08, Ahmed mid-build): replace AskUserQuestion

Ahmed: the native AskUserQuestion tool blocks the orchestrator. The board must be its non-blocking equivalent.

- **Task 4b — rich questions.** `cb.ask.options` becomes `jsonb`: array of strings or `{label, description}` objects, stored normalized as `[{label, description}]`. New column `questions.multi boolean default false` (+ `ask(multi => ...)`). `task_add.labels` also becomes `jsonb` so every array/object RPC arg is jsonb (one rule in `rpc.ts`). "(Recommended)" stays a label convention, as in AskUserQuestion. Tests: `ask options with descriptions`, `multi flag stored`, `rpc labels array`.
- **CLI (Task 5):** `-o "Label=description"` repeatable (also accepts `-o "a,b"`), `--multi`.
- **UI (Task 7):** option buttons show label + description; multi → checkboxes + Send; context rendered as markdown.
- **Task 10 — deny hook:** `hooks/deny-ask.mjs`, a PreToolUse hook on `AskUserQuestion` in Ahmed's user settings, returns `permissionDecision: deny` with a reason telling Claude to use `cb ask` (with options + descriptions, `--blocking` only when truly stuck) and keep working. `CB_ALLOW_ASK=1` bypasses.
