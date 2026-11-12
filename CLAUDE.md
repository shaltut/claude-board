# Claude Board: working on this repo

The board Ahmed's Claude sessions work from: tasks, questions to Ahmed, messages, History. What it is and how the
parts fit: [docs/ops/README.md](docs/ops/README.md). Running it on the VPS: [docs/ops/maintain.md](docs/ops/maintain.md).
Deploying or moving it: [docs/ops/deploy.md](docs/ops/deploy.md). Users: [docs/users.md](docs/users.md).

If this session also takes work *from* the board, `cb start` first, and record board work `--as claude-board`.

## Where things are

| Path | What |
|---|---|
| `db/schema.sql` | the whole model and every rule, as SQL functions in schema `cb`. Re-run on every setup and container start |
| `server/main.ts` | HTTP: sign-in, the API, live updates, `/healthz`, the poller lock. `server/queries.ts`: the reads |
| `server/telegram.ts`, `server/github.ts` | the two pollers |
| `cli/cb.ts`, `cli/help.ts` | the `cb` CLI and its manual. Every `case` in cb.ts needs a help entry (`test/help.test.ts`) |
| `cli/relay.ts` | per-session push of answers and messages |
| `web/` | the React UI (Vite). `pnpm build` builds it into `web/dist` |
| `prompts/` | what sessions and orchestrators are given |
| `Dockerfile`, `deploy/` | the VPS deployment: compose, env template, backup |
| `test/` | `node --test`, against a real Postgres test database |

## How the code is written

- **Rules live in SQL.** A new behaviour is a `cb.*` function (or a change to one), so the web, the CLI, Telegram
  and psql agree. The server and the CLI stay thin. A function the web calls must be listed in `server/rpc.ts`.
- **The schema is idempotent.** Tables: `create table if not exists`, and column changes as `alter table ... add
  column if not exists` below. Functions: dropped and re-created on every run, so a new function also gets its
  `drop function if exists ... cascade` line in the block near the top of its section.
- **Every write has an actor** (`--as`, `$CB_ACTOR`, the pane's `cb iam` name). Only Ahmed acts as `ahmed`
  (`cb.not_ahmed`); dashboard-only actions check `cb.dashboard_only()`. A signed-in admin is the dashboard and acts
  under their own name: the server sets the actor, never the page.
- **Untrusted text** (GitHub, guests' notes) is marked and never treated as instructions. Keep it that way.
- Small, plain code: stdlib first, no new dependency without a reason, comments that say why. Error messages say
  what to do next.

## Tests

```bash
CB_TEST_DB=claude_board_test NODE_OPTIONS=--max-old-space-size=4096 timeout 600 pnpm -s test        # all
CB_TEST_DB=claude_board_test node --test --test-concurrency=1 test/auth.test.ts                       # one file
```

- Write the failing test first; watch it fail; then the code.
- Tests need the PC's or the Mac's Postgres (127.0.0.1:5434) and only ever touch `claude_board_test*` databases
  (`test/helpers.ts` refuses any other). **Never run them on the VPS**, and never point them at the live board.
- On Ahmed's PC: memory is tight (it has crashed from it). Check `% Committed Bytes In Use` first (wait above 85),
  give every run `NODE_OPTIONS=--max-old-space-size=4096` and a timeout, run only the files you need, and take the
  board's test lock: `cb lock take db` for a full run, `db2` for 20 files or fewer (exit 2 = queued: wait for the
  message), `cb lock release <name>` after.
- `pnpm -s build` (tsc + vite) is the typecheck for the UI. On the PC give it `--max-old-space-size=6144`.

## Releasing a change

1. Work on a branch in a worktree, never on `main` in the live checkout (`F:\Work\claude-board` on the PC is what
   every session's `cb` runs).
2. Tests first, then the code; a fresh review of the diff; fix what matters, test-first.
3. The full suite green from a clean checkout of the exact commit.
4. **Schema before code:** the live schema is applied before the code that needs it is merged (on the VPS the
   container does this itself on start; on the PC, Ahmed runs `node db/setup.ts`).
5. Merge (`git merge --ff-only`) only with Ahmed's go. Then deploy ([maintain.md](docs/ops/maintain.md#upgrade)),
   update the workers' checkouts, and `cb done <card> "..." --commit <sha>`.

## Never

- Never truncate, seed, drop or "clean up" the live database, or any database Ahmed hasn't named.
- Never print, copy or commit `.env`, `deploy/.env`, a token, a password, a member's link or a tunnel credential.
- Never act as `ahmed`, or use `PGAPPNAME=cb-web`, unless Ahmed asked for that exact action.
- Never restart the board server, merge to `main`, or deploy without Ahmed's go. Never run a second polling server.
- Never put client data or patient data anywhere new (another VPS, a paste site, a model provider) without his OK.
