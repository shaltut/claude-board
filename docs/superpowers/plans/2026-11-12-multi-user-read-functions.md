# Multi-user sessions, phase 3: read functions. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cli/cb.ts` holds no SQL of its own: each of its 34 raw statements becomes a `cb.*` function, so a later
HTTPS transport runs the same code and project scope is applied in one place.

**Architecture:** New functions in `db/schema.sql` return `jsonb`. Every one that returns project data takes
`scope jsonb default null`: `null` is the whole board (Ahmed's machines, as today); an array of project slugs hides
everything else as if it did not exist. The CLI calls them through a second allow-list (`CLI_FUNCTIONS`) that
`/api/rpc` never serves, so the web surface does not change in this phase.

**Tech stack:** Postgres 16 (plpgsql), Node 24 (`node --test`), postgres.js.

**Spec:** `docs/superpowers/specs/2026-11-12-multi-user-sessions-design.md` (section 4.3 and phase 3 of section 6).

## Global constraints

- Pure refactor for today's sessions: same output text, same exit codes, same refusals. The existing suite is the
  proof.
- Additive schema only; idempotent (each function has its `drop function if exists ... cascade` line).
- Nothing new is reachable over HTTP: no new name in `RPC_FUNCTIONS`.
- The refusal for `cb github add|remove|mute|unmute` never names the way past it (`test/github.test.ts`).
- Tests run only against `claude_board_test*`; the live board is never connected to.

## My calls (not the owner's decisions)

- **Scope is an argument, not a session setting.** Phase 4's server overwrites `scope` with the device's projects on
  every call, the way it overwrites `actor` for admins today. A function in the session allow-list must either take
  `scope` or be on a short reviewed scope-free list; a test will enforce that in phase 4. The scope-free list here:
  `session_at` (the caller's own pane), `user_get`, `users_overview`, `github_*` (none of these four is offered to
  teammates in the design's table).
- **A scope that is not a JSON array hides everything** (fails closed).
- **The three GitHub writes move too** (`github_watch`, `github_unwatch`, `github_mute`), still dashboard-only inside
  the function, so the CLI needs no database handle of its own. They stay off `/api/rpc`: putting them there would
  let any admin's browser change the watch, which today only Ahmed's connection can.
- **Timestamps in `--json` output** of `cb show`, `cb session` and `cb huddle show` change form
  (`2026-11-12T08:51:27.643Z` becomes Postgres's `2026-11-12T08:51:27.643123+00:00`), as they already are for
  every other command that reads through a function. Same instant; the text output is unchanged.

## Review focus

1. A scoped read given another project's id answers exactly as for an id that does not exist. Test per function.
2. `scope` as `[]`, as a string, as an object: nothing is returned. Tested on `_in_scope`.
3. A session row with no project (the relay's row before `cb iam`) is invisible under any scope. Tested.
4. `cb assign #3 Omar` still refuses a wrong-case name (`user_get` matches exactly). Covered by the existing suite
   plus one assertion.
5. `cb github add` on a repo already watched keeps its checkpoint (`since`, `prs`). Existing test; re-run.

---

### Task 1: scope helper and the read functions

**Files:** Modify `db/schema.sql` (new section "reads for the CLI" after "teammates' devices"; drop lines in the
drop block). Create `test/reads.test.ts`.

**Produces** (all `returns jsonb`, `stable`, `null`/`[]` when nothing is visible):

| Function | Returns |
|---|---|
| `cb._in_scope(project text, scope jsonb) returns boolean` | `scope is null`, or scope is an array holding `project` |
| `cb.session_at(machine text, pane text)` | `{actor, project, live}` |
| `cb.session_of(actor text, scope)` | `{project, live}` of the name's latest row |
| `cb.task_peek(id bigint, scope)` | `{id, project, status, triagers}` |
| `cb.task_show(id bigint, scope)` | the task row plus `notes` (10, newest first) and `goals` |
| `cb.projects_summary(scope)` | `[{slug, next, doing, live}]` |
| `cb.queue_head(project text, actor text, n int default 3, scope)` | `[{id, priority, title, labels, project, assignee}]`, in `cb.task_claim`'s order |
| `cb.questions_asked(actor text, sent_back boolean default false, scope)` | `[{id, status, body}]` |
| `cb.released(blocker bigint, scope)` | `[{id, status, blocked_on, waits}]` |
| `cb.user_get(name text)` | `{name, display, role}`, exact name |
| `cb.users_overview()` | `[{name, display, role, open_questions, open_tasks}]` |
| `cb.huddle_show(id bigint, scope)` | `{huddle, lines, members}` |
| `cb.session_show(who text, scope)` | `{tasks, questions, events}` |
| `cb.question_peek(id bigint, scope)` | `{id, parent_id, if_answer, assigned_display}` |
| `cb.question_parents(ids jsonb, scope)` | `[{id, body, answer}]` |
| `cb.github_list()` | `{repos: [{key, value}], muted: [...]}` |

- [ ] Write `test/reads.test.ts`: one test per function for its shape with `scope` null, and one isolation test per
  scoped function (projects `a` and `b`, scope `["a"]`: `b`'s rows absent, and `b`'s id answers like a missing id).
- [ ] Run it: every test fails with "function cb.… does not exist".
- [ ] Write the functions.
- [ ] Run it: green. Re-run `db/setup.ts --test` twice: no error (idempotent).
- [ ] Commit.

### Task 2: the GitHub writes

**Files:** Modify `db/schema.sql`. Tests in `test/reads.test.ts`.

**Produces:** `cb.github_watch(repo text, to_actor text default null, project text default null) returns jsonb`
(the row's value; new rows: `since` now in `YYYY-MM-DDTHH:MM:SS.mmmZ`, `to` default `orch@shaltoot`, project default
`ihop` through `cb.read_project`; an existing row changes only what was given);
`cb.github_unwatch(repo text) returns void`; `cb.github_mute(login text, mute boolean default true) returns jsonb`
(the sorted list). Each starts with `cb.dashboard_only('GitHub')` and turns its refusal into the CLI's present
wording.

- [ ] Tests: refused without `cb-web` (message matches, names neither `cb-web` nor `PGAPPNAME`); add, re-add keeps
  `since`; unknown project; unwatch twice; mute twice, unmute a login not muted.
- [ ] Watch them fail, write the functions, watch them pass. Commit.

### Task 3: the CLI uses them

**Files:** Modify `server/rpc.ts` (`CLI_FUNCTIONS`, `callCli`), `cli/cb.ts` (every raw statement), `test/reads.test.ts`
(structure tests), `docs/guardrails.md`, `CLAUDE.md` (one line under "How the code is written").

**Interfaces:** `callFn(fn, args, db = sql, allowed = RPC_FUNCTIONS)`; `callCli(fn, args)` allows
`RPC_FUNCTIONS` plus `CLI_FUNCTIONS` (the 18 above, `read_project`, `resolve`).

- [ ] Tests first: `cli/cb.ts` contains no `` sql` ``, `` tx` `` or `sql.begin`; no `CLI_FUNCTIONS` name is in
  `RPC_FUNCTIONS`; `callFn('task_show', …)` is refused (404) while `callCli` answers; every name in both lists exists
  in schema `cb`.
- [ ] Watch them fail. Replace the statements. Watch them pass.
- [ ] Run `test/cli.test.ts`, `github`, `questions`, `followup`, `sendback`, `people`, `projects`, `relay`, `help`,
  `tasks`, `epics`, `goals`, `memory`, `asks`: green.
- [ ] Full suite; compare the failures with the base commit's four environment failures.
- [ ] Update the register row for the CLI's raw reads; commit; push.
