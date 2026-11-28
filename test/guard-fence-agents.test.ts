// #4002 install gates for the non-Claude guard shims: the fence and the secret rule reach their native edit and read
// tools (not only shell commands), the fence covers each adapter's own hook and config files, and a seat with CB_AGENT
// but no CB_ROLE never skips the role rules. Pure: real shim processes, no DB, no agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editFence, editTargets, evaluate, secretPath } from '../kit/guard/core.mjs';
import { ADAPTERS } from '../cli/agents/index.ts';

const GUARD = fileURLToPath(new URL('../kit/guard/', import.meta.url));
const CB_ENV = ['CB_ROLE', 'CB_AGENT', 'CB_PROTECTED_BRANCHES', 'CB_ALLOW_ASK'];
function hook(shim: string, input: unknown, env: Record<string, string>) {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(base)) if (CB_ENV.includes(k.toUpperCase())) delete base[k];
  const r = spawnSync(process.execPath, [join(GUARD, shim)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...base, ...env } });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
// each shim's answer as allow (true) or the deny reason
const codex = (tool_name: string, tool_input: unknown, env: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const o = hook('shim-codex.mjs', { hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra }, env);
  return o.hookSpecificOutput ? (o.hookSpecificOutput.permissionDecisionReason as string) : true;
};
const opencode = (tool: string, args: unknown, env: Record<string, string>) => {
  const o = hook('shim-opencode.mjs', { tool, args, sessionID: 's' }, env);
  return o.decision === 'block' ? (o.reason as string) : true;
};
const agy = (name: string, args: unknown, env: Record<string, string>, cwd: string) => {
  const o = hook('shim-agy.mjs', { toolCall: { name, args }, cwd, workspacePaths: [cwd] }, env);
  return o.decision === 'allow' ? true : (o.reason as string);
};
const CODEX = { CB_AGENT: 'codex', CB_ROLE: 'builder' }, OPENCODE = { CB_AGENT: 'opencode', CB_ROLE: 'builder' }, AGY = { CB_AGENT: 'agy', CB_ROLE: 'builder' };
const patch = (...files: string[]) => `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`).join('\n')}\n*** End Patch`;

// Every agent's own guard and config files, as the adapters name them, plus the Claude fence and a secret file.
const FENCED = ['~/.codex/hooks.json', 'C:\\Users\\someone\\.codex\\config.toml', '/home/someone/.codex/review.config.toml',
  '.agents/hooks.json', '/home/someone/.config/opencode/plugins/cb-guard.js', '/home/someone/.config/opencode/opencode.jsonc',
  'opencode.json', '~/.gemini/antigravity-cli/settings.json', '~/.gemini/config/hooks.json', '~/.claude/settings.json',
  '/home/someone/.claude-board/guard/core.mjs', '.env', '/tmp/cb-seat-0a1b2c3d4e5f.opencode.json'];
const ORDINARY = ['src/app.ts', 'docs/codex-notes.md', 'packages/opencode-client/index.ts', '.claude/skills/x/SKILL.md', '.agents/rules/style.md'];

test('Codex apply_patch, Edit and Write: a fence or secret target is denied, an ordinary one allowed, none denied', () => {
  for (const f of FENCED) {
    assert.match(String(codex('apply_patch', { command: patch('src/ok.ts', f) }, CODEX)), /fence|secret file/, `apply_patch ${f}`);
    assert.match(String(codex('apply_patch', { command: ['apply_patch', patch(f)] }, CODEX)), /fence|secret file/, `apply_patch argv ${f}`);
    assert.match(String(codex('Write', { file_path: f, content: 'x' }, CODEX)), /fence|secret file/, `Write ${f}`);
  }
  for (const f of ORDINARY) assert.equal(codex('apply_patch', { command: patch(f) }, CODEX), true, f);
  assert.equal(codex('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, CODEX), true);
  // a move into a fence path, and a relative name resolved against the hook's cwd
  assert.match(String(codex('apply_patch', { command: '*** Begin Patch\n*** Update File: a.json\n*** Move to: .codex/hooks.json\n*** End Patch' }, CODEX)), /fence/);
  assert.match(String(codex('apply_patch', { command: patch('hooks.json') }, CODEX, { cwd: '/home/someone/.codex' })), /fence/);
  // no target the guard can read: denied (it was an allow before)
  assert.match(String(codex('apply_patch', { command: '*** Begin Patch\n*** End Patch' }, CODEX)), /target path/);
  assert.match(String(codex('apply_patch', {}, CODEX)), /target path/);
});

test('OpenCode edit tools: a fence or secret target is blocked, an ordinary one allowed, none blocked', () => {
  for (const f of FENCED) {
    for (const t of ['edit', 'write', 'multiedit']) assert.match(String(opencode(t, { filePath: f }, OPENCODE)), /fence|secret file/, `${t} ${f}`);
    assert.match(String(opencode('patch', { patchText: patch(f) }, OPENCODE)), /fence|secret file/, `patch ${f}`);
  }
  for (const f of ORDINARY) assert.equal(opencode('write', { filePath: f, content: 'x' }, OPENCODE), true, f);
  assert.match(String(opencode('edit', {}, OPENCODE)), /target path/);
});

test('OpenCode read tools: a secret file is blocked for a seat; other reads, the fence files included, pass', () => {
  for (const t of ['read', 'grep', 'glob', 'list']) {
    assert.match(String(opencode(t, { filePath: '.env', path: '.env' }, OPENCODE)), /secret file/, t);
    assert.equal(opencode(t, { filePath: 'src/app.ts', path: 'src' }, OPENCODE), true, t);
  }
  assert.match(String(opencode('read', { filePath: '/tmp/cb-seat-0a1b2c3d4e5f.opencode.json' }, OPENCODE)), /secret file/);
  assert.equal(opencode('read', { filePath: '/home/someone/.codex/hooks.json' }, OPENCODE), true);
  // a file glob: grep's include and glob's pattern; grep's pattern is the searched text, not a file
  assert.match(String(opencode('grep', { pattern: 'API', include: '**/.env' }, OPENCODE)), /secret file/);
  assert.match(String(opencode('glob', { pattern: '.env*' }, OPENCODE)), /secret file/);
  assert.equal(opencode('grep', { pattern: '.env', include: '*.ts' }, OPENCODE), true);
  assert.equal(opencode('glob', { pattern: 'src/**/*.ts' }, OPENCODE), true);
});

test('shell writes to another agent\'s hook or config file are fenced for every shim; reads pass', () => {
  for (const cmd of ['echo {} > ~/.codex/hooks.json', 'echo [features] > ~/.codex/config.toml', 'rm ~/.config/opencode/plugins/cb-guard.js',
    'cp x.json .agents/hooks.json', 'rm -rf ~/.gemini', 'cd ~/.codex && echo {} > hooks.json', 'sed -i s/a/b/ opencode.json']) {
    assert.match(String(codex('Bash', { command: cmd }, CODEX)), /fence/, `codex ${cmd}`);
    assert.match(String(opencode('bash', { command: cmd }, OPENCODE)), /fence/, `opencode ${cmd}`);
  }
  const ws = mkdtempSync(join(tmpdir(), 'cb-fence-agy-'));
  try {
    assert.match(String(agy('run_command', { CommandLine: 'echo {} > .agents/hooks.json' }, AGY, ws)), /fence/);
    assert.equal(agy('run_command', { CommandLine: 'cat .agents/hooks.json' }, AGY, ws), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
  for (const cmd of ['cat ~/.codex/config.toml', 'ls ~/.gemini', 'git log -- docs/opencode-notes.md']) assert.equal(codex('Bash', { command: cmd }, CODEX), true, cmd);
  // the seat's OpenCode password file is a secret for a shell read too
  assert.match(String(codex('Bash', { command: 'cat /tmp/cb-seat-0a1b2c3d4e5f.opencode.json' }, CODEX)), /secret file/);
});

test('the fence names every path the adapters install to or configure (a new adapter path is fenced or this fails)', () => {
  for (const [kind, a] of Object.entries(ADAPTERS)) {
    if (kind === 'claude') continue;
    for (const p of ['win32', 'darwin', 'linux'] as const) {
      const g = a.guardInstallSpec('/home/someone/board', p);
      assert.ok(editFence(g.targetPath), `${kind} hook target ${g.targetPath} on ${p}`);
      const pre = a.trustSpec(['/home/someone/w'], p).preseedPath;
      if (pre) assert.ok(editFence(pre), `${kind} trust file ${pre}`);
    }
  }
  assert.ok(editFence('~/.config/opencode/opencode.jsonc')); // where OpenCode's question tool is turned off
  assert.ok(secretPath('cb-seat-0a1b2c3d4e5f.opencode.json'));
});

test('editTargets reads path keys and patch headers, recursively; evaluate blocks an edit it cannot see', () => {
  assert.deepEqual(editTargets({ command: ['apply_patch', patch('a.ts', 'b/c.ts')] }), ['a.ts', 'b/c.ts']);
  assert.deepEqual(editTargets({ filePath: 'x.ts', edits: [{ oldString: 'a' }] }), ['x.ts']);
  assert.deepEqual(editTargets({ content: 'no file here' }), []);
  assert.equal(evaluate({ tool: 'edit', role: 'builder', paths: [] }).allow, false);
  assert.equal(evaluate({ tool: 'edit', role: 'builder', paths: ['src/a.ts'] }).allow, true);
  // a Claude seat passes no paths: its edit rule is unchanged (kit/permissions denies the fence paths to Edit/Write)
  assert.equal(evaluate({ tool: 'edit', role: 'builder' }).allow, true);
  // no role (a hand-started session): only the base rules, as for shell commands
  assert.equal(evaluate({ tool: 'edit', role: null, paths: ['~/.codex/hooks.json'] }).allow, true);
});

test('a seat with CB_AGENT but no CB_ROLE is blocked by the Codex and OpenCode shims; a pane with neither keeps the base rules', () => {
  for (const tool of [['Bash', { command: 'ls' }], ['apply_patch', { command: patch('src/a.ts') }]] as const) {
    assert.match(String(codex(tool[0], tool[1], { CB_AGENT: 'codex' })), /CB_ROLE is not set/, tool[0]);
    assert.equal(codex(tool[0], tool[1], {}), true, `hand-started ${tool[0]}`);
  }
  assert.match(String(opencode('bash', { command: 'ls' }, { CB_AGENT: 'opencode' })), /CB_ROLE is not set/);
  assert.match(String(opencode('write', { filePath: 'src/a.ts' }, { CB_AGENT: 'opencode', CB_ROLE: ' ' })), /CB_ROLE is not set/);
  assert.equal(opencode('bash', { command: 'ls' }, {}), true);
  // the role rules then apply as for any seat
  assert.match(String(codex('Bash', { command: 'git push origin feat/x' }, { CB_AGENT: 'codex', CB_ROLE: 'reviewer' })), /^Blocked by role \(reviewer\)/);
});

// Review 68-I1: git is a writer only through its write subcommands, so reads naming a fenced file pass (on main they blocked,
// .claude/settings.json included); a repo's own .codex, .agents/hooks.json, opencode.json and .opencode stay fenced
// anywhere, while .gemini and .config/opencode are fenced only under a home folder.
test('the fence lets read-only git and a repo .gemini through; git and formatter writes to the repo-level names stay fenced', () => {
  const allowed = ['git diff -- opencode.json', 'git log --oneline -- opencode.json', 'git show HEAD:opencode.json', 'git blame opencode.jsonc',
    'git grep -n opencode.json', 'git status .opencode', 'git diff .gemini/styleguide.md', 'git log -p -- .codex', 'git -C /r log -- opencode.json',
    'cd ~/.codex && git log', 'git diff .claude/settings.json', 'git -C ~/.claude status', 'curl -s https://h.example/.agents/hooks.json -o /tmp/h.json',
    'git add .gemini/styleguide.md', 'git checkout -- .gemini/config.yaml', 'echo x > .gemini/styleguide.md', 'cd .gemini && echo x > styleguide.md'];
  const fenced = ['git add opencode.json', 'git add .codex/config.toml', 'git rm --cached .opencode/plugins/x.js', 'git -C ~/.claude checkout -- settings.json',
    'cd ~/.claude && git apply p.diff', 'git -c core.x=y checkout main -- .agents/hooks.json', 'git diff --output=/home/u/.codex/hooks.json',
    'pnpm exec prettier --write opencode.json', 'npx prettier -w .codex/config.toml', 'echo x > $HOME/.gemini/config/hooks.json',
    String.raw`echo x > $env:USERPROFILE\.gemini\antigravity-cli\settings.json`, 'rm -rf /Users/me/.config/opencode/plugins', 'cd ~/.gemini && echo x > y'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const c of allowed) assert.equal(evaluate({ tool: 'shell', command: c, role }).allow, true, `${role}: ${c}`);
    for (const c of fenced) assert.equal(evaluate({ tool: 'shell', command: c, role }).allow, false, `${role}: ${c}`);
  }
  assert.equal(editFence('.gemini/styleguide.md'), null);
  assert.equal(editFence('/repo/.gemini/config.yaml'), null);
  for (const p of ['~/.gemini/config/hooks.json', '/home/u/.gemini/x', String.raw`C:\Users\u\.config\opencode\plugins\x.js`, '.codex/hooks.json', '.opencode/plugins/x.js']) assert.ok(editFence(p), p);
});

// Review 68-I2: the spellings that passed, through the edit tools and the shell.
test('the fence folds ./ and ../, trailing dots and spaces, 8.3 names and links', () => {
  const spellings = ['~/.codex/./hooks.json', '/Users/me/.codex/x/../hooks.json', '~/.config/opencode/./plugins/cb-guard.js', String.raw`C:\Users\me\.codex.\hooks.json`,
    String.raw`C:\Users\me\.codex \hooks.json`, '~/.codex/hooks.json.', '/home/u/.gemini/../.gemini/./config/hooks.json'];
  for (const p of spellings) {
    assert.match(String(codex('Write', { file_path: p, content: 'x' }, CODEX)), /fence/, `codex ${p}`);
    assert.match(String(opencode('write', { filePath: p }, OPENCODE)), /fence/, `opencode ${p}`);
    assert.ok(editFence(p), `editFence ${p}`);
  }
  for (const c of ['echo x > ~/.codex/./hooks.json', 'cp x /Users/me/.codex/x/../hooks.json', 'echo x > ~/.config/opencode/./plugins/cb-guard.js',
    String.raw`echo x > C:\Users\me\.codex.\hooks.json`, String.raw`echo x > CODEX~1\hooks.json`, String.raw`del C:\Users\me\GEMINI~1\config\hooks.json`,
    String.raw`echo x > OPENCO~1\plugins\x.js`, 'echo x > ~/.codex/a/b/../../hooks.json']) {
    assert.equal(evaluate({ tool: 'shell', command: c, role: 'builder' }).allow, false, c);
  }
  // a link: an edit to a name in an ordinary folder that is a junction or link into ~/.codex is judged at its target
  const root = mkdtempSync(join(tmpdir(), 'cb-fence-link-'));
  try {
    mkdirSync(join(root, 'home', '.codex'), { recursive: true });
    writeFileSync(join(root, 'home', '.codex', 'hooks.json'), '{}');
    symlinkSync(join(root, 'home', '.codex'), join(root, 'cfg'), 'junction');
    assert.match(String(codex('Write', { file_path: join(root, 'cfg', 'hooks.json'), content: 'x' }, CODEX)), /fence/);
    assert.match(String(codex('apply_patch', { command: patch('cfg/hooks.json') }, CODEX, { cwd: root })), /fence/);
    assert.equal(codex('Write', { file_path: join(root, 'cfg2', 'hooks.json'), content: 'x' }, CODEX), true, 'an ordinary folder');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Review 68-M1: an indented patch header is a target too.
test('editTargets reads indented patch headers', () => {
  const p = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n  *** Update File: /Users/me/.codex/hooks.json\n@@\n-a\n+b\n*** End Patch';
  assert.deepEqual(editTargets({ command: p }), ['src/a.ts', '/Users/me/.codex/hooks.json']);
  assert.match(String(codex('apply_patch', { command: p }, CODEX)), /fence/);
});

// #4551 (review 68-m1): git is judged in command position, so a read whose search text is "git" passes (these blocked
// after PR 68), while git as the command, under any launcher or spelling, keeps every write form fenced.
const shell = (command: string, role: string) => evaluate({ tool: 'shell', command, role }).allow;
test('the fence judges git as a command: a search for the word git is a read; git behind a launcher or spelled as a path still writes', () => {
  const reads = ['rg -n git opencode.json', 'grep git .codex/config.toml', 'node cli/cb.ts help git -- .codex', 'cb help git -- .codex',
    'rg "git" opencode.json', 'grep -rn git status opencode.json', 'nice git log -- opencode.json', 'git "diff" opencode.json'];
  const writes = ['/usr/bin/git add opencode.json', 'git.exe add opencode.json', '"C:/Program Files/Git/cmd/git.exe" add opencode.json',
    'bash -c "git add opencode.json"', 'bash -c "cd x; git add opencode.json"', "sh -c 'git add .codex/config.toml'", 'xargs git add < l opencode.json',
    String.raw`find . -name opencode.json -exec git add {} \;`, 'timeout 5 git add opencode.json', 'cmd /c git add opencode.json',
    'pwsh -Command git add opencode.json', 'pnpm exec git checkout -- opencode.json', 'sudo -u root git add opencode.json',
    'env -u X git add opencode.json', 'GIT_DIR=.git git add opencode.json', 'echo $(git add opencode.json)', '(git add opencode.json)',
    '{ git add opencode.json; }', 'if true; then git add opencode.json; fi', 'time git add opencode.json', '! git add opencode.json',
    'command git add opencode.json', 'nohup git add opencode.json', 'ssh h git add opencode.json', 'npx git add opencode.json',
    'sudo git $SUB opencode.json', 'rg -n "git add" opencode.json',
    // the review's fail-closed git forms
    'git -c alias.x=checkout x opencode.json', 'git -C . apply opencode.json', 'git stash push opencode.json', 'git restore opencode.json',
    'git config -f .codex/config.toml a.b c', 'git update-index opencode.json', 'git diff --output=/home/u/.codex/hooks.json',
    'git log --output x opencode.json', 'git -c core.pager="tee ~/.codex/hooks.json" log', 'git show HEAD:x > ~/.codex/hooks.json',
    'cd ~/.claude && git apply p.diff'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const c of reads) assert.equal(shell(c, role), true, `${role}: ${c}`);
    for (const c of writes) assert.equal(shell(c, role), false, `${role}: ${c}`);
  }
  // and through a shim
  assert.equal(codex('Bash', { command: 'rg -n git opencode.json' }, CODEX), true);
  assert.match(String(codex('Bash', { command: 'xargs git add < l opencode.json' }, CODEX)), /fence/);
});

// Review 68-m2: git forms that run a program are writers, however they read.
test('the fence reads git -c program keys, grep -O and program-running git variables as writes; harmless forms stay reads', () => {
  const writes = ['git -c diff.external=./x.sh diff -- opencode.json', 'git -c DIFF.EXTERNAL=./x.sh diff -- opencode.json',
    'git -c "diff.external=./x.sh" diff -- opencode.json', 'git --config-env=diff.external=X diff -- opencode.json',
    'git --config-env core.pager=P log -- opencode.json', 'git -c core.pager=./x.sh log -- opencode.json',
    'git -c core.fsmonitor=./x.sh status opencode.json', 'git -c core.hooksPath=./h status opencode.json',
    'git -c core.sshCommand=./x status opencode.json', 'git -c diff.x.textconv=./x.sh log -p -- opencode.json',
    'git -c include.path=/tmp/c log -- opencode.json', 'git --exec-path=./bin diff -- opencode.json',
    'git grep -O./x.sh foo -- .codex/hooks.json', 'git grep --open-files-in-pager=./x.sh foo -- .codex/hooks.json',
    'git grep -nO foo -- .codex/hooks.json', 'GIT_EXTERNAL_DIFF=./x.sh git diff -- opencode.json', 'GIT_PAGER=./x.sh git log -- opencode.json',
    'env GIT_EXTERNAL_DIFF=./x.sh git diff -- opencode.json', 'GIT_CONFIG_PARAMETERS=x git log -- opencode.json'];
  const reads = ['git -c core.quotepath=off status opencode.json', 'git diff -O.order -- opencode.json', 'GIT_PAGER=cat git log -- opencode.json',
    'git -c core.pager=cat log -- opencode.json', 'git -c core.pager="less -R" log -- opencode.json', 'git grep -n foo -- .codex/hooks.json'];
  for (const c of writes) assert.equal(shell(c, 'builder'), false, c);
  for (const c of reads) assert.equal(shell(c, 'builder'), true, c);
});

// Review 68-m3: a ... segment, bash's $USERPROFILE and an NTFS stream suffix name the fenced file too.
test('the fence folds a ... segment, reads bash $USERPROFILE as home, and drops an NTFS stream suffix', () => {
  const paths = ['~/.codex/.../hooks.json', String.raw`C:\Users\me\.codex\...\hooks.json`, 'C:/Users/me/.codex/hooks.json::$DATA',
    String.raw`C:\Users\me\.codex\hooks.json::$data`, '/home/u/.codex::$INDEX_ALLOCATION/hooks.json', '/home/u/.codex:$I30:$INDEX_ALLOCATION/config.toml'];
  for (const p of paths) {
    assert.ok(editFence(p), `editFence ${p}`);
    assert.match(String(codex('Write', { file_path: p, content: 'x' }, CODEX)), /fence/, `codex ${p}`);
  }
  for (const c of ['echo x > ~/.codex/.../hooks.json', 'echo x > $USERPROFILE/.gemini/settings.json', 'echo x > ${USERPROFILE}/.gemini/settings.json',
    'echo x > ${env:USERPROFILE}/.gemini/settings.json', "echo x > '~/.codex/hooks.json::$DATA'", 'echo x > ~/.codex/hooks.json::',
    'echo x > ~/.codex::$INDEX_ALLOCATION/hooks.json', 'cd ~/.codex::$INDEX_ALLOCATION && echo x > hooks.json']) {
    assert.equal(shell(c, 'builder'), false, c);
  }
  for (const p of ['notes/.../x.md', 'src/a::b.ts']) assert.equal(editFence(p), null, p);
  assert.equal(shell('echo ... > notes.txt', 'builder'), true);
});

// PR 77 review: I1, a command word the shell fills in is an unknown program, judged as git (main blocked these by its
// word match); I2, a backtick around a command hid the fence path (main and head); M1, a function or alias defined on
// the same line moved the writer into another segment.
test('the fence judges a shell-filled command word as git, sees paths inside backticks, and treats a same-line function or alias as a writer', () => {
  const writes = ['$GIT checkout -- opencode.json', '"$GIT" checkout -- opencode.json', '${GIT:-git} checkout -- opencode.json',
    'sudo $GIT checkout -- opencode.json', 'xargs $GIT add < l opencode.json', '$(which git) checkout -- opencode.json',
    '`which git` checkout -- opencode.json',
    'echo `cp x opencode.json`', 'echo `cp x ~/.codex/hooks.json`', 'echo `echo x > .claude/settings.json`', 'v=`cp x ~/.claude/settings.json`',
    'x=`git checkout -- opencode.json`',
    'f() { cp x "$1"; }; f .claude/settings.json', 'alias c=cp; c x .claude/settings.json', 'g() { git checkout -- "$@"; }; g opencode.json',
    'function f { cp x $args }; f opencode.json', 'Set-Alias c Copy-Item; c x opencode.json'];
  const reads = ['$GIT log -- opencode.json', 'echo $HOME opencode.json', '$x = Get-Content ~/.codex/config.toml',
    "$env:X = 'y'; cat opencode.json", 'x=$(cat opencode.json)', 'echo `date` opencode.json', 'rg -n "function opencode" src opencode.json'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const c of writes) assert.equal(shell(c, role), false, `${role}: ${c}`);
    for (const c of reads) assert.equal(shell(c, role), true, `${role}: ${c}`);
  }
});

// PR 77 re-review: a shell-filled word before a writing git subcommand is git in any position (no wrapper list to fall
// behind: main blocked these by its word match); a definition inside quoted text is not a definition; alias -- and hash -p
// define too.
test('the fence judges a shell-filled word before a writing git subcommand as git anywhere; quoted text defines nothing', () => {
  const writes = ['caffeinate $GIT checkout -- opencode.json', 'caffeinate -i $GIT checkout -- .claude/settings.json',
    'arch -arm64 $GIT checkout -- opencode.json', 'taskset 1 $GIT checkout -- opencode.json', 'chrt 1 $GIT checkout -- opencode.json',
    'firejail $GIT checkout -- opencode.json', 'proxychains $GIT checkout -- opencode.json', 'time -p $GIT checkout -- opencode.json',
    '. $GIT checkout -- opencode.json', 'caffeinate `which git` checkout -- opencode.json', 'alias -- c=cp; c x opencode.json',
    'hash -p /bin/cp c; c x opencode.json'];
  const reads = ['caffeinate $GIT log -- opencode.json', 'arch -arm64 $GIT diff opencode.json', 'echo $HOME opencode.json', '$PAGER opencode.json',
    '$x = Get-Content opencode.json', 'grep -E "a|function b" opencode.json', 'node -e "(function f(){})()" opencode.json'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const c of writes) assert.equal(shell(c, role), false, `${role}: ${c}`);
    for (const c of reads) assert.equal(shell(c, role), true, `${role}: ${c}`);
  }
});

// PR 77 round 3: after a shell-filled word, the next word that is not an option decides: any git command (or a filled
// one) is judged with the command-position rule, so merge-file, stage, a read's --output and $SUB write.
// #4795, B2's note: a quoted word that starts with a backtick substitution is a filled word in the git-name place too,
// as one that starts with $( ) is
test('the fence reads a quoted word that starts with a backtick substitution as a filled word', () => {
  const lines = (w: string) => [`${w} checkout -- opencode.json`, `caffeinate ${w} checkout -- opencode.json`, `echo ${w} "$S checkout" opencode.json`,
    `echo ${w} checkout -- opencode.json | sh`, `nice -n 5 ${w} restore .claude/settings.json`];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const [dollar, tick] of [['"$(which git)"', '"`which git`"'], ['"$(echo gi)t"', '"`echo gi`t"']]) {
      for (const [i, c] of lines(tick).entries()) {
        assert.equal(shell(lines(dollar)[i], role), false, `${role}: ${lines(dollar)[i]}`);
        assert.equal(shell(c, role), false, `${role}: ${c}`);
      }
    }
    for (const c of ['"`which git`" log -- opencode.json', 'echo "`date`" opencode.json', 'grep "`cat pattern`" "$F" opencode.json', 'cat "`pwd`/opencode.json"'])
      assert.equal(shell(c, role), true, `${role}: ${c}`);
  }
});

// #4802: ; & | and a newline inside a substitution end no command, so they must not cut the filled git word off from the
// path it writes
test('the fence keeps a substitution whole across the separators inside it', () => {
  const words = ['"$(true; echo checkout)x"', '$(true; echo checkout)', '"`true; echo checkout`"', '`true; echo checkout`',
    '"$(true && echo checkout)"', '"$(false || echo checkout)"', '"$(echo checkou | cat)t"', '"$(true & echo checkout)"', '"$(true\necho checkout)x"',
    '"$(case a in a) echo checkout;; esac)x"', '"$(echo \')\'; echo checkout)x"', '"$(: $(true; true); echo checkout)"',
    '"$(echo case; echo checkout)x"', '"$(case a in (a) echo checkout;; esac)x"'];
  // a stray quote or a quoted $( earlier in the line miscounts one way of reading it, never both
  const before = ['', '# don\'t\n', 'true # don\'t\n', 'echo \'$(\'; ', 'echo "\\""; ', 'echo $\'a\\\'b\'; '];
  const reads = ['caffeinate $GIT log -- "$(true; echo opencode.json)"', 'echo "$(cp a b; cat opencode.json)"', 'x="$(git log --oneline | head -1)"; cat opencode.json',
    'cat "$(git rev-parse --show-toplevel || pwd)/opencode.json"', 'for f in $(ls; echo x); do cat $f; done; cat opencode.json',
    'echo "$(git status; git diff opencode.json)"', '# don\'t\ncat opencode.json; git add src/x.ts', 'echo "$(unclosed; git add a"; cat opencode.json'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const w of words) for (const pre of before) {
      const c = `${pre}caffeinate $GIT ${w} -- opencode.json`;
      assert.equal(shell(c, role), false, `${role}: ${JSON.stringify(c)}`);
    }
    for (const c of reads) assert.equal(shell(c, role), true, `${role}: ${JSON.stringify(c)}`);
  }
});

// #4798: only a slash OUTSIDE every substitution and ${...} makes a filled word a path. One inside (a redirect, a
// ${v/a/b} replacement) says nothing about what the word comes out as
test('the fence does not read a slash inside a substitution as a path', () => {
  const hidden = ['"$(echo checkout </dev/null)x"', '"`echo checkout </dev/null`x"', '"$(echo checkou 2>/dev/null)t"', 'x"$(echo checkout </dev/null)"',
    '"$(echo $(echo checkout </dev/null))x"', '"${S/q/checkout}"', '"$(echo checkout \')\' </dev/null)x"', '"$( (echo checkout) </dev/null)x"',
    '"$(echo checkout </dev/null"'];
  const paths = ['"${A}/${B}"', '"$(pwd)/$(date)"', '"`pwd`/`date`"', '"$(echo \')\')/x"', '"$(pwd)\\opencode.json"', '"$(cat /tmp/dir)/x"',
    '"${HOME:-/root}/.codex"', '"$ROOT/$NAME"'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const w of hidden) {
      const c = `caffeinate $GIT ${w} -- opencode.json`;
      assert.equal(shell(c, role), false, `${role}: ${c}`);
    }
    for (const w of paths) {
      const c = `ls $HOME ${w} opencode.json`;
      assert.equal(shell(c, role), true, `${role}: ${c}`);
    }
  }
});

// #4795: after a git name held in a variable, a quoted word with a backtick substitution fills the subcommand place as
// one with $( ) does. Each shape is pinned in both spellings: the $( ) one blocked before, the backtick one did not
test('the fence reads a backtick substitution in a quoted subcommand place as it reads the $( ) one', () => {
  const places: [string, string][] = [['`echo checkout`', '$(echo checkout)'], ['`echo checkou`t', '$(echo checkou)t'], ['check`echo out`', 'check$(echo out)'],
    ['`echo che``echo ckout`', '$(echo che)$(echo ckout)'], ['`echo checkout`x', '$(echo checkout)x'], ['x`echo checkout`', 'x$(echo checkout)'],
    ['`echo checkoutx`', '$(echo checkoutx)'], ['`echo checkout x`', '$(echo checkout x)']];
  const before = ['caffeinate $GIT', 'arch -arm64 ${GIT}', 'time -p $GIT --no-pager', 'caffeinate $(which git)', 'caffeinate $GIT -C .'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const b of before) for (const [tick, dollar] of places) for (const place of [`"${dollar}"`, `"${tick}"`]) {
      const c = `${b} ${place} -- opencode.json`;
      assert.equal(shell(c, role), false, `${role}: ${c}`);
    }
    // a read stays a read, and a path beside a substitution is no subcommand, as with $( )
    for (const c of ['caffeinate $GIT log -- "`echo opencode.json`"', 'cat "`pwd`/opencode.json"', 'cat "$(pwd)/opencode.json"', 'cat $HOME/.codex/config.toml "`pwd`/x"',
      'echo "`date`" opencode.json']) assert.equal(shell(c, role), true, `${role}: ${c}`);
  }
});

test('the fence judges a filled word followed by any git command with the command-position rule', () => {
  const writes = ['caffeinate $GIT merge-file opencode.json a b', 'caffeinate $GIT diff --output=opencode.json',
    'caffeinate $GIT log --output=opencode.json', 'caffeinate $GIT show --output=opencode.json HEAD', 'caffeinate $GIT $SUB -- opencode.json',
    'caffeinate $GIT stage opencode.json', 'caffeinate $GIT -C . checkout -- opencode.json', 'caffeinate ${GIT:-git} checkout -- opencode.json',
    'caffeinate $(which git) checkout -- opencode.json'];
  const reads = ['caffeinate $GIT log -- opencode.json', 'caffeinate $GIT show HEAD:opencode.json', 'arch -arm64 $GIT diff opencode.json',
    '$PAGER opencode.json', 'echo $HOME opencode.json', 'echo $HOME is opencode.json', 'cat $HOME/.codex/config.toml', 'echo `date` opencode.json'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const c of writes) assert.equal(shell(c, role), false, `${role}: ${c}`);
    for (const c of reads) assert.equal(shell(c, role), true, `${role}: ${c}`);
  }
});

// PR 77 round 4: after a filled word, only a git command, a bare $VAR / ${VAR} / %VAR% or a ${...} / $(...) / backtick group
// fills the subcommand slot ($HOME/.codex/... is a path, not git); a quoted string that starts with $ is not a command line;
// git's options after a filled word are judged, not skipped; the git 2.53 command list; cmd's %VAR% is a filled word. echo
// of a filled word still counts: what echo prints may be run ($(echo $GIT checkout ...), | sh).
test('the fence reads two filled paths and quoted $( ) paths as reads; judges options after a filled word', () => {
  const writes = ['caffeinate $GIT -c alias.x=checkout x -- opencode.json', 'caffeinate $GIT --config-env=alias.x=V x -- opencode.json',
    'caffeinate $GIT --attr-source HEAD checkout -- opencode.json', 'arch -arm64 $GIT -c alias.x=checkout x -- .claude/settings.json',
    'time -p $GIT --attr-source HEAD restore .codex/config.toml', 'caffeinate $GIT --exec-path=/tmp/x foo opencode.json',
    'caffeinate $GIT credential-store --file=opencode.json store', 'caffeinate $GIT credential-store --file ~/.codex/config.toml store',
    'caffeinate $GIT subtree add --prefix=.opencode/plugins ../p main', 'caffeinate $GIT init-db --template=/tmp/t .codex',
    'caffeinate $G merge-recursive HEAD -- a b opencode.json', '%GIT% checkout -- opencode.json', 'caffeinate %GIT% checkout -- opencode.json',
    'cmd /c "%GIT% checkout -- opencode.json"', 'caffeinate $GIT $SUB -- opencode.json', 'bash -c "$G checkout -- opencode.json"',
    'bash -c "$(which git) checkout -- opencode.json"', 'echo $(caffeinate $GIT checkout -- opencode.json)',
    'echo $GIT checkout -- opencode.json | sh', '$(echo $GIT checkout -- opencode.json)', 'bash <(echo $GIT checkout -- opencode.json)',
    'sh -c "$(echo $GIT checkout -- opencode.json)"', 'caffeinate $(echo --name) cat $GIT checkout -- opencode.json'];
  const reads = [
    'ls $HOME/.codex $HOME/.gemini',
    'diff $HOME/.codex/config.toml $HOME/.codex/config.toml.bak',
    'cat $HOME/.codex/hooks.json $HOME/.agents/hooks.json',
    'head -3 $HOME/.claude/settings.json $PWD/.claude/settings.json',
    'grep -n $PATTERN $HOME/.codex/config.toml',
    'rg $PAT $ROOT/opencode.json',
    'Get-Content $HOME/.codex/config.toml, $HOME/.gemini/settings.json',
    'Compare-Object (Get-Content $env:USERPROFILE/.codex/config.toml) (Get-Content $env:TEMP/c.toml)',
    'jq -s . $HOME/.claude/settings.json $HOME/.claude/settings.local.json',
    'for f in $HOME/.codex/config.toml $HOME/.gemini/settings.json; do wc -l $f; done',
    'sha256sum $REPO/opencode.json $BACKUP/opencode.json',
    'cat "$(git rev-parse --show-toplevel)/.claude/settings.json"',
    'cat "$(git rev-parse --show-toplevel)/opencode.json"',
    'cat "$(pwd)/opencode.json"',
    'cat "$(pwd)"/opencode.json',
    'head -5 "$(dirname $0)/opencode.json"',
    'jq . "$(git rev-parse --show-toplevel)/.agents/hooks.json"',
    'diff opencode.json "$(git rev-parse --show-toplevel)/opencode.json"',
    'ls "$(git rev-parse --show-toplevel)/.codex"',
    'cat "$HOME/.codex/config.toml"',
    'cat "${HOME}/.claude/settings.json"',
    'cat "$(echo ~)/.codex/config.toml"',
    '$(git rev-parse --show-toplevel)/scripts/lint.sh opencode.json',
    'cat `git rev-parse --show-toplevel`/opencode.json',
    'cat "`git rev-parse --show-toplevel`/opencode.json"',
    'wc -c "$(git rev-parse --show-toplevel)"/opencode.json',
    'echo "$(date) checking opencode.json"',
    'echo "$(git log -1 --format=%h) opencode.json"',
    'echo "$USER reading .claude/settings.json"',
    'echo "files: $(ls .codex)"',
    'Get-Content "$(git rev-parse --show-toplevel)/opencode.json"',
    'Get-Content "$env:USERPROFILE\\.codex\\config.toml"',
    'Get-Content (Join-Path $HOME \'.codex/config.toml\')',
    'node -e "console.log(process.env.HOME)" opencode.json',
    'caffeinate $GIT -C . diff -- opencode.json', 'caffeinate $GIT ./opencode.json'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const c of writes) assert.equal(shell(c, role), false, `${role}: ${c}`);
    for (const c of reads) assert.equal(shell(c, role), true, `${role}: ${c}`);
  }
});

// PR 77 round 5: a partly filled subcommand after a filled word ($S$X, ch$X, ch${X}, check%X%) is filled (I2); an option
// outside git's global options ends the test, a program that never runs or prints its arguments (cat, grep, rg, diff,
// git itself in command position ...) runs no filled word when it is a real command word, and the test stops at a closing
// ) or backtick (I3).
test('the fence judges a partly filled subcommand as git; two variables or a variable after an option in a read pass', () => {
  const writes = [
    'caffeinate $GIT $S$X -- opencode.json',
    'caffeinate $GIT ch$X -- opencode.json',
    'caffeinate $G $S$X -- opencode.json',
    'bash -c "$G ch$X -- opencode.json"',
    'bash -c "$G $S$X -- opencode.json"',
    'caffeinate $G ch$X -- opencode.json',
    'caffeinate $G ch${X} -- opencode.json',
    'caffeinate $G che$(echo ck)out -- opencode.json',
    'caffeinate $G check%X% -- opencode.json',
    'caffeinate $(echo --name) cat $GIT checkout -- opencode.json',
    'cat $(caffeinate $GIT checkout -- opencode.json)',
    'echo $A $B checkout -- opencode.json | sh'];
  const reads = [
    'git diff $BASE $HEAD -- opencode.json',
    'git diff "$BASE" "$HEAD" -- .claude/settings.json',
    'git diff $BASE $HEAD --stat -- .codex/config.toml',
    'git log --oneline $FROM $TO -- opencode.json',
    'git diff ${BASE} ${HEAD} -- opencode.json',
    'git show $SHA $SHA2 -- opencode.json',
    'git -C $REPO diff $A $B -- opencode.json',
    'git log -n $N $REV -- opencode.json',
    'git blame -L $A,$B $REV -- opencode.json',
    'git log --format=%h $A $B -- opencode.json',
    'rg -n $PAT $DIR opencode.json',
    'rg -n -e $A -e $B opencode.json',
    'grep -n -e $A -e $B .claude/settings.json',
    'grep -n $A $FILE opencode.json',
    'cat $A $B opencode.json',
    'wc -l $F $G opencode.json',
    'Select-String -Path $HOME/.codex/config.toml -Pattern $P',
    'Get-Content $A, $B .claude/settings.json',
    'git diff $(git rev-parse $A) $(git rev-parse $B) -- opencode.json',
    'cat `echo $A` opencode.json',
    'cat "`echo $A`" opencode.json',
    'diff $(dirname $A) $(dirname $B)/opencode.json',
    'Get-Content -Path $HOME/.codex/config.toml -TotalCount $N',
    'Get-Content $env:USERPROFILE/.codex/config.toml -Tail $N',
    'grep -A $N -B $M hooks opencode.json',
    'cmp $A $B opencode.json',
    'stat -c %y $HOME/.claude/settings.json ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json'];
  for (const role of ['builder', 'reviewer', 'lead']) {
    for (const c of writes) assert.equal(shell(c, role), false, `${role}: ${c}`);
    for (const c of reads) assert.equal(shell(c, role), true, `${role}: ${c}`);
  }
});
