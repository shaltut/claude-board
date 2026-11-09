// Claude Code SessionStart hook: one line that points a new session at the board.
// Separate from the relay hook (cli/relay.ts), so changing this never restarts live relays.
// Only herdr panes get it: board sessions always run in one.
if (process.env.HERDR_PANE_ID) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart',
    additionalContext: 'Claude Board: if this session takes work from the board, run `cb start` first and do what it prints. Manual: `cb help`.' } }));
}
