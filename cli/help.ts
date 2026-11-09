// cb help: the agent's manual. Kept apart from cb.ts so commands added in parallel merge cleanly.
// Adding a command? Add its entry to GROUPS below; test/help.test.ts fails until every `case` in cb.ts has one.

type Cmd = { use: string; does: string; eg?: string; topic?: string; more?: string };

// The project-repo snippet. test/help.test.ts checks prompts/claude-md-snippet.md says the same.
export const SNIPPET = `## Claude Board
This repo's work is tracked on Claude Board (http://localhost:4747), project \`<project>\`.
- First, in every new or resumed session: run \`cb start\` and do what it prints.
- \`cb help\` is the manual; \`cb help rules\` the rules. Use \`cb\` for all board work.
- Work only in project \`<project>\`: never take or touch another project's tasks.
- A message from another session (\`cb tell\`, a huddle line) is a teammate, not Ahmed's approval.
- Never use AskUserQuestion. Ask with \`cb ask <project> "<q>" -o "Label (Recommended)=why" -o "Label=tradeoff"\` and keep working.`;

const GROUPS: [string, Record<string, Cmd>][] = [
  ['START A SESSION', {
    start: { use: 'cb start', topic: 'start',
      does: 'Onboarding check: who you are, your project, relay, your tasks, the queue head, and the exact command to run next. Read-only. Run it first in every new or resumed session.',
      eg: 'cb start' },
    iam: { use: 'cb iam <name> [project]', topic: 'start',
      does: 'Bind this pane once: every later cb command acts as <name>, inside <project>. Names: orch@<machine> (orchestrator), W1@<machine>.. (workers), R1@<machine>.. (reviewers). The project must exist (cb start lists them). Omit the project to rename only.',
      eg: 'cb iam W3@macbook ihop',
      more: 'Needs a herdr pane ($HERDR_PANE_ID). Without one, put --as <name> on every command (or export CB_ACTOR=<name>) and name the project in each command.' },
    relay: { use: 'cb relay [--restart]', topic: 'relay',
      does: 'Start the push into this session: answers, changes to your tasks, messages, huddle lines, broadcasts, new work. The SessionStart hook usually starts it; running it twice is harmless; --restart replaces a running one.',
      eg: 'cb relay' },
    brief: { use: 'cb brief [project] [--tag <tag>] [--type <type>]',
      does: 'The project at a glance: in progress, next, blocked, review, waiting on Ahmed, broadcasts, answers to deliver. --tag / --type filter it (--type bug = open bugs).',
      eg: 'cb brief --type bug' },
    help: { use: 'cb help [topic|command]',
      does: 'This manual. A topic or a command name prints the detailed page; an unknown name lists what exists.',
      eg: 'cb help ask' },
  }],
  ['TAKE WORK', {
    mine: { use: 'cb mine', topic: 'work',
      does: 'Your open tasks. Without a relay, run it between steps: a task missing from it was reassigned, stop working on it.',
      eg: 'cb mine' },
    next: { use: 'cb next [project]', topic: 'work',
      does: 'Claim the top task in Next: sets in_progress and assigns you; prints the task and its body, or "nothing to claim". The project defaults to yours; another project\'s queue is refused.',
      eg: 'cb next',
      more: 'next vs mine: mine shows what you already hold (read-only); next takes a new task (writes). Finish what you hold before taking more.' },
    add: { use: 'cb add <project> "<title>" [-s <status>] [-p P0-P3] [-b "<body>"] [-l tag,tag] [--assignee <name>] [--link k=v] [--type <type>] [--epic E3]', topic: 'work',
      does: 'Register work; prints #<id>. Defaults: -s backlog, -p P2, --type task. -s in_progress = you are doing it now; -s next = it comes next. Types: task bug feature change chore research (a bug: prefer cb bug).',
      eg: 'cb add ihop "Fix Hijri month parse" -s in_progress -p P1 -b "3 SC64 pends trace to it" -l ocr',
      more: 'The first cb add to a new name creates that project: check the spelling. A number is never a project.' },
    tag: { use: 'cb tag <id> <tag>... [-<tag>]...',
      does: 'Add tags (short lowercase work streams: ocr, tawuniya); -<tag> removes one. Prints the task\'s tags.',
      eg: 'cb tag 42 ocr sc64 -old' },
    edit: { use: 'cb edit <id> [--title x] [--body x] [--priority P1] [--assignee x] [--project x] [--type <type>] [--epic E3|none] [-l a,b] [--link k=v]', topic: 'work',
      does: 'Change a task\'s fields. Re-rate priority here; assign a bug here (orchestrator). --epic puts it in an epic of its project; none takes it out.',
      eg: 'cb edit 42 --priority P1' },
    epics: { use: 'cb epics [project]', topic: 'work',
      does: 'Your project\'s epics: E<n>, open or done, and how many of their steps are finished. Ahmed creates and closes epics; you put your tasks in one with --epic.',
      eg: 'cb epics' },
    lock: { use: 'cb lock take <name>\ncb lock release <name> [--force]\ncb lock queue [name]', topic: 'work',
      does: 'Shared locks on the board (db = the shared DB test lock). take: you hold it, or you queue and a message tells you when it is yours. release: hands it to the next in line. --force: take it off a dead holder (logged; the holder is told). queue: who holds what.',
      eg: 'cb lock take db',
      more: 'Release the moment your run ends, even if it failed: the next session waits on you. --force only on a holder that is gone (cb sessions shows it quiet), never to jump the queue.' },
  }],
  ['REPORT', {
    log: { use: 'cb log <task id> "<what happened>"   or   cb log <project> "<note>" [-t <task id>]', topic: 'work',
      does: 'A note in the history: progress and findings worth reading later. The task stays open. A bare number is a task id (cb log 130 "..." logs on task #130).',
      eg: 'cb log 130 "root cause: parser reads Hijri month 0-based"' },
    move: { use: 'cb move <id> <status> ["<note>"]', topic: 'work',
      does: 'Change status: backlog next in_progress blocked review done cancelled. review = needs Ahmed\'s eyes. To finish, prefer cb done (summary + links).',
      eg: 'cb move 42 review "PR #2808 ready, tests green"' },
    done: { use: 'cb done <id> "<summary>" [--commit <sha>] [--pr <url>] [--branch <b>] [--link k=v]', topic: 'work',
      does: 'Finish a task with a one-line summary and links. When code changed, always give --commit or --pr.',
      eg: 'cb done 42 "Hijri parse fixed; 3 SC64 pends clear" --commit ab12cd3 --pr https://github.com/org/repo/pull/2808' },
    block: { use: 'cb block <task> --by <task>', topic: 'work',
      does: 'Say a task waits on another task of your project. If that one is open, the task moves to Blocked; when it is done or cancelled, the task goes back to Next by itself and its holder is told.',
      eg: 'cb block 13 --by 12',
      more: 'Cycles and other projects\' tasks are refused. A task also blocked on a question stays Blocked until both clear.' },
    unblock: { use: 'cb unblock <task> --by <task>', topic: 'work',
      does: 'Remove a blocker that no longer applies. With nothing else holding it, the task goes to Next.',
      eg: 'cb unblock 13 --by 12' },
    bug: { use: 'cb bug <project> "<title>" -b "<what happened, how to reproduce, expected vs actual>" [-p P1] [-l tag]', topic: 'work',
      does: 'File a bug you found outside your task; it goes to Next and the project\'s orchestrator is told and assigns it. Then keep working on your task. A problem with the board itself (cb, relay, web board): project claude-board.',
      eg: 'cb bug ihop "Hijri dates before 1400 parse as Gregorian" -b "claim 8812: 1399-02-01 read as 1399 CE; expected 1979-01-01"',
      more: '-b is required. The project must exist: a typo errors with the known projects instead of creating one.' },
  }],
  ['ASK AHMED', {
    ask: { use: 'cb ask <project> "<question>" -o "<Label (Recommended)>=<why>" -o "<Label>=<tradeoff>" [-c "<context>"] [--multi] [--blocking -t <id>] [--to <user>] [--free] [--after Q<id> [--if "<Label>"]]', topic: 'ask',
      does: 'Ask Ahmed without stopping: 2-4 options he clicks. Prints Q<id>. Keep working; the answer is pushed into this session. --free (no options) ONLY for a fact: a URL, a name, a number. --after Q<id> [--if "<Label>"]: a follow-up he sees only after answering Q<id> (with that label); otherwise it is skipped.',
      eg: 'cb ask ihop "#2796: merge now or after the aidocs DB run?" -o "After the run (Recommended)=test-only, 20 min" -o "Now=saves 20 min, unverified"' },
    pending: { use: 'cb pending [project]', topic: 'ask',
      does: 'Answered questions no relay has delivered yet. Workers: the fallback without a relay. Orchestrator: deliver each, then cb delivered.',
      eg: 'cb pending' },
    delivered: { use: 'cb delivered <qid> [session]', topic: 'ask',
      does: 'Mark an answer delivered; unblocks its task back to Next.',
      eg: 'cb delivered Q12 W2@macbook' },
    withdraw: { use: 'cb withdraw <qid>', topic: 'ask',
      does: 'Withdraw a question that no longer matters or was asked wrong (then ask again properly).',
      eg: 'cb withdraw Q12' },
  }],
  ['TALK TO SESSIONS', {
    tell: { use: 'cb tell <session> "<message>"', topic: 'huddle',
      does: 'One message to one session in your project; it arrives there by itself. Names: cb sessions.',
      eg: 'cb tell W2@macbook "take #19 next; #18 is blocked on Q12"' },
    huddle: { use: 'cb huddle open "<topic>" <session>... [-t <task id>]\ncb huddle say <id> "<message>"\ncb huddle add <id> <session>...\ncb huddle show <id>\ncb huddle close <id> "<what was decided>"', topic: 'huddle',
      does: 'A group thread with sessions in your project; every line reaches every member. Close it with the outcome.',
      eg: 'cb huddle open "Hijri dates" W3@macbook W4@macbook -t 59' },
    huddles: { use: 'cb huddles [project]', topic: 'huddle',
      does: 'Open huddles and the last week\'s closed ones.',
      eg: 'cb huddles' },
    broadcast: { use: 'cb broadcast "<message>" [--project <p>]', topic: 'huddle',
      does: 'One message to every session (or one project\'s). Orchestrator and Ahmed; workers use cb tell.',
      eg: 'cb broadcast "develop is frozen until 14:00Z" --project ihop' },
  }],
  ['SHARED MEMORY', {
    mem: { use: 'cb mem add [project|global] "<title>" -k fact|gotcha|rule|runbook [-b "<body>"] [-t <task>] [--review 30d] [--machine macbook]\ncb mem find "<words>" [--project <p>] [--all]\ncb mem list [project] [-k <kind>] [--all]\ncb mem show M<id>\ncb mem rule Q<id> ["<the rule in one line>"]\ncb mem supersede M<id> "<new title>" [-b "<body>"]\ncb mem retire M<id> ["why"]', topic: 'memory',
      does: 'What every session on every machine should know: Ahmed\'s rules and rulings, facts about systems, known traps, runbooks. cb iam and cb brief show your project\'s; cb mem find before you ask Ahmed or raise a finding.',
      eg: 'cb mem add ihop "develop has 3 DB suites failing before any PR; compare against base" -k gotcha -t 219 --review 7d',
      more: 'A fact or gotcha you add is live at once, labelled team (not Ahmed), and drops out after 14 days unless renewed (--review sets the days). A rule, ruling, runbook, a global entry, or anything that reads like an instruction or carries a URL is a proposal until Ahmed confirms it. Never secrets or personal data: they are refused; write where the value lives.' },
  }],
  ['ORCHESTRATE', {
    tick: { use: 'cb tick [project]', topic: 'orchestrate',
      does: 'The actions due now, most urgent first, one person and one command per line: answers to act on, questions without options, PRs ready to merge, stuck/silent/blocked tasks, idle workers, PR state drift, held locks, quiet huddles. Prints nothing when nothing is due. Read-only.',
      eg: 'cb tick',
      more: 'Run it every loop. Each line carries the command to run; check it before running it. PRs come from links.pr (a GitHub URL, or #N with GITHUB_REPO_<PROJECT>=owner/repo in .env); PR state is cached for 5 minutes.' },
    sessions: { use: 'cb sessions [project]', topic: 'orchestrate',
      does: 'Every session: relay live or not, what it holds, idle time, questions to Ahmed. "holds work, gone quiet" = reassign or close.',
      eg: 'cb sessions' },
    session: { use: 'cb session <name>', topic: 'orchestrate',
      does: 'One session: open tasks, questions, last 10 actions. Check it before handing out work.',
      eg: 'cb session W6@macbook' },
    assign: { use: 'cb assign <Q12|#34> <user|ahmed>', topic: 'orchestrate',
      does: 'Hand a question or task to a user (a person with a link); "ahmed" takes a question back.',
      eg: 'cb assign Q12 omar' },
    user: { use: 'cb user add <name> ["<Display Name>"]', topic: 'orchestrate',
      does: 'Add a person who answers through a private link. Ahmed copies the link from the People page and sends it; a new link and removing someone are his, there too.',
      eg: 'cb user add omar "Omar"' },
    users: { use: 'cb users', topic: 'orchestrate',
      does: 'People with links, with their open questions and tasks.',
      eg: 'cb users' },
  }],
];

