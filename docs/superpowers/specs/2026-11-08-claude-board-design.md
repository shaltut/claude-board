# Claude Board: design

Date: 2026-11-08 · Owner: Ahmed · Location: `F:\Work\claude-board`

## Intent

Ahmed runs Claude Code sessions across several projects, often overnight, with an
orchestrator session that talks to the other sessions through herdr. He needs one
local place that shows what Claude is doing, what is queued, what got done, and what
Claude needs from him, without Claude stopping to wait.

Claude Board is a local kanban board with a backlog, a questions inbox and a change
history, backed by a local Postgres. Claude writes to it; Ahmed mostly reads, answers
questions and reprioritizes.

**Success:** Ahmed wakes up, opens one URL, sees the questions waiting on him and
what happened overnight, answers in place, and the orchestrator carries on with
those answers. Claude finds the board easier to update than to skip.

## Goals

1. **Deterministic.** The UI renders only what is in Postgres. No client-side state
   that the DB does not hold (beyond UI conveniences like the selected tab).
2. **Excellent UI/UX.** Fast, dense, keyboard-friendly, polished. This is the part
   Ahmed cares most about.
3. **Trivial for Claude to use.** One-line calls, forgiving inputs, every path
   (psql, CLI, HTTP) hits the same SQL functions.
4. **Multi-project** with a project switcher at the top.
5. **Complete history.** Every change is recorded with who, when and what, even
   when Claude forgets to log.

## Non-goals

- Auth, users, roles, TLS, rate limiting, input hardening beyond basic validation.
- Cloud anything. Hosting, sync, remote DB.
- Controlling Claude sessions. The board never starts, stops or messages sessions.
  Delivery of answers is the orchestrator's job (via herdr).
- Session heartbeat/presence tracking, notifications, mobile app.

## Anti-goals (would make it a failure even if it works)

- UI that looks like a generic admin template or feels slow.
- Claude needing more than one line or a lookup of IDs/enum spellings to record work.
- Any logic duplicated between CLI, API and UI that can drift.
- Over-engineering: microservices, ORMs with migration frameworks, Docker for the app.

## Constraints

- Runs on Ahmed's Windows 11 PC (`shaltoot`). Node 24.21 (Volta), pnpm, bun available.
- Postgres **16** service already running on **port 5433** (PG15 on 5432, not used).
  `psql` is at `C:\Program Files\PostgreSQL\16\bin\psql.exe`, not on PATH.
  Database: `claude_board`, schema `cb`. Connection string lives in `.env`
  (`DATABASE_URL`); Ahmed supplies the `postgres` password at setup.
- Server listens on `127.0.0.1:4747` by default (`HOST`/`PORT` env override).

## Decided (with Ahmed)

- **Home screen = "Today" (morning briefing)**, chosen over board-first.
  - Left: **Waiting on you** — open questions, blocking first, answerable in place
    (choice buttons + free-text box).
  - Right: **Since you last looked** — counts (done / active / blocked) and a
    timeline of events since Ahmed last opened Today.
  - Default scope: All projects.
- Tabs: **Today · Board · Backlog · History** (Questions live on Today, plus a
  filterable list of all questions incl. answered).
- **Project switcher** dropdown at the top-left; "All projects" option.
- **Answer loop:** Ahmed answers on the board → question is `answered` → the
  orchestrator polls between steps, delivers each answer to the right session via
  herdr, then marks it `delivered`. The board never contacts sessions.
- Local only, no security work, Postgres as source of truth.
- **The board is the source of work** (not just a record). Sessions take their next
  task from the board with an atomic claim (`cb.task_claim(project?, actor)` /
  `cb next`, `FOR UPDATE SKIP LOCKED`, highest rank in `next` first, respecting
  priority). Between steps a session re-checks its current task (`cb mine`) and obeys
  if Ahmed moved, cancelled or reassigned it. Ahmed's ordering of Next is what gets
  picked up.

## Decided (Claude's calls, accepted by Ahmed in playback)

### Data model (schema `cb`)

- `projects` — `slug` (pk, e.g. `ihop`), `name`, `repo_path` (nullable), `color`,
  `archived`, `created_at`. Auto-created on first use by slug.
- `tasks` — `id` bigint identity (shown as `#12`), `project`, `title`, `body`
  (markdown), `status`, `priority` (`P0`–`P3`, default `P2`), `rank` (float, ordering
  within a status), `assignee` (free text actor), `labels text[]`, `links jsonb`
  (`pr`, `commit`, `branch`, `files[]`, any url), `blocked_on` (question id,
  nullable), `created_by`, `created_at`, `updated_at`, `done_at`.
- Status flow: `backlog → next → in_progress → blocked | review → done`
  (+ `cancelled`). Any transition allowed; the flow is a convention, not enforced.
- `questions` — `id`, `project`, `task_id` (nullable), `asked_by`, `body`,
  `context` (markdown), `options jsonb` (list of short choices, nullable),
  `blocking` bool, `status` (`open | answered | delivered | withdrawn`),
  `answer`, `answered_at`, `delivered_at`, `delivered_to`, `created_at`,
  `reply_to jsonb` (herdr routing: `{machine, pane}`; the CLI fills it from
  `$HERDR_PANE_ID` + hostname, the orchestrator fills it for remote workers).
  Answer is editable until delivered.
- `events` — append-only history: `id`, `at`, `actor`, `project`, `task_id`,
  `question_id`, `kind` (`task_created | moved | updated | done | note | asked |
  answered | delivered | withdrawn`), `summary` (one line), `data jsonb` (from/to
  status, links, diff of changed fields).
- `settings` — key/value; holds `owner_last_seen_at` for "since you last looked".

### Actors

