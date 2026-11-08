## Claude Board
- Track all work on Claude Board (http://localhost:4747) with the `cb` command. Run `cb help` for usage.
- On start: `cb brief <project>`, then register in-hand work (`cb add ... -s in_progress`) and next work (`-s next`).
- Take work with `cb next <project>`. Between steps run `cb mine` and obey any move or cancel.
- Finish with `cb done <id> "<summary>" --pr <url>`. Log notable findings with `cb log`.
- Never use AskUserQuestion. Ask with `cb ask <project> "<q>" -o "Label=why"...` and keep working.
- Use `--blocking -t <id>` only when that task truly cannot continue.
