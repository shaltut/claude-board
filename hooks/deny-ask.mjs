// Claude Code PreToolUse hook (matcher: AskUserQuestion).
// AskUserQuestion stops the session until Ahmed answers. Questions go to the board instead,
// and the session keeps working. Set CB_ALLOW_ASK=1 to let the native tool through.
if (process.env.CB_ALLOW_ASK === '1') process.exit(0);

const reason = `AskUserQuestion is disabled here: it stops this session until Ahmed answers, and he is often away.
Ask on Claude Board instead, then KEEP WORKING on something else:

  cb ask <project> "<question>" -o "<Label>=<why / tradeoff>" -o "<Label (Recommended)>=<why>" [-c "<context, markdown>"] [--multi]

- Give the same options and explanations you would have put in AskUserQuestion. Options are required;
  --free (no options) only for a fact: a URL, a name, a number.
- Add --blocking -t <task id> only if that task truly cannot continue; it parks the task in Blocked.
- Ahmed answers on the board (http://localhost:4747). The answer arrives in this session by itself
  (cb relay); without a relay, check with \`cb pending\`. More: cb help ask
- If no task can continue at all, say so in one line and stop. Don't wait on a prompt.`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
}));
