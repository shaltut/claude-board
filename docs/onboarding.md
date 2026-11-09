# Onboarding agents and projects onto Claude Board

`cb` is for agents. You work in the board UI (http://localhost:4747); sessions run `cb`. Each
session learns the board from three places, and they all point at the same commands:

| Where | What it says | Who reads it |
|---|---|---|
| `prompts/session.md`, `prompts/orchestrator.md` | The full rules, in workflow order | A session you start and paste it into |
| Snippet in the repo's `CLAUDE.md` (`prompts/claude-md-snippet.md`) | "Run `cb start`" plus the 3 hard rules | Any agent that opens the repo |
| `cb start`, `cb help`, `cb help <topic>` | What to do right now; the manual; the deeper pages | The agent, on demand |

## A new agent joins a project

1. Start a Claude Code session in a herdr pane. The SessionStart hook starts its relay.
2. Give it `prompts/session.md` (with `<project>` filled in), or let the repo's CLAUDE.md snippet send it to `cb start`.
3. It runs `cb start`, which checks one thing at a time and prints the next command:
   - **not bound** → `cb iam W<n>@<machine> <project>`, with the list of projects
   - **relay off** → `cb relay`
   - **ready** → its tasks, the head of the queue, its open questions, and either "continue #N" or `cb next`
4. It reads `cb help rules` once, registers what it already holds (`cb add ... -s in_progress`), then loops on
   `cb next` → `cb log` → `cb done --commit`.

A session with no herdr pane can't bind or relay. `cb start` tells it to use `--as <name>`, to name the
project in each command, and to poll `cb mine` / `cb pending`.

## A new project

1. **Create it** with its first task: `cb add <slug> "Set up <slug> on the board" -s in_progress -p P1`.
   The first `cb add` creates the project. Slugs are lowercase, and a typo creates a second project.
2. **Orchestrator:** a session in its own pane, given `prompts/orchestrator.md`, runs
   `cb iam orch@<machine> <slug>`, then `cb relay`, then `cb start`.
3. **First tasks:** one per deliverable, with acceptance criteria in the body, tagged:
   `cb add <slug> "<title>" -s next -p P1 -b "<done when ...>" -l <tag>`.
4. **Workers:** the orchestrator opens panes and gives each one `prompts/session.md`. Each worker runs
   `cb iam W<n>@<machine> <slug>`, then `cb relay`, then `cb start`, then `cb next`.
5. **Repo:** paste `prompts/claude-md-snippet.md` into the repo's `CLAUDE.md`, with `<project>` filled in.
   `cb help project` prints the same text.

## What the CLI does against known mistakes

| Mistake seen on the board | What stops it now |
|---|---|
| `cb log 130 "..."` created projects named 130 | A bare number is a task id; numeric project names are refused |
| Working another project's task through a mistyped id | A bound session is refused, and the error says to check `cb mine` |
| Questions asked with `--free` when they had obvious choices | `cb help ask` gives a litmus test with real wrong/right pairs; every `--free` post prints a reminder to withdraw it and re-ask with `-o` |
| Vague errors | Every error ends with the command to run (usage plus `cb help <cmd>`, or a specific fix) |
| Help drifting behind new commands | A test fails when a `case` in `cli/cb.ts` has no entry in `cli/help.ts` |
