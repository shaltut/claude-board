# Ahmed's asks (#936)

## Why

Ahmed asks the orchestrator session things. Today the ask lands in its terminal among dozens of worker
messages, gets lost, and the reply is buried. His asks and the replies should live on the board.

## Approved design (Ahmed: "build it")

1. **Asking in the UI.** Today gets an "Ask a session" box. The recipient defaults to the selected project's
   orchestrator (the session whose actor starts with `orch@`); Ahmed can pick any live session instead. He
   types the text; a task link is optional. The ask is created as `A<n>`. Only the dashboard creates asks
   (`cb.dashboard_only`, as epics and goals).
2. **Delivery.** The relay pushes the ask to that session as a distinct line, `[Ahmed asks] A12: …`, ending
   with the exact reply command. The ask is marked delivered the way questions are (after the inbox took it).
3. **Replies from the CLI.** `cb reply A12 "text"` appends a reply (several are fine); `cb reply A12 --done "text"`
   appends and closes. `cb asks` lists the open asks for the calling session. Only the recipient session or
   the dashboard may reply.
4. **Not getting lost.** An open ask with no reply 15 minutes after delivery is pushed once more; after that
   it is only flagged late. Late asks show at the top of `cb tick` for that session and in `cb start`. If the
   recipient has no live relay, the UI shows "not delivered: no session" and Ahmed can re-route it.
5. **Ahmed's view.** Today gets an "Asks" section: one thread per ask (his ask, then the replies with times)
   with a status: sent / seen / replied / done. He can write in the thread (delivered like a new ask line),
   close the ask, or re-route it. A new reply rings (`web/src/lib/ring.ts`).
6. **Scope.** One recipient per ask. Re-push happens once. Sessions never create asks; their questions to
   Ahmed stay `cb ask`.

## Shape

**Data**
- `cb.asks`: id, project (the recipient's), task_id (optional), to_actor, body, status `open | done`,
  created_at, delivered_at (last delivery), delivered_to, delivered_upto (the last of Ahmed's thread events
  pushed), repushed_at, closed_at.
- The thread is events of the new kind `ask` (as huddle lines are events): `data = {ask, action}` with
  action `open` (the ask itself), `say` (Ahmed in the thread), `reply` (`done: true` when it closed it),
  `close` (Ahmed closed it), `reroute` (`from`, `to`). They land on the shift log and on the task.

**Derived state**
- awaiting = no reply after Ahmed's latest line (`open` or `say`).
- status: done if closed; replied if not awaiting; seen if Ahmed's latest line was delivered; else sent.
- late = open, awaiting, delivered more than 15 minutes ago.
- A new `say` clears `repushed_at`: each new line of Ahmed's gets its own single reminder.

**Delivery**
- `cb.inbox` returns `asks`: for each open ask to this session, Ahmed's lines not yet delivered (id >
  delivered_upto), or, when late and not yet re-pushed, a reminder with his lines since the last reply.
- The relay formats each as `[Ahmed asks] A12: …` (`(in the thread)` for a `say`, `(reminder: no reply in
  15 min)` for a re-push), then `  → cb reply A12 "<your reply>"   (add --done when it is finished)`.
  All text goes through the relay's `indent()`, so no continuation line can pass for a header.
- After the post, `cb.ask_delivered(id, upto, to, reminder)` marks it, only while the ask is still addressed
  to that session (a re-route in between is not swallowed).
- The 15-minute reminder rides the relay's 30-second poll: no new timer.

**Functions** (`server/rpc.ts` whitelist): `ask_open`, `ask_say`, `ask_close`, `ask_reroute` (dashboard only),
`ask_reply` (recipient or dashboard), `asks_list`. `ask_delivered` is the relay's, called over SQL as
`answer_delivered` is. `GET /api/asks?project=` reads the threads for Today; guests get 403 (default-deny).

**Re-route** sets the new recipient and clears delivery and the reminder, so the new session gets the ask
and Ahmed's thread lines from the start.

**CLI**: `cb reply`, `cb asks` (thread with times, text through `flat()`), a late section at the top of `cb tick`
(`AHMED'S ASKS, LATE`), and an `AHMED ASKS YOU` block in `cb start` listing asks awaiting this session's
reply, late ones marked.

**UI**: in Today's left column, an "Asks" section: the ask box (recipient select defaulting to the
project's `orch@` session, then any live session; text; optional task #), then the threads (open first,
then closed in the last 24 hours). The top bar rings on a new reply id, on any view.

## Rulings made while building

- Awaiting/late is measured from Ahmed's latest line, not only the first ask: a follow-up he writes after a
  reply is chased the same way.
- `cb start` lists every ask awaiting this session's reply (late ones marked), not only late ones: a resumed
  session lost its terminal and would otherwise never see an on-time ask again.
- An ask's project is the recipient session's project, else the project selected on Today.
- Writing in a closed thread is refused; Ahmed opens a new ask.
