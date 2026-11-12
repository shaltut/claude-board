# Teammates' sessions on the board: design

Status: **design approved by Ahmed 2026-11-12.** Nothing here is built. Branch `multi-user-sessions`, worktree only; the live
checkout (`vps`) is untouched. Ahmed's decisions of 2026-11-12 are in section 8; everything marked *(my call)* is the
author's default and can be overruled.

## 1. Intent

The board now runs on the VPS, always on, tied to no one machine. Today every Claude session on it is Ahmed's: about
20 sessions on his PC and MacBook. Teammates (Omar, Iman, Asmaa, Kamel) exist only as people who answer questions he
hands them in a browser.

Next: a teammate connects **their own Claude sessions, from their own machine, under their own user**, and those
sessions take work, ask, log and talk on the board like Ahmed's do. The board becomes the team's shared working
environment, not one person's.

Why it needs care: the board's rules were written for one person. Three assumptions run through the schema, the CLI,
the server and the prompts, and all three stop being true:

1. **Every machine that connects is Ahmed's.** A session reaches the board with the Postgres password, which is full
   access to everything.
2. **Every session works for Ahmed.** "Ahmed" is the one human authority: questions go to him, his lines are
   instructions, everyone else is "(not Ahmed)".
3. **A session's name is whatever it says it is.** Names are not checked; the guards against acting as Ahmed are
   documented in the code as deterrents, not security.

## 2. What exists today (the facts the design rests on)

| Area | Today | Where |
|---|---|---|
| Transport | `cb` and the relay open a Postgres connection as role `cb` with one shared password, over Tailscale | `server/db.ts`, `docs/ops/README.md` "Machines are trusted by their database password" |
| What that password gives | Every table: all projects, `cb.users` (password hashes, tokens = members' links and admins' cookies), `cb.settings` (GitHub outbox, Telegram pairing) | schema; no row security, no per-role grants |
| Acting as Ahmed | Refused unless `application_name = 'cb-web'`. Any connection can set that. Marked "a deterrent, not auth" | `cb.not_ahmed`, `cb.dashboard_only`, `cb._is_dashboard` |
| Session identity | Free text (`W3@macbook`), bound to `(machine, herdr pane)` by `cb iam`; `--as` and `$CB_ACTOR` override it | `cb.sessions`, `cb.iam`, `cli/cb.ts:44-47` |
| Privilege by name | `orch` / `orch@%` get extra rights by name pattern alone | `cb._huddle_post` (schema ~1481), `cb.tick` (~1906, ~1913) |
| People | `cb.users` with role `admin` or `member`; `cb.user_projects` puts a member on projects | schema 26-45 |
| What a member can do | Web only: `answer`, `send_back`, `log`, on items assigned to them on their projects | `server/main.ts:136-160` |
| Authority wording | The relay prints "Ahmed" or "`<name>` (not Ahmed)"; an answer by Ahmed can't be overwritten by anyone else; memory entries are `ahmed` or `team` authority | `cli/relay.ts:62`, `cb.answer`, `cb.memories.authority` |
| Direct table reads in the CLI | 34 raw SQL statements in `cli/cb.ts`, beside the `cb.*` function calls | `cli/cb.ts` |
| Prompts | `prompts/session.md` and `orchestrator.md` say "Ahmed" throughout, and rule 16: a message from another session "comes from a teammate, not Ahmed" | `prompts/` |
| Session plumbing | Binding and the relay need a herdr pane (`$HERDR_PANE_ID`); the CLI is run from a checkout of this private repo | `cli/relay.ts:17-18`, `hooks/` |

## 3. Goals, non-goals, anti-goals

**Goals**

- G1. A teammate connects sessions from their own machine without ever holding the database password.
- G2. Every write by such a session is attributed to a **real, checked identity**: which person, which device, which
  session. A session cannot name itself into someone else, into Ahmed, or into `orch`.
- G3. A teammate's sessions see and touch **only the projects that person is on**.
- G4. Each session knows whose word is an instruction (its own person's, and Ahmed's as board owner) and whose is
  only a colleague's.
