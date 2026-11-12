# Deploy the board on a VPS, and move the live board there

Two parts: a fresh install (1 to 7), then the one-time move of Ahmed's live board from his PC (8). Commands run on
the VPS unless a step says PC or Mac. About an hour the first time, most of it waiting on the image build and DNS.

**What the VPS needs:** Linux on amd64 or arm64, 1 GB of RAM free and 5 GB of disk, Docker Engine with the compose
plugin (`docker compose version`), git, and Tailscale joined to Ahmed's tailnet (`tailscale ip -4` prints its
address). The board stores client work, so the VPS is Ahmed's choice (open question Q470 on the board).

## 1. Get the code

The repo is private (`github.com/shaltut/claude-board`). Clone with a read-only deploy key or `gh auth login`:

```bash
sudo mkdir -p /opt/claude-board && sudo chown "$USER" /opt/claude-board
git clone https://github.com/shaltut/claude-board.git /opt/claude-board
cd /opt/claude-board
git checkout main   # until the vps branch is merged: git checkout vps
```

## 2. Fill in deploy/.env

```bash
cd /opt/claude-board/deploy
cp env.example .env && chmod 600 .env
openssl rand -hex 24          # the database password: paste it as CB_PG_PASSWORD
tailscale ip -4               # paste it as CB_PG_BIND
nano .env
```

`env.example` explains every line. `CB_PUBLIC_URL` is the https address people will use (step 5). Leave
`TELEGRAM_BOT_TOKEN` and `GH_TOKEN` empty until the move (step 8): the PC's board still polls with them.

## 3. Start it

```bash
cd /opt/claude-board/deploy
docker compose up -d --build        # first build: 3 to 6 minutes
docker compose ps                   # db and board: running (healthy)
curl -s localhost:4747/healthz      # {"ok":true}
docker compose logs board | tail    # "claude_board ready", then "Claude Board: http://localhost:4747"
```

The board container applies `db/schema.sql` every time it starts (idempotent), then serves. Both containers restart
on their own after a crash or a reboot (`restart: unless-stopped`); Docker itself must start on boot
(`sudo systemctl enable docker`), and so must Tailscale (`sudo systemctl enable tailscaled`), or the database can't
bind its Tailscale address.

## 4. The first admin

Nobody can sign in yet. Make Ahmed's account from the VPS shell (the shell is trusted; `PGAPPNAME=cb-web` marks it as
the dashboard). The password goes through stdin so it never lands in the shell history:

```bash
cd /opt/claude-board/deploy
docker compose exec -e PGAPPNAME=cb-web board cb user add ahmed "Ahmed" --admin
read -rs PW && printf %s "$PW" | docker compose exec -T -e PGAPPNAME=cb-web board cb user password ahmed; unset PW
```

Skip this on the move (step 8) until after the restore: the restored board replaces everything.

## 5. HTTPS in front

The board listens on the VPS's loopback only (127.0.0.1:4747). Put one of these in front. Either way the proxy must
pass the `Host` header through unchanged and say `X-Forwarded-Proto: https`, or every POST is refused as cross-site
and the cookie is not Secure.

### Option A: the Cloudflare tunnel (board.shaltoot.cloud today)

The PC runs a locally managed named tunnel, `claude-board`, as the `cloudflared` Windows service with
`C:\Windows\System32\config\systemprofile\.cloudflared\config.yml` and its credentials file
(`<tunnel-id>.json`). To move it, do this during the move (step 8), not before, since one hostname can't point at two boards:

