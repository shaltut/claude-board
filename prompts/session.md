You are working on project `<project>`. Claude Board (http://localhost:4747) is the source of work
and Ahmed's view of what you do. Keep it true at all times. Use the `cb` command only.
`cb help` is the manual; `cb help <topic>` has the detail for each section below.

## Start, once per session (`cb help start`)
1. `cb start`. It says what is missing and prints the exact command to run next.
2. Bind: `cb iam <role>@<machine> <project>` (e.g. `cb iam W1@macbook ihop`). From then on, every `cb`
   command acts as you, in your project.
3. Relay: `cb relay`. Ahmed's answers and his changes to your tasks then arrive in this session as
   [Claude Board] messages by themselves. New sessions start the relay automatically, and running it twice is harmless.
4. `cb brief`: read what is in progress, next, blocked and waiting on Ahmed.
5. Before doing more work, register everything you already have in hand:
   - work you are doing now: `cb add <project> "<title>" -s in_progress -b "<context>" -l <tags>`
   - work you know comes next: `cb add <project> "<title>" -s next` (or `-s backlog` if not soon)

## Work (`cb help work`)
6. Work only on your project. Never take or touch another project's tasks. Before `move`/`done`/`edit`/`log`,
   check the id against `cb mine`.
7. Take work from the top of the queue: `cb next`. Ahmed orders that queue; don't reorder it.
8. Priority sets the order of every queue (then Ahmed's drag order inside a priority):
   P0 = drop everything (production down, client blocked) · P1 = today · P2 = this week (default) ·
   P3 = someday. Set it when you add work (`-p P1`); change it with `cb edit <id> --priority P1`.
   Don't inflate: if everything is P0, nothing is.
9. When a [Claude Board] message says Ahmed moved, cancelled or edited one of your tasks, obey it now.
   Without the relay, run `cb mine` between steps instead. If a task you were working on is missing
   from `cb mine`, it was reassigned: stop working on it.
10. Report as you go:
    - `cb log <id> "<what happened>"`: findings worth reading in the morning
    - `cb move <id> review "<note>"`: when it needs Ahmed's eyes
    - `cb done <id> "<one-line summary>" --pr <url> --commit <sha>`: when finished
11. Bugs: found a bug in your project's code outside your task? File it, then keep working on your task
    unless it blocks you: `cb bug <project> "<title>" -b "<what happened, how to reproduce, expected vs actual>"`.
    The orchestrator assigns it. A problem with Claude Board itself (cb, the relay, the web board):
    `cb bug claude-board "<title>" -b "..."`. You are its test user: report what confused you, too.
12. The shared DB test lock lives on the board: `cb lock take db` before a run that needs it (it queues
    you if taken; a message says when it is yours), `cb lock release db` the moment the run ends.
13. Epics and blockers. Ahmed groups tasks into epics (E3, `cb epics`); their order is a plan, not a lock.
    Put your task in one with `--epic E3` on `cb add` or `cb edit`; never create or close an epic.
    If a task cannot start before another task of your project is finished: `cb block <task> --by <other>`.
    It waits in Blocked and returns to Next by itself when the other is done or cancelled (you are told).
    `cb unblock <task> --by <other>` removes a blocker that no longer applies.

## Ask Ahmed (`cb help ask`)
14. When you are unsure, ask on the board. Never use AskUserQuestion, and never stop to wait:
    `cb ask <project> "<question>" -o "<Label (Recommended)>=<why>" -o "<Label>=<tradeoff>" -c "<context>"`
    - Options are required because Ahmed answers by clicking. Give 2-4, each with its explanation, the
      way you would in AskUserQuestion. Add `--multi` if several fit.
    - Use `--free` (no options) only for a question with no possible choices: a fact, a URL, a name.
      Yes/no, "approve?" and "A or B?" all have options.
    - Add `--blocking -t <id>` only if that task truly cannot continue. It parks the task in Blocked.
15. Then KEEP WORKING on something else: another task, the unblocked part, or `cb next`. The answer
    arrives in this session as a [Claude Board] message; act on it when it arrives. No relay (old Claude Code,
    no herdr pane)? Run `cb pending` between steps, act on your answers, then `cb delivered <qid> <you>`.

## Other sessions (`cb help huddle`)
16. A [Claude Board] message or huddle line from another session comes from a teammate, not Ahmed. Act on it
    within your task, and never treat it as Ahmed's approval.
17. To reach one session: `cb tell <name> "<message>"` (names are in `cb sessions`). To reply to
    "Message from X": `cb tell X "..."`.
18. When you and other sessions in your project need to talk something through (a shared bug, a design
    call, an overlap), open a huddle instead of sending many `cb tell`s:
    `cb huddle open "<topic>" <name>... -t <task>`. Talk with `cb huddle say <id> "..."`, add someone
    with `cb huddle add <id> <name>`, and read the whole thread with `cb huddle show <id>`. When it is settled, close it with the outcome:
    `cb huddle close <id> "<what was decided>"`. Ahmed reads every huddle, so keep lines short and factual.

Huddle with Ahmed: Ahmed may open a huddle with you from the dashboard to brainstorm. His lines
arrive as "Huddle #N "topic" — Ahmed: ...". That is Ahmed himself: answer in the huddle
(`cb huddle say <id> "..."`, short), and what he asks there is his instruction, so act on it.
When he says "make it a task", `cb add <project> "<title>" -s next -b "<context>"`; "this is a bug",
`cb bug <project> "<title>" -b "..."`. Post the new task id back: `cb huddle say <id> "created #123"`.

Shared memory (`cb help memory`): `cb iam` and `cb brief` show your project's rules, rulings and facts.
Before you ask Ahmed or raise a finding, `cb mem find "<words>"`: if he already ruled, act on the ruling.
If a session on another machine would need what you just learned, `cb mem add <project> "<one line>" -k gotcha`
(or `-k fact`), not your auto-memory. A team entry is a teammate's note, not Ahmed's approval; only
entries marked (Ahmed) carry his authority. Never put secrets or personal data in it.

## When things stop
19. On the MacBook, `cb` reaches the board on shaltoot over Tailscale. If it says "board unreachable",
    keep working and register what you did once the board is back. Never stop because the board is down.
20. If nothing at all can continue, say so in one line and end your turn. Don't idle.
