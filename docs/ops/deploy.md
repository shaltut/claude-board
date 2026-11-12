# Deploy the board on a VPS, and move the live board there

Two parts: a fresh install (1 to 7), then the one-time move of Ahmed's live board from his PC (8). Commands run on
the VPS unless a step says PC or Mac. About an hour the first time, most of it waiting on the image build and DNS.

**The VPS is vps2** (Oracle Cloud, Linux arm64; Ahmed's choice, Q470). It already has what the board needs: Docker
with the compose plugin, git, gh, Tailscale on Ahmed's tailnet, and Nginx Proxy Manager on ports 80/443 (Q471). The
board takes about 300 MB of RAM and 2 GB of disk. Another VPS works the same way: Linux on amd64 or arm64, Docker,
Tailscale, and a proxy (step 5).

vps2 also runs **Watchtower**, which restarts any container with a newer image. The compose file opts both of the
board's containers out (`com.centurylinklabs.watchtower.enable=false`): upgrades are done by hand ([maintain.md](maintain.md#upgrade)).
It also has its own `postgres` container on 5432: unrelated, leave it alone; the board's database is separate (5434).

## 1. Get the code

The repo is private (`github.com/shaltut/claude-board`). Clone with a read-only deploy key or `gh auth login`:

```bash
sudo mkdir -p /opt/claude-board && sudo chown "$USER" /opt/claude-board
git clone https://github.com/shaltut/claude-board.git /opt/claude-board
cd /opt/claude-board
git checkout main   # with the vps branch merged first (the PC's and the Mac's cb run main)
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
`TELEGRAM_BOT_TOKEN` empty until the move (step 8): the PC's board still polls with it. Leave `GH_TOKEN` empty: the
GitHub watch signs in with `gh auth login` instead (step 8.7). `CB_PROXY_NETWORK` stays as it is on vps2.

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

The board isn't reachable from outside: its port is on the VPS's loopback (127.0.0.1:4747), and it sits on Nginx Proxy
Manager's docker network as `claude-board`. NPM serves it over https. Do this during the move (step 8), not before:
today `board.shaltoot.cloud` points at the PC's Cloudflare tunnel, and one hostname can't point at two boards.

1. **DNS:** in Cloudflare (the `shaltoot.cloud` zone), replace the `board` record (today a CNAME to the tunnel) with an
   A record to vps2's public IP, set up like the other vps2 sites (`blog`, `uptime`: proxied, orange cloud; checked
   2026-11-12). Leave `CB_BEHIND_CLOUDFLARE=0`: the board then counts failed sign-ins per Cloudflare edge address,
   which is stricter (rarely, someone failing on your name through the same edge can lock it for 2 minutes) but
   can't be bypassed. `1` is only safe if vps2's 80/443 accept Cloudflare's addresses alone; otherwise anyone reaching
   vps2's IP directly could send a made-up `cf-connecting-ip` and get a fresh count on every try.
2. **NPM's admin page** listens on the VPS's loopback: from the PC, `ssh -L 8181:127.0.0.1:81 vps2`, then open
   http://localhost:8181 and sign in (Ahmed's NPM account).
3. **Hosts → Proxy Hosts → Add Proxy Host:**
   - Details: domain `board.shaltoot.cloud`; scheme `http`; forward hostname `claude-board`; port `4747`; turn on
     Block Common Exploits. Websockets Support can stay off (live updates are server-sent events; the board tells
     nginx not to buffer them). No Access List, and don't put Authelia in front: the board has its own sign-in, and
     members' links must open without another login.
   - SSL: Request a new Let's Encrypt certificate; Force SSL; HTTP/2.
4. **Check** (from anywhere): `curl -s https://board.shaltoot.cloud/healthz` says `{"ok":true}`; the address shows the
   login page.
5. **Retire the PC's tunnel** (admin PowerShell on the PC): `Stop-Service cloudflared; Set-Service cloudflared
   -StartupType Disabled`. Keep its files (`C:\Windows\System32\config\systemprofile\.cloudflared\`) for the way back.

What NPM must do, and does by default (its `proxy.conf`): pass `Host`, set `X-Forwarded-Proto` and add the client to
`X-Forwarded-For`. NPM sends `Host` without a port, so serve the board on 443 only: on any other port every sign-in
and POST is refused as cross-site. NPM on vps2 also adds a strict Content-Security-Policy to every site; the board
loads nothing from other origins, so it is unaffected (tested).

**Without NPM** (another VPS): any reverse proxy that does the same (Caddy: `reverse_proxy 127.0.0.1:4747`), or the
Cloudflare tunnel moved from the PC (copy `config.yml` and `<tunnel-id>.json` to `/etc/cloudflared/`, ingress
`http://localhost:4747`, no `httpHostHeader`, set `CB_BEHIND_CLOUDFLARE=1`). Set `CB_PROXY_NETWORK` to the proxy's
docker network, or to one made with `docker network create cb-proxy` if the proxy isn't in docker.

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

4. **Copy it to vps2** (PC): `scp $env:TEMP\cb-move.dump vps2:/tmp/cb-move.dump`
5. **Restore into an empty database** (VPS). `down -v` deletes the empty board from step 3 and gh's login volume
   (and only those: check nothing real was added to the board):

   ```bash
   cd /opt/claude-board/deploy
   docker compose down -v
   docker compose up -d db
   docker compose exec -T db pg_restore -U cb -d claude_board --no-owner --exit-on-error < /tmp/cb-move.dump
   docker compose up -d --build board        # applies the new schema (roles, ...) over the restored board
   shred -u /tmp/cb-move.dump
   ```

6. **The first admin** (VPS): step 4 above.
7. **The pollers.** Telegram: put `TELEGRAM_BOT_TOKEN` (from the PC's `.env`) in `deploy/.env`, then
   `docker compose up -d board`. GitHub (Q472: gh's own login, kept in the `ghconfig` volume, so rebuilds keep it):

   ```bash
   docker compose exec board gh auth login --hostname github.com --git-protocol https --web
   # "Authenticate Git with your GitHub credentials?": n (the board only calls gh api; there is no git in the image)
   # then a one-time code and https://github.com/login/device: press Enter (no browser here, that's fine), open the
   # address on the PC, sign in as the account that can read the watched iHop repos, enter the code
   docker compose exec board gh auth status          # Logged in to github.com
   docker compose restart board
   ```

   `docker compose exec board cb github` shows both iHop repos; a minute later `last poll` is recent.
8. **HTTPS:** step 5, now.
9. **Workers:** step 7. On the PC, don't start the old board again; if someone does, it serves pages but does not poll
   (the poller lock), and it shows the old, frozen database unless its `.env` points at the VPS.
10. **Check:** sign in at the public URL as ahmed; Today shows the open questions; answer one and see the session get
    it; `cb start` on the Mac; a member's link signs them in; `cb broadcast "The board is on the VPS. Restart your relay: cb relay --restart"`.

**Going back** (if the VPS fails during the move): stop the VPS board (`docker compose stop board`), start the PC's
Postgres and board again (`pnpm start` in `F:\Work\claude-board`), restore `.env`, point the `board` DNS record back at
the tunnel (a CNAME to `<tunnel-id>.cfargotunnel.com`) and start the PC's cloudflared service again. Anything written
on the VPS since the move is not on the PC: dump it first if it matters.

Afterwards the PC's `.pgdata` is a frozen copy of the board as it was. Keep it a week, then Ahmed deletes it.
