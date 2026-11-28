# Running the board on the VPS

Everything here runs in `/opt/claude-board/deploy` on the VPS (vps2) unless it says otherwise. `dc` below is
`docker compose`. The https side is Nginx Proxy Manager's proxy host `board.example.com` ([deploy.md](deploy.md#5-https-in-front)).

## Is it up?

```bash
dc ps                                   # db and board: running (healthy)
curl -s localhost:4747/healthz          # {"ok":true}; 503 = the board can't reach Postgres
dc logs --tail 50 board                 # errors, "github: ..." poll failures, Telegram
dc exec board cb github                 # watched repos: last poll should be minutes ago
dc exec board cb sessions               # which sessions are alive
```

For alerts, point an uptime monitor (Cloudflare health checks, UptimeRobot) at `https://<public url>/healthz`.

## Restart

```bash
dc restart board          # the server; sessions and browsers reconnect by themselves
dc restart db             # Postgres; the board and every relay reconnect (give it a minute)
```

Never `dc down -v`: `-v` deletes the database volume (and gh's login).

## Upgrade

The agent-neutral core (#4002: the per-seat relay, Stage A+B, and the unified command guard, Stage C) ships as ONE
release. Order: vps2 (the board and its schema) first, then the PC, then the Mac, then restart `cb supervise`.

A release is: the change merged to `main` (reviewed, the suite green on the PC or Mac), then:

```bash
cd /opt/claude-board && git fetch && git merge --ff-only origin/main
git log --oneline -1                    # must show the sha you pushed
git archive --format=tar.gz -o release.tgz HEAD -- bin cli db prompts server hooks kit   # the release workers check (#4352)
cd deploy && dc up -d --build board     # builds, applies the schema, swaps the container (seconds of downtime)
dc logs --tail 20 board                 # "claude_board ready", then the listen line
dc ps                                   # board shows a fresh "Up <seconds>"
```

vps2's checkout is on the `vps` branch, which tracks `origin/vps`, not `main`. A plain `git pull --ff-only` says
"Already up to date", and `dc up -d --build board` then rebuilds the OLD code from cached layers. Merge `origin/main`
as above, and check `git log --oneline -1` before the build.

If vps2's public ssh port times out, use the Tailscale route:
`ssh -o HostName=<tailscale ip> -o HostKeyAlias=<public ip> vps2`.

Then the workers, right away, because their `cb` must match the schema:

- **PC:** `git -C C:\work\claude-board pull --ff-only`
- **MacBook:** `~/Work/claude-board` is a copy, not a clone. From the PC (Git Bash, in the updated checkout):

  ```bash
  tar czf /tmp/cb.tgz bin cli db prompts server hooks kit && sum=$(md5sum /tmp/cb.tgz | cut -d' ' -f1)
  ssh macbook '[ ! -L Work/claude-board ]' && scp /tmp/cb.tgz macbook:Work/claude-board/cb.tgz
  ssh macbook "[ -L ~/Work/claude-board ] && { echo \"this copy is updated with cb update\"; exit 1; }; cd ~/Work/claude-board && [ \"\$(md5 -q cb.tgz)\" = $sum ] && tar xzf cb.tgz && rm cb.tgz && zsh -lc 'node cli/cb.ts sessions' | head -3"
  ```

  Extract only when the checksums match: a Tailscale hiccup once delivered half an archive, and a partial extract
  broke every `cb` on the Mac for 15 minutes.
- **Check each worker** after its update (#4352): build the manifest in the updated checkout on the PC
  (`node cli/release.ts --out /tmp/release.json`; it refuses a tree with uncommitted release files), copy it next to
  the archive, and run `cb doctor --manifest <file>` on the worker (on the PC's own checkout plain `cb doctor` compares
  with git: every release file committed and none untracked). It names every missing or changed file, checks the
  installed guard and its hook (as `node kit/guard/install.mjs --check`), writes nothing, never connects to the board,
  and exits 0 only when everything matches.
  Or, once the board serves the release (the `git archive` line above; its log says `release: serving <sha>`):
  `cb update --check --from <board https address>` (or PUBLIC_URL in the worker's .env). It fetches
  `/release/current.json` and `/release/<sha>.tgz` (no sign-in: the public repo's tracked files only; the board refuses
  an archive holding an env file or node_modules), verifies the archive, and compares the worker's files the same way.
  It writes nothing. Without `release.tgz` the image still builds; `/release/current.json` then answers 404 with why.
  The Today page says it too: each relay notes the commit its code is (`cb.sessions.code_sha`), and Today shows one
  line, `N seats run other code than the board (<sha>): <machine> <count>, ...`, while any live seat differs (a relay
  too old to say counts), and nothing when all match.
- **Install the release on a copy** (#4352): `cb update --from <board https address>` on the worker (the Mac),
  instead of the tar lines above. A git checkout (the PC) is refused: it updates with `git pull --ff-only`.
  Once a copy has had one `cb update`, never use the tar lines on it again: they would extract into the version in
  use (through the link) instead of a new one. This change touches `cli/relay.ts`, so the Mac gate below applies.
  - Schema first: before writing anything, `cb update` asks the board's database whether it has the schema the release
    needs (the sha256 of the release's `db/schema.sql`; `db/setup.ts` notes each schema it applies in
    `cb.schema_applied()`, and `cb.schema_covers` answers). A board whose schema is older, or one from before this check,
    is refused with what to deploy first: deploy the board (above), then `cb update` again.
  - First run: the copy moves to `<copy>.home` and `<copy>` becomes a link to it (a symlink; a junction on Windows),
    the same code. Each release goes in `<copy>.home/versions/<sha>`: written from the verified archive, `bin/cb` made
    executable (git stores it 644), checked file by file against the manifest, then `cb help` and `cb sessions` run
    from it. Only then `<copy>` is pointed at it (macOS: a new link renamed over the old one, atomic). A probe that
    fails leaves `<copy>` on the old code and nothing staged.
  - Packages: `node_modules`, `package.json`, `pnpm-lock.yaml` and `.env` stay in `<copy>.home` and are never touched;
    a version finds them by Node's upward lookup (and `.env` through server/db.ts). The board's `current.json` names
    the release's lockfile hash; a different one is refused: update the packages in `<copy>.home` by hand
    (`pnpm install --frozen-lockfile`), then `cb update` again. Absolute links into the copy (pnpm on Windows) are
    refused before anything moves (`--config.node-linker=hoisted` avoids them).
  - The safe point: a running process keeps the modules it loaded, and no version is ever deleted, so nothing breaks
    mid-flip. Relays notice their code path now points at new files and restart into it: each flip, update or
    rollback, restarts every relay running from the copy within ~3 s (no message is lost; at worst one duplicate push). A runner or supervisor running from the copy makes `cb update` refuse: stop it by its
    pid (never by name), update, start it again; `--force` goes ahead and leaves it on the old code until restarted.
    One started by a relative path (`node cli/runner.ts`) counts only when its working folder is the copy (read from
    `/proc` or `lsof`); another checkout's does not. When the folder cannot be read (always on Windows), `cb update`
    refuses and says so: `--force` when it is not this copy's.
    Nothing is stopped by `cb update`.
  - `cb update --rollback` points `<copy>` back at the version before (the original copy after the first update);
    run it again to go forward. Back on the original copy, relays run its older relay.ts, which does not follow a flip:
    after the next `cb update`, run `cb relay --restart` in each pane (rollback prints this). `<copy>.home/versions/state.json` holds `{current, previous}`. One update at a time
    per copy (`<copy>.update.lock`, taken over when its pid is gone). Old versions stay until removed by hand.
  - The probes are `cb help`, `cb sessions` and `node cli/relay.ts` (no pane: it loads every relay module, then exits
    before connecting). A run cut off midway is finished by the next one: a missing copy path is linked again, a
    `state.json` behind the link is settled, and a dead run's staging folder or spare link is removed.
    With the copy's path gone, `cb` cannot start from it: run `node <copy>.home/cli/cb.ts update --root <copy>`
    (on the Mac: `node ~/Work/claude-board.home/cli/cb.ts update --root ~/Work/claude-board`). Without `--root` it
    refuses, since `<copy>.home` is never a copy.
- **Mac gate (HARD), before the first real squad restarts on the Mac:** start one throwaway Claude on haiku in its
  own herdr tab, in a scratch folder (no client data), and leave it with a relay on the new code for 5+ minutes.
  Confirm its screen is unchanged, its cost reads 0.0000 and no turn started. If any of those fails, stop the Mac
  rollout and roll the Mac back. Pair it with the first live `herdr --env` start.
- Relays restart themselves when their code changes. Their connections are named `cb-relay/<version>` (a hash of
  the relay's code), so one query shows which sessions run what:
  `dc exec db psql -U cb -d claude_board -c "select application_name, count(*) from pg_stat_activity group by 1"`.
  Each session holds two (its LISTEN and its queries); `cb` calls ride on them (cli/bridge.ts).
- **The guard**, when the release changed `kit/guard/` (this one does): each machine runs its own installed copy in
  `~/.claude-board/guard`, not the checkout's. With Ahmed's yes, on the PC and then on the Mac (from
  `~/Work/claude-board`, after the tar step), run `node kit/guard/install.mjs` and then
  `node kit/guard/install.mjs --check`, and point the hook at it:
  [Installing the guard](#installing-the-guard-on-a-machine).
  **Never copy `kit/hooks/block-dangerous.mjs` into `~/.claude/hooks/`.** It is now a thin wrapper that imports
  `../guard/core.mjs`; copied alone it cannot find it, and it blocks EVERY shell command on that machine.
- **Restart the supervisor** (`cb supervise`, see [Supervisor](#supervisor)) after the PC has the new code.
  After any change to `cli/recipes.ts` or `runner.json`, restart BOTH `cb runner` and `cb supervise` (rule 3 under
  [PC job runner](#pc-job-runner)).
  Relays restart themselves once when their code changes.
- **Claude seats need no `~/.claude` change for the relay.** The live SessionStart hook already runs
  `node <checkout>/cli/relay.ts` (the launcher). It now hands Claude's messaging socket and token to the seat relay
  through the endpoint file `cb-seat-<seatKey>.claude.json` in the OS temp folder. That file holds the messaging
  token: never print or copy it. `hooks/claude-endpoint.mjs` is an alternative hook entry, not required.

If the schema change drops or renames a function the old CLI calls, a worker's `cb` fails until it is updated: that
is the window to keep short.

**Rolling back** code: `git checkout <previous sha> && dc up -d --build board`. The schema is applied forward only:
new columns stay (older code ignores them), and functions revert, because `db/setup.ts` re-applies `db/schema.sql`
(line 25) and the old file redefines them. If an upgrade damaged data, restore the last backup (below).
On vps2 the checkout is now detached from `vps`: the next release must first run `git checkout vps`, before its merge.

For the agent-neutral release the order runs the other way: the PC and the Mac FIRST (check out the previous sha, tar
step on the Mac, restart `cb supervise`), vps2 LAST. A new `cb` against old functions fails; an old `cb` against the
new columns works. The guard's own way back is one line, see below.

## Installing the guard on a machine

Run only with Ahmed's yes: it changes `~/.claude`, which every Claude session on the machine reads.

The guard is `kit/guard/` (`core.mjs`, `shim-claude.mjs`, `install.mjs`). The old single-file
`kit/hooks/block-dangerous.mjs` is retired as an install: it is a thin wrapper that imports `../guard/core.mjs`, so
**never copy it into `~/.claude/hooks/`**. Alone it blocks EVERY shell command on that machine.

1. From the checkout, install: `node kit/guard/install.mjs`. It defaults to `~/.claude-board/guard` (`--target <dir>`
   changes that). Then verify (after step 2): `node kit/guard/install.mjs --check` exits 0 when the installed files
   match the checkout AND `~/.claude/settings.json` has a PreToolUse hook that runs the installed shim with an absolute
   node that exists and a matcher covering Bash (and PowerShell on Windows), and the 6 probes pass through that exact
   hook command (#4348). Each problem prints one `hook:` line saying what to change. A herdr seat whose wiring is off
   hears one `Guard:` line at session start. Also checked: `disableAllHooks` is not set in that file, the hook is a
   `command` hook, and any `timeout` is 15 s or more (a hook that times out counts as allow). Git Bash forms
   (`/c/...`, `$HOME/...`, `~/...`) count as the same paths. On Windows the probes run through Git Bash, as Claude
   Code runs hooks (`CLAUDE_CODE_GIT_BASH_PATH`, else `%ProgramFiles%\Git\bin\bash.exe`; cmd.exe only with neither).
   Only this one settings file is read: `settings.local.json`, project settings and managed policy are not.
   `--check --no-wiring` checks the files only (CI, a machine with no `~/.claude`), where plain `--check` exits 1.
2. In `~/.claude/settings.json`, point the PreToolUse hook command at
   `node <abs-home>/.claude-board/guard/shim-claude.mjs` (the absolute home path, not `~`: the full home path, e.g. `C:/Users/<you>` on Windows, `/Users/<you>` on the Mac). On Windows, set that
   entry's matcher to `Bash|PowerShell`: Claude Code's PowerShell tool runs commands a `Bash`-only hook never sees.
   On the Mac the matcher is `Bash`.
3. Leave the pre-release `~/.claude/hooks/block-dangerous.mjs` (the standalone copy) in place, untouched. The way
   back is one line: set the hook command back to `node ~/.claude/hooks/block-dangerous.mjs`.
4. Check it, with the shim: `echo '{"tool_input":{"command":"ls"}}' | node ~/.claude-board/guard/shim-claude.mjs`
   prints `{}`, and
   `echo '{"tool_input":{"command":"git reset --hard"}}' | node ~/.claude-board/guard/shim-claude.mjs` prints the block JSON
   (`{"decision":"block","reason":"Blocked dangerous command: git reset --hard"}`), and, the protected-branch fence,
   `echo '{"tool_input":{"command":"git push origin development"}}' | CB_PROTECTED_BRANCHES=development node ~/.claude-board/guard/shim-claude.mjs`
   prints the block JSON
   (`{"decision":"block","reason":"Blocked dangerous command: git push to protected branch development: push your own branch and open a PR; the lead merges it"}`).
   And, the kill-by-name rule (#3809),
   `echo '{"tool_input":{"command":"taskkill /F /IM node.exe"}}' | node ~/.claude-board/guard/shim-claude.mjs` prints
   the block JSON with a reason starting `Blocked dangerous command: kill by process name`. And, malformed stdin
   (`echo 'not json' | node ~/.claude-board/guard/shim-claude.mjs`) must block, not allow: the reason starts
   `Blocked: guard could not read hook input (invalid JSON`. And, a builder's push to main:
   `echo '{"tool_input":{"command":"git push origin main"}}' | CB_ROLE=builder node ~/.claude-board/guard/shim-claude.mjs`
   must block, with a reason starting `Blocked by role (builder): git push to protected branch main`. The installed hook blocks these command lines when a Claude session runs them, so a session runs the
   checks from a small script that builds the command strings.
5. If `node` is not on the PATH of the shell that runs hooks (possible on the Mac), the hook exits 127, and Claude Code
   treats that as **allow**: the fence silently disappears. So the hook command uses an absolute node path
   (`command -v node` prints it; `--check` refuses a bare `node`), and from a fresh session confirm that a blocked
   command is refused.

On the Mac, the same, from `~/Work/claude-board` after the tar step above.

### Codex, agy and OpenCode seats (#4609)

Also only with Ahmed's yes, on each machine that runs those seats. A seat whose guard is not wired is refused by
the seat prestart, so until this runs those seats do not start.

```
node kit/guard/install.mjs --agents codex,opencode                         # per machine
node kit/guard/install.mjs --agents agy --seat <seat folder> [--seat ...]   # per agy seat folder
node kit/guard/install.mjs --check --agents codex,agy,opencode --seat <seat folder>
```

Each agent's shim is copied into the installed guard folder beside `core.mjs` and probed there (ls passes;
`git reset --hard`, a tool the shim does not know, and malformed input block) before anything is swapped in. The hooks
run that installed copy, never the checkout, so a `git pull` does not change a live guard unprobed.

- **Codex**: one `PreToolUse` entry in `$CODEX_HOME/hooks.json` (else `~/.codex/hooks.json`), matcher `.*`, command
  `<absolute node> <guard>/shim-codex.mjs`. Every other entry stays as it was, herdr's `SessionStart` included; an older
  guard entry (one pointing at a checkout) is replaced. `config.toml` gets `hooks = true` under `[features]`. A
  `hooks = false` there, or an inline `features = { ... }`, is refused: change it by hand, as is a file this installer
  cannot read the same way Codex does (a `[features]` header it could not place the key under). The matcher is a
  catch-all, so a tool Codex adds later still reaches the shim. Codex 0.160's one shell tool, `exec_command`, arrives as
  `Bash`; there is no `unified_exec`; `write_stdin` fires no hook at all (#4618), so a seat may not open an interactive
  session for it to type into (#4626).
- **agy**: group `cb-guard` in `<seat>/.agents/hooks.json`, matcher `.*`, command `node <guard>/shim-agy.mjs`
  (forward slashes, no quotes: agy runs hooks through `cmd /c` on Windows, so a guard path with a space is refused;
  install it elsewhere with `--target`). Other groups stay. `/.agents/` goes into that repo's `info/exclude` (a worktree's
  shared one). agy loads a folder's hooks only once agy trusts the folder: trust each seat folder in agy.
- **OpenCode**: `kit/guard/opencode-plugin.js` written to `$XDG_CONFIG_HOME/opencode/plugins/cb-guard.js` (else
  `~/.config/...`), with the absolute node and the installed shim filled in. Its `tool.execute.before` sends every tool
  call to the shim and stops the call on a block, a non-zero exit, a timeout or any other output.

**These hooks are machine-wide** (agy's excepted: it is per seat folder), so they also run in the owner's own Codex and
OpenCode. There, with neither `CB_ROLE` nor `CB_AGENT` set, Codex and OpenCode get exactly what Claude gets outside a
seat: the dangerous-command rules only. A tool the shim does not judge (Codex `update_plan`, `spawn_agent`, MCP tools;
OpenCode `webfetch`, `websearch`, `task`, `todowrite`, `skill`, `lsp`) passes, as Claude's tools that never reach the
guard do; no role, fence or secret rule applies; and a question follows `CB_ALLOW_ASK`, as Claude's `AskUserQuestion`
does. In a board seat every tool the shim does not judge is denied, and a seat may not change `CB_ROLE` or `CB_AGENT`
(PR 96 review r2): the seat prestart also refuses to start an agent in a pane where either is missing or names
another agent.

Nor may a seat start a process with a fresh environment, which would run outside the seat with neither variable
(#4669): another user (`sudo`, `su`, `doas`, `runas`), `ssh` or `mosh` to this machine, a scheduler (`at`, `crontab`,
`systemd-run`, `launchctl submit`, `schtasks /create|/run`, `Register-ScheduledTask`), `wsl`, WMI's
`Win32_Process Create`, or a tmux, screen or herdr command that starts a pane or types into one. Their read-only forms
pass (`sudo --version`, `crontab -l`, `tmux ls`, `herdr pane read`, `wsl -l`, `schtasks /query`). Interpreter code
that hands a child an environment of its own (`env: {}`, `env={}` without `process.env` or `os.environ`) counts too.
A shell script the command runs (`bash x.sh`, `./x.sh`, `source x.sh`, `pwsh -File x.ps1`, `cmd /c x.cmd`) is read
from the hook's working folder and judged for both rules; `node x.js` and `python x.py` are not read, since tests start
children with their own env on purpose. A `cd` earlier in the same command is not followed. A lead seat keeps
`herdr agent prompt`, `herdr pane send-keys` and `ssh` to a host named by a plain variable (`deploy/copy-to-vps.sh`'s
`ssh "$VPS"`), since the lead drives other squads' seats and deploys; `$HOSTNAME`, loopback and this machine's name
still block. Every other role is blocked from all three.

`--agents` also installs the whole guard folder: Claude's shim and `core.mjs` there are replaced with this checkout's,
exactly as a plain install does, so every agent on the machine runs the same rules.

A second run changes nothing. A rewritten `config.toml`, `hooks.json` or `info/exclude` keeps its line endings and file
mode. `--check` with `--agents` also checks each wiring and runs the probes through its own command (for OpenCode: the
plugin is exactly what this checkout writes). Seats never write these files: the fence keeps them out, and the installer
itself refuses anything but `--check` when `CB_ROLE` or `CB_AGENT` is set.

## Rules files for the other agents

Claude Code reads `CLAUDE.md`. Codex, agy and OpenCode read `AGENTS.md`. There is one source for each level (#4765).

- **The repo.** `CLAUDE.md` is the file to edit. `node cli/agent-context.ts repo` makes `AGENTS.md` from it;
  commit both. `test/agent-context.test.ts` fails when they differ.
- **The user level, per machine.** From a checkout with `pnpm install` done, in the owner's own terminal:
  `node cli/agent-context.ts user` copies `~/.claude/CLAUDE.md` into `~/.codex/AGENTS.md`,
  `~/.config/opencode/AGENTS.md` and `~/.gemini/AGENTS.md` (`CODEX_HOME` and `XDG_CONFIG_HOME` are followed).
  - **It sends that file to each agent's model provider** from the next session on: read it first.
    `--agents codex,agy` limits which agents get it.
  - The copy sits between two `cb:user-rules` marker lines. What the file already said stays, outside the block: read
    it for lines that now contradict the copy. Taking the copy away again is deleting the block.
  - An agent with no config folder on the machine is skipped. Run it again after editing the source;
    `--check` writes nothing and exits 1 when a copy is out of date. A squad seat may only `--check`.
  - These files are never in git.

## Usage ledger

`hooks/usage-stop.mjs` (#4349) is a Claude Code **Stop** hook. At each Stop it sums the token usage of every assistant
turn in the session's transcript, and in its subagents' transcripts. It then sends the session's running totals to
`cb.usage_report`, which keeps one row per session in `cb.session_usage`. `cb usage [project] [--since 24h]` reads them.

- **What it sends:** only input, output, cache read and cache write tokens, the model id, the session id, the machine
  and the pane. It never sends transcript text or paths. Cost goes with them only when the status line wrote a fresh
  one (today the claude-hud status line, and only with its daily or weekly cost display on). Nothing is priced from a
  table.
- **Cost to a session:** it prints nothing and starts no child process. It always exits 0 and gives up after 1.9 s.
- **How it reads transcripts:** incrementally, keeping an offset per file in `cb-usage/<session>.json` in the OS temp
  folder. Each Stop reads at most 32 MB, so a long transcript catches up over a few Stops. State files untouched for
  7 days are deleted.
- **When the board is down:** a send that did not succeed (refused, or the 1.9 s deadline) is not tried again for
  5 minutes, so the Stops in between stay fast. The totals are cumulative: the next send catches up.
- **Where it runs:** only in herdr panes. `CB_USAGE_OFF=1` switches it off.

Switching it on changes `~/.claude`, which every Claude session on the machine reads: **only with Ahmed's yes**. The
board's schema must already have `cb.session_usage` (the board applies it on start, after a backup).

1. **Pick the node.** On each machine, use the same node path that machine's SessionStart hook entry in
   `~/.claude/settings.json` already uses: it is known to work from the hook shell. It must be an absolute path to the
   node executable itself (a bare `node` missing from the hook shell's PATH just fails, silently), not a
   version-manager shim such as Volta's `C:/Program Files/Volta/node.exe`, which starts another process on every Stop.
   Examples only:
   - **PC:** the installer's `C:/Program Files/nodejs/node.exe`.
   - **Mac:** nvm's `/Users/<you>/.nvm/versions/node/v24.<x>/bin/node`, or Homebrew's `/opt/homebrew/bin/node`.
2. **Add the hook.** In `~/.claude/settings.json`, add a `Stop` entry that runs the checkout's hook, with the node
   from step 1. Write Windows paths with forward slashes. The node paths below are the examples from step 1.
   - **PC** (checkout `C:/work/claude-board`):

     ```json
     "Stop": [{ "hooks": [{ "type": "command", "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/work/claude-board/hooks/usage-stop.mjs\"", "timeout": 5 }] }]
     ```

   - **Mac** (checkout `~/Work/claude-board`, written out in full, since `~` is not expanded inside the quotes):

     ```json
     "Stop": [{ "hooks": [{ "type": "command", "command": "\"/Users/<you>/.nvm/versions/node/v24.<x>/bin/node\" \"/Users/<you>/Work/claude-board/hooks/usage-stop.mjs\"", "timeout": 5 }] }]
     ```

   If `Stop` already has entries, add this one beside them. Existing hooks in `hooks/` are wired the same way: they run
   from the checkout, and only the guard is copied out (`kit/guard/install.mjs`). The tar step above already ships
   `hooks/` to the Mac.
3. **Check it.** Test the exact command first, with a made-up session:
   `echo '{"session_id":"probe","transcript_path":"/nonexistent.jsonl"}' | HERDR_PANE_ID=probe <the command>`
   prints nothing and exits 0. Then, after a live session's next reply, `cb usage --all --since 1h` lists that session,
   and its numbers grow at each Stop.
4. **Switch it off.** Remove that entry, or set `CB_USAGE_OFF=1` in the session's environment.

## Fault log and triage (#4535)

Every `cb` run that fails, needed a connect retry, started this machine's own board, or took over 5 s
(`CB_FAULT_SLOW_MS`) appends one JSON line to `~/.claude-board/faults/<UTC day>.jsonl` on the machine that ran it. A run
that succeeds writes nothing. The line holds the command and flag names, the kind, the exit code, an error code,
timings, the pane and a masked message: only words found in cb's own source survive (`kit/fault-words.json`), every
other word is `‹v›`, every number `N`, every argument value and quoted span `‹v›`. Never a value, a token, a URL, a path
or an environment value.

- **Where and how much.** `CB_FAULTS_HOME=<dir>` moves it, `CB_FAULTS_OFF=1` stops it. 5 MB per day file (then one
  `cap` line and nothing more that day), 14 days kept (`CB_FAULTS_KEEP_DAYS`). Under `node --test` nothing is written
  unless the test sets `CB_FAULTS_HOME`, so the suite's expected errors never reach a real log.
- **The words file.** `kit/fault-words.json` is generated (`node kit/fault-line.mjs --words`). Regenerate it as part of
  each release: `node cli/release.ts` prints a note when it differs from the source; then run the command on a branch
  and merge it before the release. A word missing from it is only masked, never leaked, so a stale file is a note,
  not a failure. `test/fault-log.test.ts` fails only when the file holds a word no longer in the source (a removed name
  must not survive) or a denied name.
- **Read it:** `cb faults [--since 24h] [--json]`. Local files only; works with the board down.
- **Triage it, by hand only** (Q3002: no schedule): `cb triage --dry-run` first, then `cb triage`. cb decides the
  plain groups itself (wrong use by fewer than 3 sessions, the board unreachable), searches claude-board for cards that
  may hold the rest, and makes one `claude -p --model opus` call with Read, Grep and Glob only (no shell, no MCP
  servers, no settings or hooks, an allow-listed environment) in a temporary copy of the tracked code (never the
  checkout's `.env`). The whole card as filed (the judge's text and cb's facts) passes the redaction check, or the
  group is held. Bugs and misleading messages pass a
  redaction check and are filed as P2 bugs on claude-board ending `fault:ft-…`, or noted on the open card that carries
  that marker, under `pg_advisory_xact_lock` on the template: two machines never file one fault twice. Nothing else is
  ever written (Q3001). Bounds: `--max 4` groups per run (one Opus run with 2 groups measured USD 0.28), `--budget 1.00` USD (`CB_TRIAGE_BUDGET_USD`), a 10-minute
  timeout (`CB_TRIAGE_TIMEOUT_MS`), one filing run per machine per 6 hours (`--force`). `triage.json` in the fault
  folder remembers every verdict, so a group is judged again only when its count triples or a new release shows it.
- **Not covered yet:** the hooks (session-start, usage-stop), the relay and the supervisor still log only to their own
  files, and the guard's fail-closed reasons are not recorded (it needs the guard reinstalled, which is Ahmed's).

## Backups

`deploy/backup.sh` runs nightly from root's crontab ([deploy.md](deploy.md#6-backups)): a `pg_dump -Fc` in
`/var/backups/claude-board`, 14 days kept. Run it by hand before anything risky:

```bash
sudo /opt/claude-board/deploy/backup.sh       # prints the file
```

Once a month, prove a backup restores, into a scratch database next to the live one:

```bash
f=$(ls -t /var/backups/claude-board/*.dump | head -1)
dc exec -T db createdb -U cb claude_board_restore_check
dc exec -T db pg_restore -U cb -d claude_board_restore_check --no-owner --exit-on-error < "$f"
dc exec -T db psql -U cb -d claude_board_restore_check -c "select count(*) from cb.tasks"
dc exec -T db dropdb -U cb claude_board_restore_check
```

Copy dumps off the VPS only to Ahmed's own machines (the PC or the Mac): they hold client work.

## Restore

The board goes back to the dump; everything after it is lost. Take a fresh backup first if the current state matters.

```bash
sudo /opt/claude-board/deploy/backup.sh                 # what is there now, just in case
dc stop board
dc exec -T db dropdb -U cb claude_board
dc exec -T db createdb -U cb claude_board
dc exec -T db pg_restore -U cb -d claude_board --no-owner --exit-on-error < /var/backups/claude-board/<file>.dump
dc up -d board                                          # re-applies the schema, starts polling
```

Then tell the sessions: `dc exec board cb broadcast "The board was restored to <time>: re-register anything you did since." --all`

## Users

Day to day, on the board: Users (key 7). Add a member, copy their link or set a password, put them on projects, make
an admin, remove someone. Everyone changes their own password at the top of the page (admins: under their name).

From the VPS shell, when the board itself can't be used (no admin can sign in):

```bash
dc exec board cb users                                                          # who, which role
read -rs PW && printf %s "$PW" | dc exec -T -e PGAPPNAME=cb-web board cb user password ahmed; unset PW   # reset a password
dc exec -e PGAPPNAME=cb-web board cb user role cai admin                       # or member
```

A locked name (5 wrong passwords from one address) unlocks by itself after 2 minutes; `dc restart board` clears every
lock at once. Removing someone, or a new link for a member, is on the Users page only.

## GitHub watch: Ahmed's own login (#3221)

The lead's relay holds routine notices up to 10 minutes (and a session's own lines 120 s: `cb help relay`); a PR,
comment, review or commit by Ahmed on a watched repo goes through at once (with the rest of that poll's message). The watch knows which login is his only from the `github-owner` setting (a JSON string). None is
set by default, and then nothing is marked urgent. It is never taken from gh's own login: the agents post under it.
Ahmed sets it once (not a secret, but keep it out of cards, pages and this repo):

```bash
dc exec db psql -U cb -d claude_board -c "insert into cb.settings (key, value) values ('github-owner', to_jsonb('<your GitHub login>'::text)) on conflict (key) do update set value = excluded.value"
dc exec db psql -U cb -d claude_board -c "delete from cb.settings where key = 'github-owner'"   # back to none
```

The next poll (within 3 minutes) uses it; case does not matter. Failed CI runs are never marked, whoever pushed.

## Secrets

All in `deploy/.env` (mode 600). After changing one: `dc up -d` (recreates what changed).

- **Database password:** `dc exec db psql -U cb -d claude_board -c "alter user cb password '<new>'"`, then
  `CB_PG_PASSWORD` in `.env`, `dc up -d`, then every worker's URL (the PC's `.env`, the Mac's `~/.zshrc`) and their
  relays. Do it if a worker machine is lost or the password leaks.
- **Telegram bot token:** revoke in @BotFather, new token in `.env`, `dc up -d board`.
- **GitHub:** gh's own login inside the board container (`dc exec board gh auth status`), stored by gh in the
  `ghconfig` volume as a plain file (no keyring in a container): anyone with root on vps2 can read it, and it has
  the signed-in account's scopes. Rotate: `dc exec board gh auth logout`, then the login in
  [deploy.md](deploy.md#8-the-move-ahmeds-live-board-from-the-pc-to-the-vps) step 7. Narrower option: a fine-grained,
  read-only `GH_TOKEN` in `.env` (it overrides the login). `dc logs board | grep github` shows HTTP 401 when the
  login stopped working.
- **Nginx Proxy Manager:** its admin account and Let's Encrypt certificates are NPM's (it renews them itself).

## Disk and housekeeping

```bash
docker system df                 # images, volumes
docker image prune -f            # old board images after upgrades
dc exec db psql -U cb -d claude_board -c "select pg_size_pretty(pg_database_size('claude_board'))"
```

The board is small (tens of MB). Postgres vacuums itself. A Postgres major version upgrade (16 to 17) is a dump,
a new volume and a restore, never just a new image tag.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every POST says "cross-site request refused" | the proxy rewrites `Host`, or the board is served on a port other than 443 (NPM drops the port from `Host`) | serve on 443; pass the public Host through |
| The public URL says 502 Bad Gateway | the board is down, or not on NPM's network | `dc ps`; `docker network inspect nginx-proxy-manager_default` lists `claude-board-board-1`; `dc up -d board` |
| Pages load but nothing updates live | a proxy buffering the event stream | the board sends `X-Accel-Buffering: no`; another proxy: turn its buffering off for `/api/stream` |
| Signed in, but sent back to the login page | the cookie isn't kept: https page with a non-Secure cookie blocked, or a proxy dropping `Set-Cookie` | check `X-Forwarded-Proto: https` reaches the board |
| "That name and password don't match" for the right password | 5 failures from that address in 2 minutes, or no password set | wait 2 minutes or `dc restart board`; set a password from the shell |
| `healthz` 503, board logs `ECONNREFUSED db` | Postgres is down or still starting | `dc ps`, `dc logs db` |
| db won't start: "cannot assign requested address" | Tailscale wasn't up when Docker started, so `CB_PG_BIND` doesn't exist yet | `sudo systemctl enable tailscaled`; `dc up -d db` |
| A worker's `cb` says "board unreachable at 100.x.y.z" | the VPS, Tailscale or Postgres is down, or the URL/password is wrong | `tailscale ping vps2`; `dc ps`; check the worker's URL |
| A worker's `cb` errors "function cb.x(...) does not exist" | the worker's code is older or newer than the VPS's schema | update the worker's checkout (Upgrade) |
| No Telegram pushes | no token, or another server polls with it (409 in the logs) | `TELEGRAM_BOT_TOKEN` in `.env`; stop the other server |
| Log: "another board server polls Telegram and GitHub" | a second server (the PC's?) holds the poller lock | stop it; this one takes over within a minute |
| GitHub watch silent | gh signed out, or its token expired or was revoked | `dc exec board gh auth status`; `dc exec board cb github` shows the last error; log in again |
| The board or db restarted on its own at night | Watchtower, if the opt-out label was lost | `docker inspect -f '{{.Config.Labels}}' claude-board-board-1` shows `watchtower.enable:false` |

## PC job runner

Heavy checks (type checks, test suites, builds, DB tests) run on the PC, not on the Macs: sessions queue them with
`cb run` and get the result as a message. One runner serves all projects.

Set up, once, on the PC:

1. Copy `docs/ops/runner.example.json` to `~/.claude-board/runner.json` (or point `CB_RUNNER_CONFIG` at it). Set
   `log.host` to the PC's Tailscale address and `log.port` to a free port (the example's are placeholders), list the
   Tailscale addresses that may read logs in `log.peers`: the PC's own address (`cb job log` on the PC connects to it) and the MacBook's, and each project's `git` URL, `base` folder
   and recipes. Logs live in `~/.claude-board/runner/logs` (override with `CB_RUNNER_HOME`), kept 7 days.
2. Start `cb runner` in a herdr pane on the PC and leave it. It connects to the board, publishes its recipes
   (`cb jobs` shows them) and serves job logs. `itest` and `kbtest` need Docker running.
   - Ahmed's slot and lane numbers on the board's Runners page (#4527) win over these two when set: the runner reads
     them at start (a higher number takes the next restart, and a new slot's first job clones fresh; a lower one applies
     at the next claim; slots 1-64, lanes 1-9). Clearing them there falls back to this file. A setting this file cannot
     take (more lanes than its `laneEnv` allows) keeps the file's counts; the runner's pane logs why and the page shows
     that it was refused. A board older than the runner has no setting: the runner runs this file's counts.
   - `slots` (1-10) is how many jobs run at once; `dbLanes` (1-9, default 1, at most `slots`) is how many of them may
     be DB jobs. Each DB job holds a lane, and `{lane}` in its recipe's env values becomes that lane's number, so every
     lane gets its own test stack: `"TEST_STACK_PROJECT": "cb-runner-it-{lane}"`, `"TEST_STACK_PG_PORT": "2544{lane}"`,
     `"TEST_STACK_REDIS_PORT": "2638{lane}"`, `"TEST_STACK_S3_PORT": "2901{lane}"`. Keep lane ports off the old
     single-stack ports (55432, 56379, 59000) and any stack you start by hand.
   - Keep lane ports below 32768 (#4417). Docker Desktop binds a published port inside its Linux VM, where 32768-60999
     is the range the kernel hands to outgoing connections, so a fixed port in it is sometimes held by a connection at
     the moment a lane's `up` binds it: `failed to bind host port 0.0.0.0:<port>/tcp: address already in use`, and the
     job fails in seconds. A Windows port reservation (`netsh ... add excludedportrange`) reaches that VM only when
     Docker Desktop starts (it copies them to the VM's reserved ports then), so one added later protects nothing there
     until Docker Desktop restarts. Check the VM's view with
     `docker run --rm --network host redis:7 cat /proc/sys/net/ipv4/ip_local_port_range /proc/sys/net/ipv4/ip_local_reserved_ports`.
   - With `dbLanes` above 1, `laneEnv` names those env values. Every DB recipe must set each of them with `{lane}`,
     and all DB recipes must write each one the same way, so lane n is one stack whichever recipe runs in it. The
     runner refuses to start otherwise.
   - A DB recipe's first step brings its test stack up (#4710). The runner starts its stacks 30 s apart (the board's
     `cb.runners.stack_gap_set`, 0-300 s, read at the runner's start; no page control yet), because Postgres containers
     that initialise together miss compose's health deadline (27 Nov: 9 lanes claimed at once after a restart all died
     `container ... is unhealthy`). The wait comes before the job's timeout starts. When that first step still fails on
     `container <name> is unhealthy`, the runner runs the recipe's `finally` steps (the stack's `down`), waits its turn
     and runs the step once more; the job's summary then starts with "The test stack was slow to start and was retried
     once." Any other failure is never run again.
   - Switching on lanes: stop the runner, remove the stack left from before (`docker compose -p cb-runner-it down -v`),
     then start it. A stopped runner's `finally` steps do not run, so that stack stays up until removed.
   - A `guards` recipe can also run the repo's script tests on every job with the pre-push hook's own command
     (`pnpm exec lefthook run pre-push --commands <command> --no-tty`): the commit's own `lefthook.yml` decides which
     files run, so no file list is copied into runner.json.
   - Placeholders in `steps`, `finally` and `cwd` are written `{name}` (declared in `params`; at most one per step
     argument). Write `{{` and `}}` for literal braces (inline JS, JSON: `fs.rmSync('dist', {{force:true}})`), so
     misspelled parameter names are still refused at start (#3773).
   - A DB recipe whose tests start Postgres on the PC (this repo's own `test` recipe) gets a cluster per slot: every job
     has `CB_RUNNER_JOB=1`, so `db/pg.ts` treats the slot like a worktree (own port, `.pgdata` in the slot), and a
     `finally` step `node db/setup.ts --test --stop` stops it. A cluster left running anyway (a runner crash, a commit
     older than #4756) is stopped before the slot's next `git clean`, which cannot delete its open log; only a postmaster
     whose command line names that slot's `.pgdata` is stopped.
3. After any change to `cli/recipes.ts` or `runner.json`, restart BOTH `cb runner` and `cb supervise`: the supervisor
   validates runner.json with the code it loaded at start.
   Restarting the runner is safe: a job that was running ends `error: runner restarted`, the requester is told, queued jobs go on.
4. runner.json must follow a project merge (`cb.project_alias`): rename that project's key to the target and restart
   `cb runner` straight after. The merge moves the jobs and the published recipes on the board, but until then the
   runner has no config for the new name (a claimed job ends `error: bad job row`), and a restart under the old name
   publishes the old name again (the moved jobs stay queued).
5. runner.json takes a project's shape from its squad file: a squad with a `repos` key (even one repo) needs that
   project's runner.json entry under `repos` with the same names. A one-entry `repos` squad's home is not `main`, so
   its sessions start with `--repo <name>` and `cb run` defaults to that name; a flat entry offers only `main` and
   every `cb run` is refused.
6. Switching a project from flat to `repos`:
   - runner.json and the squad file switch together; until both list the same repos, `cb run` is refused.
   - Slot clones are named `<project>-<slot>` for `main` and `<project>-<repo>-<slot>` for any other repo (`iris-1`
     becomes `iris-<repo>-1`). The old `<project>-<slot>` folders under `base` and their files in
     `~/.claude-board/runner/state` are orphaned: delete them by hand. The first job in each slot clones and installs again.
   - Jobs still queued as `main` at the switch are never claimed by the new runner: cancel them (`cb job cancel <id>`)
     and queue them again.

What each result means:

| Result | Meaning | Do |
|---|---|---|
| `error: push it first` | the commit is not on origin | push the branch, queue again |
| `error: not on a branch of origin` | the commit is only on a tag, a PR ref or nowhere | push it on a branch |
| `error: timed out after <N> min` | the recipe's timeout hit; the process tree was killed | read `cb job log <id>`; raise `timeout` only if the work is real |
| `error: Docker is not running` | a DB recipe, no Docker on the PC | start Docker Desktop, queue again |
| `error: runner restarted` | the runner stopped mid-job | queue again |
| `error: could not start <cmd>` | the program is missing or is a `.cmd` file | fix `runner.json` or the PC's PATH |
| `error: bad parameter <name>: <value>` | the runner's own check refused a value | fix the value; if it looks right, the recipe's pattern is too tight |
| `error: not in the repo at <sha>: <paths>` | a path parameter (`files`, or one with `"paths": true`) is no file or folder tracked at that commit, read from the recipe's folder or from a package folder under it (one with a tracked `package.json`, where `pnpm --filter … exec` runs the tool), never as the tail of a deeper path (#4338) | fix the name; a path from the repo root that starts with the recipe's folder is taken too. It proves the names are real. A `node --test` recipe is fully covered when its names are paths from its folder: one whose folder holds packages could pass a package-relative name that `node --test` then drops, so give it its own `cwd`. vitest filters by substring, so it may run more. `"paths": false` on a parameter turns the check off |
| `error: could not fetch from origin` | no network, or no access to the repo | check git credentials on the PC |
| `error: bad job row` | the job row is malformed | `cb job show <id>`; report it |
| `error: runner fault: see cb job log <id>` | the runner itself failed | read the log, then the runner's pane |
| `no tests ran: <summary>` | the command exited 0 but ran nothing | the file list or app is wrong |
| `step <n> of <m> (<program>) exited <code>, but no test failed. Its last lines: ...` | the step's test counts show no failure, yet it exited non-zero (a crash after the run, a hook runner's own failure); the lines are that step's last output (stdout and stderr share the log) | read them, then `cb job log <id>`; queue again if it looks like a flake |
| `summary withheld: see cb job log <id>` | the output looked sensitive, so none of it went to the board | read the log from the PC or the MacBook |

## Supervisor

`cb supervise` keeps each supervised project's squad sessions in line with its queues, and restarts the PC runner
when it stops. Card #3601; design: `docs/superpowers/specs/2026-11-23-supervisor-design.md`.

Start it by hand on the PC, in a herdr tab named `supervisor`, and leave it: `cb supervise`. After any change to
`cli/recipes.ts` or `runner.json`, restart BOTH `cb runner` and `cb supervise` (it validates runner.json with the code
it loaded at start). Only one runs at a time,
on any machine (a Postgres advisory lock); a second says `another supervisor is running` and exits. Check the plan
first with `cb supervise --dry-run` (prints `would start ...`, `would close ...`, acts on nothing); `cb supervise
--once` acts once and exits. Its log is `~/.claude-board/supervisor/<date>.log` (override the folder with
`CB_SUPERVISOR_HOME`), one file a day, kept 7 days. Every start, close, restore and runner start is also a board event by actor
`supervisor` (session names, roles and counts only).

A project is supervised when its squad file says `"supervise": true` (`cb squad set`), with or without a pipeline.
**One supervisor serves every project**, so starting it acts on all of them: it prints `acts on: a, b (winding down)`
at its first tick and whenever that list changes, and each project's settings page shows the same list. Waiting work is
counted by stage, so a project **with no pipeline** gets no seat started for its cards, and an idle seat the squad file
names stays open (nothing would start it again); restores, closing idle seats the squad no longer names, restarts on a
new setting and wind-down work the same. The squad `count` per role is the most the supervisor keeps up. Every 60 s it:

- restores a squad session that is down but holds open cards, under the same name with `cb resume` (at most once
  per 30 minutes per name; a restore that failed to start is tried again after 10 minutes; down again within 30
  minutes of a restore that started: a `down_again` event, and no automatic restore until the name binds again:
  restore it by hand; with no pipeline there is no digest, so the supervisor messages the live lead once);
- starts sessions for waiting cards, like `cb squad up` (names, models, permission files), at most 3 a tick, 8 on
  the Mac in all; a name that failed to start waits 10 minutes;
- closes a squad session idle 20 minutes that holds nothing (no card, question, job or open dashboard ask), that herdr
  shows ready for input (`idle`, or `done` for a pane nobody looked at), when its role has no waiting work (pipeline only): it marks
  it closing, finds its pane, checks again (board and herdr), sends `/exit`, then closes the pane (not gone in 60 s: the pane stays and the mark lapses in 5 minutes);
- treats a seat an earlier saved version of the squad file generated but this one does not (the role moved machine,
  its count went down, the role or repo left; read from the last 20 `squad updated` events) as leaving (#3770): it
  counts toward no role's slots and cancels no waiting work, so the new seats start; once idle as above it is closed
  even while its role has waiting work, at most 2 a tick. A hand-started name no saved version generated (`foo@m`, an
  extra `<project>-B5@m` past any count) is never leaving. Busy (holding a card, question, job or ask, or mid-turn), down
  holding cards, or on a machine that is not one of the squad's, it is kept and said in its log once per reason
  (`--dry-run`: `would keep ... open`): a person hands its work over or closes it. A squad file with no seats besides
  the lead closes none of them (likely a bad save): every leaving seat is only listed. Only the closing mark of a close
  under way keeps new work off a leaving seat; until then a live one can still take a card from `cb next`;
- restarts a squad seat running another agent or model than the squad file now names for it (#4332, Q2970: the
  agent and `cb iam --model` it bound with against its seat's, as the digest's wrong-model line reads them) once it is
  idle as above and quiet 5 minutes: it closes it as above, then starts it under the same name on the new setting, at
  most 2 a tick, each taking one of the 3 starts (waiting work starts first). Busy, it waits until idle. Never the lead,
  a hand-started name or a leaving seat; one idle 20 minutes with no waiting work is simply closed. Each restart is a
  `restart` board event (`restart <seat> (opus to sonnet)`). A setting its machine cannot start (an agent not installed,
  a model its adapter refuses) is refused once per setting per supervisor run, logged, and the seat keeps running; a
  seat restarted once for a setting is not restarted again for it until it has been seen running it (no loop when a
  model name never reads as matching);
- winds down a supervised squad whose project is disabled or archived (#4559, Q3018): it starts, restores and restarts
  nothing there. Each seat of the squad (an earlier version's too) is closed once herdr shows it ready and it has been
  quiet 10 minutes, counted from the disable at the earliest, with the cards it holds, which stay its own (Q3017); at
  most 2 a tick, logged `close <seat> (project disabled)`. A running job of its own is waited for; a queued one waits
  for Enable. Never the lead or a hand-started session, and a seat holding a card of an enabled project is kept. After
  Enable, the seats that hold cards are restored as above, whatever was restored before the disable. A squad without
  `"supervise": true` gets only the disable message;
- looks for a seat stopped by its model's quota (#4787). This one runs for **every enabled project with a squad**,
  with or without a pipeline or `"supervise": true`, since it only reads screens and tells (it still needs `cb
  supervise` running): for each seat of the squad, and the lead, that herdr shows
  not working (`idle`, `done`, `blocked`), it reads the last lines of its screen (`herdr pane read`) and asks the
  agent's adapter. A quota stop is a `quota` board event (`quota <seat> (herdr pane <id>)`, also a digest line), and
  the lead is told once: again only after the seat has done something on the board, or bound anew, and stopped again.
  A stopped lead is only in the digest. A rate limit the CLI retries is ignored, and no pane text goes to the board.
  Nothing is closed or switched. The words can also be ordinary output at the bottom of an idle screen, so look at the
  pane before acting. `--dry-run` reads the screens too and prints `would say ...`; a screen it cannot read is said
  once in its log (`cannot check <seat> for a quota stop`);
- restarts the PC runner (herdr tab `runner`, `cb runner`) when `runner.json` exists and the runner has not beaten
  for 3 minutes, at most once per 10 minutes (first closing the runner tab it opened before, that pane only). A start that does not beat, or a log port still held by an old
  runner, is told to each supervised project's lead once an hour.
- skips a project whose squad puts its own machine (`"herdr": null`) on another machine than this one, saying so
  in its log once an hour.

It never:

- starts, closes or restores the lead (`orch@*`) or a name no version of the squad file generated (a hand-started
  session); it starts and restores only names the squad file generates now, and closes a leaving one only as above;
- answers a startup dialog (folder trust, the bypass warning): it logs `blocked` and tells the lead (the project's
  live session in the lead role; none live: the digest's blocked line) once per block, with the pane and the command to send
  the first prompt afterwards (the same when a session started but its first prompt was not sent, or may not have landed, which the lead checks in the pane before sending: #4687);
  `cb squad trust <project>`, run once by the owner on each machine (#4575), marks the squad's seat folders trusted for
  Claude, Codex and agy so that dialog never shows; `cb squad up` stops an untrusted seat before its pane (`cb help squad`);
- frees a card held by a down session, or runs anything heavy itself.

## Squad file: herdr workspace

A machine may name the herdr workspace its squad sessions open in: `"macbook": {"herdr": "macbook", "board": "...",
"workspace": "Iris Squad"}` (the workspace's label, 1 to 64 characters). `cb squad up` and the supervisor then open each
new session as a tab there (two per tab, as before), and make the workspace when herdr has none by that label; its first
pane takes the first session. Without `workspace` a session opens in whichever workspace is focused on that machine.
Sessions already running stay where they are: move them with `herdr pane move <pane> --new-tab --workspace <id>`.
Card #3719.

## Squad file: Codex, OpenCode and agy seats (#4585)

A role or a seat in any project may give `"agent": "codex"` (or `opencode`, `agy`) with that agent's model (Q3024).
The save gate's list is `cb._agents_main()` in `db/schema.sql`, the launch gate's `INSTALLED` in `cli/agents/index.ts`
(`test/settings.test.ts` compares them). Each of the three needs, on every machine that runs its seats and where
`cb squad up`, the supervisor and the seat's relay run:

- its MCP check done by Ahmed (no MCP server in that CLI's own config), then `CB_MCP_GATE_OK=codex,opencode,agy`
  (the ones checked) in that environment; without it the launch fails before any pane (`cb squad up --dry-run` prints a
  `would fail` line under the seat);
- the guard installed for that CLI (`kit/guard/install.mjs`), which the seat prestart checks before the agent starts.

An OpenCode seat's server port comes from its name (41000-48999, `CB_OPENCODE_PORT`).

**No interactive sessions in a Codex seat (#4626).** Codex's `exec_command` can leave a process running, and
`write_stdin` then types into it without any hook, so the guard never sees what a shell, REPL, database client, editor,
pager or remote login opened that way runs next. In a Codex seat the guard therefore refuses a command that opens one
(`bash`, `bash -s`, `sudo -s`, `python`, `node -i`, `psql`, `sqlite3 app.db`, `ssh host`, `ssh host bash`, `vim`,
`less`, `tmux`, `docker exec -it c sh`, `kubectl exec -i pod -- sh`, `xargs`, `read`, `cat | sh`, `Read-Host`, ...),
inside `bash -c "..."`, `$(...)` and the like too, whether or not Codex asked for a TTY. The one-shot forms stay
allowed: `bash -c "..."`, `python x.py`, `python -c`, `psql -c`, `ssh -n host cmd`, `docker exec c ls`, or input from
`< file`, a heredoc or a pipe. Codex sends no TTY or stdin field, so the rule reads the command text alone (PR 104
review), and fails closed where it cannot read it:

- A variable, `eval` or a substitution as the command word counts unless a literal assignment earlier in the same
  command says what it runs (`X=python3; $X x.py` passes; `$SHELL`, `$(echo bash)` and `eval $cmd` do not).
- `<&0`, `<&3` (any descriptor copy, since `exec 3<&0` makes one of the input) and `< /dev/stdin` read the seat's own
  input, so they are no feed.
- Editors, pagers and other full-screen programs count even when piped into (`ls | vim -`, `git log | less`, `fzf`), as
  do git's interactive modes (`add -p`, `add -i`, `checkout -p`, `rebase -i`, `clean -i`, `commit --interactive`) and
  `crontab -e`.
- grep, sed, head, tail and cut given a file read that file, not the input (`grep foo file | awk` passes).
- A package runner or `find -exec` is judged by the command it starts (`npx node`, `pnpm exec bash`, `npm exec -- python`,
  `uv run python`, `find . -exec bash \;` are sessions; `npx tsc` and `find . -exec bash {} \;` pass) (#4658).
- A one-shot whose code opens a session counts: `python -m code` or `-m pdb`, `pty.spawn`, `code.interact`,
  `breakpoint()`, Node's `require('repl')`, `binding.irb`, and a call that starts a bare shell (`exec "/bin/sh"`,
  `os.system('cmd')`, `spawnSync('bash', {stdio: 'inherit'})`; `os.system('sh build.sh')` passes). This reads only the
  literal spellings. Code that builds the names gets past it; `--disable unified_exec_tty` is what stops a seat typing
  into a process.

Programs that open an editor or a pager themselves (`git commit` with no `-m`, `git log`, `gh pr create`, `man`) are
handled at launch instead. A Codex seat starts with `--disable unified_exec_tty`, so its commands get no terminal. Every
Codex, agy and OpenCode seat's pane also gets `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `EDITOR` and `VISUAL` set to
`true`, `PAGER`, `GIT_PAGER`, `GH_PAGER` and `MANPAGER` set to `cat`, `GH_PROMPT_DISABLED=1` and
`GIT_TERMINAL_PROMPT=0` (`NO_PROMPT_ENV` in `cli/agents/env.ts`). An editor returns at once with the text git prepared
(a conflicted `git rebase --continue` finishes; `git commit` or `git tag -a` with no `-m` fails on the empty message),
and a pager only prints.
Claude's Bash has no stdin, so it does not get this rule. Codex's `update_plan` is
allowed and `view_image` is a read with the secret-file rule; `spawn_agent` stays blocked until the live check (#4612)
shows a sub-agent's own tools reach the hook.

## Squad file: protected branches

A squad may list the branches its sessions must never push to: `"protected": ["development", "staging",
"releases/*", "athena-production"]` (branch names, or globs where `*` is any run of characters, `/` included; at most
30, each 1 to 100 characters of letters, digits and `. _ / * -`, not starting with `-`). Give each branch as git shows
it: `cb squad set` refuses an entry starting with `refs/`, `heads/` or `origin/`, or ending with `/`, since the hook
could never match it. `cb squad up` and the supervisor then create each new session's pane with
`CB_PROTECTED_BRANCHES=<the list, comma-joined>` (herdr `--env`), and the guard blocks a `git push`
whose destination is on it: `git push origin development`, `x:development`, `HEAD:refs/heads/development`,
`x:heads/development`, `+x:development`, `--delete origin development`. Plain `git push` and `git push origin` stay
denied by the role permission files. Card #3746.

- The block says what to do instead: push your own branch and open a PR; the lead merges it.
- While the list is set, a push whose remote or branch the shell fills in (`$B`, `$(git branch --show-current)`,
  backticks) is blocked too, since the hook cannot see the branch: name it literally.
- While the list is set, a wildcard destination (`refs/heads/*:refs/heads/*`, `develop*`) is blocked too: it can write
  a protected branch. Push one branch by name.
- Sessions already running have no such variable: the fence holds only after each is restarted (closed, then started
  by `cb squad up` or the supervisor).
- A lead started by hand (not by `cb squad up`) never gets the variable that way: squad up skips a lead-role session
  of the project (a live one with no line; one seen in the last day but not live is named in a `skip lead:` line),
  and the supervisor never starts a lead. Close it and restart it by hand in a pane that carries the variable, quoted so no shell expands the `*`
  (zsh refuses an unmatched glob):
  - a new herdr tab: `herdr tab create --cwd <repo> --label <name> --env 'CB_PROTECTED_BRANCHES=development,releases/*'`
    (`herdr --machine <label> tab create ...` on another machine), then start `claude` in that pane;
  - or set it in the shell that starts `claude`: `export CB_PROTECTED_BRANCHES='development,releases/*'` (bash, zsh),
    `$env:CB_PROTECTED_BRANCHES = 'development,releases/*'` (PowerShell).

  Then bind it as before (`cb iam <name> <project> --role lead`). From the session, `echo $CB_PROTECTED_BRANCHES`
  prints the list.
- The fence is the hook installed on each machine: after a release that changed it, copy it there (Upgrade, above).

## Squad file: several repos

One board project can hold several git repos. ZED is four: `api`, `dashboard`, `app`, `bot`. Add a `repos` key to the
squad file (`cb squad set <project> -f <file>`):

```json
"repos": {
  "api":       { "home": true, "paths": { "shaltoot": "C:/work/ZED/api", "macbook": "/Users/me/work/ZED/api" } },
  "dashboard": { "paths": { "shaltoot": "C:/work/ZED/dashboard", "macbook": "/Users/me/work/ZED/dashboard" } }
}
```

- A repo name is a slug: lower-case letters, digits and dashes, starting with a letter, 32 characters at most.
- Exactly one repo is `home`; lead, architect, qa and investigator start there.
- Machines then give only `herdr` and `board`; each repo carries its own `paths`.
- Areas become `{"name": "api", "repo": "api"}`; builder and reviewer counts go per repo (`{"api": 2, "dashboard": 1}`).
- Every repo with builders needs a reviewer count for that repo (`repo X has builders but no reviewers`).
- The Mac cap of 8 counts all sessions on the Mac, across repos.
- An owner starts in its area's repo, so the owner's machine needs a path for that repo. Lead, architect, qa and investigator need a path for the home repo on their machine.
- No `repos` key: one repo named `main`, as before. A `cb run` for a repo the PC runner does not have is refused.

## Squad versions and role texts (#4332)

- Every save that changes a squad raises its version. `cb squad show <p> --json` prints it as `"version"` and `cb squad
  set` sends it back, so a file taken before a newer save (from the project settings page or another set) is refused.
  Take it again with `show --json` and redo the change. Once the squad has a version, a kept squad file with no
  `version` is refused unless you pass `--overwrite`, which replaces the current squad, including changes made on the
  page. A save made between its read and its write is still refused. A script that sets a squad from a stored file needs
  one or the other.
- Role texts live in the database (`cb.role_texts`), and Ahmed edits them on the project settings page. Every edit is
  kept in `cb.role_text_edits`. Setup seeds only a role that has no row from `prompts/roles/*.md`. It never overwrites or
  deletes a row, so a change to those files after a board's first setup reaches the board only when Ahmed presses "Load
  the new texts" on the page (Role text section; it shows when the release's files differ from the stored texts). That
  loads every text in one transaction through `cb.role_text_import`, each change kept in `cb.role_text_edits` (#4525).
- Each project also has its own addition (at most 1000 characters) and who its stuck seats ask first (the lead, Ahmed or
  a named session; the lead until set), in `cb.project_role_settings`, set on the same page. `cb role` and the start hook
  print them after the board-wide text. The start hook's re-injection limits are `CAP` and `RESUME_KEEP` in `hooks/session-start.mjs`;
  `test/role-text-size.test.ts` checks every text, with the longest addition, fits them uncut.

## Tests

Never on the VPS. The suite truncates whatever database it is given and expects the PC's layout (127.0.0.1:5434);
run it on the PC or the Mac against their own test databases (`CB_TEST_DB=claude_board_test`). On the PC each worktree
tests on its own cluster and port (#4413); stop it (`node db/setup.ts --test --stop` in the worktree) before removing
the worktree, or its Postgres keeps running and holds the folder (a forced delete under it crashes that cluster). Put
that step in any worktree clean-up a squad or brief runs. Changing the code is
in [CLAUDE.md](../../CLAUDE.md).
