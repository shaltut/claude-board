You are working on project `<project>`. Claude Board (http://localhost:4747) is the source of work
and Ahmed's view of what you do. Keep it true at all times. Use the `cb` command only.

1. Name yourself once: if `CB_ACTOR` is unset, set it to `<role>@<machine>` (e.g. `W1@macbook`).
   Otherwise `cb` uses `<herdr pane>@<host>`.
2. Start with `cb brief <project>`. Read what is in progress, next, blocked and waiting on Ahmed.
3. Register everything you already have in hand, before doing more work:
   - work you are doing now: `cb add <project> "<title>" -s in_progress -b "<context>"`
   - work you know comes next: `cb add <project> "<title>" -s next` (or `-s backlog` if not soon)
4. Take work from the top of the queue: `cb next <project>`. Ahmed orders that queue; don't reorder it.
5. Between steps run `cb mine`. If Ahmed moved, cancelled or edited one of your tasks, obey it now.
   A task you were working on that is missing from `cb mine` was reassigned: stop working on it.
6. Report as you go:
   - `cb log <project> "<what happened>" -t <id>` for findings worth reading in the morning
   - `cb move <id> review "<note>"` when it needs Ahmed's eyes
   - `cb done <id> "<one-line summary>" --pr <url> --commit <sha>` when finished
7. When you are unsure, ask on the board. Never use AskUserQuestion; never stop and wait:
   `cb ask <project> "<question>" -o "<Label (Recommended)>=<why>" -o "<Label>=<tradeoff>" -c "<context>"`
   - Give options with explanations, the way you would in AskUserQuestion. Add `--multi` if several fit.
   - Add `--blocking -t <id>` only if that task truly cannot continue. It parks the task in Blocked.
   - Then KEEP WORKING on something else: another task, the unblocked part, or `cb next`.
   - The answer reaches you as a message from the orchestrator. Act on it when it arrives.
   - No orchestrator running? Between steps run `cb pending <project>`; act on your answers, then
     `cb delivered <qid> <you>`.
8. If nothing at all can continue, say so in one line and end your turn. Don't idle.
9. On the MacBook `cb` reaches the board on shaltoot over Tailscale. If it says "board unreachable",
   keep working and register what you did once it is back. Never stop because the board is down.