1. On the VPS, install cloudflared (Cloudflare's apt repo, `cloudflared --version`).
2. Ahmed copies `config.yml` and the credentials `.json` from the PC to `/etc/cloudflared/` on the VPS (`chmod 600`
   the json: it is the tunnel's secret). In `config.yml`, fix `credentials-file:` to the new path and make the
   ingress service `http://localhost:4747`. Don't add `httpHostHeader`.
3. `sudo cloudflared service install && sudo systemctl enable --now cloudflared`
4. On the PC (admin PowerShell): `Stop-Service cloudflared; Set-Service cloudflared -StartupType Disabled`
5. `cloudflared tunnel info claude-board` shows the VPS's connector only.

### Option B: Caddy with its own domain

Point a DNS A record at the VPS, open ports 80 and 443, and use this `/etc/caddy/Caddyfile`:

```
board.example.com {
    reverse_proxy 127.0.0.1:4747
}
```

Caddy gets the certificate itself, passes `Host`, and sets `X-Forwarded-For` and `X-Forwarded-Proto`.

## 6. Backups

```bash
sudo crontab -e
15 3 * * * /opt/claude-board/deploy/backup.sh >> /var/log/claude-board-backup.log 2>&1
```

A dump a night in `/var/backups/claude-board`, 14 kept. Restoring: [maintain.md](maintain.md#restore).

## 7. Workers: point the sessions' cb at the VPS

Each machine whose Claude sessions use the board needs the database URL (Tailscale address, port 5434):

```
postgres://cb:<CB_PG_PASSWORD>@<VPS tailscale ip>:5434/claude_board
```

- **The PC:** `DATABASE_URL=<that URL>` in `F:\Work\claude-board\.env` (Ahmed edits it: it holds the Telegram token).
  `cb` reads `.env` on every run, so new commands use it at once.
- **The MacBook:** `export CB_DATABASE_URL=<that URL>` in `~/.zshrc` (it points at the PC's Tailscale IP today).
- **Relays** read the URL when they start: restart each one, by restarting the session or `cb relay --restart` in it.
- Check from each machine: `cb sessions` lists the sessions; `cb start` says what to do next.

The workers' CLI code must match the VPS's schema: after every upgrade, update the PC's checkout (`git pull`) and the
Mac's copy too ([maintain.md](maintain.md#upgrade)).

## 8. The move: Ahmed's live board from the PC to the VPS

About 20 minutes of downtime for the sessions; they keep working and log "board unreachable" meanwhile. Do steps 1 to
3 first (an empty board on the VPS is fine; it is replaced here). The dump carries client work to the VPS: Ahmed's
call, made when he asked for the move.

1. **Warn the sessions** (PC): `cb broadcast "The board moves to the VPS now: cb is unreachable for about 20 minutes. Keep working; register what you did after."`
2. **Stop the PC's board server** (Ahmed's terminal, Ctrl+C). Nothing polls Telegram or GitHub now.
3. **Freeze and dump the PC's database** (PC, PowerShell). Restarting Postgres on a port nobody uses guarantees no
   session writes after the dump:

   ```powershell
   $bin = 'C:\Program Files\PostgreSQL\16\bin'
   & "$bin\pg_ctl.exe" -D F:\Work\claude-board\.pgdata stop
   & "$bin\pg_ctl.exe" -D F:\Work\claude-board\.pgdata -o "-p 5499" -w start
   & "$bin\pg_dump.exe" -h 127.0.0.1 -p 5499 -U cb -d claude_board -Fc -f "$env:TEMP\cb-move.dump"
   & "$bin\pg_ctl.exe" -D F:\Work\claude-board\.pgdata stop
   ```

4. **Copy it to the VPS** (PC): `scp $env:TEMP\cb-move.dump <vps>:/tmp/cb-move.dump`
5. **Restore into an empty database** (VPS). `down -v` deletes the empty board from step 3 (and only that: check
   nothing real was added to it):

   ```bash
   cd /opt/claude-board/deploy
   docker compose down -v
   docker compose up -d db
   docker compose exec -T db pg_restore -U cb -d claude_board --no-owner --exit-on-error < /tmp/cb-move.dump
   docker compose up -d --build board        # applies the new schema (roles, ...) over the restored board
   shred -u /tmp/cb-move.dump
   ```

6. **The first admin** (VPS): step 4 above.
7. **The pollers:** put `TELEGRAM_BOT_TOKEN` (from the PC's `.env`) and a read-only `GH_TOKEN` (open question Q472)
   in `deploy/.env`, then `docker compose up -d board`. `docker compose exec board cb github` shows both iHop repos;
   a minute later `last poll` is recent.
8. **HTTPS:** step 5 (option A moves the tunnel now).
9. **Workers:** step 7. On the PC, don't start the old board again; if someone does, it serves pages but does not poll
   (the poller lock), and it shows the old, frozen database unless its `.env` points at the VPS.
10. **Check:** sign in at the public URL as ahmed; Today shows the open questions; answer one and see the session get
    it; `cb start` on the Mac; a member's link signs them in; `cb broadcast "The board is on the VPS. Restart your relay: cb relay --restart"`.

**Going back** (if the VPS fails during the move): stop the VPS board (`docker compose stop board`), start the PC's
Postgres and board again (`pnpm start` in `F:\Work\claude-board`), restore `.env` and the tunnel. Anything written on
the VPS since the move is not on the PC: dump it first if it matters.

Afterwards the PC's `.pgdata` is a frozen copy of the board as it was. Keep it a week, then Ahmed deletes it.
