# Users: letting Omar (or Iman) answer on the board

A user is a name plus a secret link. Through the link they see only the questions and tasks
you assigned to them, answer the questions and add notes on the tasks. Nothing else on the
board is readable through the tunnel. The link is the whole login, so send it privately.

## Share the board with Omar

1. **Add the person:** People (key 7) → **Add person**, with a display name and a short name
   (`omar`). It shows Omar's link with a Copy button. A session can add people too
   (`cb user add omar "Omar"`), but never sees the link: the link is Omar's whole login, so only
   the People page shows it.

   Then **put Omar on his projects** with **+ Project** on his card. Questions and tasks reach a
   person only on their projects: handing him one anywhere else is refused ("omar is not on project
   qhs"), and the For picker and the Assignee list offer only the people on that item's project.
   Omar sees only what is assigned to him on his projects. A new person has no projects. Taking him
   off a project (the x on its chip) hands his open work there back, like removing him.

   **Optional: a password.** **Set password** on his card lets Omar sign in on the board's login page
   with his name and password instead of the link (send the password separately from the name). The
   link keeps working as one-click sign-in. Anyone reaching the board through the tunnel without
   being signed in gets the login page; a wrong name or password gets one message after a second.
   He can **Sign out** on his page.

2. **Check the tunnel is up.** The board is shared through a Cloudflare named tunnel,
   `claude-board`, which runs as the `cloudflared` Windows service and forwards its https
   hostname to the board on this PC (port 4747). As a service it runs without a terminal, so there
   is nothing to start per session. Check it with `Get-Service cloudflared` (Status should be Running); the
   team lead set it up, and `cloudflared tunnel info claude-board` shows its connections.

3. **Set the public URL**, so links point at the tunnel and not at localhost. PUBLIC_URL is the
   tunnel's https hostname. Add it to `.env` in the board's own checkout
   (`F:\Work\claude-board\.env`; `cb` and the board read the repo's `.env`, not the current folder's):

   ```
   PUBLIC_URL=https://<the tunnel's hostname>
   ```

   The hostname is fixed, so this is a one-time step, and the board picks it up without a restart
   (it reads `.env` on each request). Then **Copy link** on People gives the link with the
   tunnel's URL.

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

Stop the tunnel: `Stop-Service cloudflared` from an admin shell (`Start-Service cloudflared` brings
it back). Nothing is reachable from outside while it's stopped, but anyone who has a link gets in
again once the tunnel is up.

- **A link leaked:** People (key 7) → **New link**. The old link stops working at once, and every
  browser signed in as that person is signed out, by link or by password (the password itself still
  works: they sign in again with it, or with the new link). Send the new one.
- **Done with someone:** People → **Remove**. Their link stops working, their open questions come
  back to you, and their open tasks become unassigned: status kept, so work held on one of those
  questions stays held, except a task in progress goes back to Next, since nobody is working it.
  Answers and notes they left stay under their name.

New links and removals are Ahmed's: only the dashboard can make them (`cb user rotate` and
`cb user remove` say so). Adding, new links and removals each leave a line in History.

## Don'ts

- **Don't set `HOST`** (leave the server on 127.0.0.1). The board treats a request as yours when
  it comes to `localhost` with no proxy headers. Requests through the Cloudflare tunnel carry
  `cf-connecting-ip` and `X-Forwarded-For`, so `isLocal()` treats them as outside and they need a
  link. A server bound to `0.0.0.0` lets anyone on the LAN who sends
  `Host: localhost` count as you.
- **Don't put a tunnel or proxy in front that strips those headers** (`cf-connecting-ip`,
  `X-Forwarded-For`, `X-Forwarded-Host`) and sends a `localhost` host header: every visitor would
  get the full board.
- **Don't set `httpHostHeader`** in the cloudflared config. The tunnel must pass the public Host
  through: a guest's answer, note or sign-in is checked against it (Origin must match Host), so a
  rewritten Host refuses every one of them as cross-site.
