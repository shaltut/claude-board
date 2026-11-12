# Running the board on the VPS

Everything here runs in `/opt/claude-board/deploy` on the VPS (vps2) unless it says otherwise. `dc` below is
`docker compose`. The https side is Nginx Proxy Manager's proxy host `board.shaltoot.cloud` ([deploy.md](deploy.md#5-https-in-front)).

## Is it up?

```bash
dc ps                                   # db and board: running (healthy)
curl -s localhost:4747/healthz          # {"ok":true}; 503 = the board can't reach Postgres
dc logs --tail 50 board                 # errors, "github: ..." poll failures, Telegram
dc exec board cb github                 # watched repos: last poll should be minutes ago
dc exec board cb sessions               # which sessions are alive
```

For alerts, point an uptime monitor (Cloudflare health checks, UptimeRobot) at `https://<public url>/healthz`.

## Restart

```bash
dc restart board          # the server; sessions and browsers reconnect by themselves
dc restart db             # Postgres; the board and every relay reconnect (give it a minute)
```

Never `dc down -v`: `-v` deletes the database volume (and gh's login).

## Upgrade

A release is: the change merged to `main` (reviewed, the suite green on the PC or Mac), then:

```bash
cd /opt/claude-board && git pull --ff-only
cd deploy && dc up -d --build board     # builds, applies the schema, swaps the container (seconds of downtime)
dc logs --tail 20 board                 # "claude_board ready", then the listen line
```

Then the workers, right away, because their `cb` must match the schema:

- **PC:** `git -C F:\Work\claude-board pull --ff-only`
- **MacBook:** `~/Work/claude-board` is a copy, not a clone. From the PC (Git Bash, in the updated checkout):

  ```bash
  tar czf /tmp/cb.tgz bin cli db prompts server hooks && sum=$(md5sum /tmp/cb.tgz | cut -d' ' -f1)
  scp /tmp/cb.tgz macbook:Work/claude-board/cb.tgz
  ssh macbook "cd ~/Work/claude-board && [ \"\$(md5 -q cb.tgz)\" = $sum ] && tar xzf cb.tgz && rm cb.tgz && zsh -lc 'node cli/cb.ts sessions' | head -3"
  ```

  Extract only when the checksums match: a Tailscale hiccup once delivered half an archive, and a partial extract
  broke every `cb` on the Mac for 15 minutes.
- Relays restart themselves when their code changes.

If the schema change drops or renames a function the old CLI calls, a worker's `cb` fails until it is updated: that
is the window to keep short.

**Rolling back** code: `git checkout <previous sha> && dc up -d --build board`. The schema is applied forward only:
new columns and functions stay, which older code ignores. If an upgrade damaged data, restore the last backup (below).

## Backups

`deploy/backup.sh` runs nightly from root's crontab ([deploy.md](deploy.md#6-backups)): a `pg_dump -Fc` in
`/var/backups/claude-board`, 14 days kept. Run it by hand before anything risky:

```bash
sudo /opt/claude-board/deploy/backup.sh       # prints the file
```

Once a month, prove a backup restores, into a scratch database next to the live one:

```bash
f=$(ls -t /var/backups/claude-board/*.dump | head -1)
dc exec -T db createdb -U cb claude_board_restore_check
dc exec -T db pg_restore -U cb -d claude_board_restore_check --no-owner --exit-on-error < "$f"
dc exec -T db psql -U cb -d claude_board_restore_check -c "select count(*) from cb.tasks"
dc exec -T db dropdb -U cb claude_board_restore_check
```

Copy dumps off the VPS only to Ahmed's own machines (the PC or the Mac): they hold client work.

## Restore

The board goes back to the dump; everything after it is lost. Take a fresh backup first if the current state matters.

```bash
sudo /opt/claude-board/deploy/backup.sh                 # what is there now, just in case
dc stop board
dc exec -T db dropdb -U cb claude_board
dc exec -T db createdb -U cb claude_board
dc exec -T db pg_restore -U cb -d claude_board --no-owner --exit-on-error < /var/backups/claude-board/<file>.dump
dc up -d board                                          # re-applies the schema, starts polling
```

Then tell the sessions: `dc exec board cb broadcast "The board was restored to <time>: re-register anything you did since."`

## Users

Day to day, on the board: Users (key 7). Add a member, copy their link or set a password, put them on projects, make
an admin, remove someone. Everyone changes their own password at the top of the page (admins: under their name).

From the VPS shell, when the board itself can't be used (no admin can sign in):

```bash
dc exec board cb users                                                          # who, which role
read -rs PW && printf %s "$PW" | dc exec -T -e PGAPPNAME=cb-web board cb user password ahmed; unset PW   # reset a password
dc exec -e PGAPPNAME=cb-web board cb user role omar admin                       # or member
```

A locked name (5 wrong passwords from one address) unlocks by itself after 2 minutes; `dc restart board` clears every
lock at once. Removing someone, or a new link for a member, is on the Users page only.

## Secrets

All in `deploy/.env` (mode 600). After changing one: `dc up -d` (recreates what changed).

- **Database password:** `dc exec db psql -U cb -d claude_board -c "alter user cb password '<new>'"`, then
  `CB_PG_PASSWORD` in `.env`, `dc up -d`, then every worker's URL (the PC's `.env`, the Mac's `~/.zshrc`) and their
  relays. Do it if a worker machine is lost or the password leaks.
- **Telegram bot token:** revoke in @BotFather, new token in `.env`, `dc up -d board`.
- **GitHub:** gh's own login inside the board container (`dc exec board gh auth status`), stored by gh in the
  `ghconfig` volume as a plain file (no keyring in a container): anyone with root on vps2 can read it, and it has
  the signed-in account's scopes. Rotate: `dc exec board gh auth logout`, then the login in
  [deploy.md](deploy.md#8-the-move-ahmeds-live-board-from-the-pc-to-the-vps) step 7. Narrower option: a fine-grained,
  read-only `GH_TOKEN` in `.env` (it overrides the login). `dc logs board | grep github` shows HTTP 401 when the
  login stopped working.
- **Nginx Proxy Manager:** its admin account and Let's Encrypt certificates are NPM's (it renews them itself).

## Disk and housekeeping

```bash
docker system df                 # images, volumes
docker image prune -f            # old board images after upgrades
dc exec db psql -U cb -d claude_board -c "select pg_size_pretty(pg_database_size('claude_board'))"
```

The board is small (tens of MB). Postgres vacuums itself. A Postgres major version upgrade (16 to 17) is a dump,
a new volume and a restore, never just a new image tag.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every POST says "cross-site request refused" | the proxy rewrites `Host`, or the board is served on a port other than 443 (NPM drops the port from `Host`) | serve on 443; pass the public Host through |
| The public URL says 502 Bad Gateway | the board is down, or not on NPM's network | `dc ps`; `docker network inspect nginx-proxy-manager_default` lists `claude-board-board-1`; `dc up -d board` |
| Pages load but nothing updates live | a proxy buffering the event stream | the board sends `X-Accel-Buffering: no`; another proxy: turn its buffering off for `/api/stream` |
| Signed in, but sent back to the login page | the cookie isn't kept: https page with a non-Secure cookie blocked, or a proxy dropping `Set-Cookie` | check `X-Forwarded-Proto: https` reaches the board |
| "That name and password don't match" for the right password | 5 failures from that address in 2 minutes, or no password set | wait 2 minutes or `dc restart board`; set a password from the shell |
| `healthz` 503, board logs `ECONNREFUSED db` | Postgres is down or still starting | `dc ps`, `dc logs db` |
| db won't start: "cannot assign requested address" | Tailscale wasn't up when Docker started, so `CB_PG_BIND` doesn't exist yet | `sudo systemctl enable tailscaled`; `dc up -d db` |
| A worker's `cb` says "board unreachable at 100.x.y.z" | the VPS, Tailscale or Postgres is down, or the URL/password is wrong | `tailscale ping vps2`; `dc ps`; check the worker's URL |
| A worker's `cb` errors "function cb.x(...) does not exist" | the worker's code is older or newer than the VPS's schema | update the worker's checkout (Upgrade) |
| No Telegram pushes | no token, or another server polls with it (409 in the logs) | `TELEGRAM_BOT_TOKEN` in `.env`; stop the other server |
| Log: "another board server polls Telegram and GitHub" | a second server (the PC's?) holds the poller lock | stop it; this one takes over within a minute |
| GitHub watch silent | gh signed out, or its token expired or was revoked | `dc exec board gh auth status`; `dc exec board cb github` shows the last error; log in again |
| The board or db restarted on its own at night | Watchtower, if the opt-out label was lost | `docker inspect -f '{{.Config.Labels}}' claude-board-board-1` shows `watchtower.enable:false` |

## Tests

Never on the VPS. The suite truncates whatever database it is given and expects the PC's layout (127.0.0.1:5434);
run it on the PC or the Mac against their own test databases (`CB_TEST_DB=claude_board_test`). Changing the code is
in [CLAUDE.md](../../CLAUDE.md).