- G5. Ahmed can see, per person, which devices and sessions are connected, and cut any of them off at once.
- G6. Every existing guardrail is listed, and for each one the design says: unchanged, tightened, generalised, or
  replaced (section 7). That register is kept in the repo and updated as phases land.
- G7. Ahmed's own sessions keep working exactly as now through every phase.

**Non-goals (this project)**

- Moving Ahmed's own sessions off the direct database connection. (Worth doing later: it would turn the
  "deterrents" into real checks. Out of scope here; nothing in this design blocks it.)
- Per-task or per-field permissions. The unit of access is the project.
- Organisations, teams of teams, billing, self-sign-up. People are still added by an admin.
- Changing Telegram (it stays Ahmed's) or the GitHub watch.

**Anti-goals (a failure even if it works)**

- A teammate's machine, or a prompt-injected session on it, can read another client's project, a user's link, a
  password hash, or a secret.
- A teammate's session can speak as Ahmed, as another person, or as an orchestrator, or have its text land in
  someone else's session looking like an instruction.
- The live board is disturbed during the build: a restart without Ahmed's go, a schema change that alters existing
  behaviour, tests run on the VPS or against the live database.
- Client data starts flowing to a new machine without that being an explicit, recorded decision by Ahmed.

## 4. The approach

### 4.1 Teammates' sessions come in through the board server, not Postgres *(my call)*

The server is already the place where people are authenticated and scoped. Teammates' sessions use the same door:
`cb` gains a second transport, HTTPS to `https://board.shaltoot.cloud/api/session/*`, with a per-device token.
The server works out who is calling, sets the actor itself, and applies the project scope.

Considered and dropped:

- **A Postgres role per person, with row security.** It is what the schema's own comment calls "real auth", but
  it needs every teammate on the tailnet, Postgres exposed to machines Ahmed doesn't own, and row security retrofitted
  across ~200 functions and 34 raw reads, where one missed policy leaks a client's project. The failure mode is silent.
- **Handing teammates the shared password with stricter prompts.** Fails anti-goals 1 and 2 outright.

Consequence: Postgres stays Tailscale-only and Ahmed's machines-only. Teammates need no VPN. The "Never expose
Postgres" rule gets stronger, not weaker.

Ahmed's sessions keep the direct transport. The CLI picks one by configuration: a database URL (as now) or a board
URL plus a device token. Same commands, same help.

### 4.2 Identity: person → device → session

New tables (additive; no existing column changes meaning):

- `cb.devices`: `id`, `user_name` → `cb.users`, `label` (machine name, unique per user), `token_hash` (SHA-256;
  the token itself is shown once and never stored), `created_at`, `last_seen`, `revoked_at`.
- `cb.sessions` gains `user_name` (null = an owner's-machine session, as today) and `device_id`.
- `cb.events` gains `owner` (the person the actor belongs to; null for the past and for Ahmed's direct sessions), so
  History can be read per person.

A teammate's session actor is **composed by the server**: `<role>@<device label>`, where the device label is
registered to that person and `<role>` is chosen by the session from an allowed pattern (`W<n>`, or a short name).
`orch` is refused unless the person has been made an orchestrator on that project (section 4.4). Names containing
`ahmed` stay reserved. `--as` works only for names on the caller's own devices.

Connecting a machine *(my call)*: the person signs in to the board in a browser, opens "My devices", and creates a
device, which shows a one-time token and the one-line setup command. Ahmed (or any admin) sees every person's
devices on the Users page. A device-code flow (`cb login` prints a code to approve in the browser) is a nicer later
step; not needed for the pilot.

A per-person switch **"can connect sessions"** (off by default) decides who may create devices at all. Roles stay
`admin` and `member`: no third role. *(my call)*

### 4.3 What a teammate's session may do

Through `/api/session/rpc/<fn>`, with a **separate allow-list** from the dashboard's, never run as `cb-web`:

| Allowed, scoped to the person's projects | Refused |
|---|---|
| tasks: add, claim/next (see 4.4), move, edit, done, log, tag, block/unblock | users, roles, links, passwords, projects on people |
| questions: ask, reask, withdraw, pending, delivered | answering as anyone; "already ruled" answers |
| tell, huddles, broadcast within the project | epics and goals: create, close, delete (Ahmed's, as now) |
| memory: add (as `team`), find, list, show, pack | memory: rule, confirm, retire an `ahmed` entry |
| iam, inbox, mine, brief, sessions (their projects only) | settings, GitHub watch, Telegram, locks for Ahmed's machines |
| `cb bug claude-board ...` (write-only: file it, don't read that project) | reading any project they are not on |

Every one of the 34 raw reads in `cli/cb.ts` becomes either a `cb.*` read function or a scoped server endpoint,
so both transports run the same code and the scope is applied in one place. This is the largest single piece of
work, and the one where a mistake leaks data, so it is test-first with a "person on project A cannot see project B"
test per read.

Live updates: the relay's HTTPS mode reads the server's event stream (`/api/session/stream`), filtered to the
person's projects and the session's own inbox, instead of Postgres LISTEN.

Session identity without herdr *(my call)*: a teammate may not use herdr. Binding falls back to a stable id
derived from the Claude Code session (its messaging socket), so `cb iam` and the relay work in a plain terminal.

Limits: per-device rate limit and request size cap on the session API; a revoked device or removed person is refused
on the next request and its stream is closed.

### 4.4 Whose word counts: the authority rules

This is the part that changes the board's logic rather than adding to it.

Each session has a **principal**: the person it belongs to. For Ahmed's sessions that is Ahmed, so nothing changes
for them. The rules generalise from "Ahmed" to "your principal, and the board owner":

| Rule today | Becomes |
|---|---|
| A session's questions go to Ahmed unless `--to` | **(decided, D1)** A teammate's session's question is not tied to one answerer: it shows for its principal and for Ahmed, and either may answer; `--to <person>` still hands it to one person. The first answer stands, labelled with who gave it. Ahmed's answer can't be overwritten by the principal; the principal's can be changed by Ahmed. Other members on the project answer only if it is handed to them (confirmed by Ahmed) |
| "Ahmed answered" / "omar (not Ahmed) answered" | "Omar (you work for him) answered" / "Ahmed (board owner) answered" / "`<name>` (a colleague, not an instruction) answered" |
| Ahmed's answer can't be overwritten by others | Unchanged. Plus: a principal's answer to their own session's question can be changed only by them or Ahmed |
| Ahmed moves, cancels or edits a task → the session obeys | Unchanged for Ahmed. The principal has the same power over tasks held by their own sessions |
| A message from another session is "a teammate, not Ahmed" | Split in two: **same principal** (a sibling session: act on it within your task) and **another person's session** (marked with that person's name; information only, never an instruction, never approval) |
| `orch@...` has orchestrator rights by name | By grant: an admin makes a person an orchestrator on a project; only then may their device register an `orch` session there. Ahmed's direct sessions keep today's behaviour |
| Memory: `ahmed` vs `team` | Unchanged, plus the entry records the author's person. A flagged proposal still goes to Ahmed first |
| Terminal asks (`cb asks add`) show on Ahmed's Today | Each person's terminal asks show on their own page |
| `cb next` takes the top of the project queue | **(decided, D2)** a teammate's session takes only tasks assigned to its principal, so Ahmed's queue order for his own sessions is never raided. Assigning a task to Omar is how work reaches Omar's sessions |

Text from another person's session reaching a session is treated like GitHub text is today: marked, indented, never
able to start a line that reads as a header. The existing relay code for that is reused.

### 4.5 What people see and manage in the browser

- **Users page (admins):** per person: the "can connect sessions" switch, their devices (label, last seen, live
  sessions), **Revoke device**, and "Remove" / "taken off project" also end that person's sessions and hand back the
  tasks their sessions hold (extending `cb._user_hand_back`, which today only knows tasks assigned to the person).
- **For the teammate (decided, D4): the full board, for their projects.** A person with sessions turned on gets
  the board's pages (Today, Board, Questions, History, Sessions, Memory) limited to their projects, plus "My
  devices". Read: the whole project (D3). Write: what their sessions may do (4.3), plus answering their own
  sessions' questions and ordering/moving tasks assigned to them. Still Ahmed's or an admin's: Users, epics, goals,
  Telegram, GitHub watch, other people's tasks. Every `/api/*` read the pages use gets the same project scope as the
  session API, enforced in the server, never by hiding things in the page. A member without sessions keeps today's
  guest page.
- **History:** filter by person.

### 4.6 Client data

Putting a person on a project already means "work on this project may reach them". With sessions, card text from
that project will be read on their machine and sent to their Claude account. The design makes that explicit rather
than implied: turning on "can connect sessions" for a person shows what it means and records the decision in
History. This is the "OK" the repo's `CLAUDE.md` requires before client data goes anywhere new. No patient data
belongs on the board, as now.

### 4.7 Getting `cb` onto a teammate's machine *(my call)*

Teammates should not need the private repo. The board serves a single-file build of the CLI and relay at a fixed
path, version-matched to the server, with a short install line. The session API carries a version; a CLI that is
too old is told to update. Prompts for teammates' sessions are served the same way, with the person's name filled in
where today's say "Ahmed".

## 5. Constraints

- Schema is idempotent and applied on container start: every change here is additive (`create table if not exists`,
  `add column if not exists`), so starting the new image never rewrites existing rows.
- Schema before code; merge and deploy only with Ahmed's go; never a second polling server.
- **Tests never run on the VPS.** The suite needs the PC's or the Mac's Postgres. So this worktree is where the
  design lives; the build itself happens in a worktree on the PC or Mac from this branch.
- The whole feature sits behind one board setting (`sessions_api`, off by default). Off = the routes answer 404 and
  nothing else differs from today.
- Rules live in SQL; the server and CLI stay thin. Scope checks that can live in a `cb.*` function do.
- No new dependency without a reason.

## 6. Phases (each one releasable on its own, with the feature off until the pilot)

1. **Register and decisions.** This document approved; `docs/guardrails.md` created from
   section 7.
2. **Identity foundation.** `cb.devices`, the new columns, device create/revoke functions, the "can connect
   sessions" switch. No route uses them yet. Existing sessions unaffected.
3. **Read functions.** The 34 raw reads become `cb.*` functions used by the existing direct transport first. Pure
   refactor: the proof is the existing suite staying green.
4. **Session API and CLI transport.** Token auth, allow-list, scope, stream, rate limits; relay over HTTPS;
   binding without herdr. Isolation tests per function.
5. **Authority rules.** Principal on sessions; question routing; relay wording; cross-person marking; orchestrator
   grant; hand-back on revoke.
6. **Browser.** Users page devices; the scoped board for teammates (every existing `/api/*` read scoped and tested
   for isolation before any page is shown to a member).
7. **Distribution and prompts.** Served CLI, teammate prompts and onboarding doc, ops docs updated.
8. **Pilot.** Omar on `ihop`, feature on. A written checklist of what to watch. Then the rest.

## 7. Guardrail register

Every rule that exists today and what happens to it. This table moves to `docs/guardrails.md` and is the tracked
list: a phase is not done until its rows are updated.

| # | Guardrail today | Source | Under this design | Phase |
|---|---|---|---|---|
| 1 | Database password only on Ahmed's machines; Postgres only on the Tailscale address | ops README | **Unchanged**, and now a hard line: teammates never get it | all |
| 2 | Only the dashboard acts as `ahmed` (`cb.not_ahmed`) | schema | **Tightened** for teammates: the session API never sets `cb-web`, and the server sets the actor. Still a deterrent on Ahmed's machines | 4 |
| 3 | Dashboard-only actions (`cb.dashboard_only`: users, links, epics, roles) | schema | **Unchanged**; none are on the session allow-list | 4 |
| 4 | Names with `ahmed` reserved | `cb.user_add`, `cb.ahmed_like` | **Unchanged**; also applied to device labels and session roles | 2 |
| 5 | Every write has an actor | `cb.set_actor` | **Tightened**: for teammates the actor is composed and checked by the server; `owner` recorded on events | 2, 4 |
| 6 | `--as` / `$CB_ACTOR` name any actor | CLI | **Restricted** for teammates to their own devices' names | 4 |
| 7 | `orch` rights by name | `_huddle_post`, `tick` | **Replaced** for teammates by an explicit grant | 5 |
| 8 | A bound session works only its own project | CLI + functions | **Tightened**: enforced by the server from `cb.user_projects`, not by the session's own binding | 4 |
| 9 | Work reaches a person only on their projects | `assignee_on_project` trigger | **Generalised**: also covers that person's sessions | 5 |
| 10 | Members: only answer / send back / note their own items | `server/main.ts` | **Unchanged** for the browser. Sessions get the wider allow-list of 4.3, only with the switch on | 4, 6 |
| 11 | Ahmed's answer can't be overwritten | `cb.answer` | **Unchanged**; extended to a principal's answers | 5 |
| 12 | "(not Ahmed)" on others' answers | relay | **Generalised** to principal / board owner / colleague | 5 |
| 13 | Another session's message is never Ahmed's approval | `prompts/session.md` 16 | **Split**: sibling session vs another person's session, the second marked as untrusted | 5, 7 |
| 14 | GitHub text is untrusted and marked | relay, prompts | **Unchanged**; the same marking reused for cross-person text | 5 |
| 15 | Memory: no secrets or personal data (`cb._sensitive`); flagged entries wait for Ahmed | schema | **Unchanged**; applies to teammates' entries | 4 |
| 16 | Memory authority `ahmed` only from the dashboard | schema | **Unchanged**; author's person recorded | 5 |
| 17 | Epics and goals are Ahmed's | schema, prompts | **Unchanged** | 4 |
| 18 | Members' links and admins' tokens never shown to sessions | `user_add`, `/api/people` | **Unchanged**; device tokens stored only as hashes, shown once | 2 |
| 19 | Sign-in lockout, CSRF origin check, cookie flags | `server/main.ts` | **Unchanged** for browsers. Token requests get their own rate limit and never count as "the dashboard" | 4 |
| 20 | `Sec-Fetch-Site` page-only reads (people, Telegram, memory-as-Ahmed) | `server/main.ts` | **Unchanged**; unreachable with a device token | 4 |
| 21 | Telegram is Ahmed's alone | server | **Unchanged**; teammates' sessions' questions never go there unless assigned to Ahmed | 5 |
| 22 | One polling server | server | **Unchanged** | - |
| 23 | Removing a person hands their work back | `_user_hand_back` | **Extended**: also revokes devices, ends sessions, hands back tasks held by their sessions | 5 |
| 24 | The DB test lock (`cb lock`) | schema | **Kept to Ahmed's machines**: refused on the session API | 4 |
| 25 | Never truncate / seed / test against the live database; tests never on the VPS | CLAUDE.md | **Unchanged**; governs how this is built | all |
| 26 | Never print `.env`, a token, a password, a link | CLAUDE.md | **Unchanged**; device tokens join the list | all |
| 27 | No restart, merge or deploy without Ahmed's go | CLAUDE.md | **Unchanged** | all |
| 28 | No client data anywhere new without his OK | CLAUDE.md | **Made explicit**: the per-person switch is that OK, recorded | 2, 6 |
| 29 | Backups stay on the VPS or Ahmed's machines | `deploy/backup.sh` | **Unchanged**; dumps now also hold device token hashes | - |

Known weaknesses this design does **not** fix, listed so they are not mistaken for fixed: the `cb-web` deterrent on
Ahmed's own machines; `cb.users.token` stored in plain text (it is the cookie and the member link).

## 8. Ahmed's decisions (2026-11-12)

- **D1. Who answers a teammate's session?** Not one fixed person: its principal or Ahmed, whoever answers first
 .
- **D2. What may it take from the queue?** Only tasks assigned to its person.
- **D3. How much of a project does it read?** All of it: tasks, history, huddles, memory, other sessions' logs, and
  answered questions there.
- **D4. Browser view in v1:** the full board, for their projects.
- **D5. Pilot:** Omar, on `ihop`.

## 9. Left to the builder

File layout for the session routes; the exact shape of the read functions; token format and length; the stream's
filtering implementation; rate-limit numbers; the CLI bundling tool; UI layout of the devices list. All inside the
repo's existing conventions (`CLAUDE.md`: rules in SQL, idempotent schema, tests first, help entry per command).
