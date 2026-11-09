# Claude Board

A local kanban board for Claude sessions: tasks, backlog, history, and questions from Claude to
Ahmed. Everything lives in a local Postgres; the UI and the `cb` CLI are views onto it.

## Run it

```bash
pnpm i && pnpm run setup && pnpm start
```

Open http://localhost:4747.

- `setup` creates a private Postgres cluster in `.pgdata/` (port 5434, trust auth, user `cb`),
  applies `db/schema.sql`, and puts `bin/` on your user PATH so `cb` works anywhere.
  Re-running it is safe; it re-applies the schema.
- `start` starts Postgres if it is down, builds the UI if `web/dist` is missing, and serves on 4747.
- `pnpm seed` loads synthetic demo projects; `node db/seed.ts --remove` deletes them.
- `pnpm dev` runs the Vite dev server (proxies `/api` to 4747; run `pnpm start` alongside).
- `pnpm test` runs the suite against the `claude_board_test` database.

## The `cb` CLI

| Command | What it does |
|---|---|
| `cb brief [project]` | In progress, next, blocked, and questions waiting on Ahmed |
| `cb next [project]` | Claim the top task in Next (sets in_progress, assigns you) |
| `cb mine` | Your tasks. Re-check between steps; obey moves and cancels |
| `cb add <project> "<title>" [-s next] [-p P1] [-b body] [-l a,b] [--link k=v]` | New task |
| `cb move <id> <status> ["note"]` | backlog, next, in_progress, blocked, review, done, cancelled |
| `cb done <id> "summary" [--pr x] [--commit x] [--branch x]` | Finish with a summary and links |
| `cb edit <id> [--title x] [--body x] [--priority P1] [--assignee x]` | Edit fields |
| `cb log <project> "what happened" [-t id]` | A note in the history |
| `cb ask <project> "question" [-o "Label=why"]... [--multi] [-c ctx] [--blocking -t id]` | Ask Ahmed without stopping |
| `cb pending [project]` | Answered questions waiting to be delivered (orchestrator) |
| `cb delivered <qid> [session]` | Mark an answer delivered; unblocks its task |
| `cb withdraw <qid>` | Withdraw a question |
| `cb tick [project]` | The actions due now, ranked, one command each; prints nothing when nothing is due (orchestrator). PRs: `links.pr` URL, or `#N` with `GITHUB_REPO_<PROJECT>=owner/repo` in `.env` |
| `cb lock take\|release <name>`, `cb lock queue [name]` | Shared locks (the DB test lock): take queues you; release hands it to the next |

Every write records who did it. The actor is `--as <name>`, else `$CB_ACTOR`, else
`<herdr pane>@<host>`. Add `--json` for raw output.

## Prompts

- `prompts/session.md`: paste into a worker session. Registers its work, takes from Next, asks via `cb ask`.
- `prompts/orchestrator.md`: for the orchestrator. Adds delivering answers through herdr.
- `prompts/claude-md-snippet.md`: a short block for a project's CLAUDE.md.

## AskUserQuestion is blocked

`hooks/deny-ask.mjs` is a PreToolUse hook on `AskUserQuestion` in `~/.claude/settings.json`. It
denies the tool and tells Claude to use `cb ask` and keep working, so no session stalls on a
dialog. Set `CB_ALLOW_ASK=1` in a session's environment to allow the native tool there.

## From psql

All logic is SQL functions in schema `cb`, so psql gets the same history and rules as the CLI.

```bash
psql postgres://cb@127.0.0.1:5434/claude_board
```

```sql
select cb.task_add(project => 'demo-api', title => 'Fix retry jitter', status => 'next', actor => 'me@host');
select cb.task_move(id => '42', status => 'review', note => 'ready', actor => 'me@host');
select cb.task_done(id => '42', summary => 'Jitter fixed', links => '{"pr":"#88"}', actor => 'me@host');
select cb.ask(project => 'demo-api', body => 'Bump the SDK?',
              options => '[{"label":"Yes","description":"Drops Node 18"},"No"]', actor => 'me@host');
select * from cb.answers_pending();
select jsonb_pretty(cb.brief('demo-api'));
select * from cb.events order by at desc limit 20;
```

## Over HTTP

`POST /api/rpc/<function>` with named arguments as JSON calls the same functions:

```bash
curl -s localhost:4747/api/rpc/task_add -H 'content-type: application/json' \
  -d '{"project":"demo-api","title":"Fix retry jitter","status":"next","actor":"me@host"}'
```

Reads: `GET /api/projects`, `/api/tasks?project=&status=`, `/api/tasks/<id>`, `/api/questions`,
`/api/events?project=&actor=&kind=&q=&before=`, `/api/today`. Live changes stream on `/api/stream` (SSE).

## Workers on the MacBook

The board's Postgres also accepts the MacBook over Tailscale, from its IP only:

- `.pgdata/postgresql.auto.conf`: `listen_addresses = 'localhost,100.75.18.74'` (this PC's Tailscale IP)
- `.pgdata/pg_hba.conf`: `host claude_board cb 100.78.139.58/32 trust` (the MacBook)

Both live in the cluster, not the repo: a recreated `.pgdata` needs them again. On the Mac,
`~/Work/claude-board` holds a copy of the CLI (`pnpm i --prod`), and `~/.zshrc` sets PATH and
`CB_DATABASE_URL=postgres://cb@100.75.18.74:5434/claude_board`. The deny hook is in the Mac's
`~/.claude/settings.json` too. After changing `cli/`, `server/db.ts`, `server/rpc.ts` or `hooks/`, copy them again.

If this PC is asleep, `cb` on the Mac fails within 5 seconds with "board unreachable" and the
session keeps working.

## Troubleshooting

- **`cb: command not found`** after setup: open a new terminal. PATH changes only reach new shells.
- **Port 4747 in use**: another board is running. Find it with `netstat -ano | findstr :4747`, stop
  that PID, or run on another port with `PORT=4848 pnpm start`.
- **Port 5434 in use**: something else owns it. Stop it, or point `CB_DATABASE_URL` at your own Postgres
  and run `pnpm run setup` again.
- **`cb` says it cannot connect**: it starts Postgres itself and retries once. If that fails, run
  `pnpm start` once from this folder and read the error.
