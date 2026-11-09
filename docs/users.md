# Users: letting Omar (or Iman) answer on the board

A user is a name plus a secret link. Through the link they see only the questions and tasks
you assigned to them, answer the questions and add notes on the tasks. Nothing else on the
board is readable through the tunnel. The link is the whole login, so send it privately.

## Share the board with Omar

1. **Create the user** (on this PC, where the board runs):

   ```
   cb user add omar "Omar"
   ```

   It prints Omar's link. Running it again prints the same link.

2. **Start the tunnel** to the board's port:

   ```
   ngrok http 4747
   ```

   Copy the `https://….ngrok-free.app` URL from the "Forwarding" line.

   - **ngrok is broken on this PC right now (checked 2026-11-09).** The Chocolatey shim
     `C:\ProgramData\chocolatey\bin\ngrok.exe` points at
     `C:\ProgramData\chocolatey\lib\ngrok\tools\ngrok.exe`, and that file is missing. Reinstall it
     from an admin shell with `choco install ngrok --force` (or `winget install ngrok.ngrok`), then
     check with `ngrok version` and `ngrok config check`.
   - **The authtoken is already set** in `%LOCALAPPDATA%\ngrok\ngrok.yml`. If `ngrok config check`
     ever says it's missing, copy the token from dashboard.ngrok.com (Your Authtoken) and run
     `ngrok config add-authtoken <token>`.
   - A free URL changes each time ngrok restarts, unless you use your free static domain (see
     `ngrok http --help` for the domain flag). If the URL changes, repeat steps 3 and 4.
   - The first time Omar opens the link, ngrok's free plan shows a "You are about to visit…"
     page. He clicks **Visit Site** and the link works from then on.

3. **Set the public URL**, so the link points at the tunnel and not at localhost. Add it to
   `.env` in the board's own checkout (`F:\Work\claude-board\.env`; `cb` reads the repo's `.env`,
   not the current folder's):

   ```
   PUBLIC_URL=https://<your-subdomain>.ngrok-free.app
   ```

   Or set it for one command only: `$env:CB_PUBLIC_URL = "https://…"` (PowerShell).
   Then run `cb user add omar` again to print the link with the new URL.

4. **Send Omar the link** in a direct message, not in a group chat. Opening it signs his browser
   in for 90 days.

5. **Give him things to answer:**

   ```
   cb ask <project> "Which date do we launch?" -o "March 14" -o "March 21" --to omar
   cb ask <project> "What discount for returning customers?" --free --to omar
   cb assign Q12 omar      # hand an existing question to Omar
   cb assign Q12 ahmed     # take it back
   cb assign #34 omar      # hand him a task: he can add notes to it
   cb users                # who has what open
   ```

   On the board, the **For** picker on a question card does the same as `cb assign`. Questions
   handed to someone move from "Waiting on you" to "Waiting on others" and stop counting in the
   Today badge. A task's Assignee field suggests the users.

When Omar answers, the session that asked gets "omar (not Ahmed) answered…", so a guest's answer is
never taken as your approval.

## Stop sharing

Stop ngrok (Ctrl+C). Nothing is reachable from outside after that, but anyone who has a link gets
in again the next time the tunnel is up.

- **A link leaked:** People (key 7) → **New link**, or `cb user rotate omar`. The old link stops
  working at once, also in a browser already signed in with it. Send the new one.
- **Done with someone:** People → **Remove**, or `cb user remove omar`. Their link stops working,
  their open questions come back to you, and their open tasks become unassigned (status kept, so
  work held on one of those questions stays held). Answers and notes they left stay under their name.

The People page also adds people and copies anyone's link again later.

## Don'ts

- **Don't set `HOST`** (leave the server on 127.0.0.1). The board treats a request as yours when
  it comes to `localhost` with no proxy headers. ngrok always adds `X-Forwarded-For`, so tunnel
  traffic never counts as yours. A server bound to `0.0.0.0` lets anyone on the LAN who sends
  `Host: localhost` count as you.
- **Don't use a tunnel or proxy that strips `X-Forwarded-For`** together with a `localhost` host
  header: every visitor would get the full board.
