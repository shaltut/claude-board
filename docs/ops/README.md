# Claude Board: what it is and how it fits together

The knowledge base for whoever runs the board: Ahmed, and the Claude agent that maintains it on the VPS.

| Read | For |
|---|---|
| this page | what the board is, its parts, who can do what, what must never happen |
| [deploy.md](deploy.md) | putting it on a VPS, and moving the live board there from Ahmed's PC |
| [maintain.md](maintain.md) | the day to day: status, logs, upgrades, backups and restores, users, secrets, troubleshooting |
| [../users.md](../users.md) | users and sign-in, as Ahmed uses them |
| [../../CLAUDE.md](../../CLAUDE.md) | changing the code |

## What it is

A kanban board, a question queue and a message bus for about 20 Claude Code sessions that work for Ahmed (Director of
Engineering, TachyHealth) across his projects. The sessions take tasks, ask Ahmed questions instead of stopping, tell
each other things, and record what they did. Ahmed answers on the web board, or on Telegram; a few teammates (Omar,
Iman) sign in to answer the questions he hands them. A watcher turns activity on the iHop GitHub repos into cards.

It began on Ahmed's Windows PC. Now it runs on a VPS, always on, reachable from anywhere over HTTPS, so the sessions on
his PC and MacBook and the people he shares it with all use one board.

## The parts

```
  Ahmed, Omar, Iman (browsers, Telegram)              Claude sessions on the PC and the MacBook
          │ HTTPS                                             │ cb CLI + relay, Postgres protocol over Tailscale
          ▼                                                   ▼
  ┌── VPS (vps2) ──────────────────────────────────────────────────────────────────┐
  │  Nginx Proxy Manager :443 ──► board :4747 ────────► Postgres 16 :5434           │
  │                                          (container)        (container, volume) │
  │                                          Telegram bot ─► api.telegram.org       │
  │                                          GitHub watch ─► api.github.com (gh)    │
  └────────────────────────────────────────────────────────────────────────────────┘
```

- **Postgres** (`claude_board`, schema `cb`): the whole board. Every rule is a SQL function (`cb.task_add`,
  `cb.ask`, `cb.answer`, ...) in `db/schema.sql`, so the web, the CLI, Telegram and psql all go through the same code.
  Writes record who did them (the *actor*) and land in `cb.events` (History). Changes NOTIFY channel `cb`.
- **The board server** (`server/main.ts`, Hono on Node 24, port 4747): serves the UI (`web/dist`), the HTTP API
  (`/api/*`, `/api/rpc/<function>`), live updates (`/api/stream`, server-sent events fed by LISTEN `cb`) and
  `/healthz`. It also runs two pollers, on whichever server holds the poller lock (one per board):
  - the **Telegram bot** (`server/telegram.ts`): pushes Ahmed's open questions, takes his answers;
  - the **GitHub watch** (`server/github.ts`): every 3 minutes, `gh api` for each repo `cb github` lists; one card per
    PR, one short message per poll to orch. GitHub text is always marked untrusted.
- **The `cb` CLI** (`cli/cb.ts`, `cb help`): how sessions use the board. It talks to Postgres directly
  (`CB_DATABASE_URL`), so it runs on the worker machines, not on the VPS.
- **The relay** (`cli/relay.ts`): one per session, started by the SessionStart hook; LISTENs and pushes answers and
  messages into that Claude Code session as they happen.
- **Hooks** (`hooks/`): `deny-ask.mjs` turns Claude's AskUserQuestion into `cb ask`; `session-start.mjs` points new
  sessions at `cb start`.

## Who can do what

**People sign in** (`/login`). Accounts are rows of `cb.users`:

| Role | Gets | Signs in with |
|---|---|---|
| **admin** | the whole board, acting under their own name | password only |
| **member** | only the questions and tasks handed to them, on their projects | password, or a private link |

Ahmed is the owner: the user `ahmed`, always an admin, never removable. What he does on the board is recorded as
`ahmed`, which the sessions read as his decision. Another admin acts as themself (an answer from Omar says "omar (not
Ahmed) answered"). The Users page (key 7) manages accounts. The first admin on a new server is made from the VPS
shell ([deploy.md](deploy.md#4-the-first-admin)).

**Machines are trusted by their database password.** A session's `cb` connects to Postgres as `cb` with the password,
over Tailscale. That is full access: whoever has the password can read and change anything, and can act as the
dashboard (`PGAPPNAME=cb-web`). That last name is a guard against sessions acting as Ahmed by mistake, not a
security boundary. So the database password goes only to Ahmed's own machines (the PC, the MacBook, the VPS), and
Postgres listens only on the VPS's Tailscale address.

**Sessions are named, not authenticated.** A session's actor is `W3@macbook`, `orch@shaltoot` and so on. Only a
signed-in admin (or the dashboard on Ahmed's PC, before the move) can act as `ahmed`.

## Security, in one place

- Passwords: bcrypt (pgcrypto, cost 10), at least 8 characters. The cookie `cb_user` is HttpOnly, SameSite=Lax, and
  Secure when the proxy says `X-Forwarded-Proto: https`. 5 wrong passwords for one name from one address lock that
  pair for 2 minutes (the address is the last X-Forwarded-For hop, the one the proxy adds; `cf-connecting-ip` only
  with `CB_BEHIND_CLOUDFLARE=1`, since a client reaching nginx directly could send it).
- CSRF: a POST whose `Origin` is not the board's own `Host` is refused. The proxy must pass `Host` through unchanged.
- An admin's token (their cookie) is never shown or sent anywhere; a member's link is their token, shown only on the
  Users page, to admins.
- A teammate's device token (not in use yet) is shown once and stored only as a SHA-256 hash (`cb.devices`); backups
  hold the hashes.
- The server trusts "plainly local" requests only on Ahmed's PC (HOST on loopback, no proxy headers). In the container
  `HOST=0.0.0.0` and `CB_TRUST_LOCAL=0`, so everyone signs in.
- Secrets live in `deploy/.env` on the VPS (mode 600, git-ignored): the database password, the Telegram bot token, the
  GitHub token. Never in the repo, the image, a log, a card or a message.
- The board holds client work (iHop cards, GitHub comments, questions about clients). Backups stay on the VPS or
  Ahmed's machines. No patient data belongs on the board, and none should be put there.

## Never

- Never truncate, seed or test against the live database. Tests use only `claude_board_test*` databases, and the
  suite runs on the PC or the Mac, never on the VPS (`test/helpers.ts` refuses any other name).
- Never run two board servers that both poll (the poller lock prevents it; don't work around it).
- Never print or paste `deploy/.env`, a token, a password or a member's link.
- Never expose Postgres or port 4747 on a public address.
- Never act as `ahmed` from a script or a session.