Free text, convention `<session>@<machine>` (e.g. `W2@macbook`, `orch@shaltoot`).
Every function takes `actor`. Triggers read it from `current_setting('cb.actor', true)`
set by the function; raw SQL edits without it record `unknown`.

### History is automatic

Triggers on `tasks` and `questions` write `events` for every insert and status /
field change. `cb.log(...)` adds free-form notes ("investigated X, dead end").
Each write fires `pg_notify('cb', <json: table, id, project>)`.

### Claude's interface — one set of SQL functions, three doors

Functions (names final-ish; builder may tune signatures, keep them short and
forgiving — e.g. accept status aliases like `todo`, `wip`, `doing`, `done`):

| Function | Purpose |
|---|---|
| `cb.task_add(project, title, body?, status='backlog', priority='P2', actor?, labels?, links?)` → id | create |
| `cb.task_move(id, status, note?, actor?)` | change status (+ event) |
| `cb.task_update(id, fields jsonb, actor?)` | edit title/body/priority/assignee/labels/links |
| `cb.task_done(id, summary, links?, actor?)` | shortcut: done + history entry with links |
| `cb.log(project, summary, task_id?, data?, actor?)` | free note |
| `cb.ask(project, body, options?, blocking=false, task_id?, context?, actor?)` → id | ask Ahmed; if `blocking` and `task_id`, task → `blocked` with `blocked_on` |
| `cb.answers_pending(project?)` | answered-but-not-delivered questions (for the orchestrator) |
| `cb.answer_delivered(id, delivered_to, actor?)` | mark delivered; unblocks linked task back to `next` |
| `cb.answer(id, answer, actor='ahmed')` | used by the UI |
| `cb.task_claim(project?, actor)` → task | atomically take the top `next` task, set `in_progress` + assignee |
| `cb.mine(actor)` | my current tasks with live status (re-check between steps) |
| `cb.brief(project?)` | compact text/JSON snapshot: in progress, next, blocked, open questions — what a session reads at start |

Doors:
1. **psql**: `psql -d claude_board -c "select cb.task_add('ihop','Fix RI grading')"`.
2. **`cb` CLI**: tiny Node script on PATH (Windows `.cmd` shim), talks **directly to
   Postgres** (works when the web server is down). Examples: `cb add ihop "Fix RI
   grading" -p P1`, `cb move 12 done "merged #412"`, `cb ask ihop "Rotate creds now?"
   -o "now,friday" --blocking --task 12`, `cb brief ihop`, `cb pending`.
   Actor from `CB_ACTOR` env or `--as`.
3. **HTTP**: `POST /api/rpc/<function>` with JSON args, plus `GET` read endpoints the
   UI uses. Thin passthrough to the same functions.

### Remote workers

Sessions on the MacBook/vps2 don't reach this PC's Postgres. v1: the orchestrator
(on this PC) records on their behalf, using their actor names. `HOST` env lets Ahmed
bind to the Tailscale IP later if he wants workers to write directly.

### Orchestrator count (Claude's call)

One orchestrator. `answer_delivered` is idempotent; no delivery locking.

### "Since you last looked" (Claude's call)

One global marker. On opening Today, the UI captures the stored
`owner_last_seen_at` and anchors the timeline there for the whole visit (refreshes
and live updates don't empty it). The marker advances to "now" when Ahmed leaves
Today / closes the tab, or clicks **Mark caught up**.

### UI

- React + TypeScript + Vite, Tailwind, shadcn/ui components, dnd-kit for drag
  (board columns and backlog ordering), cmdk for ⌘K (jump to task/project, quick
  add), TanStack Query for data. Dark theme first, light available.
- Live: server `LISTEN cb` → Server-Sent Events → client invalidates queries. No
  polling, no optimistic state that can diverge (optimistic drag is fine if it
  reconciles from the DB).
- **Today:** questions (answer inline; choice buttons; ⌘Enter to send), counts,
  timeline since last seen. Answered-awaiting-pickup questions shown as such until
  delivered.
- **Board:** columns Next · In progress · Blocked · Review · Done (Done shows last
  7 days, rest collapsible). Cards: `#id`, title, priority, assignee chip, project
  chip (in All), age since last update, link icons. Click → side panel with body
  (markdown), links, linked questions, and that task's history.
- **Backlog:** ordered list, drag to reorder, multi-select → move to Next, inline
  quick-add.
- **History:** reverse-chronological event feed, filter by project/actor/kind/date,
  grouped by day.
- Ahmed can also create/edit/move tasks from the UI (actor `ahmed`).

### Prompts (deliverables)

- `prompts/session.md` — pasted into any Claude session: register current and next
  tasks, keep statuses current, log what you did with links, ask instead of
  stopping (`cb ask`, non-blocking unless truly blocked, keep working on something
  else), read `cb brief` at start.
- `prompts/orchestrator.md` — the above plus: poll `cb pending` between steps,
  deliver answers via herdr, `cb delivered`, record on behalf of remote workers.
- A short `CLAUDE.md` snippet Ahmed can drop into project CLAUDE.md files.

### Running

- `pnpm i && pnpm setup` — creates DB + applies `schema.sql` (idempotent, plain SQL
  file, no migration framework).
- `pnpm start` — builds UI if needed, serves on `http://localhost:4747`.
- `pnpm dev` for UI work. Optional Windows startup shortcut is out of scope for v1.

## Left to the builder

- Exact function signatures, alias list, CLI flag names.
- Visual design details within "dense, dark, Linear-like, polished".
- Server framework (Hono suggested) and Postgres driver (`postgres` suggested).
- Seed/demo data for development (synthetic only).
- Tests: SQL function behavior (status transitions, events written, blocking/unblock
  loop) is the one non-trivial logic; cover it with a small runnable test.