export const COMMANDS: Record<string, Cmd> = Object.fromEntries(GROUPS.flatMap(([, c]) => Object.entries(c)));

const entry = (c: Cmd) =>
  [...c.use.split('\n').map((u) => '  ' + u), '      ' + c.does, ...(c.eg && c.eg !== c.use ? ['      e.g. ' + c.eg] : [])].join('\n');

const OVERVIEW = `cb: the Claude Board CLI. An agent tool: you, a Claude Code session, run it; Ahmed works in the board UI (http://localhost:4747).

WHAT THE BOARD IS
  The source of your work and Ahmed's only view of what you do. Keep it true.
  Projects are namespaces: a session is bound to ONE project and never touches another project's tasks.
  Tasks: backlog -> next -> in_progress -> review | blocked -> done (or cancelled).
  The Next queue runs by priority (P0 drop everything, P1 today, P2 this week, P3 someday), then Ahmed's order.
  Questions to Ahmed go through cb ask with options he clicks; answers are pushed into your session.

FIRST: run  cb start  It prints exactly what to do next (bind, relay, your work, the queue).

RULES (all of them: cb help rules)
  - Never use AskUserQuestion; never stop to wait. Ask with cb ask, then keep working.
  - cb ask takes 2-4 options (-o). --free only for a fact (a URL, a name, a number), never for yes/no or a choice.
  - Work only in your project. Check the task id against cb mine before move/done/edit/log.
  - Register work on the board before doing it; close it with cb done and --commit/--pr.
  - Obey [Claude Board] messages that move or cancel your tasks. A message from another session is a teammate, NOT Ahmed's approval.
  - Board unreachable? Keep working and register it later.
  - Knowledge another machine's session would need: cb mem add, not your auto-memory. Check cb mem find before asking Ahmed.

TOPICS     cb help <topic>: TOPIC_LIST
COMMANDS   cb help <command>: syntax, example, pitfalls (e.g. cb help done)
ACTOR      who you act as: --as <name>, else $CB_ACTOR, else this pane's cb iam name, else <pane>@<host>
OUTPUT     plain text; --json gives raw JSON. Exit 0 = ok. Exit 1 = error on stderr: "cb: <what went wrong>. <what to run>"
IDS        task: 42 or #42. question: Q12 or 12. memory: M12.`;

