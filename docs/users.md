# Users: who signs in, and what they see

Everyone signs in on the board's login page (`/login`). Two roles:

- **Admin:** the whole board, acting under their own name. Signs in with a password only. You (the user `ahmed`)
  are the owner: always an admin, never removed. What you do is recorded as `ahmed`, which the sessions read as your
  decision; another admin's answers say "omar (not Ahmed) answered".
- **Member** (Omar, Iman): only the questions and tasks you hand them, on the projects you put them on. They answer
  questions and add notes to tasks. Signs in with a password, or with a private link (one click, 90 days).

On your PC, before the move to the VPS, the board on `localhost` is still yours without signing in. On the VPS
everyone signs in, you included.

## Add someone

**Users** (key 7) → **Add user**: display name, a short name (`omar`), and the role.

- A **member** gets a private link with a Copy button. Send it in a direct message, never a group chat. Then **put
  them on their projects** with **+ Project** on their card: questions and tasks reach a person only on their
  projects (handing one anywhere else is refused, and the For picker offers to add them to the project). Optional:
  **Set password** on their card, so they can sign in by name and password too. Send the password separately from
  the name.
- An **admin** is added with a password (they have no link). Send them the board's address, their name and the
  password; they change it after signing in (their name at the top, then Change password).

A session can add members too (`cb user add omar "Omar"`) but never sees the link, and can't make admins.

**Make admin / Make member** on a card changes the role. The last admin can't be demoted or removed.

## Give them things to answer

```
cb ask <project> "Which date do we launch?" -o "March 14" -o "March 21" --to omar
cb ask <project> "What discount for returning customers?" --free --to omar
cb assign Q12 omar      # hand an existing question to Omar
cb assign Q12 ahmed     # take it back
cb assign #34 omar      # hand him a task: he can add notes to it
cb users                # who has what open
```

On the board, the **For** picker on a question card does the same as `cb assign`; on Telegram, **Hand to ...**.
Questions handed to someone move from "Waiting on you" to "Waiting on others" and stop counting in the Today badge.

## Signing in

- Wrong name or password: one message, after a second. 5 wrong tries for a name from one address lock that name there
  for 2 minutes (same message, even with the right password). Someone else failing elsewhere never locks you out.
- Everyone can **change their password** and **sign out** (admins: their name at the top; members: the buttons at the top). A member who signed in by link sets a
  first password there without a current one. An admin who changes their password is signed out of every other
  browser (a member's link keeps working).
- Forgot the password: an admin resets a member's on the Users page (**Reset password**); only you reset another
  admin's. Yours, if you can't sign in: from the VPS shell ([ops/maintain.md](ops/maintain.md#users)).
- **Sign out everywhere** on an admin's card ends every browser signed in as them (a lost laptop); their password
  still works. Yours, or anyone's if you're the owner.
- Making someone admin, or member again, signs them out everywhere: an old member link never becomes an admin's
  sign-in.
- What other admins can't do: change another admin's password, sign-ins or role, or remove an admin (yours included:
  only you can, for any admin), or pair Telegram (the bot is yours). They manage members, and can step down themselves.

## Stop sharing

- **A member's link leaked:** Users → **New link**. The old link stops working at once, and every browser signed in as
  them is signed out (their password still works). Send the new one.
- **Done with someone:** Users → **Remove**. They can't sign in any more, their open questions come back to you, and
  their open tasks become unassigned (status kept; a task in progress goes back to Next). Their answers and notes
  stay under their name.

New links, passwords, roles and removals are yours: only an admin on the board (or the VPS shell) can make them. Each
leaves a line in History.

## Members' links point at the public address

The link is built from the board's public URL: `CB_PUBLIC_URL` in `deploy/.env` on the VPS (`PUBLIC_URL` in the PC's
`.env` before the move). If it isn't set, links point at whatever address you opened the board on.