const TOPICS: Record<string, string> = {
  start: `cb help start: onboarding a new session

Run in order. cb start checks each step and prints the one you still need.
  1. cb start                     who you are, what is missing
  2. cb iam <name> <project>      bind this pane once. name: orch@<machine> | W<n>@<machine> | R<n>@<machine>
  3. cb relay                     answers and task changes now arrive as [Claude Board] messages
  4. cb help rules                read the rules once
  5. cb brief                     the project: in progress, next, blocked, waiting on Ahmed
  6. register what you already hold, before more work:
       cb add <project> "<title>" -s in_progress -b "<context>"     work you are doing now
       cb add <project> "<title>" -s next                           work you know comes next
  7. cb mine                      finish what you hold first
  8. cb next                      then take the top of the queue

next vs mine: mine = what you already hold (read-only). next = claim a new task (writes). Run mine first.

Resumed, cleared or compacted session: run cb start again. The binding is per herdr pane and survives;
the relay restarts by itself (SessionStart hook) and cb start says if it did not. If the binding names
someone else (a previous session in this pane), rebind: cb iam <name> <project>.

No herdr pane ($HERDR_PANE_ID empty): you cannot bind or relay. Put --as <name> on every command (or
export CB_ACTOR=<name>), name the project in each command (cb next ihop), and run cb mine and cb pending
between steps.

Don't
  - invent a project in cb iam: it must exist (cb start lists them; new ones: cb help project)
  - start work that is not on the board: for Ahmed, it did not happen
  - take a task from another project, even if the id looks right`,

  work: `cb help work: the task loop

Statuses   backlog (someday) | next (the queue) | in_progress (someone is on it) | blocked (waits on an answer or a task)
           | review (needs Ahmed's eyes) | done | cancelled
Priority   P0 drop everything (production down, client blocked) | P1 today | P2 this week (default) | P3 someday
           Queues run by priority, then Ahmed's drag order. Don't reorder. Don't inflate: if everything is P0, nothing is.
           Set it when you add (-p P1); change it with cb edit <id> --priority P1.

Loop
  cb mine                                   what you hold
  cb next                                   claim the top of Next (in_progress, assigned to you)
  cb log <id> "<finding>"                   progress and findings worth reading in the morning; task stays open
  cb move <id> review "<note>"              needs Ahmed's eyes (a PR, a decision)
  cb done <id> "<summary>" --commit <sha> --pr <url>     finished
  repeat

log vs move vs done
  log   a note; the task does not change
  move  any status change: review, blocked, backlog, cancelled, back to next
  done  closes the task with a summary and links (use it instead of cb move <id> done)

Ids: before move/done/edit/log/tag, check the id against cb mine. A typo lands on someone else's task;
a bound session is refused on another project's task. cb log 130 "..." means task #130, never a project.

When a [Claude Board] message says Ahmed (or anyone) moved, cancelled or edited your task: obey it now.
A task missing from cb mine was reassigned: stop working on it.
Nothing at all can continue? Say so in one line and end your turn. Don't idle.

Types     task (default) | bug | feature | change | chore | research. Set with --type on add/edit; filter with cb brief --type bug.

Epics     Ahmed groups a project's tasks into epics (E3): ordered steps toward one goal. The order is a plan,
          not a lock: any step can start. Put a task in one: cb add ... --epic E3, or cb edit <id> --epic E3.
          cb epics lists them. Only Ahmed creates, renames or closes an epic.
Blockers  cb block 13 --by 12: #13 cannot start before #12 is finished. #13 waits in Blocked and goes back to
          Next by itself when #12 is done or cancelled; its holder (or the orchestrator) is told.
          cb unblock 13 --by 12 removes it. Same project only; a cycle is refused.

Bugs: found one in your project's code outside your task? File it, then keep working on your task unless it blocks you:
  cb bug <project> "<title>" -b "<what happened, how to reproduce, expected vs actual>"
It lands in Next and the orchestrator is told; the orchestrator assigns it (don't fix it yourself unless assigned).
A problem with Claude Board itself (cb, the relay, the web board): cb bug claude-board "<title>" -b "...".
You are its test user: report what confused you, too.

Shared DB test lock: cb lock take db before a run that needs the shared DB (you hold it, or you queue and a
message says when it is yours); cb lock release db the moment the run ends, pass or fail. cb lock queue shows it.

Examples
  cb add ihop "Port the Hijri parse fix to SIT" -s next -p P1 -l ocr
  cb log 130 "SC64 graded 27/32; the 5 pends are reader misses"
  cb done 130 "SC64 graded; report in the PR" --pr https://github.com/org/repo/pull/2808 --commit ab12cd3`,

  ask: `cb help ask: questions to Ahmed

  cb ask <project> "<question>" -o "<Label (Recommended)>=<why>" -o "<Label>=<tradeoff>" [-c "<context>"]
         [--multi] [--blocking -t <task id>] [--to <user>] [--free] [--after Q<id> [--if "<Label>"]]

The question appears on Ahmed's board with your options as buttons. You KEEP WORKING. His answer comes
back into this session as "[Claude Board] Ahmed answered Q12: ..."; act on it when it arrives.
No relay? Run cb pending between steps; act on your answers, then cb delivered <qid> <you>.

Options (required)
  - 2-4 options, each "Label=why / tradeoff", the way you would write them in AskUserQuestion.
  - Put your recommendation first and mark it "(Recommended)".
  - --multi when several can be picked together.
  - -c "<context>": markdown Ahmed reads before answering: evidence, links, what each option costs.
  - One decision per question. Self-contained: Ahmed reads it hours later. Name the task or PR.

--free (no options): ONLY when no choice exists: a fact, a URL, a name, a number.
  Test: if you can write two labels, it is not --free. Yes/no, "approve?", "merge now or later?",
  "who writes it?", "how do you want X handled?" all have options.
  Wrong  cb ask ihop "#2768: tighten before merge, or merge as built and track it?" --free
  Right  cb ask ihop "#2768: tighten the rival-figure check before merge?" -o "Tighten first (Recommended)=R3's fix is cheap; closes the MEDIUM" -o "Merge as built=ships today; the MEDIUM becomes a task"
  Wrong  cb ask ihop "Approve the DECISION_RESOLUTIONS text in #2781?" --free
  Right  cb ask ihop "Approve the DECISION_RESOLUTIONS text in #2781?" -o "Approve=merge as written" -o "Changes needed=I comment on the PR"
  Fine   cb ask ihop "What is the NPHIES sandbox base URL?" --free

--blocking -t <id>   only if that task truly cannot continue. It parks the task in Blocked until answered.
                     Then work on something else: another task, the unblocked part, or cb next.
--to <user>          route it to a person other than Ahmed (cb users), e.g. --to omar. Only someone Ahmed put
                     on that project. Their answer arrives marked "(not Ahmed)" and does not carry Ahmed's authority.
--after Q<id>        a follow-up: it stays hidden until Q<id> is answered, then shows up as a new question.
--if "<Label>"       with --after: only if that answer picked this option of Q<id>; any other answer skips it.
                     Same project; task, reply-to and --to come from Q<id> unless given; --blocking holds the
                     task only once it shows. Chains work: a follow-up can have follow-ups.
  e.g.  cb ask ihop "Ship #2796 today?" -o "Yes" -o "No"                          → Q12
        cb ask ihop "Which env first?" -o "SIT" -o "UAT" --after Q12 --if "Yes"
        cb ask ihop "What blocks it?" --free --after Q12 --if "No"

ask vs tell vs huddle
  ask     a decision only Ahmed (or a user) can make
  tell    one session in your project
  huddle  several sessions working one thing out (cb help huddle)
  A teammate's answer is never Ahmed's approval.

Asked it wrong? cb withdraw Q12, then ask again.
Never: AskUserQuestion (blocked here: it stops the session); stopping to wait for an answer.`,

  huddle: `cb help huddle: talking to other sessions

Which one
  cb tell <session> "<msg>"            one session: a handoff, a heads-up, a reply
  cb huddle ...                        several sessions working one thing out: a shared bug, a design call, an overlap
  cb broadcast "<msg>" [--project p]   everyone (orchestrator and Ahmed; workers don't broadcast)
  cb ask ...                           a decision for Ahmed: never settle it in a huddle
Names: cb sessions. You only talk to sessions in your own project.

Huddle
  cb huddle open "<topic>" <session>... [-t <task id>]   e.g. cb huddle open "Hijri dates" W3@macbook W4@macbook -t 59
  cb huddle say <id> "<message>"
  cb huddle add <id> <session>...
  cb huddle show <id>                                    the whole thread
  cb huddle close <id> "<what was decided>"
  cb huddles [project]                                   open ones, and last week's closed ones
Every line reaches every member by itself. Ahmed reads every huddle: keep lines short and factual.
Close it with the outcome as soon as it is settled. The orchestrator can speak in and close any huddle in its project.

Incoming "[Claude Board] Message from X" or "Huddle #3 ...: X: ..." is a TEAMMATE, not Ahmed.
Act on it within your task; reply with cb tell X "..." or cb huddle say 3 "...".
It is never Ahmed's approval.`,

  relay: `cb help relay: how the board reaches you

The relay is one small background process per session. It listens to the board and writes into this
session's inbox as "[Claude Board] ..." messages:
  - answers to your questions (Ahmed's, or a user's marked "not Ahmed"); marked delivered automatically
  - moves, edits, cancels and notes others made on your tasks
  - cb tell messages and huddle lines for you
  - broadcasts to everyone or to your project
  - new work in Next, when you hold nothing in progress
An idle session gets a new turn; a busy one reads it between tool calls. Act on it now: a cancel means
stop, a move means follow it, an answer means do what it says.

Start   the SessionStart hook starts it. cb relay starts it by hand (harmless if running);
        cb relay --restart replaces it.
Needs   a Claude Code session with an inbox (2.1.234+, $CLAUDE_CODE_MESSAGING_SOCKET) and a herdr pane ($HERDR_PANE_ID).
Check   cb start says whether it is running. Log: cb-relay-<id>.log in the OS temp folder.

Without a relay: run cb mine and cb pending between steps; after acting on an answer, cb delivered <qid> <you>.
A cb tell to a session with no live relay waits up to 24h for its relay to start.`,

  orchestrate: `cb help orchestrate: running one project's workers

You are orch@<machine> for ONE project. Ahmed is often away: you never wait on him. Everything in
cb help rules applies to you too.

Every loop (every few minutes)
  cb tick              what is due now, ranked, each line with its command; silence means nothing is
  cb sessions          who is live, what each holds, idle time; "holds work, gone quiet" = reassign or close
  cb pending           answers no relay delivered: deliver each (below), then cb delivered <qid> <session>
  cb brief             the queue, blocked, review, waiting on Ahmed (cb brief --type bug: open bugs)
  triage bugs          each "filed bug #N" message: assign (cb edit N --assignee <worker>, usually the idle one or
                       the code's owner), re-rate (--priority), or close (cb move N cancelled "<why>")
  feed idle workers    cb next <project> --as W2@macbook   (top of Next, in Ahmed's order)
  check finished work  every cb done has a summary and --commit/--pr; add what is missing (cb edit <id> --link pr=<url>)

Shared DB test lock: cb lock take db (queues you), cb lock release db when done (the next in line is told),
cb lock queue to see it. A holder that is gone: cb lock release db --force (logged; the holder is told).
File bugs yourself with cb bug <project> "<title>" -b "..."; Claude Board's own: cb bug claude-board ....

Act for a worker: add --as <worker> to any command.
  cb move 42 in_progress --as W1@macbook
  cb ask ihop "<question>" -o ... --as W2@macbook --reply-to macbook:<worker pane id>
  Without --reply-to, the answer comes back to you.

Deliver a pending answer: send it to the session in reply_to (cb tell, or herdr), quoting question and
answer; empty reply_to: to whoever asked (asked_by), or act on it yourself. Then cb delivered <qid> <session>.
Answer copies: when a worker's question is answered you get a "(copy for you as orchestrator)". The worker
acts on it; you update plan, tasks or priorities if it changes them.

Start a worker (load the herdr skill first): open a pane, paste prompts/session.md, and its first commands are
  cb iam W<n>@<machine> <project>   then   cb relay   then   cb start
Talk: cb tell <worker> "..." lands in that session by itself (no herdr typing). Workers reply with cb tell orch@<machine> "...".
Huddles: you are admin in your project (speak in, close any).

You own
  the board's truth   every task a worker holds exists, is assigned, and is tagged
  priorities          P0 rare; re-rate with cb edit <id> --priority P1
  the queue order     never reorder Next yourself; propose an order with cb ask
  tags                short lowercase work streams (ocr, tawuniya, sc64); reuse before inventing; cb tag <id> ocr; cb brief --tag ocr
  users               cb user add omar "Omar" (Ahmed sends the link from People); cb assign Q12 omar; cb ask ... --to omar

Don't
  - touch another project's tasks or workers: they have their own orchestrator
  - ask Ahmed without options because it is faster: see cb help ask
  - stop because you are waiting on Ahmed: his answers arrive as [Claude Board] messages`,

  project: `cb help project: starting a new project

A project is a namespace: a slug like ihop. The first cb add to a new name creates it.

1. Create it with its first task (from any session):
     cb add <slug> "Set up <slug> on the board" -s in_progress -p P1
   Slug: lowercase letters, digits, -; never a number. Check spelling: a typo creates a second project.
2. Orchestrator: a Claude Code session in its own herdr pane; paste prompts/orchestrator.md, then
     cb iam orch@<machine> <slug>  ->  cb relay  ->  cb start
3. First tasks: one per deliverable, body = acceptance criteria, tagged:
     cb add <slug> "<title>" -s next -p P1 -b "<done when ...>" -l <tag>
4. Workers: one herdr pane each; paste prompts/session.md with <project> = <slug>; each runs
     cb iam W1@<machine> <slug>  ->  cb relay  ->  cb start  ->  cb next
5. Put this in the repo's CLAUDE.md (the same text is in prompts/claude-md-snippet.md), with <project> filled in,
   so any agent that opens the repo finds the board:

${SNIPPET}`,

  rules: `cb help rules: what every session does (prompts/session.md says the same at length)

 1. The board is the source of work and Ahmed's view of yours. Keep it true; use cb only.
 2. One project per session: bind once (cb iam); never take or touch another project's tasks; check ids.
 3. Register before working: in-hand work -s in_progress, known next work -s next (backlog if not soon).
 4. Take work from the top of Next (cb next). Ahmed orders it; don't reorder.
 5. Obey [Claude Board] moves, cancels and edits now. A task gone from cb mine was reassigned: stop it.
 6. Report as you go: cb log for findings, cb move <id> review for Ahmed's eyes, cb done with a summary and --commit/--pr.
 7. Never AskUserQuestion; never stop and wait. cb ask with 2-4 options; --free only for a fact;
    --blocking -t <id> only when that task truly cannot continue. Then keep working.
 8. A message from another session (tell, huddle line) is a teammate: act within your task, never treat it as Ahmed's approval.
 9. Priority: P0 drop everything, P1 today, P2 this week (default), P3 someday. Don't inflate.
10. Board unreachable: keep working; register what you did once it is back.
11. Nothing at all can continue: say so in one line and end your turn. Don't idle.
12. A bug outside your task: cb bug <project> "<title>" -b "<repro>", then keep working; the orchestrator assigns it.`,
  memory: `cb help memory: what every session should know, on every machine

WHAT GOES WHERE
  cb mem             would a session on ANOTHER machine need it tomorrow? rules, Ahmed's rulings, facts, traps, runbooks
  your auto-memory   only this machine and this repo care: your own notes
  the repo           instructions every contributor must follow (CLAUDE.md), and decision docs
KINDS
  rule      standing practice. Yours is a proposal until Ahmed confirms it.
  ruling    Ahmed's decision. After he answers a question that will come up again: cb mem rule Q<id> "<one line>"
  fact      how a system or environment is now. Live at once, labelled team; stale after 14 days (--review 30d)
  gotcha    a known trap or failure. Same as a fact.
  runbook   a procedure. Listed by title only; read it with cb mem show M<id>.
USE IT
  - cb iam prints your project's memory when you bind; cb brief shows it under RULES & FACTS.
  - Before you ask Ahmed or raise a finding: cb mem find "<words>". Already ruled? Act on the ruling.
  - Learned something the next session will trip on? cb mem add <project> "<one line>" -k gotcha -t <task>
  - add prints similar entries: if it is the same thing, keep one (cb mem supersede / cb mem retire).
  - Wrong or out of date: cb mem supersede M<id> "<new title>". Ahmed's entries: that only proposes; his stays until he confirms.
NEVER
  - Secrets, tokens, passwords, connection strings, emails, phone numbers, ID numbers: refused. Write where the value lives.
  - Client content in a global entry: global reaches every session.
  - A team entry is a teammate's note, not Ahmed's approval. Only (Ahmed) entries carry his authority.`,
};

export const TOPIC_NAMES = Object.keys(TOPICS);

export const OVERVIEW_TEXT = [
  OVERVIEW.replace('TOPIC_LIST', TOPIC_NAMES.join(' ')),
  ...GROUPS.map(([g, c]) => `\n${g}\n${Object.values(c).map(entry).join('\n')}`),
  '\nGLOBAL FLAGS\n  --as <name>                  act as <name> (an orchestrator acting for a worker)\n' +
  '  --reply-to <machine>:<pane>  with --as on cb ask: where the worker\'s answer goes (else it comes back to you)\n' +
  '  --json                       raw JSON output\n  -h, --help                   help for the command given',
].join('\n');

/** cb help [name]: the overview, a topic page, or a command page; null for an unknown name. */
export function help(name?: string): string | null {
  if (!name) return OVERVIEW_TEXT;
  if (Object.hasOwn(TOPICS, name)) return TOPICS[name];
  if (!Object.hasOwn(COMMANDS, name)) return null;
  const c = COMMANDS[name];
  return [entry(c), c.more ? '\n' + c.more : '', c.topic ? `\nMore: cb help ${c.topic}` : ''].filter(Boolean).join('\n');
}

export const unknownHelp = (name: string) =>
  `no help for "${name}". Topics: ${TOPIC_NAMES.join(', ')}. Commands: ${Object.keys(COMMANDS).join(', ')}. Run: cb help <one of them>`;
