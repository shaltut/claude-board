// Guard core (#4002): one fail-closed rule set for an agent's shell commands, file edits and ask-user tool, keyed by role.
// Pure ES module: no I/O, no imports, no dependencies. A thin per-CLI shim (shim-claude.mjs) reads the hook input and
// CB_ROLE / CB_PROTECTED_BRANCHES / CB_ALLOW_ASK from its pane, calls evaluate, and prints the CLI's block format.
// Deploy with node kit/guard/install.mjs (it copies this file with its shims and probes them); never copy one file alone.
//
// Shell commands: it ignores message text (cb tell, git commit -m, gh --body, quoted-delimiter heredoc bodies written to
// files), so "the shutdown is planned" can be posted. What is left is matched ANYWHERE, like the old hook: a fence fails
// closed (ssh host reboot, nohup, xargs ...). Text the shell would expand ("$(...)", backticks, unquoted heredocs) is
// never stripped.

export const ROLES = Object.freeze(['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator']);
// read and report: no edits, commits or pushes (Q2799: architect and owner keep Edit/Write)
export const READ_ONLY_ROLES = Object.freeze(['reviewer', 'qa', 'investigator']);

const QUOTED = String.raw`"(?:\\.|[^"\\])*"|'[^']*'`;
// #4742: text.replace(<a global QUOTED pattern>, fn) in linear time. A global replace tries a " with no close again from
// every later one: 100,000 \" took 6 to 43 s, past a hook's timeout, and a hook that times out allows. Those later ones
// need no try: each is the second half of a \ pair the failed read walked over, so a read from it stops at the same
// place and closes nowhere either. `at` is the pattern, sticky; `body` reads what its double quotes may hold.
const QUOTED_AT = new RegExp(QUOTED, 'y');
const DQ_BODY = /(?:\\.|[^"\\])*/y;
function replaceQuoted(text, fn, at = QUOTED_AT, body = DQ_BODY) {
  const starts = /["'{]/g;
  let out = '', done = 0, dead = 0;
  for (let m; (m = starts.exec(text));) {
    const i = m.index;
    if (text[i] === '"' && i < dead) continue;
    at.lastIndex = i;
    const hit = at.exec(text);
    if (hit) {
      out += text.slice(done, i) + fn(...hit);
      starts.lastIndex = done = i + hit[0].length;
    } else if (text[i] === '"') {
      body.lastIndex = i + 1;
      body.exec(text);
      dead = body.lastIndex;
    }
  }
  return out + text.slice(done);
}
const blankQuoted = (text) => replaceQuoted(text, () => '""');
const PS_STRING_AT = /"(?:\\.|[^"\\$`])*"/y;
const PS_STRING_BODY = /(?:\\.|[^"\\$`])*/y;
// A message command plus its same-line args: quoted runs, escaped pairs or bare words (stops at ; & | newline).
const MESSAGE_HEAD = String.raw`\bcb[ \t]+(?:tell|ask|log|add|bug|done|move|fail|pass|edit)\b|\bgit[ \t]+commit\b|\bgh[ \t]+pr[ \t]+(?:create|comment|review)\b|\bherdr(?:[ \t]+--machine[ \t]+\S+)?[ \t]+agent[ \t]+prompt\b`;
const MESSAGE_CMD = new RegExp(String.raw`(${MESSAGE_HEAD})((?:[ \t]+(?:${QUOTED}|\\.|[^\s;&|"'\\])+)*)`, 'g');
// Only a quoted-delimiter heredoc is literal; an unquoted <<EOF body is expanded by the shell. A header line holds <<'ID'
// or <<"ID" (<<- too); its body runs to the first later line holding only ID (blanks around it allowed), which may be the
// line right after the header (#4768: an empty body). A body is dropped only where bash reads a heredoc (bashReader).
// One pass (#4002): the regex form, /^([^\n]*<<-?[ \t]*(['"])(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3
// [ \t]*(?=\n|$)/gm, searched to the end of the text again for every header without its end line ((headers x length):
// 4 s on 156 KB through a role seat's six scans). Same matches: end lines are indexed once per word, a line's << are
// tried last to first (the regex's greedy [^\n]*), and ^ and $ keep the m flag's line ends (\n, \r, U+2028, U+2029).

// #4768, #4770: a body is dropped only where the shell reads a heredoc. Seats run bash and PowerShell and the guard is
// told neither, so the reader holds a list of what may stand before a marker, all of which both shells read alike: words,
// ; & | > ( ), plain '...' and "..." strings, $( ), $name, and simple ${name} forms. PowerShell has no heredoc (a << in
// its code runs nothing), so what has to be ruled out is text that moves a quote in one of them only. Anything else (a
// backtick, a backslash, <, a smart quote, $'..', $[ ], @'..', another heredoc, case, whose ) closes nothing) makes the
// reader unsure for good: from there nothing is dropped, so the text is judged as commands.
// Comments are never skipped: whether a # starts one differs between the shells and between places in one shell (1# in
// PowerShell, $(( )), [[ =~ ]], a[ ] in bash). A # may stand only when the rest of its line holds nothing that changes
// what is read, so that both readings come to the same thing (PLAIN_TAIL).
// PowerShell also skips the syntax check inside a $( ) that is part of a command's name (x=$( ... ), ./"$( ... )"), so
// there a << stops nothing. No body is dropped while inside a $( or a " that is glued to the word before it.
// read(to) leaves at() === to when `to` is not inside a '...' word; open holds the " and ( not yet closed, as g and x
// where they are glued to the word before them, and unchecked counts those two.
const PLAIN_CODE = /[A-Za-z0-9_ \t\n./:=@%+,~;&|>*?!^[\]{}#-]/;
const WORD_START = /[ \t\n;&|(]/;
const PS_QUOTE = /[\u2018-\u201f]/; // PowerShell reads these as ' and "
const PLAIN_SQ = /\x27[^\x27\u2018-\u201f]*\x27/y;
// ${name}, ${#name}, ${name:0:7}, ${name:-plain words}: nothing inside that could open a quote, a substitution or a
// second line
const PLAIN_PARAM = /\$\{[#!]?\w+(?::?[-=?+][\w ./:-]*|(?::\d+){1,2})?\}/y;
const PLAIN_TAIL = /[^\x22\x27\x60\\$()<\u2018-\u201f\r\n]*(?=\r?\n|$)/y; // the rest of a line after a #
// after a \ inside "...": printable ASCII that bash leaves as it is (not " $ \ `, and no line end to join)
const PLAIN_ESCAPED = /(?![\x22\x24\x5c\x60])[\x20-\x7e]/y;
const inQuotes = (top) => top === '"' || top === 'g';
const CASE_AT = /case[ \t\r\n]/y;
const DELIMITER_END = /(?=[ \t\n;&|<>()]|\r\n)/y;
function bashReader(text) {
  let i = 0;
  let plainTo = 0; // the line already checked for a #, so many of them on one line are checked once
  const r = {
    open: [],
    low: 0, // the fewest open since the caller last set it
    unchecked: 0,
    unsure: false,
    at: () => i,
    skip(to) { i = to; },
    read(to) {
      const { open } = r;
      const push = (e) => { open.push(e); if (e === 'g' || e === 'x') r.unchecked++; };
      const close = () => { const e = open.pop(); if (e === 'g' || e === 'x') r.unchecked--; r.low = Math.min(r.low, open.length); };
      const lost = () => { r.unsure = true; };
      const startsWord = () => i === 0 || WORD_START.test(text[i - 1]);
      while (i < to && !r.unsure) {
        const c = text[i], quoted = inQuotes(open.at(-1));
        if (c === '$') {
          const d = text[i + 1];
          if (d === '(') {
            push((quoted ? open.at(-1) === 'g' : !startsWord()) ? 'x' : '('); i += 2; continue;
          }
          if (d === '{') {
            PLAIN_PARAM.lastIndex = i;
            if (PLAIN_PARAM.test(text)) i = PLAIN_PARAM.lastIndex; else lost();
            continue;
          }
          if (d === '[' || (d === "'" && !quoted)) lost();
          i += d === '$' ? 2 : 1;
          continue;
        }
        // Git Bash drops every carriage return (so one can join $ to (), PowerShell ends a line at it
        if (c === '\r' && text[i + 1] !== '\n') lost();
        if (quoted) {
          if (c === '"') close();
          else if (c === '`' || PS_QUOTE.test(c)) lost();
          else if (c === '\\') { // PowerShell does not escape with \: the next character is read again on its own
            PLAIN_ESCAPED.lastIndex = i + 1;
            if (!PLAIN_ESCAPED.test(text)) lost();
          }
          i++;
          continue;
        }
        if (c === '"' || c === "'") {
          if (text[i - 1] === '@') { lost(); continue; } // a PowerShell here-string
          if (c === '"') { push(startsWord() ? c : 'g'); i++; continue; }
          PLAIN_SQ.lastIndex = i;
          if (PLAIN_SQ.test(text)) i = PLAIN_SQ.lastIndex;
          else if (text.indexOf("'", i + 1) < 0) i = text.length + 1;
          else lost();
          continue;
        }
        if (c === '#' && i >= plainTo) {
          PLAIN_TAIL.lastIndex = i;
          if (PLAIN_TAIL.test(text)) plainTo = PLAIN_TAIL.lastIndex; else lost();
        }
        if (c === '(') push(c);
        else if (c === ')') { if (open.length) close(); else lost(); }
        else if (c !== '\r' && !PLAIN_CODE.test(c)) lost();
        else if (c === '-' && text.startsWith('--%', i)) lost(); // PowerShell stops reading quotes after it
        else if (c === 'c' && startsWord()) { CASE_AT.lastIndex = i; if (CASE_AT.test(text)) lost(); }
        i++;
      }
    },
  };
  return r;
}
const END_LINE = /\n[ \t]*(\w+)[ \t]*(?=\n|$)/gm; // a line holding only a word, from the \n before it
// a line bash takes as the end inside $( ) or backticks, though more follows the word: EOF) or EOF`
const CLOSING_LINE = /\n[ \t]*(\w+)(?=[ \t]*[)\x60])/g;
const LONE_CR = /\r(?!\n)/;
const HEADER_AT = /<<-?[ \t]*(['"])(\w+)\1/y;
const LINE_START = /^/gm;
function replaceHeredocs(text, fn) {
  // word -> { at: [[index of the \n before the line, end of the line's word and blanks], ...], k }
  const index = (re) => {
    const map = new Map();
    for (const m of text.matchAll(re)) {
      const e = map.get(m[1]) ?? { at: [], k: 0 };
      e.at.push([m.index, m.index + m[0].length]);
      map.set(m[1], e);
    }
    return map;
  };
  const ends = index(END_LINE), closings = index(CLOSING_LINE);
  // the first line of a word's list whose \n is at or after `from`; callers ask with a growing `from`
  const lineFrom = (e, from) => {
    while (e && e.k < e.at.length && e.at[e.k][0] < from) e.k++;
    return e?.at[e.k];
  };
  const bash = bashReader(text);
  // whether bash reads the heredoc found at `at` on the line ending at nl, with its body ending where the guard's does
  const isHeredoc = (at, nl, f) => {
    bash.read(at);
    if (bash.unsure || bash.at() !== at || bash.unchecked || inQuotes(bash.open.at(-1))) return false;
    // PowerShell refuses a << only where it starts a token: in cb log 1 -<<'EOF' it is part of the word, and line 2 runs
    if (at && !WORD_START.test(text[at - 1])) { bash.unsure = true; return false; }
    // <<'EOF'x: bash's delimiter is EOFx, so its body ends somewhere else
    DELIMITER_END.lastIndex = at + f.header;
    if (!DELIMITER_END.test(text)) { bash.unsure = true; return false; }
    // the rest of the header line must end as it began: a quote left open or a trailing \ puts commands where the body seemed to be
    const depth = bash.open.length;
    bash.low = depth;
    bash.skip(at + f.header);
    bash.read(nl);
    if (bash.unsure || bash.at() !== nl || bash.open.length !== depth || bash.low < depth) return false;
    const closing = lineFrom(closings.get(f.id), nl);
    if (closing && closing[0] < f.before) { bash.unsure = true; return false; }
    // Git Bash drops every carriage return, so a lone one in the body may spell an earlier end line (\rEOF, E\rOF)
    if (LONE_CR.test(text.slice(nl, f.before + 1))) { bash.unsure = true; return false; }
    bash.skip(f.end);
    // an end line bash does not take (blanks around it): bash's body goes on, so what follows cannot be read
    const last = text.slice(f.before + 1, f.end);
    if ((f.dash ? last.replace(/^\t+/, '') : last) !== f.id || (text[f.end] === '\r') !== (text[nl - 1] === '\r')) bash.unsure = true;
    return true;
  };
  let out = '';
  let pos = 0;
  for (let s = 0; ;) {
    const nl = text.indexOf('\n', s);
    if (nl < 0) break;
    const line = text.slice(s, nl);
    let found = null;
    for (let at = line.lastIndexOf('<<'); at >= 0 && !found; at = at > 0 ? line.lastIndexOf('<<', at - 1) : -1) {
      HEADER_AT.lastIndex = at;
      const h = HEADER_AT.exec(line);
      const e = h && ends.get(h[2]);
      if (!e) continue;
      const end = lineFrom(e, nl); // from the header line's own \n: the very next line may end it
      if (end) found = { id: h[2], before: end[0], end: end[1], at: s + at, header: h[0].length, dash: h[0][2] === '-' };
    }
    if (found && !isHeredoc(found.at, nl, found)) found = null;
    // no match from here: a later ^ on this line (after \r) only reaches some of the same <<, so none matches either
    if (!found) { s = nl + 1; continue; }
    out += text.slice(pos, s) + fn(text.slice(s, found.end), line, found.id);
    pos = found.end;
    LINE_START.lastIndex = pos;
    const next = LINE_START.exec(text);
    if (!next) break;
    s = next.index;
  }
  return out + text.slice(pos);
}
const TEXT_WRITER = /^[ \t]*(?:cb[ \t]|cat[ \t]*>>?[ \t]*\S|git[ \t]+commit\b.*-F[ \t]+-)/;
const SUBST_CAT = /\$\([ \t]*cat[ \t]*$/;
const MESSAGE_ARG = new RegExp(String.raw`(?:^|[;&|(][ \t]*)(?:${MESSAGE_HEAD})[^;&|\n]*"$`);

// Does the heredoc header line belong to a text writer? Judged from the command segment holding the <<.
function writesText(line) {
  if (line.split('<<').length !== 2) return false; // two heredocs on one line: strip neither
  const at = line.indexOf('<<');
  const before = line.slice(0, at);
  if (SUBST_CAT.test(before)) return MESSAGE_ARG.test(before.replace(SUBST_CAT, '')); // "$(cat <<'EOF' in a message arg
  const seg = before.slice(Math.max(...[';', '&', '|', '('].map((c) => before.lastIndexOf(c))) + 1);
  const after = line.slice(at).search(/[;&|]/);
  return TEXT_WRITER.test(seg + (after < 0 ? line.slice(at) : line.slice(at, at + after)));
}

// #4669: several rules strip the same command in one evaluate; the last answer is kept (a pure string function)
let stripLast = null;
export function stripMessages(cmd) {
  if (stripLast && stripLast.in === cmd) return stripLast.out;
  const out = stripMessagesOnce(cmd);
  stripLast = { in: cmd, out };
  return out;
}
function stripMessagesOnce(cmd) {
  return replaceHeredocs(cmd, (all, line, id) => (writesText(line) ? `${line}\n${id}` : all))
    .replace(MESSAGE_CMD, (_all, head, args) =>
      // kept: a "$(...)" or backtick the shell runs, and a herdr prompt starting with ! (it runs as a shell command there)
      head + replaceQuoted(args, (q) =>
        ((/^herdr/.test(head) && /^["']!/.test(q)) || (/^"/.test(q) && /\$\(|`/.test(q)) ? q : '""')));
}

// PowerShell and cmd (#4002): a recursive delete whose target is a root, a drive root or the home folder. The command,
// its recursion flag and its target sit in one command segment (stops at ; & | newline), in any order (Remove-Item ~
// -Recurse). The target is a whole word, quoted or not, so rm -rf *, Remove-Item -Recurse -Force dist, dist/ and
// C:\work\dist pass. Each part is one linear test per segment: a lookahead per command word would be quadratic, and a
// long command must not run past the hook's timeout.
// A backslash before a newline (bash's line continuation) or before ; & | (bash's escaped character: find -exec rm
// -rf {} \;) is the shell's, not a \ root: joined or replaced before the split, as is PowerShell's ` continuation. The
// cost: a PowerShell \ root with more lines after it is not seen (a \ that ends the command still blocks).
const SHELL_ESCAPES = (text) => text.replace(/[\\`]\r?\n/g, ' ').replace(/\\[;&|]/g, '_');
const inOneSegment = (...parts) => {
  const res = parts.map((p) => new RegExp(p, 'i'));
  return { test: (text) => SHELL_ESCAPES(text).split(/[;&|\n]/).some((seg) => res.every((re) => re.test(seg))) };
};
const ROOT = String.raw`(?:[/\\]\*?|[a-z]:(?:[/\\]\*?)?|(?:~|\$home|\$env:userprofile)(?:[/\\]\*?)?)`;
const ROOT_ARG = String.raw`[ \t,]["']?${ROOT}["']?(?=[\s,)]|$)`;
const DRIVE_ARG = String.raw`[ \t]["']?(?:[a-z]:(?:[/\\]\*?)?|\\\*)["']?(?=[\s)]|$)`;
const RECURSE = String.raw`[ \t](?:-[fvi]*r[fvi]*|-re(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?|--recursive|/{1,2}s)(?::\$true)?(?=[\s)]|$)`;
const SLASH_S = String.raw`[ \t]/{1,2}s(?=[\s)"']|$)`;

// Linear forms of the base rules shaped /first[^;&|\n]*then/ (or /first.*then/, one line): the first match of first in
// each piece, then one search for then after it. Same answer (a later match of first only sees less of its piece), but
// such a regex rescans the piece from every match of first: 4 s on 40,000 "mv" words, minutes on "git push" repeated,
// and a hook that runs past its timeout is the one way a fail-closed guard still fails open.
const SEGMENTS = /[^;&|\n]+/g;
const LINES = /.+/g; // the reach of .* : up to a line terminator
const thenLater = (pieces, first, then) => {
  const a = new RegExp(first, 'i');
  const b = new RegExp(then, 'i');
  return { test: (text) => (text.match(pieces) ?? []).some((s) => { const m = a.exec(s); return m !== null && b.test(s.slice(m.index + m[0].length)); }) };
};
// git ... push in one segment, then after that push main or master and a force flag (or a +refspec naming main/master)
const MAIN_WORD = /\b(?:main|master)\b/i;
const FORCE_FLAG = /--force|[ \t]-[a-z]*f[a-z]*\b/i;
const forcesMain = (rest) => MAIN_WORD.test(rest)
  && (FORCE_FLAG.test(rest) || rest.split(/\s+/).some((t) => t.includes('+') && MAIN_WORD.test(t.slice(t.indexOf('+') + 1))));
const FORCE_PUSH_MAIN = { test: (text) => (text.match(SEGMENTS) ?? []).some((seg) => {
  const g = /\bgit\b/i.exec(seg);
  const p = g && /\bpush\b/i.exec(seg.slice(g.index + 3));
  return !!p && forcesMain(seg.slice(g.index + 3 + p.index + 4));
}) };
// a download, the first | after it in its ; & newline segment, then iex: the parts between pipes
const DOWNLOAD = /(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b/i;
const TO_IEX = /^[ \t]*(?:Invoke-Expression|iex)\b/i;
const DOWNLOAD_TO_IEX = { test: (text) => text.split(/[;&\n]/).some((seg) => {
  const parts = seg.split('|');
  return parts.some((part, k) => k + 1 < parts.length && TO_IEX.test(parts[k + 1]) && DOWNLOAD.test(part));
}) };
// rm, then its option words (each -[a-z-]+, read one way), one of them recursive, then a / ~ target. The base regex,
// \brm[ \t]+(?:--?[a-z-]+[ \t]+)*(?:-[a-z]*r[a-z]*|--recursive)(?:[ \t]+--?[a-z-]+)*[ \t]+ then the target, read --a two
// ways (rm --a --a ...: 2^n) and retried every rm inside an option run (-rm -rm ...: count x length). Here each run is
// read once: an rm start inside it (-rm) ends at the same word with a subset of its flags, so it cannot match either.
const RM_RUN = /\brm[ \t]+((?:-[a-z-]+[ \t]+)*)/gi;
const RECURSIVE_WORD = /^(?:-[a-z]*r[a-z]*|--recursive)$/i;
const ROOT_TARGET = /["']?(?:\/\*?|~(?:\/\.?\*)?\/?)(?=["'\s;&|)]|$)/iy;
const RM_ROOT = { test: (text) => {
  for (const m of text.matchAll(RM_RUN)) {
    if (!m[1] || !m[1].split(/[ \t]+/).some((x) => RECURSIVE_WORD.test(x))) continue;
    ROOT_TARGET.lastIndex = m.index + m[0].length;
    if (ROOT_TARGET.test(text)) return true;
  }
  return false;
} };

const PATTERNS = [
  // recursive rm (any flag order, -r/-R/--recursive, with or without -f; a non-TTY rm -r never prompts);
  // the target is a bare / /* ~ ~/ ~/* ~/.* (also quoted), not ~/tmp/x
  ['rm -rf /', RM_ROOT],
  ['mkfs.', String.raw`\bmkfs\.`],
  ['dd of=/dev/', thenLater(LINES, String.raw`\bdd[ \t]+if=`, String.raw`\bof=/dev/`)], // was \bdd[ \t]+if=.*\bof=/dev/
  ['fork bomb', String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`],
  ['chmod -R 777 /', String.raw`\bchmod[ \t]+-R[ \t]+777[ \t]+/`],
  // one command segment: "git mv a b && x > /dev/null" is fine (was \bmv[ \t][^;&|\n]*[ \t]/dev/null)
  ['mv to /dev/null', thenLater(SEGMENTS, String.raw`\bmv[ \t]`, String.raw`[ \t]/dev/null`)],
  // was \b(?:wget|curl)[ \t].*\|[ \t]*(?:sudo[ \t]+)?(?:ba)?sh\b
  ['pipe to shell', thenLater(LINES, String.raw`\b(?:wget|curl)[ \t]`, String.raw`\|[ \t]*(?:sudo[ \t]+)?(?:ba)?sh\b`)],
  // a power-off word as a command or argument, not inside a file name (graceful-shutdown.ts, shutdown.test.ts)
  // (a trailing dot is a file name unless it is .exe or .target: shutdown.exe, reboot.target)
  ['shutdown', String.raw`(?<![\w.-])shutdown(?![\w/-])(?!\.(?!(?:exe|target)\b))`],
  ['reboot', String.raw`(?<![\w.-])reboot(?![\w/-])(?!\.(?!(?:exe|target)\b))`],
  ['init 0/6', String.raw`\binit[ \t]+[06]\b`],
  ['format c:', String.raw`\bformat[ \t]+c:`],
  ['del c:', String.raw`\bdel[ \t]+/f[ \t]+/s[ \t]+/q[ \t]+c:`],
  // one segment only (was \bgit\b[^;&|\n]*\bpush\b(?=[^;&|\n]*(?:--force|[ \t]-[a-z]*f[a-z]*\b|\+\S*\b(?:main|master)\b))
  // (?=[^;&|\n]*\b(?:main|master)\b))
  ['git push --force main', FORCE_PUSH_MAIN],
  ['git reset --hard', thenLater(SEGMENTS, String.raw`\breset\b`, String.raw`--hard\b`)], // was \breset\b[^;&|\n]*--hard\b
  ['> /dev/sda', String.raw`>[ \t]*/dev/sd[a-z]`],
  ['--no-preserve-root', String.raw`--no-preserve-root`],
  ['drop database', String.raw`\bdrop[ \t\n]+database\b`],
  ['drop table', String.raw`\bdrop[ \t\n]+table\b`],
  // PowerShell and cmd (#4002)
  ['cmd del/rd /s on a drive root', inOneSegment(String.raw`(?<![\w.-])(?:del|rd|rmdir)(?![\w.-])`, SLASH_S, DRIVE_ARG)],
  ['recursive Remove-Item on a root, drive or home folder',
    inOneSegment(String.raw`(?<![\w.-])(?:remove-item|ri|rd|rmdir|del|erase|rm)(?![\w.-])`, RECURSE, ROOT_ARG)],
  ['Stop-Computer', String.raw`(?<![\w-])stop-computer(?![\w-])`],
  ['Restart-Computer', String.raw`(?<![\w-])restart-computer(?![\w-])`],
  ['disk wipe (Format-Volume, Clear-Disk, Initialize-Disk, Remove-Partition)', String.raw`(?<![\w-])(?:format-volume|clear-disk|initialize-disk|remove-partition)(?![\w-])`],
  // was (?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget)\b[^;&|\n]*\|[ \t]*(?:Invoke-Expression|iex)\b
  ['download piped to Invoke-Expression', DOWNLOAD_TO_IEX],
].map(([name, re]) => [name, typeof re === 'string' ? new RegExp(re, 'i') : re]);

// Returns the name of the matched pattern, or null when the command is fine.
export function check(command) {
  const text = stripMessages(String(command ?? ''));
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? (killByName(text) ? KILL_BY_NAME : null);
}

// Kill by process name (#3809): a name stops every process that has it, other sessions' too. On 24 Nov one session's
// Get-Process node | Stop-Process killed the PC's job runner, its supervisor and every session's relay, twice.
// (pwsh 7.6 preview on the PC cannot load CIM, so its list and port commands run in Windows PowerShell or netstat)
const KILL_BY_NAME = `kill by process name: it stops every process with that name on this machine, other sessions' too (node: the board runner, supervisor and relays). A lookup by name (Get-Process node, pgrep, ps | grep, Win32_Process) feeding a stop counts too. Stop only yours, by PID: note it when you start the process (Start-Process -PassThru, or $! in bash), or list them with their command lines and pick yours (Git Bash: powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Format-List ProcessId, CommandLine"; in Windows PowerShell the inner command alone; from pwsh wrap it in powershell -NoProfile { ... }; Mac: pgrep -fl node), then stop it in the next command: Stop-Process -Id <pid> (Git Bash: taskkill //PID <pid>; Mac: kill <pid>). Or by the port it listens on: netstat -ano | findstr :<port> (the PID ends the LISTENING line), or on the Mac kill $(lsof -t -iTCP:<port> -sTCP:LISTEN); a port Docker publishes belongs to Docker: stop the container instead`;
// a command word as a name: no quotes, no path, lower case, no .exe (C:\Windows\System32\taskkill.exe is taskkill)
// (a leading ! too: herdr agent prompt w1 "!pkill node" runs pkill in that session)
const cmdName = (raw) => raw.replace(/["']/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '').replace(/^!/, '');
const KILL_WORDS = new Set(['stop-process', 'spps', 'kill', 'taskkill', 'killall', 'pkill', 'remove-ciminstance', 'terminate',
  'get-process', 'gps', 'ps', 'pgrep', 'pidof', 'tasklist', 'win32_process', 'wmic', 'lsof']);
const OTHER_TOOL = new Set(['docker', 'podman', 'nerdctl', 'kubectl', 'compose', 'pm2']); // docker ps, docker kill
const PS_BEFORE = new Set(['sudo', '$', 'xargs', 'exec', 'command', 'nohup', 'time', 'env']); // ps as the command
const NOT_RUN = new Set(['which', 'man', 'type', 'whereis', 'where', 'get-command', 'gcm', 'get-help', 'help', 'tldr']); // which pkill
const ARGS = 64; // a command's arguments are read this far: one pass over the words, not one per word
// pkill / pgrep limited to this shell's processes: a pid file (-F) or a parent PID (-P $$). A pattern is not enough:
// pkill -f relay.ts matches every session's relay, and the killer's own shell holds the pattern too.
// (-P 1 is not narrow: detached processes, relays among them, have parent 1)
const parentOk = (p) => p === '$$' || (/^\d+$/.test(p ?? '') && p !== '1');
const narrow = (args) => args.some((a, k) => /^(?:-F|--pidfile)(?:=|$)/.test(a)
  || (/^(?:-P|--parent)$/.test(a) && parentOk(args[k + 1])) || parentOk(/^(?:-P|--parent=)(.+)$/.exec(a)?.[1]));
// options whose next word is their value, not a PID: PowerShell's common ones (-ea 0, -ErrorAction SilentlyContinue,
// -OutBuffer 1), -InputObject, kill -s 9 / -n 9, taskkill /S /U /P
const VALUE_OPT = /^(?:-(?:ea|ev|wa|wv|ov|ob|pv|iv|infa|proga|erroraction|errorvariable|warningaction|warningvariable|outvariable|outbuffer|pipelinevariable|informationaction|informationvariable|progressaction|inputobject|s|n)|(?:\/\/?|-)(?:s|u|p))$/i;
// a stop that names its PIDs (Stop-Process -Id 1234 -ErrorAction SilentlyContinue, -Id:1234, kill -s TERM 1234,
// taskkill /PID 1234 /F): option values skipped, every other word a PID or a switch, at least one PID
function literalPids(args) {
  let pids = 0;
  for (let k = 0; k < args.length; k++) {
    const x = args[k];
    if (/^-id:\d+(?:,\d*)*$/i.test(x)) pids++;
    else if (x === '@') continue; // -Id @(1234,5678)
    else if (VALUE_OPT.test(x)) k++;
    else if (/^(?:-|\/\/?[a-z])/i.test(x)) continue; // a switch: -Force, -9, /F
    else if (/^\d+(?:,\d*)*$/.test(x)) pids++;
    else return false;
  }
  return pids > 0;
}

// Fails closed like the patterns: a command word anywhere counts, and a quoted command (powershell "...", ssh host '...',
// "$(pgrep node)") is read as a command too. Blocks a kill that names the image (Stop-Process -Name, taskkill /IM or a
// filter other than PID eq, killall, pkill), and a by-name lookup feeding a stop that does not name its PIDs: the lookup
// earlier in the command (Get-Process node | Stop-Process, $p = Get-Process node; $p | Stop-Process) or inside the
// stop's arguments (kill $(pgrep node), Stop-Process -Id (Get-Process node).Id). A lookup after the stop is a check
// (kill $PID; ps aux | grep mock). Get-Process -Id and ps -p are not by-name lookups. text has had its messages
// stripped already (check).
function killByName(text) {
  const joined = text.replace(/`\r?\n/g, ' ').replace(/\\\r?\n/g, ' ').replace(/`/g, ' $ ');
  return scanKills(joined, { lookup: false, stop: false }, false);
}

// a single-clause ProcessId filter names one process: -Filter "ProcessId=1234", where processid=1234 (not "... OR ProcessId=1")
const oneProcess = (w) => w.some((x) => /^\s*processid\s*=\s*\S+\s*$/i.test(x))
  || (/\bprocessid\s*=\s*\d+\b/i.test(w.join(' ')) && !/\b(?:or|and)\b/i.test(w.join(' '))); // where ProcessId = 1234
// a segment for kills also ends at a brace: a stop's arguments never run into the next block (if/else, try/catch)
const KILL_SEGMENT = new RegExp(String.raw`(?:${QUOTED}|\\.|[^;&|\n{}"'\\])+`, 'g');
// cmd /c "taskkill" ..., bash -c, pwsh -Command: after a shell, the next word runs (grep -c "kill" is grep's)
const RUNS_NEXT = new Set(['c', 'k', '-c', '-command']);
const SHELLS = new Set(['cmd', 'bash', 'sh', 'zsh', 'pwsh', 'powershell']);
const TERMINATE_AFTER = new Set(['-methodname', '-name', 'call', '=', 'methodname']); // Invoke-CimMethod -Name Terminate, splats
// -InputObject and its abbreviations down to -Inp (-In is ambiguous), colon-bound too: -Inp (...), -InputObject:(...)
const INPUT_OBJECT = /^-inp(?:u(?:t(?:o(?:b(?:j(?:e(?:c(?:t)?)?)?)?)?)?)?)?:?$/;
// built-in cmdlets whose -InputObject only reads or shows it (Format-Table -InputObject (Get-Process node) after a stop
// is a check). Any other cmdlet's -InputObject after a stop fails closed: ForEach-Object, Where-Object, Start-Job and
// Measure-Command run a block on it ($sb = { $input | Stop-Process }; Start-Job -ScriptBlock $sb -InputObject (...)).
// Names, not wildcards: function Out-Kill { ... } is a user's. Several run a -Property / -GroupBy block or an @{e=...}
// calculated property, so readsInput also needs no $ word in the arguments and no { right after the segment.
const READS_INPUT = /^(?:format-(?:table|list|wide|custom)|f[tlwc]|out-(?:file|string|null|host|default|gridview|printer)|measure-object|measure|select-object|select|get-member|gm|sort-object|sort|group-object|group|convertto-(?:json|csv|xml|html)|export-(?:csv|clixml)|write-output|write|echo|write-host|tee-object|tee|compare-object|compare)$/;
// a segment after a block's closing brace that starts another branch, or a do loop's condition: its words are not that
// block's arguments (Stop-Process -Id $id; do { Start-Sleep 1 } while (Get-Process node))
const DEFINES = new Set(['function', 'filter', 'set-alias', 'new-alias', 'sal', 'nal']);
const BRANCH = new Set(['else', 'elseif', 'catch', 'finally', 'while', 'until']);

// a stop's arguments end at a redirection
const stopArgs = (rest) => { const cut = rest.findIndex((x) => /^\d*[<>&]/.test(x)); return cut >= 0 ? rest.slice(0, cut) : rest; };
const dryRun = (rest) => rest.some((x) => /^-whatif(?::\$true)?$/i.test(x));
// a stop's options that name the image: Stop-Process -Name, kill -n node (PowerShell's kill is Stop-Process; bash's kill
// -n takes a signal number), taskkill /IM or a filter other than PID eq <number>, $name or ${name}; kill -9 -1,
// kill -- -1: every process you own (kill -1 1234 is SIGHUP to 1234)
function namesImage(n, rest) {
  if ((n === 'stop-process' || n === 'spps') && rest.some((x) => /^-(?:n|processn)[a-z]*(?::|$)/i.test(x))) return true;
  if (n === 'kill' && rest.some((x, k) => /^-(?:name|processname)(?::|$)/i.test(x) || (/^-n[a-z]*$/i.test(x) && !/^\d+$/.test(rest[k + 1] ?? '')))) return true;
  if (n === 'taskkill' && rest.some((x, k) => /^(?:\/\/?|-)im$/i.test(x)
    || (/^(?:\/\/?|-)fi$/i.test(x) && !/^\s*pid\s+eq\s+(?:\d+|\$\w+|\$\{\w+\})\s*$/i.test(rest[k + 1] ?? '')))) return true;
  return n === 'kill' && rest.some((x, k) => k > 0 && x === '-1' && !/^-[sn]$/.test(rest[k - 1]));
}

// seen.lookup / seen.stop: a by-name lookup, or a stop, came earlier in the command; seen.splat: a Terminate named in a
// hashtable (@{ MethodName = 'Terminate'; Query = ... }), whose query can come after it; inArgs: this text is inside a
// stop's arguments
function scanKills(text, seen, inArgs) {
  // the } that closes a ${...}, and whether the text before that ${ was a block's arguments or a stop's, and which stop
  // (they carry past the ${...})
  let dollarClose = -1, dollarAfter = false, lastAfter = false, dollarArgs = false, lastArgs = false;
  let dollarStop = null, lastStop = null;
  for (const m of text.matchAll(KILL_SEGMENT)) {
    const raw = m[0].match(WORD) ?? [];
    const w = raw.map(unquote);
    const name = raw.map(cmdName);
    let argsEnd = -1; // the last word of a stop's arguments in this segment
    let openStop = null; // the stop those arguments are for
    // once per segment, not once per word (#4002: per word, both re-read the whole segment: 200 KB took 7 to 16 s)
    let one; // oneProcess(w): the segment's ProcessId filter names one process
    const isOne = () => (one ??= oneProcess(w));
    // the segment's command, past an assignment ($r = Measure-Object ...), only reads its -InputObject
    let reads;
    const readsInput = () => (reads ??= (() => {
      const k = name.findIndex((x) => !x.startsWith('$') && x !== '=');
      return k >= 0 && !seen.defines && READS_INPUT.test(name[k]) && !w.slice(k + 1).some((x) => x.includes('$')) && text[m.index + m[0].length] !== '{';
    })());
    // right after a block's closing brace, not another branch: & { Stop-Process -Id $args } (Get-Process node).Id,
    // Invoke-Command { ... } -ArgumentList (...), ForEach-Object { ... } -InputObject (...). The } of a parameter
    // expansion is no block (echo "stopped ${pid}, left: $(pgrep -c node)"): after it, the text before its ${ decides
    // (& { Stop-Process -Id $ids } ${x} (Get-Process node).Id; & { Stop-Process -Id $ids; ${x}} (Get-Process node).Id)
    const afterDollar = text[m.index - 1] === '}' && m.index - 1 === dollarClose;
    const afterBlock = afterDollar ? dollarAfter : text[m.index - 1] === '}' && !BRANCH.has(name[0]);
    const inDollar = text[m.index - 1] === '{' && text[m.index - 2] === '$'; // this segment is the inside of ${...}
    if (inDollar) {
      dollarClose = text[m.index + m[0].length] === '}' ? m.index + m[0].length : -1;
      dollarAfter = lastAfter;
      dollarArgs = lastArgs;
      dollarStop = lastStop;
    }
    lastAfter = afterBlock;
    // a stop's arguments run on through a ${...} and past it (#4436): kill -9 ${MAIN_PID} $(pgrep -f relay),
    // Stop-Process -Id ${pid}, (Get-Process node).Id, kill ${x:-$(pgrep node)}. Only the single-segment ${name} counts
    // as closed (above); bash and PowerShell end a nested one differently, so any other } stays a block's close.
    const segArgs = inArgs || ((inDollar || afterDollar) && dollarArgs);
    const segStop = inDollar || afterDollar ? dollarStop : null;
    // ... its options too: taskkill //PID ${PID} //IM node.exe, Stop-Process -Id ${pid} -Name node, kill -s ${SIG} -1
    if (afterDollar && segStop) {
      const rest = stopArgs(['$', ...w.slice(0, ARGS)]);
      if (!dryRun(rest) && namesImage(segStop, rest)) return true;
    }
    let fed = false; // an earlier word feeds stdin: < <(...), done < ..., done <<< ... (a here-string, glued or not)
    let shell = false; // an earlier word of the segment is a shell: powershell -NoProfile -ExecutionPolicy Bypass -Command
    for (let i = 0; i < w.length; i++) {
      if (i > 0 && (((w[i - 1] === '<' || w[i - 1] === '<<<') && (w[i - 2] === '<' || name[i - 2] === 'done'))
        || (name[i - 1] === 'done' && w[i].startsWith('<<<')))) fed = true;
      const args = segArgs || i <= argsEnd;
      // a quoted here-string of a lookup is fed to the loop's earlier stop: done <<< "$(pgrep node)"
      if (/["']/.test(raw[i]) && /[\s;&|]/.test(w[i]) && scanKills(stripMessages(w[i]), seen, args || (fed && seen.stop))) return true;
      const n = name[i], prev = name[i - 1];
      // CIM/WMI Terminate, quoted or not: Invoke-CimMethod -MethodName "Terminate", -Name Terminate, @{ MethodName = 'Terminate' }
      // (-MethodName:Terminate too); its arguments, like any stop's, hold its source: -MethodName Terminate -Query "..."
      if ((n === 'terminate' && TERMINATE_AFTER.has(prev)) || /^(?:-(?:method)?name:|methodname=)terminate$/.test(n)) {
        if (seen.lookup) return true;
        seen.stop = true;
        if ((prev === '=' && name[i - 2] === 'methodname') || n === 'methodname=terminate') seen.splat = true;
        argsEnd = Math.max(argsEnd, Math.min(w.length - 1, i + ARGS));
        continue;
      }
      // a quoted word is an argument (Select-String "kill"), unless it is the command: & 'taskkill' /IM node.exe, or
      // the word after a shell's -c / -Command / /c, with the shell's options between (cmd /d /c "taskkill" /IM node.exe)
      if (/^["']/.test(raw[i]) && i > 0 && !PS_BEFORE.has(prev) && !(RUNS_NEXT.has(prev) && shell)) { shell ||= SHELLS.has(n); continue; }
      shell ||= SHELLS.has(n);
      if (DEFINES.has(n)) seen.defines = true; // function Format-Table { ... }, Set-Alias ft Stop-Process
      if (!KILL_WORDS.has(n) && !/\.(?:kill|terminate|foreach)$/.test(n) && !n.includes('getprocessesbyname')) continue;
      if (NOT_RUN.has(prev) || (prev === '-v' && name[i - 2] === 'command')) continue; // which pkill, command -v pkill
      const rest = stopArgs(w.slice(i + 1, i + 1 + ARGS));
      if (/^--(?:help|version)$/.test(rest[0] ?? '') || dryRun(rest)) continue;
      if (namesImage(n, rest)) return true;
      if (n === 'killall' || (n === 'pkill' && !narrow(rest))) return true;
      const byId = rest.some((x) => /^(?:-id|-p|--pid|-q)(?::|=|$)/i.test(x) || (n === 'ps' && /^-[a-zA-Z]*p\d*$/.test(x))); // ps -fp $PID
      const lookup = ((n === 'get-process' || n === 'gps' || (n === 'ps' && (prev === undefined || PS_BEFORE.has(prev)))) && !byId)
        || (n === 'pgrep' && !narrow(rest)) || n === 'pidof' || n === 'tasklist'
        || (n === 'win32_process' && !isOne()) || (n === 'wmic' && /^process$/i.test(rest[0] ?? '') && !isOne())
        || (n === 'lsof' && rest.some((x) => /^-c/.test(x))) // lsof -c node
        || n.includes('getprocessesbyname');
      // inside a stop's arguments, or fed to an earlier stop's input: xargs kill < <(pgrep node), done < <(pgrep node);
      // after the closing brace of a block that stops; the -InputObject of a cmdlet that may run a block on it
      // ($sb = { Stop-Process ... }; ForEach-Object $sb -InputObject (Get-Process node)), not of one that only reads it
      if (lookup) {
        if (args || (seen.stop && (fed || afterBlock || (INPUT_OBJECT.test(prev ?? '') && !readsInput())))) return true;
        if (seen.splat && n === 'win32_process') return true; // @{ MethodName = 'Terminate'; Query = "... Win32_Process ..." }
        seen.lookup = true;
      }
      const stop = ((n === 'stop-process' || n === 'spps' || n === 'taskkill' || n === 'remove-ciminstance'
        || (n === 'kill' && !OTHER_TOOL.has(prev))) && !literalPids(rest))
        || /\.(?:kill|terminate)$/.test(n)
        || (/\.foreach$/.test(n) && /^(?:kill|terminate)$/i.test(w[i + 1] ?? '')) // (Get-Process node).ForEach('Kill')
        || (n === 'wmic' && rest.some((x) => /^delete$/i.test(x)))
        // a pid file or parent the shell fills in: pkill -F <(pgrep node); its arguments run to the segment's end
        || (n === 'pkill' && w.slice(i + 1, i + 1 + ARGS).some((x) => x === '<' || (x.includes('$') && x !== '$$')));
      if (stop) {
        if (seen.lookup) return true;
        seen.stop = true;
        // to the window's end, past a redirection: kill 2>/dev/null $(pgrep node)
        argsEnd = Math.max(argsEnd, n === 'pkill' ? w.length : Math.min(w.length - 1, i + ARGS));
        openStop = n;
      }
    }
    const endsInArgs = argsEnd >= 0 && argsEnd >= w.length - 1; // the segment ends inside a stop's arguments
    lastArgs = segArgs || endsInArgs;
    lastStop = endsInArgs && openStop ? openStop : segStop;
  }
  return false;
}

// Protected branches (#3746): a squad session's pane carries CB_PROTECTED_BRANCHES (cb squad up), and a git push whose
// destination is one of them is blocked. Unset or empty: no check at all.
const GIT_OPT_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source']); // git -C <path> push
const PUSH_OPT_ARG = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']); // git push -o ci.skip ...
// a list entry with * is a glob: * is any run of characters, / included; the rest is literal; the whole name must match
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const globRe = (e) => new RegExp(`^${e.split('*').map(literal).join('.*')}$`);

// Shell-ish splitting, quote-aware: a quoted run (with \" inside "...") never ends a command or a word.
// Segments end at ; & | newline and at a brace outside quotes (#4002: a PowerShell script block { ... } is read on its
// own, so a push's arguments never run into the next block); words end at whitespace and ( ) { } outside quotes.
const SEGMENT = KILL_SEGMENT;
const WORD = new RegExp(String.raw`(?:${QUOTED}|\\.|[^\s(){}"'\\])+`, 'g');
// one layer of quoting off, as the shell does: "..." (\" \\ \$ \` inside unescaped), '...' as is, \x outside quotes.
// The regex is built once, and a word with no quote or backslash is returned as is (the replace would change nothing):
// every scan unquotes every word, so this is most of a scan's cost on a long command.
const UNQUOTE = new RegExp(String.raw`"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)`, 'g');
const unquote = (w) => (/["'\\]/.test(w)
  ? w.replace(UNQUOTE, (_all, dq, sq, esc) => (dq !== undefined ? dq.replace(/\\(["\\$`])/g, '$1') : sq ?? esc))
  : w);

// Which quoted words (holding a space or a separator) a scan reads as commands, one layer of quotes off.
// EVERY_QUOTED, for the dangerous and protected-branch scans and the role rules' main/master check: all of them (fail
// closed: echo "git push origin development" blocks). runnerArg, for the other role rules (#4002): only what a shell
// runs, so grep -rn "git push" docs and git log --grep "git commit" are text to a reviewer or a builder:
// - the argument of bash, sh, zsh or su -c; cmd /c or /k;
// - anything after pwsh or powershell (-c, -Command or a positional script), ssh, eval, xargs, iex or Invoke-Expression;
// - a herdr prompt starting with ! (it runs there);
// - any quoted text in a pipeline stage whose output goes on to a shell or iex (| sh, | sudo bash, | pwsh -, | cmd, | iex);
// - a double-quoted string the shell expands ("$(...)", `...`).
// Each is built once per segment (the earlier words' names become prefix flags, so a long segment stays linear) and
// answers for word i.
const EVERY_QUOTED = () => () => true;
const SHELL_C = new Set(['bash', 'sh', 'zsh', 'su']);
const RUNS_REST = new Set(['ssh', 'eval', 'xargs', 'iex', 'invoke-expression', 'pwsh', 'powershell']);
const PIPE_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression']);
function runnerArg(raw, w, name, piped) {
  const seen = []; // seen[k]: which runners are among the names of words 0 .. k-1
  let s = { shellC: false, cmd: false, herdr: false, rest: false };
  for (const n of name) {
    seen.push(s);
    s = { shellC: s.shellC || SHELL_C.has(n), cmd: s.cmd || n === 'cmd', herdr: s.herdr || n === 'herdr', rest: s.rest || RUNS_REST.has(n) };
  }
  return (i) => {
    if (piped) return true;
    if (raw[i].includes('"') && /\$\(| \$ /.test(w[i])) return true; // " $ " is a backtick substitution (scanCommands)
    const flag = (w[i - 1] ?? '').toLowerCase();
    const before = seen[Math.max(0, i - 1)]; // the words before the flag
    if (/^-(?:[a-z]*c|co|com|comm|comma|comman|command)$/.test(flag) && before.shellC) return true;
    if (/^\/\/?[ck]$/.test(flag) && before.cmd) return true;
    if (/^["']!/.test(raw[i]) && seen[i].herdr) return true;
    return seen[i].rest;
  };
}

// A segment with more than this many words naming the scanned command (git, gh, az) is blocked, not read: each one's
// arguments run to the segment's end, so reading them all costs (count x length), and a check that runs past the hook's
// timeout lets the command through. No hand-typed command comes near it; the block tells the agent to split it.
const MAX_COMMANDS_PER_SEGMENT = 16;

// A word's command name in a scan for names: cmdName of the raw word, which reads a backslash as a path separator, or,
// when that is none of them, of the unquoted word: bash drops a backslash before an ordinary letter, so g\it is git (#4729)
function scannedName(raw, names) {
  const name = cmdName(raw);
  if (names.has(name) || !raw.includes('\\')) return name;
  const escaped = cmdName(unquote(raw));
  return names.has(escaped) ? escaped : name;
}

// Calls fn(w, i) for every word i whose command name (cmdName of the raw word: C:\...\git.exe, GIT.EXE, !git) is in
// names; returns its first non-null. Message text is ignored (stripMessages); a line continuation joins its lines (bash
// \ and PowerShell `, #4002); a backtick substitution counts as $ (and its inner command stays a command); a quoted
// command (bash -c "...", ssh host '...') is read as a command too when quoted says so. Throws past
// MAX_COMMANDS_PER_SEGMENT (evaluate turns that into a block).
function scanCommands(cmd, names, fn, quoted = EVERY_QUOTED) {
  const text = stripMessages(String(cmd ?? '')).replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ').replace(/`/g, ' $ ');
  const segs = [...text.matchAll(SEGMENT)].map((m) => {
    const raw = m[0].match(WORD) ?? [];
    return { start: m.index, end: m.index + m[0].length, raw, name: raw.map((x) => scannedName(x, names)) };
  });
  // piped[k]: segment k's output goes on, through | or |& (not ||), to a stage a shell or iex runs.
  // into[k]: what is piped into segment k reaches one: ANY word of k names one (so env bash, command bash, sudo -u x bash,
  // exec, nohup and xargs bash -c all count, with no wrapper list; one pass over the words), or k is blank and a newline carries the pipeline on
  // (a pipe may end a line; a CRLF or trailing blanks leave a blank segment). An & right after > or < is a redirection
  // (2>&1), not a new command, so the segment before it shares the next one's flag.
  const piped = segs.map(() => false);
  const into = segs.map(() => false);
  for (let k = segs.length - 1; k >= 0; k--) {
    const gap = k + 1 < segs.length ? text.slice(segs[k].end, segs[k + 1].start) : null;
    into[k] = segs[k].name.some((n) => PIPE_RUNNERS.has(n)) || (segs[k].raw.length === 0 && /^\n+$/.test(gap ?? '') && into[k + 1]) ||
      // a brace ends a segment, not the stage: xargs -I{} bash -c {}
      (/^[{}]+$/.test(gap ?? '') && into[k + 1]);
    if (gap === null) continue;
    if (/^\|&?\n*$/.test(gap)) piped[k] = into[k + 1] || piped[k + 1];
    else if (gap === '&' && /[<>]$/.test(text.slice(segs[k].start, segs[k].end))) piped[k] = piped[k + 1];
  }
  for (const [k, { raw, name }] of segs.entries()) {
    const w = raw.map(unquote);
    const hits = name.filter((n) => names.has(n)).length;
    if (hits > MAX_COMMANDS_PER_SEGMENT) {
      throw new Error(`${hits} ${[...names].join('/')} commands in one command segment are more than the guard reads (${MAX_COMMANDS_PER_SEGMENT}): split the command`);
    }
    const isCommand = quoted(raw, w, name, piped[k]);
    for (let i = 0; i < w.length; i++) {
      if (/["']/.test(raw[i]) && /[\s;&|]/.test(w[i]) && isCommand(i)) {
        const inner = scanCommands(w[i], names, fn, quoted);
        if (inner) return inner;
      }
    }
    for (let i = 0; i < w.length; i++) {
      if (!names.has(name[i])) continue;
      const hit = fn(w, i);
      if (hit) return hit;
    }
  }
  return null;
}
const GIT = new Set(['git']);
// the index of git's subcommand: past git's own options (git -C <path> -c k=v push)
function gitSub(w, i) {
  let j = i + 1;
  while (j < w.length && w[j].startsWith('-')) j += GIT_OPT_ARG.has(w[j]) ? 2 : 1;
  return j;
}
// a push's words (remote, then refspecs) and options, from the word after push
function pushArgs(w, j) {
  const words = [], opts = [];
  let del = false;
  for (j++; j < w.length; j++) {
    const x = w[j];
    if (/^\d*[<>]/.test(x)) { if (/^\d*[<>]+$/.test(x)) j++; continue; } // a redirection, and its file when apart
    if (!x.startsWith('-')) { words.push(x); continue; }
    opts.push(x);
    if (x === '--delete' || /^-\w*d\w*$/.test(x)) del = true;
    else if (PUSH_OPT_ARG.has(x)) j++; // -o <value>; --push-option=<value> is one word
  }
  return { words, opts, del };
}
// each refspec's destination: dst of src:dst (:dst too), a bare src itself, and under --delete the word as given
const destination = (r, del) => { const s = r.replace(/^\+/, ''); return del || !s.includes(':') ? s : s.slice(s.lastIndexOf(':') + 1); };

// The protected branch a git push in cmd writes to, or null. A git ... push anywhere in a segment counts, like the
// patterns above, so it fails closed (echo git push origin development blocks). A branch the shell fills in ($B, $(...),
// backticks) cannot be checked: that word is returned, so it blocks too. So is a wildcard destination (refs/heads/*,
// develop*): it can write a protected branch.
export function protectedPush(cmd, list) {
  if (!list.length) return null;
  const hit = (b) => list.some((e) => (e.includes('*') ? globRe(e).test(b) : e === b));
  const text = unbrace(cmd); // #4661: once, for both scans
  return scanCommands(text, GIT, (w, i) => {
    const j = gitSub(w, i);
    if (w[j] !== 'push') return subtreePush(w, j, hit); // #4661 S1
    const { words, del } = pushArgs(w, j);
    // the shell fills in a $ word: the branch is unknown here. The remote too: an unquoted $R can split into two words
    const filled = words.find((x) => x.includes('$'));
    if (filled) return filled;
    // the first word is the remote; each refspec's destination without a leading + or refs/heads/ (or heads/, which git
    // reads the same)
    for (const r of words.slice(1)) {
      const to = destination(r, del);
      if (to.includes('*')) return to; // a wildcard refspec writes every branch it matches: protected ones too (C11)
      const dst = to.replace(/^(?:refs\/)?heads\//, '');
      if (hit(dst)) return dst;
    }
    return null;
  }) ?? hiddenPushes(text, hit, list); // #4661 S1: git $S / an alias naming the branch; B1: a setting's command
}

// The block reason for a protectedPush hit.
function pushReason(branch) {
  if (branch.startsWith(ALIAS_MARK)) return aliasReason(branch); // #4661
  return branch.includes('$')
    ? `git push to a branch the shell fills in (${branch}) while branches are protected: name the branch literally, e.g. git push -u origin feat/my-card`
    : branch.includes('*')
      ? `git push to a wildcard destination (${branch}) while branches are protected: push one branch by name, e.g. git push -u origin feat/my-card`
      : `git push to protected branch ${branch}: push your own branch and open a PR; the lead merges it`;
}

// Role rules (#4002), the same for every agent (they replace the push globs in kit/permissions/*.json):
// every role: main/master are protected; no force push, --mirror/--all, HEAD or @ as the destination, or a push that
// names no branch. Every role but the lead: no PR merges (gh pr merge; az repos pr complete, auto-complete or
// bypass-policy). Read-only roles: no commits and no pushes at all (and no edits, in evaluate).
const FORCE_OPT = /^(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease|-if-includes)?(?:=.*)?)$/;
const EVERY_BRANCH_OPT = /^--(?:mirror|all|branches)$/;
const GH = new Set(['gh']);
const GH_OPT_ARG = /^(?:-R|--repo|--hostname)$/;
const AZ = new Set(['az']);
const AZ_OPT_ARG = /^(?:-o|--output|--query|--subscription)$/;
const MERGES_PR = (x) => /^(?:--status=)?completed?$/i.test(x) || /^--(?:auto-complete|bypass-policy)(?:=|$)/i.test(x);
const NAME_IT = 'e.g. git push -u origin feat/my-card';
const LEAD_MERGES = 'only the lead merges pull requests: open the PR and tell the lead (cb tell)';
const readsOnly = (role) => `a ${role} session reads and reports; post what you found on the board (cb log, cb tell)`;
// past a command's options (skipping the values of the ones in valueOpt) from index j
function pastOpts(w, j, valueOpt) {
  while (j < w.length && w[j].startsWith('-')) j += valueOpt.test(w[j]) ? 2 : 1;
  return j;
}

// #4638 (PR 99 review): spellings past the commit, push and merge rules, which read git's subcommand and gh pr merge.
// An alias renames a subcommand, so git -c alias.c=commit c commits and git -c alias.p=push p origin main pushes main
// unseen: every role, an alias or include (a file that can hold one) set for the call (-c, --config-env, GIT_CONFIG_*
// before git) or written to git config is blocked. send-pack and http-push push past git push's branch rules. A read-only
// role also writes no commit or ref by plumbing (commit-tree, update-ref, mktree, mktag, write-tree, fast-import,
// hash-object -w), and runs git only by its subcommands' own names where git is the command: an alias from a config
// file the guard cannot see (git ci) or a subcommand the shell fills in (git $SUB) blocks.
const ALIAS_KEY = /^(?:alias|include|includeif)\./i;
const CONFIG_NULL = /^(?:\/dev\/null|nul|\$null)$/i;
const RO_GIT_WRITES = new Set(['commit', 'commit-tree', 'update-ref', 'mktree', 'mktag', 'write-tree', 'fast-import']);
const ALIASES = 'an alias renames a git subcommand past the commit, push and merge rules: run git with the subcommand\'s own name';
// an assignment before git that sets an alias or include for the call: GIT_CONFIG_KEY_<n> or GIT_CONFIG_PARAMETERS naming
// one, or GIT_CONFIG / _GLOBAL / _SYSTEM pointing at a config file (other than the null device), which can hold one
function configEnvAlias(x) {
  const m = /^(GIT_CONFIG\w*|XDG_CONFIG_HOME)=(.*)$/is.exec(x);
  if (!m) return false;
  const k = m[1].toUpperCase();
  if (k === 'XDG_CONFIG_HOME') return true; // #4661 B3: git reads $XDG_CONFIG_HOME/git/config, which can hold an alias
  if (k === 'GIT_CONFIG_PARAMETERS' || /^GIT_CONFIG_KEY_\d+$/.test(k)) return /(?:^|['"\s])(?:alias|include|includeif)\./i.test(m[2]);
  return (k === 'GIT_CONFIG' || k === 'GIT_CONFIG_GLOBAL' || k === 'GIT_CONFIG_SYSTEM') && !CONFIG_NULL.test(m[2]);
}
// git's words w, git at i, its subcommand at j: the reason this call gets past the rules, or null
function gitHides(w, i, j, role, text) {
  for (let k = 0; k < i; k++) if (configEnvAlias(w[k])) return `${w[k].split('=')[0]} before git: ${ALIASES}`;
  for (let k = i + 1; k < j; k++) {
    const o = w[k];
    const cfg = o === '-c' || o === '--config-env' ? (w[k + 1] ?? '') : /^--config-env=/.test(o) ? o.slice(13) : null;
    if (cfg !== null && ALIAS_KEY.test(cfg)) return `git ${o.split('=')[0]} ${cfg.split('=')[0]}: ${ALIASES}`;
  }
  const runs = gitRuns(w, i, j, role, text); // #4661 L1: a setting or variable that runs a command
  if (runs) return runs;
  const sub = w[j];
  if (sub === undefined) return null;
  if (sub === 'config') {
    // git config [--global] alias.x <value>, git config set alias.x <value>: a key followed by a value is a write
    const pos = stopArgs(w.slice(j + 1)).filter((x) => !x.startsWith('-')); // to a redirection: --get alias.c 2>/dev/null reads
    if (pos.some((x, k) => ALIAS_KEY.test(x) && pos[k + 1] !== undefined)) return `git config writing an alias or include: ${ALIASES}`;
  }
  if (sub === 'send-pack' || sub === 'http-push') return `git ${sub} pushes past the branch rules: push with git push, ${NAME_IT}`;
  // #4661 S1: a subcommand the shell fills in can be push (S=push; git $S origin $B), for every role
  if ((isFilled(sub) || /[$`%]/.test(sub)) && isCommandWord(w, i)) return `git ${sub}: a subcommand the shell fills in can push past the branch rules: name the subcommand`;
  if (!READ_ONLY_ROLES.includes(role)) return null;
  if (RO_GIT_WRITES.has(sub) || (sub === 'hash-object' && w.slice(j + 1).some((x) => /^-[^-]*w/.test(x)))) return `git ${sub}: ${readsOnly(role)}`;
  // git as the command: first in its segment, or after assignments, launchers (sudo git ci) and $( (x=$(git ci))
  if (isCommandWord(w, i) && !GIT_COMMANDS.has(sub.toLowerCase())) {
    return `git ${sub} is not a git command (an alias, or a word the shell fills in): a ${role} runs git subcommands by their own names; ${readsOnly(role)}`;
  }
  return null;
}

// gh api (#4638): a call that writes, by an explicit method other than GET or HEAD or by a body (-f, -F, --field,
// --raw-field, --input make gh send POST), merges (pulls/<n>/merge, merges), moves refs (git/refs) or commits (contents,
// update-branch) past gh pr merge: every role but the lead. A graphql query given inline with no mutation in it is a read.
// gh alias set / import renames a command (gh m for pr merge) the same way.
// gh api's options: the long ones taking a value, the boolean ones; a short flag bundles as pflag reads it (-iX PUT,
// -iXPUT, -X=PUT). An option it does not know is judged a write (fail closed: it may take a value and shift the endpoint).
const GH_API_LONG_VALUE = new Set(['--header', '--jq', '--template', '--hostname', '--cache', '--preview']);
const GH_API_LONG_BOOL = new Set(['--paginate', '--slurp', '--include', '--silent', '--verbose', '--allow-escape-sequences', '--help']);
const GH_WRITES = 'gh api that writes (a method other than GET, or -f/-F/--input fields, which make gh POST) can merge, move a branch or commit past the merge rule: read with GET, comment with gh pr comment or gh pr review, and ' + LEAD_MERGES;
function ghApiWrites(w, j) {
  let method = null, body = false, unseen = false, endpoint = null;
  const fields = [];
  for (let k = j + 1; k < w.length; k++) {
    const x = w[k];
    if (/^\d*[<>]/.test(x)) continue; // a redirection
    if (x.startsWith('--')) {
      const eq = x.indexOf('='), name = eq < 0 ? x : x.slice(0, eq);
      const val = () => (eq < 0 ? (w[++k] ?? '') : x.slice(eq + 1));
      if (name === '--method') method = val();
      else if (name === '--field' || name === '--raw-field') { body = true; fields.push(val()); }
      else if (name === '--input') { body = true; unseen = true; val(); }
      else if (GH_API_LONG_VALUE.has(name)) val();
      else if (!GH_API_LONG_BOOL.has(name)) return true;
      continue;
    }
    if (x.startsWith('-') && x.length > 1) {
      for (let c = 1; c < x.length; c++) {
        const letter = x[c];
        if (letter === 'i') continue; // --include, the one boolean short flag
        const rest = x.slice(c + 1).replace(/^=/, '');
        const val = rest !== '' ? rest : (w[++k] ?? '');
        if (letter === 'X') method = val;
        else if (letter === 'f' || letter === 'F') { body = true; fields.push(val); }
        else if (!'Hqtp'.includes(letter)) return true;
        break;
      }
      continue;
    }
    endpoint ??= x;
  }
  if (/^(?:https?:\/\/[^/]+(?:\/api)?)?\/?graphql$/i.test(endpoint ?? '')) {
    // a read only with its query readable here: given inline (not a file or stdin), not a value the shell fills in (no
    // { in it), and no mutation anywhere
    const query = fields.filter((f) => /^query=/i.test(f));
    return unseen || query.length === 0 || fields.some((f) => /=@/.test(f)) || query.some((f) => !f.includes('{'))
      || w.slice(j + 1).some((x) => /\bmutation\b/i.test(x));
  }
  return method !== null ? !/^(?:get|head)$/i.test(method) : body;
}

// #4661 (PR 107 review S1, L1, L2): more ways past the push, commit and merge rules.
// - S1, every role: a git call whose subcommand the shell fills in (S=push; git $S origin $B: any, branch named or not)
//   or that is no git command (an alias already in a config file: git p origin main) and names main/master or a
//   protected branch later (read where a shell runs it, so echo "git is on main" is text); git
//   subtree push to one; and any write to a git config file (.git/config, a worktree's config, ~/.gitconfig,
//   ~/.config/git/config, /etc/gitconfig), which can add an alias. A git setting or variable that runs a command which
//   pushes (git -c core.pager='git push origin HEAD:main' log) too.
// - L1, read-only roles: no git setting or variable that runs a command (core.pager and pager.* other than a plain pager
//   or a switch, core.sshCommand, core.editor, diff.external, textconv, filter, credential.helper, gpg.program, merge
//   drivers, fsmonitor, hooksPath; GIT_PAGER/PAGER other than a plain pager, GIT_EXEC_PATH, GIT_SSH*, GIT_EXTERNAL_DIFF,
//   GIT_EDITOR, EDITOR ...; --exec-path=<dir>), and no git subtree push, add, merge or pull.
// - L2, every role but the lead: gh extension install / upgrade / exec, a gh word that is no gh command (an installed
//   extension or an alias runs its own code: gh merge 5), gh repo sync <repo> (moves a branch on GitHub), gh workflow run.
// A brace group with no space in it outside quotes (${S}, gh's {owner}) is read without its braces by the git and gh
// scans, or the brace ends the segment and hides the words after it (git ${S} origin main).
// PR 111 review R1: a group bash and zsh expand ({main,}, {a,b}, {1..3}) is never unbraced: it becomes a word the shell
// fills in ($BRACE_GROUP), so a push naming it blocks as a shell-filled branch, as git push origin $B does
// (no brace: the text as it is, one cheap test instead of a pass over a long command)
const BRACE_AT = new RegExp(String.raw`${QUOTED}|\{([^\s{}"']*)\}`, 'y');
const unbrace = (t) => (!String(t ?? '').includes('{') ? String(t ?? '') : replaceQuoted(String(t ?? ''),
  (m, inner) => (inner === undefined ? m : /,|\.\./.test(inner) ? '$BRACE_GROUP' : inner), BRACE_AT));
// word i is the command: first in its segment, or after assignments, launchers (sudo git p) and $( (x=$(git p)); after
// any launcher or a shell that runs the rest (timeout 30 git, sudo -u x gh, cmd /c git, B2)
const RUNS_REST_SHELL = new Set(['cmd', 'pwsh', 'powershell']);
const isCommandWord = (w, i) => w.slice(0, i).every((x) => ASSIGNMENT.test(x) || LAUNCHERS.has(cmdName(x)) || SHELL_KEYWORD.has(x))
  || /(?:^|=)\$$/.test(w[i - 1] ?? '') || w.slice(0, i).some((x) => LAUNCHERS.has(cmdName(x)) || RUNS_REST_SHELL.has(cmdName(x)));
// the protected branch one of words names (src:dst's dst, +, refs/heads/ dropped), or null
const namesBranch = (words, hit) => words.filter((x) => !x.startsWith('-'))
  .map((x) => destination(x, false).replace(/^(?:refs\/)?heads\//, '')).find(hit) ?? null;
// protectedPush's test for git subtree push (in the same every-quoted-string scan as git push): the protected branch, or
// a word the shell fills in
function subtreePush(w, j, hit) {
  if (w[j] !== 'subtree') return null;
  const from = w.indexOf('push', j + 1) + 1;
  if (from === 0) return null;
  const words = stopArgs(w.slice(from)); // a redirection is no branch (2>$null)
  return words.find((x) => x.includes('$')) ?? namesBranch(words, hit);
}
// A git call where git is the command, whose subcommand the shell fills in or is no git command (an alias), naming a
// protected branch later. Read where a shell runs it (runnerArg), not in every quoted string: echo "git is on main" is text.
function aliasPush(w, i, j, hit) {
  const sub = w[j];
  if (sub === undefined || !isCommandWord(w, i)) return null;
  if (!isFilled(sub) && !/[$`%]/.test(sub) && GIT_COMMANDS.has(sub.toLowerCase())) return null;
  // B4: a branch the shell fills in counts too, as for git push (not HEAD or --all: git lg --all is a log alias)
  const words = stopArgs(w.slice(j + 1));
  const branch = words.filter((x) => !x.startsWith('-')).find((x) => x.includes('$')) ?? namesBranch(words, hit);
  return branch ? `${ALIAS_MARK}${sub}${ALIAS_MARK}${branch}` : null;
}
// protectedPush's second scan (text already unbraced), where a shell runs it: aliasPush, then the commands of the call's
// command-running settings (valuesPush). One pass for both, and none when no git word is in the text (PR 111 r2: a
// 600 KB command took about six unbrace-and-scan passes, past the guard's time budget)
// (r3-1: cmdName reads a command word without its quotes, so g""it and 'gi''t' are git too)
const GIT_WORD = /g\W*i\W*t/i;
function hiddenPushes(text, hit, list) {
  if (!GIT_WORD.test(text)) return null;
  return scanCommands(text, GIT, (w, i) => {
    const j = gitSub(w, i);
    return aliasPush(w, i, j, hit) ?? valuesPush(w, i, j, list, text);
  }, runnerArg);
}
const RUNS_ENV = /^(GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_ASKPASS|SSH_ASKPASS|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PROXY_COMMAND|EDITOR|VISUAL|GIT_PAGER|PAGER)=(.*)$/is;
const SWITCH = /^(?:true|false|yes|no|on|off|[01])?$/i;
// a config key whose value git runs as a command (alias and include are gitHides' own)
// (a switch or an empty value runs nothing: core.fsmonitor=false, credential.helper= clears the helpers)
function keyRuns(key, value, isEnv) {
  if (!isEnv && SWITCH.test(value)) return false;
  if (/^core\.pager$/i.test(key) || /^pager\./i.test(key)) return isEnv || !PAGER_OK.test(value);
  return !ALIAS_KEY.test(key) && (GIT_RUNS_KEY.test(key) || /\.driver$/i.test(key));
}
// GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> pairs and GIT_CONFIG_PARAMETERS ('key=value' or 'key'='value', space apart)
// among the assignments before git: [key, value] each
function configEnvPairs(before) {
  const vars = new Map();
  for (const x of before) {
    const m = /^(GIT_CONFIG_(?:KEY|VALUE)_\d+|GIT_CONFIG_PARAMETERS)=(.*)$/is.exec(x);
    if (m) vars.set(m[1].toUpperCase(), m[2]);
  }
  const out = [];
  for (const [k, v] of vars) {
    const n = /^GIT_CONFIG_KEY_(\d+)$/.exec(k);
    if (n) out.push([v, vars.get(`GIT_CONFIG_VALUE_${n[1]}`) ?? '']);
  }
  for (const m of (vars.get('GIT_CONFIG_PARAMETERS') ?? '').matchAll(/'([^'=]*)(?:=([^']*)'|'(?:='([^']*)')?)/g)) {
    out.push([m[1], m[2] ?? m[3] ?? '']);
  }
  return out;
}
// git's words w, git at i, its subcommand at j: the settings and variables of this call whose value git runs as a
// command, [setting, value] each: assignments before git, GIT_CONFIG_* pairs, -c / --config-env (an env value unknown:
// ''), --exec-path=, and (PR 111 review B1, L1-persist) a key git config writes for every later call
function runsValues(w, i, j) {
  const found = [];
  for (let k = 0; k < i; k++) {
    const m = RUNS_ENV.exec(w[k]);
    if (m && !(/PAGER$/i.test(m[1]) && PAGER_OK.test(m[2]))) found.push([m[1], m[2]]);
  }
  for (const [key, value] of configEnvPairs(w.slice(0, i))) if (keyRuns(key, value, false)) found.push([key, value]);
  for (let k = i + 1; k < j; k++) {
    const o = w[k];
    if (/^--exec-path=/i.test(o)) found.push(['--exec-path', o.slice(12)]);
    const isEnv = o === '--config-env' || /^--config-env=/.test(o);
    const cfg = o === '-c' || o === '--config-env' ? (w[k + 1] ?? '') : /^--config-env=/.test(o) ? o.slice(13) : null;
    if (cfg === null) continue;
    const eq = cfg.indexOf('='), key = eq < 0 ? cfg : cfg.slice(0, eq), value = eq < 0 ? '' : cfg.slice(eq + 1);
    if (keyRuns(key, value, isEnv)) found.push([key, isEnv ? '' : value]);
  }
  if (w[j] === 'config') {
    // git config [--global] <key> <value>, git config set <key> <value>: a key followed by a value is a write
    const pos = stopArgs(w.slice(j + 1)).filter((x) => !x.startsWith('-'));
    for (let k = 0; k + 1 < pos.length; k++) if (keyRuns(pos[k], pos[k + 1], false)) found.push([`git config ${pos[k]}`, pos[k + 1]]);
  }
  return found;
}
// git runs such a value through a shell (and a trailing # makes git's own arguments a comment), so the value is judged
// as a command by the same rules: the branch rules for main/master, then the role's (B1: git pu""sh, an alias, $S)
// N1 (PR 111 r2): a value the shell fills in or decodes ($'...\x69...', $(...), $VAR, a backtick) cannot be read here
// (a $HOME/ or $USERPROFILE\ path start is read as the home folder, unless the command names HOME or USERPROFILE any
// other way: GIT_SSH_COMMAND="ssh -i $HOME/.ssh/key" passes. PR 111 r3-3: any other mention, not a list of setters
// (HOME+=, read -r HOME, printf -v HOME, for HOME in, Set-Variable -Name HOME, $env:HOME); case-sensitive and not a
// path segment, so /home/ubuntu and "home page" keep the exemption, and $home/ is no exemption)
const HOME_NAMED = /(?<![$\w{/\\.])(?:HOME|USERPROFILE)\b(?![/\\.])/;
// (#4729: a name is the same name quoted, escaped, continued or in braces (HO""ME, \HOME, HO`ME, {HOME,x}), so a copy of
// the text without those is read too. Reads are written $HOME first, with a default or a trim too (${HOME:-/tmp}): they
// set nothing. PowerShell reads a variable's name in any case, from any part of the command, and matches * ? [ against
// it, so these count too, outside message text: a brace expansion inside a word (H{O,}ME); a setter anywhere with home
// anywhere; home or a wildcard on the variable: or env: drive; a wildcard after a setter or Get-Variable in its
// statement; and, with a setter anywhere, a quoted wildcard name ($n='hom*'). Blocking too much is the accepted cost)
// (#4729, PR 132 re-read: $'...' and $"..." leave no dollar sign in the word bash builds. The dollar goes with the quote,
// and in a text with a $' its numeric escapes are decoded anywhere, with no pairing of quotes, so an earlier $' that
// opens nothing cannot hide the real one. Decoding too much only adds a block)
const ANSI_NUMBER = /\\(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|([0-7]{1,3}))/g;
const ansiChar = (all, x, u, long, oct) => {
  const n = parseInt(x ?? u ?? long ?? oct, oct === undefined ? 16 : 8);
  return n <= 0x10ffff ? String.fromCodePoint(n) : all;
};
const plainQuotes = (t) => (t.includes("$'") ? t.replace(ANSI_NUMBER, ansiChar) : t).replace(/\$(?=["'])/g, '');
const unquotedText = (t) => plainQuotes(t.replace(/\$(?:HOME|USERPROFILE|\{(?:HOME|USERPROFILE)\})(?=[\\/])/g, '')
  .replace(/\$\{(HOME|USERPROFILE)(?:\}|(?=:?[-+]|[#%]))/g, '$$$1 ').replace(/[\\`]\r?\n/g, '')).replace(/["'`\\^]/g, '');
const bareText = (t) => unquotedText(t).replace(/[{},]/g, ' ');
// a word bash or zsh may expand into the name: braces with a list or a range, touching a letter or another brace group
// ({HO,X}{ME,Y}); each word is read once
const braceWord = (word) => {
  if (!word.includes('{')) return false;
  const w = word.replace(/\$\{[^{}]*\}/g, '$');
  return w.includes('{') && w.includes('}') && (w.includes(',') || w.includes('..')) && /[\w}]\{|\}[\w{]/.test(w);
};
const SETTERS = 'set-variable|new-variable|remove-variable|set-item|new-item|setenvironmentvariable|set|sv|nv|rv|si|ni';
const PS_SETTER = new RegExp(String.raw`(?<![\w-])(?:${SETTERS})(?![\w-])`, 'i');
const PS_REACH = new RegExp(String.raw`(?<![\w-])(?:${SETTERS}|get-variable|gv)(?![\w-])`, 'i');
const ANY_CASE_HOME = /(?<![\w$])(?:home|userprofile)\b(?![/\\.])/i;
const DRIVE_HOME = /\b(?:variable|global|script|local|private|env):\/?(?:home|userprofile)\b(?![/.])/i;
// (#4737: ('HO'+'ME') is HOME, so the text with its + joins closed up is read too; the blanks around + are bounded, so
// the join stays linear)
const joinedStrings = (t) => t.replace(/[ \t]{0,4}\+[ \t]{0,4}/g, '');
const DRIVE_WILD = /\b(?:variable|env):\/?[\w-]*[*?[]/i;
const QUOTED_WILD = /(["'])(?=[\w\]]{0,32}[*?[])[\w*?[\]]{1,32}\1/;
// a statement keeps its pipeline (gv hom* | sv); a quoted ; ends none. Each is read once from its first setter: linear
const NAME_STATEMENT = new RegExp(String.raw`(?:${QUOTED}|\\.|[^;&\n"'\\])+`, 'g');
const wildAfterSetter = (statement) => {
  const t = bareText(statement);
  const m = PS_REACH.exec(t);
  return !!m && /[*?[]/.test(t.slice(m.index + m[0].length).replace(/\$\?/g, ''));
};
function namesHome(text) {
  if (HOME_NAMED.test(text)) return true;
  const bare = bareText(text);
  if (HOME_NAMED.test(bare) || DRIVE_HOME.test(bare)) return true;
  const code = joinLines(stripMessages(text));
  const loose = bareText(code);
  // (#4737: {HO,X}$(){ME,Y} has side-by-side groups once the empty expansion is out of the way)
  if (unquotedText(code).replace(EMPTIES, '').split(/\s+/).some(braceWord) || DRIVE_WILD.test(loose)) return true;
  if (PS_SETTER.test(loose) && (ANY_CASE_HOME.test(loose) || ANY_CASE_HOME.test(joinedStrings(loose)) || QUOTED_WILD.test(code))) return true;
  return (code.match(NAME_STATEMENT) ?? []).some(wildAfterSetter);
}
// (the command is read only when a value has such a path start, once per text: nested values stay linear, r3-2)
const homeNamed = new Map();
function filledValue(value, text) {
  if (!/[$`]/.test(value)) return false;
  const rest = value.replace(/\$(?:HOME|USERPROFILE|\{(?:HOME|USERPROFILE)\})(?=[\\/])/g, '');
  if (rest === value || /[$`]/.test(rest)) return true;
  const key = String(text ?? '');
  if (!homeNamed.has(key)) {
    if (homeNamed.size >= 256) homeNamed.clear();
    homeNamed.set(key, namesHome(key));
  }
  return homeNamed.get(key);
}
function valueRuns(setting, value, role, text) {
  if (filledValue(value, text)) return `${setting} runs a command the shell fills in (${value.slice(0, 60)}), which the guard cannot read: write the command out`;
  const branch = protectedPush(value, ['main', 'master']);
  if (branch) return `${setting} runs a command git starts: ${pushReason(branch)}`;
  const why = checkRole(value, role);
  return why ? `${setting} runs a command git starts: ${why}` : null;
}
// git's words w, git at i, its subcommand at j: why a setting or variable that runs a command (or a read-only role's
// subtree write) may not run, or null
function gitRuns(w, i, j, role, text) {
  const found = runsValues(w, i, j);
  for (const [setting, value] of found) {
    const why = value && valueRuns(setting, value, role, text);
    if (why) return why;
  }
  if (!READ_ONLY_ROLES.includes(role)) return null;
  if (found.length) return `${found[0][0]} makes git run a command: ${readsOnly(role)}`;
  const write = w[j] === 'subtree' && w.slice(j + 1).find((x) => /^(?:push|add|merge|pull)$/.test(x));
  return write ? `git subtree ${write}: ${readsOnly(role)}` : null;
}
// protectedPush's test for those values (CB_PROTECTED_BRANCHES too): the protected branch a value's command pushes
// (a value the shell fills in is returned as such, so it blocks as a filled branch: N1)
function valuesPush(w, i, j, list, text) {
  for (const [, value] of runsValues(w, i, j)) {
    const branch = value && (filledValue(value, text) ? value : protectedPush(value, list));
    if (branch) return branch;
  }
  return null;
}
// the block reason for an aliasPush hit (PR 111 review: not "git push", which misleads for git co main)
const ALIAS_MARK = '\u0001';
function aliasReason(hitText) {
  const [, sub, branch] = hitText.split(ALIAS_MARK);
  const what = branch.includes('$') ? `a branch the shell fills in (${branch})` : `protected branch ${branch}`;
  return `git ${sub} is not a git command (an alias, or a word the shell fills in) and names ${what}; an alias can push it past the branch rules: run the git command by its own name, e.g. git checkout ${branch.includes('$') ? 'main' : branch}`;
}
// a git config file as a path, any separator (one worktree or module folder name, with no separator in it, so a long
// path is read once from each start)
const GIT_CONFIG_FILE = /(?:^|[\s"'=:(\\/~<>])(?:\.git[\\/]+(?:(?:worktrees|modules)[\\/]+[^\s"';&|)>\\/]+[\\/]+)?config(?:\.worktree)?|\.gitconfig|\.config[\\/]+git[\\/]+config|gitconfig)(?=[\s"';&|)>`]|$)/i;
const GIT_CONFIG_WRITE = 'a write to a git config file (.git/config, ~/.gitconfig and the like) can add an alias or include that renames a git subcommand past the commit, push and merge rules: change a setting with git config (never alias.* or include.*); one that needs the file itself: cb ask';
// per segment, like the fence: the segment names a git config file and redirects into it or has a writer (not git: git
// config's own writes are gitHides'); the joined text is judged as well as the raw lines (rawAndJoined)
function gitConfigFileWrite(raw) { return rawAndJoined(gitConfigFileWriteOne)(raw); }
function gitConfigFileWriteOne(command) {
  // (config with quote pairs or backslashes inside, as unhide reads it; one cheap test, not an unhide pass per command)
  if (!/c\W*o\W*n\W*f\W*i\W*g/i.test(command)) return null;
  const text = stripMessages(command).replace(URL_WORD, ' ').replace(NOCLOBBER, '> ');
  // the fence's spellings of a path: quote pairs and a backslash inside a word, ./ and seg/../ folded (.git/con""fig)
  const named = (t) => forms(t).some((f) => GIT_CONFIG_FILE.test(f));
  for (const seg of text.match(SEGMENTS) ?? []) {
    if (!named(seg)) continue;
    for (const m of seg.matchAll(REDIRECT_TARGET)) if (named(` ${m[1] ?? ''}`)) return GIT_CONFIG_WRITE;
    if (FENCE_WRITER.test(seg) || IN_PLACE.test(seg) || (INTERPRETER.test(seg) && WRITE_CALL.test(seg))) return GIT_CONFIG_WRITE;
  }
  return null;
}
// gh's own commands (gh help), its extension command's names and the built-in alias co
const GH_COMMANDS = new Set(['auth', 'browse', 'codespace', 'discussion', 'gist', 'issue', 'org', 'pr', 'project', 'release', 'repo',
  'skill', 'cache', 'run', 'workflow', 'co', 'agent-task', 'alias', 'api', 'attestation', 'completion', 'config', 'copilot',
  'extension', 'extensions', 'ext', 'gpg-key', 'label', 'licenses', 'preview', 'ruleset', 'search', 'secret', 'ssh-key', 'status',
  'variable', 'help', 'version', 'accessibility', 'actions', 'environment']);
const GH_SYNC_VALUE = /^(?:-b|--branch|-s|--source)$/;
// gh's words w, gh at i, its command at j: why a non-lead role may not run it, or null
function ghRuns(w, i, j) {
  const sub = w[j];
  if (sub === undefined) return null;
  const s = sub.toLowerCase();
  const at = pastOpts(w, j + 1, GH_OPT_ARG), next = w[at] ?? '';
  if (/^(?:extensions?|ext)$/.test(s) && /^(?:install|upgrade|exec)$/.test(next)) {
    return `gh extension ${next} runs code that is not gh's as a gh command, past the merge rule: an extension is Ahmed's to add (cb ask)`;
  }
  if (s === 'workflow' && next === 'run') return `gh workflow run starts a workflow, which can merge or deploy: ${LEAD_MERGES}`;
  const rest = stopArgs(w.slice(at + 1));
  if (s === 'repo' && next === 'sync' && pastOpts(rest, 0, GH_SYNC_VALUE) < rest.length) {
    return `gh repo sync <repo> moves a branch on GitHub: sync your local checkout with plain gh repo sync, and ${LEAD_MERGES}`;
  }
  if (isCommandWord(w, i) && !GH_COMMANDS.has(s)) {
    return `gh ${sub} is not a gh command (an extension or an alias runs its own code, past the merge rule): use gh's own commands; a new one is Ahmed's (cb ask)`;
  }
  return null;
}

// Secret files (#4347). What a seat reads goes to the model provider, and the board holds client work, so no role
// reads a secret file into its context: .env and its real variants (not .env.example/sample/template/dist, nor source
// files named after it: .env.d.ts, .env.md), private keys and keystores, .pgpass, .netrc, git, npm, cloud and container
// credentials, the seat's messaging token file. Using one where it lives (node --env-file=.env, docker compose
// --env-file) passes: no read word names it. Per segment (review M3): the reader and the name in the same command; an
// input redirect (< .env) is a read; the bootstrap copy of a template (cp .env.example .env) and --exclude=.env pass.
// Quote pairs inside a word (.e""nv) count. kit/permissions/<role>.json denies the same files to Read (a closed list:
// it can only name files). Linear: every name starts at a path boundary, so a long word is read once.
const SECRET_LEAD = String.raw`(?:^|[\s"'=:(\\/~@<,{;|&>$` + '`' + String.raw`])`;
const SECRET_END = String.raw`(?=[\s"';&|)<>*?[{},:` + '`' + String.raw`]|$)`;
const SOURCE_EXT = String.raw`(?:md|mdx|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|cs|txt|html|css)`;
const SECRET_NAME = new RegExp(SECRET_LEAD + String.raw`(?:\.env(?!\.(?:example|sample|template|dist)(?![\w.-]))(?![\w.-]*\.${SOURCE_EXT}(?![\w.-]))(?:\.[\w.-]*)?|[\w.-]+\.(?:pem|key|p12|pfx|jks|keystore|tfvars)|id_(?:rsa|ed25519|ecdsa|dsa)|\.pgpass|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.htpasswd|\.credentials\.json|\.aws[\\/]+credentials|\.kube[\\/]+config|\.docker[\\/]+config\.json|service-account[\w.-]*\.json|cb-seat-[\w.-]*\.(?:claude|opencode)\.json)` + SECRET_END, 'i');
const SECRET_READERS = ['cat', 'tac', 'type', 'get-content', 'gc', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'grep', 'egrep',
  'fgrep', 'rg', 'ag', 'ack', 'findstr', 'select-string', 'sls', 'awk', 'gawk', 'sed', 'cut', 'sort', 'uniq', 'paste', 'strings',
  'xxd', 'od', 'hexdump', 'base64', 'diff', 'cp', 'copy', 'copy-item', 'cpi', 'scp', 'rsync', 'curl', 'wget', 'nc', 'tar', 'zip',
  '7z', 'jq', 'yq', 'source', 'readallbytes', 'readalltext', 'readalllines', 'show', 'xargs', 'openssl', 'ssh-add', 'import-csv',
  'ipcsv', 'tee'];
// a reader word (not $type, not part of a path), a dot-source (. ./.env), or an input redirect (< .env, $(<.env))
const SECRET_READER = new RegExp(String.raw`(?<![\w.$\\/-])(?:${SECRET_READERS.join('|')})(?![\w.\\/-])|(?:^|[\s;&|(])\.(?=[ \t])|(?<![<\d])<(?![<(])`, 'i');
const TEMPLATE_COPY = /^\s*(?:cp|copy|copy-item|cpi)\s+(?:-\S+\s+)*["']?[^\s"']+\.(?:example|sample|template|dist)["']?\s+["']?[^\s"']+["']?\s*$/i;
const EXCLUDE = /--exclude(?:-dir)?=\S*/gi;
const dequote = (t) => t.replace(/""|''/g, '');
const SECRET = 'secret files (#4347): what a seat reads goes to the model provider, so no seat reads .env, a private key, .pgpass/.netrc, git, npm or cloud credentials or a seat token file. Use the file where it lives (node --env-file=.env, docker compose --env-file .env) and name where a value lives instead of printing it; .env.example shows the keys. A value you need: cb ask';
// a file path that is a secret file (for an adapter whose agent reads files natively, review I4)
export function secretPath(path) {
  return typeof path === 'string' && path !== '' && SECRET_NAME.test(` ${path}`);
}
// Stripping only removes text: a raw command naming no secret file cannot name one stripped (the cheap test first). A
// backtick substitution inside a message runs before the message goes anywhere (review I1), so with one the message
// text is judged too. #4589: the joined text is judged as well as the raw lines (rawAndJoined, as for the fence, #4587):
// cat \<newline>.env split the reader from the name, and .e\<newline>nv hid the name from the cheap test.
// (called through, not built here: rawAndJoined is defined further down)
function secretRead(raw) { return rawAndJoined(secretReadOne)(raw); }
function secretReadOne(command) {
  if (!SECRET_NAME.test(command) && !SECRET_NAME.test(dequote(command))) return null;
  const text = dequote(command.includes('`') ? command : stripMessages(command)).replace(EXCLUDE, ' ');
  for (const seg of text.match(SEGMENTS) ?? []) {
    if (TEMPLATE_COPY.test(seg)) continue;
    if (SECRET_NAME.test(seg) && SECRET_READER.test(seg)) return SECRET;
  }
  return null;
}

// The fence (#4345). A squad seat runs under bypassPermissions, so the guard's hook entry in ~/.claude/settings*.json
// (or a repo's .claude/settings*.json) and ~/.claude-board (the installed guard, the runner config) are all that stand
// between it and anything: no role writes them from a shell, and none runs the guard installer (it installs whatever
// guard its own checkout holds). Reading stays open. kit/permissions/<role>.json denies the same paths to Edit/Write
// (Claude seats); the other agents' shims pass their edit targets to evaluate, which applies editFence (#4002).
// A tripwire, not a sandbox: it reads command text, so a script the seat wrote and then runs (node fix.mjs) or a path
// built in a variable passes. It stops the accident and the injected command; the boundary is OS permissions.
// Per segment (review I3): a segment that names a fence path blocks when it also has a writer (git unless a known read
// subcommand, a formatter only with its write flag: #4002 review 68-I1), an in-place edit, an interpreter with a write
// call, or a redirect INTO a fence path; after a cd into ~/.claude or ~/.claude-board any later writer or redirect blocks.
// Fence paths: .claude/settings*.json anywhere, the .claude folder itself (moving or deleting it, a git write in it), and
// .claude-board; a repo's .claude/skills, agents, worktrees are ordinary work. Spellings that hide the path count: quote
// pairs and a backslash inside the word (.cla""ude, .cl\aude), a glob (.cl*, .claud?), trailing dots (.claude.), the 8.3
// name (CLAUDE~1), ./ and seg/../ (review 68-I2). A URL names no local file. Fail closed. Linear: a few single-pass
// tests per segment.
// PR 77 review I2: a backtick starts and ends a path too (echo `cp x ~/.claude/settings.json` hid it)
const TICK = '`';
const FENCE_LEAD = String.raw`(?:^|[\s"'=:(\\/~` + TICK + '])';
const FENCE_END = String.raw`(?=[\s"';&|)>` + TICK + ']|$)';
const FENCE_NAME = String.raw`(?:\.claude\.*|claude~\d)`;
const FENCE_PATH = new RegExp(FENCE_LEAD + String.raw`(?:\.claude-board\.*(?=[\\/\s"';&|)>` + TICK + String.raw`]|$)|${FENCE_NAME}(?:[\\/]+settings[\w.*?-]*\.json|[\\/]*)${FENCE_END}|\.c[\w.-]{0,64}[*?[][^\s/\;&|]{0,64}${FENCE_END}|\.c[\w.-]{0,64}[*?[][^\s/\;&|]{0,64}[\\/]+settings[\w.*?-]*\.json${FENCE_END})`, 'i');
// The other agents' own guard and config files (#4002 install gate): the hook file each adapter's guardInstallSpec names
// (~/.codex/hooks.json, a seat's .agents/hooks.json, OpenCode's plugins folder), Codex's config and profiles (hook trust,
// [features] hooks), every OpenCode config (opencode.json[c] anywhere: plugins, permissions, MCP) and all of ~/.gemini
// (agy's settings, trusted workspaces, global hooks and MCP), and the Codex and OpenCode config folders themselves (moving
// or deleting one, a cd into one). test/guard-fence-agents.test.ts pins it to the adapters.
// Review 68-I1: the repo-level names stay fenced anywhere (a repo's own .codex hooks run unreviewed under Codex's hook-trust
// bypass, .agents/hooks.json runs in a trusted agy folder, a repo's opencode.json or .opencode/plugins load into a seat),
// but ~/.gemini and ~/.config/opencode only under a home folder: a repo's .gemini/ (a styleguide) is not agy's config.
// Trailing dots (Windows drops them) and the 8.3 names (CODEX~1) count, as for .claude.
const AGENT_FENCE = new RegExp(FENCE_LEAD + String.raw`(?:(?:\.codex\.*|codex~\d)(?:[\\/]+(?:hooks\.json|[\w.-]*\.toml)\.*|[\\/]*)|\.agents\.*[\\/]+hooks\.json\.*|opencode\.jsonc?\.*|(?:\.opencode\.*|openco~\d)(?:[\\/]+plugins?\.*(?:[\\/]+[^\s"';&|)>]*)?|[\\/]*))` + FENCE_END, 'i');
// #4551 (review 68-m3): bash's $USERPROFILE (Git Bash has it) and PowerShell's ${env:USERPROFILE} too
const HOME = String.raw`(?:~|\$\{?(?:HOME|USERPROFILE)\}?|\$\{?env:(?:USERPROFILE|HOME)\}?|%USERPROFILE%|[\\/](?:Users|home)[\\/]+[^\\/\s"';&|)>]+|[\\/]root)[\\/]+`;
const HOME_AGENT_FENCE = new RegExp(HOME + String.raw`(?:(?:\.gemini\.*|gemini~\d)(?:[\\/]+[^\s"';&|)>]*)?|\.config\.*[\\/]+opencode\.*(?:[\\/]+plugins?\.*(?:[\\/]+[^\s"';&|)>]*)?|[\\/]*))` + FENCE_END, 'i');
// the cd argument is in the fence: anything under .claude-board, or the .claude folder itself
const IN_BOARD_DIR = /(?:^|[\\/~])\.claude-board\.*(?:[\\/]|$)/i;
const IS_CLAUDE_DIR = /(?:^|[\\/~])(?:\.claude\.*|claude~\d)[\\/]*$/i;
// or another agent's config folder: a .codex or .opencode folder, ~/.gemini, ~/.config/opencode
const IS_AGENT_DIR = /(?:^|[\\/~])(?:\.codex\.*|codex~\d|\.opencode\.*|openco~\d)(?:[\\/]|$)/i;
const IS_HOME_AGENT_DIR = new RegExp(HOME + String.raw`(?:\.gemini\.*|gemini~\d|\.config\.*[\\/]+opencode\.*)(?:[\\/]|$)`, 'i');
// #4590: the cd's redirects go first (cd ~/.claude 2>/dev/null still enters the fence)
// #4595: the whole argument and each word on its own: an option after the target (Set-Location $HOME\.claude -PassThru,
// sl ~/.claude -ea 0, cd ~/.claude --) hid it from the end-anchored tests. Any word, not the first non-option one: which
// options take a value is not known here (-ErrorAction 0 ~/.claude), so fail closed. -Path:<dir> names its value too.
const CD_WORD = /"[^"]*"|'[^']*'|\S+/g;
const isFenceDir = (a) => forms(a).some((f) => IN_BOARD_DIR.test(f) || IS_CLAUDE_DIR.test(f) || IS_AGENT_DIR.test(f) || IS_HOME_AGENT_DIR.test(f));
const fenceDir = (seg) => {
  const arg = seg.replace(CD, '').replace(REDIRECT_TARGET, ' ').trim();
  if (isFenceDir(arg.replace(/^["']|["']$/g, ''))) return true;
  return (arg.match(CD_WORD) ?? []).some((w) => isFenceDir(w.replace(/^-[\w-]+:/, '').replace(/^["']|["']$/g, '')));
};
// #4631: Push-Location is pushd's PowerShell name
const CD = /^\s*(?:cd|pushd|chdir|set-location|push-location|sl)\s+/i;
// a redirect whose target is a fence path, or (after a cd into one) any redirect but to the null device.
// #4631: any fd number (Git Bash opens and truncates the target of 10>)
const REDIRECT_TARGET = /(?<![-\d&])\d*>>?[ \t]*["']?(\S*)/g;
const NULL_DEVICE = /^(?:\/dev\/null|\$null|nul)(?![\w/.\\-])/i;
const FENCE_WORDS = ['tee', 'cp', 'mv', 'rm', 'rmdir', 'ln', 'install', 'rsync', 'dd', 'truncate', 'touch', 'chmod', 'chown',
  'curl', 'wget', 'sponge', 'patch', 'tar', 'unzip', '7z', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
  'new-item', 'ni', 'remove-item', 'ri', 'del', 'erase', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move',
  'rename-item', 'rni', 'ren', 'clear-content', 'clc', 'mklink', 'robocopy', 'xcopy', 'icacls', 'takeown', 'attrib',
  'expand-archive', 'invoke-webrequest', 'iwr',
  // .NET from PowerShell ([IO.File]::WriteAllText(...)), and editors
  'writealltext', 'writeallbytes', 'writealllines', 'appendalltext', 'appendalllines',
  'vi', 'vim', 'nvim', 'nano', 'emacs', 'code', 'notepad'];
// a whole word (not part of a path or a longer word): touch in ~/.claude/touch is not the command
const FENCE_WRITER = new RegExp(String.raw`(?<![\w.\\/-])(?:${FENCE_WORDS.join('|')})(?![\w.\\/-])`, 'i');
// git is a reader only through a known read subcommand (review 68-I1: git diff, log, show, blame, grep and status naming a
// fence path were blocked), found after its global options (-C dir, -c k=v, --git-dir dir, quoted or not); anything else,
// an unknown or unreadable form included, or a read with --output, is a writer (fail closed). A formatter writes only
// with its write flag.
// #4551 (review 68-m1): git is judged as a command, not as a word anywhere (rg -n git opencode.json is rg's search text).
// - In command position every form above holds, a missing or shell-filled subcommand included. Command position: the
//   segment's first word past VAR=x assignments and !, if, then, else, do, while, time, or the first word after ( { $( or
//   a backtick; any spelling of git (/usr/bin/git, git.exe, a quoted path).
// - Anywhere else (sudo git, xargs git, timeout 5 git, find -exec git, pnpm exec git: no launcher list to fall behind) it
//   is a git call when the word past its options is a bare word (add, checkout) or one the shell fills in ($S), and then
//   the same rules hold. A path or file name there (rg -n git opencode.json, cb help git -- .codex) is text: a read.
// - A quoted word with a space or separator in it (bash -c "git add opencode.json") is judged as a command line too.
// Review 68-m2: a git call that runs a program is a writer: -c or --config-env setting an alias, include, external diff,
// textconv, filter, credential helper, pager (but cat, less, more), editor, fsmonitor, hooks path or ssh command;
// --exec-path=<dir>; grep -O (--open-files-in-pager); GIT_EXTERNAL_DIFF, GIT_CONFIG*, GIT_SSH*, GIT_EXEC_PATH,
// GIT_ASKPASS, GIT_EDITOR or a pager (but cat, less, more) assigned earlier in the segment.
const GIT_READS = new Set(['diff', 'log', 'show', 'blame', 'annotate', 'grep', 'status', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse',
  'rev-list', 'describe', 'shortlog', 'whatchanged', 'diff-tree', 'diff-files', 'diff-index', 'show-ref', 'name-rev', 'help', 'version']);
// a segment's words, quote-aware (an unclosed quote runs to the end), with ( ) { } and a backtick as words of their own
const GIT_TOKEN = /(?:"(?:\\.|[^"\\])*"?|'[^']*'?|\\.|[^\s(){}`"'\\])+|[(){}`]/g;
const GIT_OPENER = /^[(){}`]$/;
const SHELL_KEYWORD = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const PAGER_OK = /^\s*(?:(?:cat|less|more)(?:\s+-\w+)*)?\s*$/i;
const GIT_RUNS_ENV = /^(?:GIT_EXTERNAL_DIFF|GIT_CONFIG\w*|GIT_SSH\w*|GIT_EXEC_PATH|GIT_ASKPASS|GIT_EDITOR|(?:GIT_)?PAGER)=/i;
const GIT_RUNS_KEY = /^(?:alias|include|includeif|pager)\.|^(?:core\.(?:fsmonitor|hookspath|sshcommand|askpass|gitproxy|editor)|sequence\.editor)$|\.(?:external|textconv|command|cmd|program|helper|clean|smudge|process|proxycommand)$/i;
const BARE = /^[a-z][\w-]*$/i;
// git's words (w[0] is git): true when the call writes or runs a program. atCommand: git is in command position;
// runsEnv: the segment set a program-running git variable before it
function gitCallWrites(w, atCommand, runsEnv) {
  let i = 1;
  for (; i < w.length && w[i].startsWith('-'); i++) {
    const o = w[i];
    if (/^--exec-path=/i.test(o)) return true;
    const isEnv = /^--config-env(?:=|$)/.test(o);
    const cfg = o === '-c' || o === '--config-env' ? (w[++i] ?? '') : isEnv ? o.slice(13) : null;
    if (cfg === null) { if (GIT_OPT_ARG.has(o)) i++; continue; }
    const eq = cfg.indexOf('='), key = eq < 0 ? cfg : cfg.slice(0, eq);
    if (GIT_RUNS_KEY.test(key)) return true;
    if (/^core\.pager$/i.test(key) && (isEnv || !PAGER_OK.test(eq < 0 ? '' : cfg.slice(eq + 1)))) return true;
  }
  const sub = w[i] ?? '';
  if (!atCommand && !BARE.test(sub) && !/[$%`]/.test(sub)) return false; // text, not a git call
  const s = sub.toLowerCase();
  if (runsEnv || !GIT_READS.has(s) || w.some((x) => /^--output(?:=|$)/.test(x))) return true;
  return s === 'grep' && w.slice(i + 1).some((x) => /^--op/.test(x) || /^-(?!-)[A-Za-z]*O/.test(x));
}
// PR 77 review I1: a command word the shell fills in ($GIT, "$GIT", ${GIT:-git}, $(...), a backtick) is an unknown
// program, judged as git (fail closed: $GIT checkout -- opencode.json blocks, $GIT log -- opencode.json reads). So is an
// expansion after one of these launchers (sudo $GIT checkout ...), with the argument-position rule. A PowerShell
// assignment ($x = ...) is not a command word.
const LAUNCHERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'gtimeout', 'time', 'stdbuf',
  'ionice', 'watch', 'parallel', 'strace', 'ltrace', 'xargs', 'npx', 'pnpx', 'bunx', 'pnpm', 'npm', 'yarn', 'bun', 'ssh', 'eval', 'coproc',
  'chronic', 'unbuffer', 'flock', 'setsid', 'script', 'runas', 'start', 'start-process', 'find', 'fd', 'busybox', 'wsl', 'winpty']);
const PS_ASSIGN = /^\$[\w:.{}]+(?:[+\-*/]?=.*)?$/;
// Every git command name, read or write (PR 77 round 3: a list of only the writing ones missed merge-file, stage and a
// read's --output). A shell-filled word, in ANY position, whose next word that is not an option is one of these, or is
// filled in itself ($SUB, a backtick), is git, judged with the command-position rule: an unknown subcommand writes, a read
// is still checked for --output. Anything else after it is not git ($PAGER opencode.json, echo $HOME opencode.json).
const GIT_COMMANDS = new Set([...GIT_READS, 'add', 'am', 'apply', 'archive', 'bisect', 'branch', 'bugreport', 'bundle', 'check-attr',
  'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'citool', 'clean', 'clone',
  'column', 'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'credential', 'daemon', 'diagnose', 'difftool',
  'fast-export', 'fast-import', 'fetch', 'fetch-pack', 'filter-branch', 'fmt-merge-msg', 'for-each-ref', 'for-each-repo', 'format-patch',
  'fsck', 'gc', 'get-tar-commit-id', 'gui', 'hash-object', 'hook', 'http-backend', 'index-pack', 'init', 'instaweb', 'interpret-trailers',
  'lfs', 'ls-remote', 'mailinfo', 'mailsplit', 'maintenance', 'merge', 'merge-base', 'merge-file', 'merge-index', 'merge-one-file',
  'merge-tree', 'mergetool', 'mktag', 'mktree', 'multi-pack-index', 'mv', 'notes', 'pack-objects', 'pack-redundant', 'pack-refs',
  'patch-id', 'prune', 'prune-packed', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'receive-pack', 'reflog', 'refs', 'remote',
  'repack', 'replace', 'replay', 'request-pull', 'rerere', 'reset', 'restore', 'revert', 'rm', 'send-email', 'send-pack', 'show-branch',
  'show-index', 'sparse-checkout', 'stage', 'stash', 'stripspace', 'submodule', 'svn', 'switch', 'symbolic-ref', 'tag', 'unpack-file',
  'unpack-objects', 'update-index', 'update-ref', 'update-server-info', 'upload-archive', 'upload-pack', 'var', 'verify-commit',
  'verify-pack', 'verify-tag', 'worktree', 'write-tree', 'backfill', 'checkout--worker', 'credential-cache',
  'credential-cache--daemon', 'credential-store', 'credential-wincred', 'diff-pairs', 'difftool--helper', 'fsck-objects', 'fsmonitor--daemon',
  'http-fetch', 'http-push', 'imap-send', 'init-db', 'last-modified', 'merge-octopus', 'merge-ours', 'merge-recursive', 'merge-recursive-ours',
  'merge-recursive-theirs', 'merge-resolve', 'merge-subtree', 'pickaxe', 'quiltimport', 'remote-ext', 'remote-fd', 'remote-ftp', 'remote-ftps',
  'remote-http', 'remote-https', 'repo', 'submodule--helper', 'subtree', 'survey', 'update', 'upload-archive--writer', 'web--browse']);
// the index just past the filled word at raw[k]: past a whole ${...}, $(...) or backtick group
const SHAPES = new WeakMap();
function shape(raw) {
  let r = SHAPES.get(raw);
  if (r) return r;
  const ends = new Int32Array(raw.length).fill(raw.length), closingTick = new Uint8Array(raw.length), nextTick = new Int32Array(raw.length + 1).fill(-1);
  const st = { '(': [], '{': [] };
  let ticks = 0;
  for (let j = 0; j < raw.length; j++) {
    const x = raw[j];
    if (x === '(' || x === '{') st[x].push(j);
    else if (x === ')' || x === '}') { const o = st[x === ')' ? '(' : '{'].pop(); if (o !== undefined) ends[o] = j + 1; }
    else if (x === '`') closingTick[j] = ticks++ % 2;
  }
  for (let j = raw.length - 1, n = -1; j >= 0; j--) { nextTick[j] = n; if (raw[j] === '`') n = j; }
  r = { ends, closingTick, nextTick };
  SHAPES.set(raw, r);
  return r;
}
function filledEnd(raw, k) {
  const open = raw[k] === '`' ? '`' : raw[k] === '$' && /^[({]$/.test(raw[k + 1] ?? '') ? raw[k + 1] : null;
  if (!open) return k + 1;
  const { ends, nextTick } = shape(raw);
  if (open === '`') { const j = nextTick[k]; return j < 0 ? raw.length : j + 1; }
  return ends[k + 1];
}
// a word the shell fills in: $X, ${...}, $(...), or cmd's %X% (round 4, I2)
const isFilled = (u) => u.startsWith('$') || /^%[A-Za-z_]\w*%/.test(u);
// git's own options a filled word may carry before its subcommand: more than this many and the word is judged a writer
const MAX_FILLED_OPTS = 32;
const GIT_GLOBAL_OPTS = new Set(['-v', '--version', '-h', '--help', '-C', '-c', '--exec-path', '--html-path', '--man-path', '--info-path',
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--bare',
  '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--list-cmds', '--super-prefix', '--shallow-file', '--']);
// programs that neither run nor print their arguments (not echo/printf: what they print may be run); git in command
// position is judged whole by the command-position rule, so its later words are arguments too
const NO_RUN = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'cmp', 'diff', 'stat', 'sha256sum', 'md5sum',
  'get-content', 'gc', 'select-string', 'sls', 'test-path', 'get-item', 'gi']);
// a filled word at raw[k] (any position): true when it is a git call that writes. Its options are judged as git's, not
// skipped (round 4, I2: -c alias.x=checkout, --config-env, --exec-path=, --attr-source <v>). The subcommand slot holds a
// git command, a bare $VAR / ${VAR} / %VAR%, or a ${...} / $(...) / backtick group; a path ($HOME/.codex/...) is not one
// (round 4, I1). judge(words, atCommand) is the segment's budgeted gitCallWrites (round 4, I5).
function filledWrites(raw, k, judge) {
  const after = filledEnd(raw, k);
  for (let j = after, opts = 0; j < raw.length; j++) {
    const x = raw[j];
    if (x === ')' || (x === '`' && shape(raw).closingTick[j])) return false; // the filled word's command ended
    if (/^[({}]$/.test(x)) continue;
    const v = unquote(x);
    if (x !== '`' && v.startsWith('-')) {
      if (++opts > MAX_FILLED_OPTS) return true;
      if (!GIT_GLOBAL_OPTS.has(v.split('=')[0]) && !/^-C./.test(v)) return false;
      const opt = v === '-c' || v === '--config-env' || GIT_OPT_ARG.has(v) ? [v, unquote(raw[j + 1] ?? '')] : [v];
      if (gitCallWrites(['git', ...opt, 'status'], true, false)) return true;
      if (GIT_OPT_ARG.has(v)) j++;
      continue;
    }
    const filledSub = x === '`' || (x === '$' && /^[({]$/.test(raw[j + 1] ?? '')) || /^(?:\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%)$/.test(v) || (/\$|%[A-Za-z_]\w*%/.test(v) && !/[\\/]/.test(v));
    if (!filledSub && !GIT_COMMANDS.has(v.toLowerCase())) return false;
    return judge(() => ['git', ...raw.slice(after).filter((y) => !GIT_OPENER.test(y)).map(unquote)], true);
  }
  return false;
}
const gitWrites = (seg, inQuote = false) => {
  const raw = seg.match(GIT_TOKEN) ?? [];
  let start = true, runsEnv = false, launched = false, noRun = false, afterClose = false, ticks = 0;
  const rest = (k) => raw.slice(k).filter((x) => !GIT_OPENER.test(x)).map(unquote);
  // round 4, I5: each git call reads the rest of the segment, so a segment judges at most MAX_COMMANDS_PER_SEGMENT of them
  // and blocks past that (a scan that runs past the hook's timeout lets the command through), as scanCommands does
  let budget = MAX_COMMANDS_PER_SEGMENT;
  const judge = (words, atCommand) => (--budget < 0 ? true : gitCallWrites(words(), atCommand, runsEnv));
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k];
    if (GIT_OPENER.test(t)) {
      // a backtick in command position runs what it prints: an unknown program whose first word is the subcommand slot
      if (t === '`' && start && !inQuote && judge(() => ['`', ...rest(k + 1)], true)) return true;
      if (t === '`' && ticks++ % 2 === 0 && filledWrites(raw, k, judge)) return true; // anywhere: caffeinate `which git` checkout
      start = true;
      noRun = false;
      afterClose = t === ')' || t === '}' || (t === '`' && ticks % 2 === 0);
      continue;
    }
    const u = unquote(t);
    if (start && PS_ASSIGN.test(u) && (/=/.test(u) || /^[+\-*/]?=/.test(raw[k + 1] ?? ''))) { // $x = ..., $env:X='y'
      if (!/=/.test(u)) k++;
      continue;
    }
    // a quoted command line, judged on its own: one layer of quotes off (an unclosed quote dropped, so it always shrinks)
    if (/["']/.test(t) && /[\s;&|]/.test(u)) {
      const inner = u === t ? t.replace(/["']/g, '') : u;
      if (inner.length < t.length && (inner.match(SEGMENTS) ?? []).some((x) => gitWrites(x, true))) return true;
    }
    if (ASSIGNMENT.test(u)) { // VAR=x git ..., env VAR=x git ...
      const eq = u.indexOf('=');
      if (GIT_RUNS_ENV.test(u) && !(/pager$/i.test(u.slice(0, eq)) && PAGER_OK.test(u.slice(eq + 1)))) runsEnv = true;
      if (start) continue;
    }
    const filled = isFilled(u) && (start || launched);
    // a filled word takes the argument-position rule ($PAGER opencode.json is no git call; $GIT $SUB still blocks)
    const isGit = cmdName(t) === 'git';
    // a $( or ${ group in command position: the subcommand slot is the word after the whole group (round 4, I4); inside
    // a quoted line ("$(git rev-parse --show-toplevel)/x", "$USER reading x") a filled first word takes the filledWrites test
    const words = () => (u === '$' && /^[({]$/.test(raw[k + 1] ?? '') ? ['$', ...rest(filledEnd(raw, k))] : rest(k));
    if (filled && start && inQuote) { if (filledWrites(raw, k, judge)) return true; }
    else if ((isGit || filled) && judge(words, start && isGit)) return true;
    // a shell-filled word in ANY position (caffeinate $GIT, arch -arm64 $GIT, time -p $GIT, . $GIT: no wrapper list to fall
    // behind), judged by the word after it (GIT_COMMANDS)
    if (isFilled(u) && !noRun && filledWrites(raw, k, judge)) return true;
    if (start && !SHELL_KEYWORD.has(u.toLowerCase())) {
      start = false;
      if (LAUNCHERS.has(cmdName(t))) launched = true;
      // only a real command word: not one after a closing ) } or backtick (caffeinate $(echo --name) cat $GIT ...)
      noRun = !launched && !afterClose && (isGit || NO_RUN.has(cmdName(t).toLowerCase()));
    }
  }
  return false;
};
const FORMAT_WRITE = /(?<![\w.\\/-])(?:prettier|eslint|biome|dprint|oxlint)(?![\w.\\/-])[^;&|]*[ \t](?:--write|-w|--fix|--apply)(?![\w-])/i;
const writes = (seg) => FENCE_WRITER.test(seg) || gitWrites(seg) || FORMAT_WRITE.test(seg) || IN_PLACE.test(seg) || (INTERPRETER.test(seg) && WRITE_CALL.test(seg));
// an interpreter writes only when its code says so (review I3: node x.mjs ~/.claude/settings.json is a read)
const INTERPRETER = /(?<![\w.\\/-])(?:python3?|py|node|deno|bun|ruby|perl|awk|gawk|sh|bash|zsh|pwsh|powershell)(?![\w.\\/-])/i;
const WRITE_CALL = /write|append|unlink|rename|copy|move|remove|delete|rmdir|rmsync|truncate|chmod|replace|dump|mkdir|\bopen\s*\([^),]{0,300},\s*["'][wax+]|-i\b|--in-place/i;
const IN_PLACE = thenLater(SEGMENTS, String.raw`(?<![\w.-])(?:sed|perl)(?![\w.-])`, String.raw`[ \t](?:-[a-z]*i|--in-place)`);
// the guard's installer, not any project's install.mjs: the file named under a guard folder, or run from inside one
const INSTALLER = /(?:^|[\s"'\\/])install\.mjs(?![\w.-])/i;
const GUARD_DIR = /(?:^|[\s"'\\/])guard(?=[\\/\s"';&|)]|$)/i;
// PR 96 review I1: Codex sends no cwd, so a bare node install.mjs (or ./install.mjs) may be run from inside kit/guard,
// and a glob or variable (kit/gu*/install.mjs, $D/install.mjs) hides the folder: each counts as the guard's (fail closed;
// scripts/install.mjs stays another project's)
const INSTALLER_DIR = /(?:^|[\s"'=(])([^\s"';&|()]*?)install\.mjs(?![\w.-])/gi;
const hiddenInstaller = (s) => [...s.matchAll(INSTALLER_DIR)].some((m) => !m[1] || /^\.[\\/]+$/.test(m[1]) || /[*?[\]{}$`%]/.test(m[1]));
// PR 96 review r2 (minor): only a run of it counts, so cat install.mjs and git add kit/guard/install.mjs pass: a JS runner
// anywhere in the command (a pipe or a < redirect feeds it too, and interpreter code can name it), or, in a segment
// naming the file, the file itself, a launcher or a command word the guard cannot read ($N, "$(which node)") as the
// command word
const JS_RUNNER = /(?<![\w.\\/-])(?:node|nodejs|bun|deno|tsx|ts-node)(?:\.exe)?(?![\w.\\/-])/i;
function installerRuns(s) {
  if (JS_RUNNER.test(s)) return true;
  for (const seg of s.match(SEGMENTS) ?? []) {
    if (!INSTALLER.test(seg)) continue;
    const first = seg.trim().split(/[ \t]+/)[0] ?? '';
    if (!/^[A-Za-z][\w.-]*$/.test(first) || LAUNCHERS.has(first.toLowerCase()) || INSTALLER.test(` ${first}`)) return true;
  }
  return false;
}
const GUARD_INSTALL = { test: (s) => INSTALLER.test(s) && (GUARD_DIR.test(s) || hiddenInstaller(s)) && installerRuns(s) };
// --check counts only as a word of the command itself: not inside quotes (--target "x --check") or a comment (# --check)
const CHECK_WORD = (seg) => /(?:^|[ \t])--check(?![\w-])/.test(blankQuoted(seg).replace(/(?:^|[ \t])#.*$/s, ''));
// and an install that clears or sets the seat's variables (CB_ROLE= CB_AGENT= node install.mjs, env -u CB_ROLE) is
// blocked even with --check: those variables are what make the installer itself refuse to run in a seat
const SEAT_VARS = /CB_(?:ROLE|AGENT)(?![\w])/i;
// PR 96 review r2 (1): CB_ROLE and CB_AGENT are what make a pane a seat: with them the guard applies its seat rules and
// the installer refuses to run. A seat that assigns, unsets or removes either (CB_ROLE= codex exec, env -u, unset,
// Remove-Item Env:, SetEnvironmentVariable, $env:CB_ROLE=, a delete in interpreter code) or clears its whole environment
// (env -i, exec -c, -UseNewEnvironment, os.environ.clear) would run that command, or a child CLI, with the
// dangerous-command rules only. A name the guard cannot read (unset $n, env -u $X, Env:CB_*) counts as one of them.
// Reading them stays open ($CB_ROLE, ${CB_ROLE:-x}, $env:CB_ROLE, printenv, grep). Quoted text is judged only when
// the command runs code (bash -c "unset CB_ROLE"), so grep "CB_ROLE=" stays a search. Each test reads a segment once.
const SEAT_VAR = /^CB_(?:ROLE|AGENT)$/i;
// a mention that is not a $ read: CB_ROLE, Env:CB_ROLE, process.env.CB_ROLE, 'CB_ROLE'
const SEAT_VAR_NAMED = /(?<![\w$]|\$\{|\$env:|\$\{env:)CB_(?:ROLE|AGENT)(?!\w)/i;
// an assignment: CB_ROLE=, CB_ROLE+=, export/set CB_ROLE=, $env:CB_ROLE =, process.env.CB_ROLE=, os.environ['CB_ROLE'] =
// #4669 [6]: PowerShell's braced ${env:CB_ROLE} = ... too (a closing brace before the =)
const SEAT_VAR_SET = /(?<![\w$]|\$\{)CB_(?:ROLE|AGENT)(?!\w)["'`]?[\]}]?[ \t]*\+?=(?!=)/i;
// #4669: for CB_ROLE in ... (or select) assigns it on each pass
const SEAT_VAR_FOR = /(?<![\w.$:\\/-])(?:for|select)[ \t]+CB_(?:ROLE|AGENT)(?!\w)/i;
// #4669 [5]: eval, declare and the like assigning through a name they are given ($x=, ${x}=): a name the guard cannot read
const NAME_ASSIGNER = /(?<![\w.$:\\/-])(?:eval|declare|typeset|export|local|readonly|let)(?![\w-])/i;
const ASSIGN_THROUGH = /\$\{?[A-Za-z_]\w*\}?\+?=(?!=)/;
const EVAL_WORD = /(?<![\w.$:\\/-])eval(?![\w-])/i;
const THROUGH_WORD = /^\$\{?[A-Za-z_]\w*\}?\+?=(?!=)/;
const ASSIGN_WORD = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s"'\\])+/g;
// PR 116 review I1: the $x= must belong to the assigner, in its own statement: eval runs its words as code, so a $x=
// anywhere in them counts; declare, export and the rest assign only a word that starts with it. An export earlier in
// the command and an echo "$k=$v" later are two statements (export A=1; echo "url=$BASE=ok" passes). A statement runs
// from the assigner to the first ; & | or newline outside quotes (eval "true; $x= codex" is one), or an unclosed quote.
// Words split on blanks only, quotes dropped (WORD would split ${x}= at its braces). Linear: an assigner inside the
// statement of an earlier one is not walked again.
const NAME_ASSIGNERS = new RegExp(NAME_ASSIGNER.source, 'gi');
const STATEMENT = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^;&|\n"'\\])*/y;
// #4707 review M5: declare -n r=$x makes r stand for a name the guard cannot read. Every operand of a declare, typeset
// or local with -n is judged, one with no value too (a later assignment picks its target). In command position only (a
// quoted search for it is text); each statement is walked once, so it stays linear
const NAMEREF_HEAD = /(?:^|[;&|\n({]|(?<![\w-])(?:then|do|else|command|builtin)[ \t])[ \t]*(?:declare|typeset|local)(?![\w-])/g;
const QUOTED_OR_ESCAPED = /"(?:\\.|[^"\\])*"|'[^']*'|\\./g;
// does the shell expand something in this word: a $ or a backtick outside single quotes and not escaped
const expands = (word) => /[$`]/.test(word.replace(QUOTED_OR_ESCAPED, (s) => s[0] === '"' ? s : ''));
function hiddenNameref(raw) {
  let end = 0;
  for (const m of raw.matchAll(NAMEREF_HEAD)) {
    if (m.index < end) continue;
    const from = m.index + m[0].length;
    STATEMENT.lastIndex = from;
    STATEMENT.exec(raw);
    end = Math.max(STATEMENT.lastIndex, from);
    let nameref = false;
    for (const word of raw.slice(from, end).match(ASSIGN_WORD) ?? []) {
      const plain = unquote(word);
      if (plain.startsWith('#')) break;
      if (/^[-+]/.test(plain)) nameref ||= /^-\w*n/.test(plain);
      else if (nameref && !/^\d*[<>]/.test(plain) && (/^[A-Za-z_]\w*$/.test(plain) || expands(word))) return true;
    }
  }
  return false;
}
function assignsThrough(raw) {
  let end = 0;
  for (const m of raw.matchAll(NAME_ASSIGNERS)) {
    if (m.index < end) continue;
    STATEMENT.lastIndex = m.index + m[0].length;
    STATEMENT.exec(raw);
    end = Math.max(STATEMENT.lastIndex, m.index + m[0].length);
    const span = raw.slice(m.index, end);
    const e = EVAL_WORD.exec(span);
    if (e && ASSIGN_THROUGH.test(span.slice(e.index))) return true;
    if ((span.slice(m[0].length).match(ASSIGN_WORD) ?? []).some((w) => THROUGH_WORD.test(unquote(w)))) return true;
  }
  return false;
}
// a command or call that removes or sets the variable named after it in the same segment (a word before : is a drive:
// Get-Item Env:CB_ROLE reads)
const SEAT_VAR_REMOVER = /(?<![\w.$:\\/-])(?:unset|unsetenv|putenv|setenv|setx|delete|del|env|set|reg(?:\.exe)?|(?:remove|clear|set|new|rename|move|copy)-item(?:property)?|ri|rm|erase|cli|si|ni|rni|ren|mi|mv)(?![\w:-])|\.(?:pop|remove)\b|SetEnvironmentVariable|(?<![\w.$:\\/-])(?:export|declare|typeset|local|readonly)[ \t]+(?:[-+]\w+[ \t]+)*?(?:\+\w*x|-\w*n)(?!\w)/i;
const HIDDEN_NAME = /[$`*?[{(%"']/;
const UNSET = /(?<![\w.$:\\/-])(?:unset|unsetenv)(?![\w-])/i;
const ENV_DRIVE_WRITER = /(?<![\w.$:\\/-])(?:(?:remove|clear|set|new|rename|move|copy)-item(?:property)?|ri|rm|del|erase|cli|si|ni|rni|ren|mi|mv)(?![\w-])/i;
const ENV_DRIVE = /(?<![\w$])env:[\\/]*([^\s;&|)]*)/gi;
// #4669 [7]: a quoted name is read only when the argument ends there ("CB_"+"ROLE" is not the name CB_)
const SET_ENV_CALL = /SetEnvironmentVariable[ \t]*\([ \t]*(?:(['"])([A-Za-z_]\w*)\1(?=[ \t]*[,)]))?/gi;
const ENV_CLEARS = /(?<![\w.$:\\/-])exec[ \t]+-[a-z]*c(?![\w-])|-usenewenv\w*|environ\.clear[ \t]*\(|process\.env[ \t]*=(?!=)/i;
const SEAT_RUNS_CODE = new RegExp(String.raw`${INTERPRETER.source}|(?<![\w.\\/-])(?:eval|iex|invoke-expression|cmd|fish|source)(?![\w.\\/-])`, 'i');
// env's own options, word by word up to its command: -i, -, --ignore-environment, or -u/--unset of a seat variable or of
// a name the guard cannot read
// #4669 [1]: words are read with their quotes off, as env receives them (env -S'-i' is env -S-i; env C'B'_ROLE= sets
// CB_ROLE), and a -S/--split-string value's words are more options for env (at most 64 words are added)
function envChangesSeat(seg) {
  const w = (seg.match(WORD) ?? []).map(unquote);
  let added = 0;
  for (let i = 0; i < w.length; i++) {
    if (!/^(?:\S*[\\/])?env(?:\.exe)?$/i.test(w[i])) continue;
    let splits = 0;
    for (let j = i + 1; j < w.length; j++) {
      const x = w[j];
      if (/^-[0v]*i[0iv]*S/.test(x)) return true; // env -iS: cleared, in the same word as the split
      let split = null;
      if (x === '-S' || x === '--split-string') split = w[++j] ?? '';
      else if (x.startsWith('--split-string=')) split = x.slice(15);
      else if (/^-[a-zA-Z0-9]*S/.test(x)) split = x.slice(x.indexOf('S') + 1) || (w[++j] ?? '');
      if (split !== null) {
        if (++splits > 64) return true; // more than any real command: blocked, so the walk from each env stays short
        const more = split.trim().split(/[ \t]+/).filter(Boolean).slice(0, Math.max(0, 64 - added));
        added += more.length;
        w.splice(j + 1, 0, ...more);
        continue;
      }
      if (x === '-' || x === '--ignore-environment' || /^-[a-zA-Z0-9]*i/.test(x)) return true;
      if (/^[A-Za-z_]\w*\+?=/.test(x) && SEAT_VAR.test(x.slice(0, x.search(/\+?=/)))) return true;
      let name = null;
      if (/^--unset(?:=|$)/.test(x)) name = x.length > 7 ? x.slice(8) : w[++j] ?? '';
      else if (/^-[a-zA-Z0-9]*u/.test(x)) name = x.slice(x.indexOf('u') + 1) || (w[++j] ?? '');
      if (name !== null) {
        if (!/^[A-Za-z_]\w*$/.test(name) || SEAT_VAR.test(name)) return true;
        continue;
      }
      if (x.startsWith('-') || /^[A-Za-z_]\w*=/.test(x)) continue;
      i = j - 1; // the command: an env further on is read from there
      break;
    }
  }
  return false;
}
// #4669 [2][3][4]: builtins that write a variable named in their arguments: read's, mapfile's and readarray's names (and
// -a's), printf -v's, getopts's. A seat variable there, or a name the guard cannot read, counts
const ENV_WORD = /env/i;
const TAKER_WORD = /read|mapfile|printf|getopts/i;
const TAKER_ARG = { read: new Set(['-d', '-i', '-n', '-N', '-p', '-t', '-u']), mapfile: new Set(['-d', '-n', '-O', '-s', '-u', '-C', '-c']) };
TAKER_ARG.readarray = TAKER_ARG.mapfile;
const takenName = (t) => /[$`]/.test(t) || SEAT_VAR.test(unquote(t).split(/[<>[]/)[0]);
function nameTakers(seg) {
  const w = seg.match(WORD) ?? [];
  for (let i = 0; i < w.length; i++) {
    const name = cmdName(w[i]);
    if (TAKER_ARG[name]) {
      for (let j = i + 1; j < w.length && j <= i + 64 && !/^\d*[<>]/.test(w[j]); j++) { // a 64-word window: linear
        if (w[j] === '-a') { if (w[j + 1] && takenName(w[++j])) return true; continue; }
        if (TAKER_ARG[name].has(w[j])) { j++; continue; }
        if (w[j].startsWith('-')) continue;
        if (takenName(w[j])) return true;
      }
    } else if (name === 'printf') {
      const v = w[i + 1] === '-v' ? w[i + 2] : /^-v./.test(w[i + 1] ?? '') ? w[i + 1].slice(2) : null;
      if (v && takenName(v)) return true;
    } else if (name === 'getopts' && w[i + 2] && takenName(w[i + 2])) return true;
  }
  return false;
}
function seatVarChangeOne(command) {
  const raw = stripMessages(String(command ?? ''));
  const t = SEAT_RUNS_CODE.test(raw) ? raw : blankQuoted(raw);
  if (SEAT_VAR_SET.test(t) || SEAT_VAR_FOR.test(t) || ENV_CLEARS.test(t)) return SEAT_VARS_CHANGE;
  if (NAME_ASSIGNER.test(raw) && (hiddenNameref(raw) || assignsThrough(raw))) return SEAT_VARS_CHANGE;
  for (const seg of t.match(SEGMENTS) ?? []) {
    const r = SEAT_VAR_REMOVER.exec(seg);
    if (r && SEAT_VAR_NAMED.test(seg.slice(r.index))) return SEAT_VARS_CHANGE;
    const u = UNSET.exec(seg);
    if (u && HIDDEN_NAME.test(seg.slice(u.index + u[0].length))) return SEAT_VARS_CHANGE;
  }
  // the word walks run only where their command names appear (a cheap test first keeps big commands fast)
  for (const seg of raw.match(SEGMENTS) ?? []) {
    if ((ENV_WORD.test(seg) && envChangesSeat(seg)) || (TAKER_WORD.test(seg) && nameTakers(seg))) return SEAT_VARS_CHANGE;
  }
  // the Env: drive and .NET take the name as text: judged unblanked (Remove-Item ("Env:" + $n), Env:CB_*)
  for (const seg of raw.match(SEGMENTS) ?? []) {
    if (ENV_DRIVE_WRITER.test(seg)) {
      for (const m of seg.matchAll(ENV_DRIVE)) {
        const name = m[1].replace(/["')]+$/, '');
        if (!/^[A-Za-z_]\w*$/.test(name) || SEAT_VAR.test(name)) return SEAT_VARS_CHANGE;
      }
    }
    for (const m of seg.matchAll(SET_ENV_CALL)) if (!m[2] || SEAT_VAR.test(m[2])) return SEAT_VARS_CHANGE;
  }
  return null;
}
// #4669 (R3-I2 and the PR 96 residual list): a process started with a fresh environment carries neither seat variable, so
// it runs outside the seat. Judged in command position: another user (sudo, doas, su, runuser, pkexec, runas, psexec); ssh
// or mosh to this machine (loopback, a name in `hosts`, or a host the guard cannot read); a scheduler (systemd-run, at,
// batch, crontab, launchctl submit|load|bootstrap|start|kickstart|asuser, schtasks /create|/run|/change,
// Register-/Start-/Set-ScheduledTask); wsl; explorer opening a script; tmux, screen and herdr commands that start a pane
// or type into one (the server's env, not the seat's). Their read-only forms pass (sudo --version, crontab -l, tmux ls,
// herdr pane read, wsl -l, schtasks /query). Anywhere: WMI's Win32_Process Create and wmic process call create. In code
// an interpreter runs: a child given an env of its own (env: {} or env= without process.env or os.environ, clearEnv,
// unsetenv_others, os.exec*e and os.spawn*e), a delete or pop of a name the guard cannot read, EnvironmentVariables.Clear().
const FRESH_WRAP = new Set(['nohup', 'time', 'nice', 'command', 'builtin', 'exec', 'xargs', 'setsid', 'stdbuf', 'ionice', 'then', 'do', 'else', 'if', 'while',
  'until', '!', '{', 'call', 'start', 'start-process', 'saps', 'busybox']);
// a cheap first test: a segment that names none of the launchers is not walked word by word
const FRESH_NAME = /sudo|doas|su\b|runuser|pkexec|runas|psexec|ssh|mosh|systemd-run|\bat\b|batch|crontab|launchctl|wsl|schtasks|scheduled|explorer|tmux|screen|herdr/i;
const OTHER_USER = new Set(['sudo', 'doas', 'su', 'runuser', 'pkexec', 'runas', 'psexec', 'psexec64']);
const LOCAL_HOST = /^(?:localhost|[\w.-]*\.localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|0|0\.0\.0\.0|::|ip6-localhost)$/i;
const SSH_ARG = new Set(['-b', '-B', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
const TMUX_SAFE = new Set(['ls', 'list-sessions', 'list-windows', 'lsw', 'list-panes', 'lsp', 'list-clients', 'lsc', 'list-buffers', 'lsb', 'list-keys', 'lsk',
  'list-commands', 'lscm', 'has-session', 'has', 'display-message', 'display', 'capture-pane', 'capturep', 'show-options', 'show', 'show-window-options', 'showw',
  'show-environment', 'showenv', 'info', 'server-info', 'kill-session', 'kill-window', 'kill-pane', 'kill-server', 'select-pane', 'selectp', 'select-window',
  'selectw', 'resize-pane', 'resizep', 'rename-session', 'rename', 'rename-window', 'renamew', 'detach-client', 'detach', '-V']);
const HERDR_RUNS = new Set(['run', 'send', 'send-keys', 'send-text', 'type', 'paste', 'start', 'create', 'new', 'exec', 'prompt', 'spawn', 'split', 'respawn', 'keys']);
// the {env} shorthand, anywhere in an option object ({stdio: 'inherit', env}); the lookbehind runs only after "env"
const ENV_SHORTHAND = /(?:spawn|exec|fork|Command)\w*[\s\S]{0,400}?env(?<=[{,]\s*env)\s*(?=[,}])/;
const ENV_SET = /(?<![\w.])env\s*=(?!=)/g;
const ENV_COPY = /\s*(?:\{\s*\.\.\.\s*)?process\.env\b(?!\s*[.[])/y;
// every "env =" in the code is a copy of process.env, so the shorthand hands the child that copy
const envIsCopy = (code) => {
  const sets = [...code.matchAll(ENV_SET)];
  return sets.length > 0 && sets.every((m) => { ENV_COPY.lastIndex = m.index + m[0].length; return ENV_COPY.test(code); });
};
const FRESH_CODE = [
  /(?:spawn|exec|fork|Command)\w*[\s\S]{0,400}?\benv\s*:(?!\s*process\.env\b|\s*\{\s*\.\.\.\s*process\.env\b)/,
  /(?:subprocess|Popen|create_subprocess)[\s\S]{0,400}?\benv\s*=(?!=|\s*os\.environ\b|\s*dict\(\s*os\.environ\b|\s*\{\s*\*\*\s*os\.environ\b)/,
  /\bclearEnv\s*:\s*true/, /\bunsetenv_others\b/, /\.Environment(?:Variables)?\.Clear\s*\(/i,
  /delete\s+process\.env\s*\[(?!\s*['"][A-Za-z_]\w*['"]\s*\])/, /del\s+os\.environ\s*\[(?!\s*['"][A-Za-z_]\w*['"]\s*\])/,
  /environ\.pop\(\s*(?!['"][A-Za-z_]\w*['"]\s*[,)])/, /unsetenv\(\s*(?!['"][A-Za-z_]\w*['"]\s*\))/,
];
const OS_EXEC_E = /os\.(?:exec|spawn)\w*e\s*\(/;
// URL's IPv4 parser accepts the short, octal, hex and integer forms the OS resolver accepts.
const hostName = (h) => String(h).toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
// (an IPv6 address needs brackets there, and has no %zone)
const hostAddress = (h) => {
  const bare = h.split('%')[0];
  try { return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}`).hostname; } catch { return h; }
};
// an IPv4 loopback or zero address written as IPv6, as URL normalizes it
const MAPPED_LOCAL = /^::ffff:(?:7f[0-9a-f]{2}|0):[0-9a-f]{1,4}$/;
// the host in an ssh destination: [ssh://][user@]host[:port], the user ending at the last @ (as OpenSSH splits it)
const sshHost = (word) => {
  const uri = /^ssh:\/\//i.test(word);
  const h = word.replace(/^ssh:\/\//i, '').replace(/^.*@/s, '');
  if (!uri) return h;
  const authority = h.split('/')[0];
  return authority.startsWith('[') ? authority.replace(/\]:\d*$/, ']') : authority.replace(/^([^:]*):\d*$/, '$1');
};
// ssh -o Key=value: HostName replaces the destination, and ProxyCommand may tunnel back to this machine's sshd
const sshOptionLocal = (option, hosts) => {
  // OpenSSH drops quotes wherever they stand in an option; a host name is its value's first word
  const m = /^\s*([A-Za-z]+)(?:\s*=\s*|\s+)([\s\S]*)$/.exec(option.replace(/["']/g, ''));
  const key = m?.[1].toLowerCase();
  if (key === 'hostname') {
    const host = m[2].trim().split(/\s+/)[0];
    return host !== '%h' && (/[$`]/.test(host) || localHost(sshHost(host), hosts));
  }
  if (key !== 'proxycommand') return false;
  return m[2].split(/[\s;&|'"]+/).some((w) => w && !/^(?:-|\d+$)/.test(w) && localHost(sshHost(w).replace(/^([^:]*):\d+$/, '$1'), hosts));
};
const localHost = (h, hosts) => {
  const n = hostName(h), address = hostName(hostAddress(n));
  return LOCAL_HOST.test(n) || LOCAL_HOST.test(address) || MAPPED_LOCAL.test(address) || /^127\./.test(address) || hosts.some((v) => {
    if (typeof v !== 'string' || !v) return false;
    const own = hostName(v), short = own.split('.')[0];
    return own === n || hostName(hostAddress(own)) === address ||
      (!/^[\d.:]+$/.test(own) && (n === short || n.startsWith(short + '.')));
  });
};
// No DNS/network requests in a hook: the shims provide the hostname and all interface addresses.
export const localHosts = (name, interfaces) => [name, ...Object.values(interfaces).flatMap((items) => (items ?? []).map((item) => item.address))];
// herdr's global options that take a value (herdr --machine <m> pane run ...): skipped before its subcommand is read
const HERDR_OPT_ARG = new Set(['--machine', '-m', '--session', '--remote', '--remote-keybindings']);
// N1 / #4707 R2-1: the lead keeps herdr prompt/send-keys. A variable SSH host must resolve to the deploy script's
// default target; an arbitrary inherited variable is no exemption. Only VPS is supplied by the shims.
const LEAD_HERDR = new Set(['agent prompt', 'pane send-keys']);
const LEAD_SSH_HOST = /^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/;
const OWN_HOST_VAR = /^\$\{?(?:HOSTNAME|HOST|COMPUTERNAME)\}?$/i;
const DEPLOY_TARGET = 'vps2'; // deploy/copy-to-vps.sh's default; pinned to that file by the tests
function freshLaunch(name, a, hosts, role, vars) {
  const only = (ok) => a.length > 0 && a.every((x) => ok.test(x));
  if (OTHER_USER.has(name)) return only(/^(?:--version|-V|-h|--help|-l|--list|-k|-K)$/) ? null : name;
  if (name === 'ssh' || name === 'mosh') {
    let destination = null;
    for (let i = 0; i < a.length; i++) {
      const option = /^-[46AaCfGgKkMNnqsTtVvXxYy]*o(.*)$/s.exec(a[i]);
      if (option) {
        const value = option[1] || (a[++i] ?? '');
        if (sshOptionLocal(value, hosts)) return `${name} -o ${value.slice(0, 60)}`;
        continue;
      }
      if (SSH_ARG.has(a[i])) { i++; continue; }
      if (a[i].startsWith('-')) continue;
      if (destination !== null) break; // the remote command: ssh still reads options between the host and it
      destination = a[i];
    }
    if (destination === null) return null;
    let host = sshHost(unquote(destination));
    if (role === 'lead' && name === 'ssh' && LEAD_SSH_HOST.test(host) && !OWN_HOST_VAR.test(host)) {
      const key = host.replace(/^\$\{?|\}$/g, '');
      host = vars.get(key);
      if (host !== DEPLOY_TARGET || localHost(host, hosts)) return `${name} variable host outside the deploy target`;
    }
    return /[$`]/.test(host) || !host || localHost(host, hosts) ? `${name} ${destination.slice(0, 60)}` : null;
  }
  if (name === 'wsl') return only(/^(?:-l|--list|-v|--verbose|--status|--version|--help|-q|--quiet|--shutdown|--update|--all|--running)$/) ? null : name;
  if (name === 'launchctl') return a.some((x) => /^(?:submit|load|bootstrap|start|kickstart|asuser)$/.test(x)) ? name : null;
  if (name === 'at') return a.length === 0 || !only(/^-[lrdc]$|^\d+$/) ? name : null;
  if (name === 'crontab') return a.some((x) => /^-[lr]$/.test(x)) ? null : name;
  if (name === 'systemd-run') return only(/^(?:--version|-h|--help)$/) ? null : name;
  if (name === 'batch') return name;
  if (name === 'schtasks') return a.some((x) => /^[/-](?:create|run|change)$/i.test(x)) ? name : null;
  if (/^(?:register|start|set)-scheduled(?:task|job)$/.test(name)) return name;
  if (name === 'explorer' && a.some((x) => /\.(?:bat|cmd|ps1|exe|com|lnk|vbs|js|hta|msi|sh|py)$/i.test(unquote(x)))) return name;
  if (name === 'tmux') {
    let i = 0;
    while (i < a.length && a[i].startsWith('-') && a[i] !== '-V') i += /^-[LSfcT]$/.test(a[i]) ? 2 : 1;
    return a[i] !== undefined && TMUX_SAFE.has(a[i]) ? null : `tmux${a[i] ? ` ${a[i]}` : ''}`;
  }
  if (name === 'screen') return only(/^(?:-ls|-list|-v|--version|-h|--help)$/) ? null : name;
  if (name === 'herdr') {
    // PR 116 review I2: global options and their values first (herdr -m macbook pane run passed as "macbook pane")
    let i = 0;
    while (i < a.length && a[i].startsWith('-')) i += HERDR_OPT_ARG.has(a[i]) ? 2 : 1;
    const sub = a.slice(i).filter((x) => !x.startsWith('-')).slice(0, 2).map(unquote);
    if (role === 'lead' && LEAD_HERDR.has(sub.join(' '))) return null;
    return sub.some((x) => HERDR_RUNS.has(x)) ? `herdr ${sub.join(' ')}` : null;
  }
  return null;
}
// a short option that takes a value may close a run of flags that take none (-vs 9, -0n 1, -vS 'cmd')
const TIMEOUT_OPT_ARG = /^(?:-[fpv]*[sk]|--signal|--kill-after)$/;
// for xargs alone: elsewhere the second letter can be the first one's value (stdbuf -oL)
const XARGS_OPT_ARG = /^-[0oprtx]*[adEIJLnPs]$/;
const ENV_SPLIT = /^(?:-[0iv]*S|--split-string(?:=|$))/;
const ENV_OPT_ARG = /^(?:-[0iv]*[uC]|--unset|--chdir)$/;
const FRESH_OPT_ARG = new Set(['-a', '--arg-file', '-d', '--delimiter', '--process-slot-var', '-I', '-J', '-L', '-n', '-P', '-s', '-E', '--eof', '--replace', '--max-args', '--max-procs', '--max-lines', '--max-chars']);
const SHELL_COMMENT = /"(?:\\.|[^"\\])*"|'[^']*'|\\.|(?:^|[ \t])#[^\n]*/gm;
// comments as spaces, so every later position still holds
const blankComments = (t) => t.replace(SHELL_COMMENT, (s) => /^[ \t]*#/.test(s) ? ' '.repeat(s.length) : s);
const sshValue = (key, value, inherited) => key === 'VPS' && value === '${VPS:-vps2}' ? (inherited || DEPLOY_TARGET) : value;
// set, but to something the guard cannot know: never the deploy target (and not "unset", which takes the script default)
const UNKNOWN_HOST = '$?';
const PLAIN_SET = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/;
const DECLARES = new Set(['export', 'readonly', 'declare', 'typeset', 'local']);
const WRITES_NAMES = new Set(['read', 'mapfile', 'readarray', 'getopts', 'unset', 'for', 'select', 'let', 'printf']);
// a block or a function body may not run, may run again or runs apart: from its first word on, no assignment is certain
const OPENS_BLOCK = /^(?:if|while|until|for|select|case|function|\{)$|^\(|\(\)/;
// #4707 R2-1: the variable writes of a command, in order, each from the end of its statement. Only a statement that is
// nothing but assignments (after export and the like), run for certain in this shell, gives a value. A prefix
// (X=1 cmd) leaves the shell's variable as it was. Any other writer, a condition, a pipe or a subshell makes the name
// unknown; eval and source make every name unknown, and a nameref does so for the rest of the command. Linear.
function varWrites(text) {
  const out = [];
  let nameref = false, compound = false, before = '';
  for (let at = 0; at < text.length;) {
    STATEMENT.lastIndex = at;
    STATEMENT.exec(text);
    const end = Math.max(STATEMENT.lastIndex, at);
    let next = end;
    while (next < text.length && ';&|\n'.includes(text[next])) next++;
    const after = text.slice(end, next);
    const words = text.slice(at, end).match(ASSIGN_WORD) ?? [];
    // run only on a condition (&& || before it, or inside a block), or in a subshell (a pipe on either side, or sent to
    // the background)
    compound ||= words.some((word) => OPENS_BLOCK.test(word));
    const unsure = compound || /&&|\|/.test(before) || /^(?:\|(?!\|)|&(?!&))/.test(after);
    const set = (key, value) => out.push({ at: end, key, value: nameref ? undefined : value });
    let k = 0;
    if (DECLARES.has(words[0])) {
      for (k = 1; /^[-+]/.test(words[k] ?? ''); k++) {
        if (words[0] !== 'export' && words[0] !== 'readonly' && /n/.test(words[k])) { nameref = true; set('*'); }
      }
    }
    let first = k;
    while (PLAIN_SET.test(words[first] ?? '')) first++;
    if (first === words.length) {
      for (let i = k; i < words.length; i++) {
        const [, key, plus, value] = PLAIN_SET.exec(words[i]);
        set(key, unsure || plus ? undefined : unquote(value));
      }
    } else {
      const printsInto = words.includes('-v');
      let writes = false;
      for (let i = first; i < words.length; i++) {
        const word = unquote(words[i]).replace(/^[({]+/, '');
        if (word === 'eval' || word === 'source' || (word === '.' && i === first)) set('*');
        if (writes || (WRITES_NAMES.has(word) && (word !== 'printf' || printsInto))) {
          writes = true;
          const name = /^[A-Za-z_]\w*/.exec(word);
          if (name) set(name[0]);
        }
        const assigned = /^[({]*([A-Za-z_]\w*)\+?=/.exec(words[i]);
        if (assigned) set(assigned[1]);
      }
    }
    before = after;
    at = Math.max(next, at + 1);
  }
  return out;
}
function applyWrite(vars, { key, value }) {
  if (key === '*') { // every name is unknown now: any but VPS is simply forgotten, and a forgotten name is no host
    vars.clear();
    vars.set('VPS', UNKNOWN_HOST);
  } else vars.set(key, value === undefined ? UNKNOWN_HOST : sshValue(key, value, vars.get(key)));
}
// #4741: what the walk below does not follow by itself, because the command string is one word, unquoted, behind
// another option, or glued from pieces: a shell's -c string, eval's and iex's arguments, what follows cmd /c or pwsh -c
// (any prefix of -Command or -CommandWithArgs, and -cwa), and rg's --pre program. Each is judged like a command line
const CODE_CARRIER = /sh|eval|iex|invoke-expression|cmd|\brg\b/i;
const SHELL_PIECE = /\$?'([^']*)'|\$?"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])|([^'"\\$]+|[\s\S])/g;
// a word as the shell hands it on: quotes gone, 's'"udo x" joined
const shellValue = (w) => w.replace(SHELL_PIECE, (_m, single, double, escaped, plain) => single ?? double?.replace(/\\(["\\$`])/g, '$1') ?? escaped ?? plain);
const PS_COMMAND = (x) => /^(?:--?|\/)c/i.test(x) && ((f) => f === 'cwa' || '-commandwithargs'.startsWith(`-${f}`))(x.replace(/^(?:--?|\/)/, '').toLowerCase());
// -Verbose and -Debug, however far abbreviated
const PS_SWITCH = (f) => /^-(?:vb|db)$/i.test(f) || ['-verbose', '-debug'].some((s) => f.length > 1 && s.startsWith(f.toLowerCase()));
// cut: the second reading split this command inside a quote, so a shell's command string may be every word that is left
function codeStrings(name, args, cut) {
  const rest = (k) => (k < args.length ? [args.slice(k).map(shellValue).join(' ')] : []);
  if (name === 'eval') return rest(shellValue(args[0] ?? '') === '--' ? 1 : 0);
  if (name === 'iex' || name === 'invoke-expression') {
    // it takes -Command and PowerShell's common parameters: two are switches, the rest take a value, any may bind it with a colon
    let k = 0;
    while (k < args.length) {
      const x = shellValue(args[k]);
      if (x === '--') return rest(k + 1);
      if (!x.startsWith('-') && !PS_COMMAND(x)) break;
      const colon = x.indexOf(':'), flag = colon < 0 ? x : x.slice(0, colon);
      if (PS_COMMAND(flag)) {
        return colon < 0 ? rest(k + 1) : [[x.slice(colon + 1), ...args.slice(k + 1).map(shellValue)].join(' ').trim()];
      }
      k += colon >= 0 || PS_SWITCH(flag) ? 1 : 2;
    }
    return rest(k);
  }
  if (name === 'cmd') {
    for (let k = 0; k < args.length; k++) {
      // a second slash is Git Bash's way to write one
      const m = /^\/\/?(?:[a-z](?::[^\s/]*)?\/\/?)*[ck](.*)$/i.exec(shellValue(args[k]));
      if (m) return m[1] ? [[m[1], ...args.slice(k + 1)].map(shellValue).join(' ')] : rest(k + 1);
    }
    return [];
  }
  if (name === 'pwsh' || name === 'powershell') {
    const k = args.findIndex((x) => PS_COMMAND(shellValue(x)));
    return k < 0 ? [] : rest(k + 1);
  }
  if (name === 'rg') {
    return args.flatMap((x, k) => {
      const m = /^--pre(?:=(.*))?$/.exec(shellValue(x));
      return m ? [m[1] ?? shellValue(args[k + 1] ?? '')] : [];
    });
  }
  if (!SCRIPT_SHELLS.has(name)) return [];
  const word = (k) => (cut ? rest(k) : k < args.length ? [shellValue(args[k])] : []);
  let runs = false;
  for (let k = 0; k < args.length; k++) {
    const x = shellValue(args[k]);
    if (x === '--' || x === '-') return runs ? word(k + 1) : [];
    const fish = name === 'fish' ? /^--command(?:=([\s\S]*))?$/.exec(x) : null;
    if (fish?.[1] !== undefined) return [fish[1]];
    if (fish) runs = true;
    if (!/^[-+]./.test(x)) return runs ? word(k) : []; // the first operand: the command after -c, else a script file
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(x)) runs = true;
    if (/^(?:[-+][A-Za-z]*[oO]|--rcfile|--init-file)$/.test(x)) k++;
  }
  return [];
}
// #4767: reading quotes as bash does is right for plain text only. Where bash and PowerShell count them differently (a
// smart quote, a backslash before a quote, a here-string, <# #>, --%), where bash nests them ("$( )", "${ }"), where a
// quote may not be one at all (a comment, a heredoc body, one left open), or where a search runs its own text (an alias
// or function, git grep -O, rg --pre), that reading can take a real command for quoted data. Such a command is read a
// second time, flat: cut at every ; & | and newline, as before PR 124. The second reading can only add a block
const MISCOUNTS = /#|--%|`|\$[({[']|@["']|\\["']|[\u2018-\u201E]/;
// a word that makes another word run something else, anywhere in the text; or name() and any body bash takes, on the
// same line or a later one. [ \t\r\n]* follows a ) of its own each time, so it stays linear
const REDEFINES = /(?<![\w-])(?:alias|function|set-alias|new-alias|sal|nal)(?![\w-])|\([ \t]*\)[ \t\r\n]*(?:[({]|\[\[|(?:if|while|until|for|case|select)(?![\w-]))/i;
const SEARCH_PROGRAM = /(?:^|[ \t])(?:--pre(?![\w-])|--op|-[A-Za-z]{0,8}O)/;
const CLOSED_TEXT = /(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|[^"'\\]+)*/y;
const leftOpen = (text) => {
  CLOSED_TEXT.lastIndex = 0;
  CLOSED_TEXT.exec(text);
  return text[CLOSED_TEXT.lastIndex] === '"' || text[CLOSED_TEXT.lastIndex] === "'";
};
// a heredoc's << (not <<< or <<=), and the one header form the guard can place: a plain word, quoted or not, then a
// blank, a redirect, an operator or the line's end
const HEREDOC_MARK = /(?<!<)<<(?![<=])/;
const HEREDOC_HEADER = /<<(-?)[ \t]*(["']?)(\w+)\2(?=[ \t;&|<>()]|$)/y;
// a heredoc body is not shell text, so a quote it leaves open pairs with a later one. Anything about a heredoc that the
// guard cannot place counts as lost. The end line is bash's: the word exactly (<<- drops leading tabs), with no other
// blank: a looser match would end the body early and leave the rest unchecked. Each line is read once
function bodyLeavesQuote(text) {
  // Git Bash drops a carriage return, so there EOF plus one ends a heredoc, which on Linux it does not: lost either way
  if (text.includes('\r')) return true;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].search(HEREDOC_MARK);
    if (at < 0) continue;
    HEREDOC_HEADER.lastIndex = at;
    const header = HEREDOC_HEADER.exec(lines[i]);
    if (!header || HEREDOC_MARK.test(lines[i].slice(HEREDOC_HEADER.lastIndex)) || leftOpen(lines[i].slice(0, at))) return true;
    const [, tabs, , word] = header;
    let end = i + 1;
    while (end < lines.length && (tabs ? lines[end].replace(/^\t+/, '') : lines[end]) !== word) end++;
    if (end === lines.length || leftOpen(lines.slice(i + 1, end).join('\n'))) return true;
    i = end;
  }
  return false;
}
const countLost = (text) => MISCOUNTS.test(text) || REDEFINES.test(text) || leftOpen(text)
  || (/grep|\brg\b/i.test(text) && SEARCH_PROGRAM.test(text.replace(/["'\\]/g, ''))) || (text.includes('<<') && bodyLeavesQuote(text));
// walked: the strings already followed, over all levels of one command. Two ways to find one (eval's words joined, and
// a quoted one of them alone) lead to the same strings below, so without it the work doubles at every level of nesting.
// One seen before was walked and passed: a block would have ended the whole walk
function freshRead(command, hosts, role, deployHost, depth = 0, walked = new Set()) {
  return freshEnvOne(command, hosts, role, deployHost, depth, false, walked)
    ?? (countLost(stripMessages(String(command ?? ''))) ? freshEnvOne(command, hosts, role, deployHost, depth, true, walked) : null);
}
// flat: the second reading. It follows the same strings as the first, since after a lost quote count only it sees them.
// A string it follows gets the second reading only, so the readings never multiply from one level to the next
function freshEnvOne(command, hosts, role, deployHost, depth, flat, walked) {
  if (depth > 8) return FRESH_ENV('commands nested deeper than the guard reads');
  const stripped = stripMessages(String(command ?? ''));
  const raw = flat ? stripped : blankComments(stripped);
  const vars = new Map(deployHost === undefined ? [] : [['VPS', deployHost]]);
  // variables are tracked on the text without comments in both readings (same positions): what is set is bash's to say
  const writes = varWrites(blankComments(stripped));
  let written = 0;
  for (const segment of raw.matchAll(flat ? SEGMENTS : SEGMENT)) {
    const seg = segment[0];
    if (/win32_process|\bwmic\b/i.test(seg) && /\bcreate\b/i.test(seg)) return FRESH_ENV('WMI Win32_Process Create');
    if (!FRESH_NAME.test(seg) && !CODE_CARRIER.test(seg)) {
      // a carrier's own name may be split by quotes or a backslash, with what it runs split so that no launcher shows
      const plain = unhide(seg.replace(/["']/g, ''));
      if (!FRESH_NAME.test(plain) && !CODE_CARRIER.test(plain) && !FRESH_NAME.test(unhide(seg))) continue;
    }
    // flat: a quote the cut left alone is dropped, never read as opening a word that swallows the rest
    const tokens = [...seg.matchAll(flat ? WORD : GIT_TOKEN)], w = tokens.map((m) => m[0]);
    const u = w.map(unquote), names = w.map(cmdName);
    const runsQuote = runnerArg(w, u, names, false);
    const cut = flat && leftOpen(seg);
    const follow = (text) => {
      const key = `${flat}\0${vars.get('VPS')}\0${text}`; // the reading and the deploy host change the verdict
      if (walked.has(key)) return null;
      walked.add(key);
      return flat ? freshEnvOne(text, hosts, role, vars.get('VPS'), depth + 1, true, walked) : freshRead(text, hosts, role, vars.get('VPS'), depth + 1, walked);
    };
    let cmd = true;
    for (let i = 0; i < w.length; i++) {
      while (written < writes.length && writes[written].at <= segment.index + tokens[i].index) applyWrite(vars, writes[written++]);
      if (/["']/.test(w[i]) && /[\s;&|]/.test(u[i]) && runsQuote(i)) {
        const why = follow(u[i]);
        if (why) return why;
      }
      if (/^[({`]$/.test(w[i])) { cmd = true; continue; }
      if (/^[)}]$/.test(w[i])) { cmd = false; continue; }
      const originalName = cmdName(w[i]), name = FRESH_NAME.test(originalName) ? originalName : cmdName(unhide(unquote(w[i])));
      if (!cmd) continue;
      if (ASSIGNMENT.test(u[i])) continue;
      if (FRESH_WRAP.has(name)) {
        // Wrapper option values (xargs -a file sudo) are not command words.
        while (u[i + 1]?.startsWith('-')) {
          const opt = u[++i];
          if (FRESH_OPT_ARG.has(opt) || (name === 'xargs' && XARGS_OPT_ARG.test(opt))) i++;
        }
        continue;
      }
      if (name === 'env') {
        while (w[i + 1] && (w[i + 1].startsWith('-') || ASSIGNMENT.test(w[i + 1]))) {
          const option = u[++i];
          // env -S splits its value into the command and arguments that run
          const s = ENV_SPLIT.exec(option);
          if (s) {
            const split = option.slice(s[0].length) || (u[++i] ?? '');
            const why = follow([split, ...w.slice(i + 1)].join(' '));
            if (why) return why;
            cmd = false;
            break;
          }
          if (ENV_OPT_ARG.test(option)) i++;
        }
        continue;
      }
      if (name === 'timeout') { while (w[i + 1]?.startsWith('-')) { if (TIMEOUT_OPT_ARG.test(u[++i])) i++; } i++; continue; }
      const why = freshLaunch(name, u.slice(i + 1, i + 41), hosts, role, vars);
      if (why) return FRESH_ENV(why);
      // its arguments end at the next ( ) { } or backtick, where another command word may start: each word is read once
      let end = i + 1;
      while (end < w.length && !/^[(){}`]$/.test(w[end])) end++;
      for (const code of codeStrings(name, w.slice(i + 1, end), cut)) {
        const inner = follow(code);
        if (inner) return inner;
      }
      cmd = false;
    }
  }
  if (SEAT_RUNS_CODE.test(raw)) {
    if (FRESH_CODE.some((re) => re.test(raw)) || (ENV_SHORTHAND.test(raw) && !envIsCopy(raw))) return FRESH_ENV('interpreter code that gives a child an environment of its own');
    if (OS_EXEC_E.test(raw) && !/os\.environ/.test(raw)) return FRESH_ENV('os.exec*e or os.spawn*e with an environment of its own');
  }
  return null;
}
const freshEnv = (raw, hosts, role = null, deployHost) => {
  const joined = joinLines(raw);
  return freshRead(raw, hosts, role, deployHost) ?? (joined === raw ? null : freshRead(joined, hosts, role, deployHost));
};
const FRESH_ENV = (what) => `starting a process with a fresh environment (${what}): another user (sudo, su), a login to this machine, a scheduler (at, cron, systemd-run, schtasks, launchctl), WSL, WMI, or a pane that tmux, screen or herdr starts or types into gives it an environment without CB_ROLE and CB_AGENT, so it runs outside the seat with the dangerous-command rules only. Run the command in this pane itself; for a change to how your seat runs: cb ask`;

// #4669: a shell script the seat runs (bash x.sh, ./x.sh, source x.sh, pwsh -File x.ps1, cmd /c x.cmd, x.cmd) is read
// through the shim's readScript and its text judged for the seat-variable and fresh-environment rules. Interpreter files
// (node x.js, python x.py) are not read: tests spawn children with their own env on purpose.
const SCRIPT_EXT = /\.(?:sh|bash|zsh|ksh|fish|ps1|psm1|cmd|bat)$/i;
const SCRIPT_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
const SCRIPT_LEAD = new Set(['nohup', 'time', 'exec', 'command', 'nice', 'builtin']);
const pathWord = (w) => w.replace(/["']/g, '');
const scriptPath = (base, p) => !base || /^(?:[a-z]:|[\\/])/i.test(p) ? p : `${base}/${p}`;
const FEEDS = new Set(['cat', 'get-content', 'gc', 'head', 'tail']);
const TOO_MANY_SCRIPTS = 'shell script traversal exceeds the guard limit (32 files): split the command';
function scriptCalls(command, base = '', deployHost, depth = 0) {
  if (depth > 8) throw new Error('shell commands nested deeper than the guard reads: split the command');
  const out = [];
  const text = blankComments(stripMessages(String(command ?? '')));
  const vars = new Map(deployHost === undefined ? [] : [['VPS', deployHost]]);
  const writes = varWrites(text);
  let cwd = base, feed = [], lastEnd = 0, written = 0;
  for (const m of text.matchAll(SEGMENT)) {
    const seg = m[0], piped = /^\|&?$/.test(text.slice(lastEnd, m.index));
    lastEnd = m.index + seg.length;
    if (!piped) feed = [];
    while (written < writes.length && writes[written].at <= m.index) applyWrite(vars, writes[written++]);
    let vps = vars.get('VPS'); // this command's: a VPS= prefix sets it for this one alone
    const raw = seg.match(WORD) ?? [], w = raw.map(pathWord);
    const prefix = (word) => { const set = /^VPS=([\s\S]*)$/.exec(word ?? ''); if (set) vps = sshValue('VPS', set[1], vps); };
    const add = (p) => {
      if (!p || /[$`*?]/.test(p)) return;
      if (out.length >= 32) throw new Error(TOO_MANY_SCRIPTS);
      out.push({ path: scriptPath(cwd, p), cwd, deployHost: vps });
    };
    let i = 0;
    for (;;) {
      const n = cmdName(w[i] ?? '');
      if (ASSIGNMENT.test(w[i] ?? '')) prefix(w[i++]);
      else if (SCRIPT_LEAD.has(n)) i++;
      else if (n === 'env') {
        for (i++; w[i] && (w[i].startsWith('-') || ASSIGNMENT.test(w[i])); i++) {
          const option = unquote(raw[i]), s = ENV_SPLIT.exec(option);
          if (s) {
            const split = option.slice(s[0].length) || unquote(raw[++i] ?? '');
            out.push(...scriptCalls([split, ...raw.slice(i + 1)].join(' '), cwd, vps, depth + 1));
            if (out.length > 32) throw new Error(TOO_MANY_SCRIPTS);
            i = w.length;
          } else if (ENV_OPT_ARG.test(w[i])) i++;
          else prefix(w[i]);
        }
      } else if (n === 'timeout') { for (i++; w[i]?.startsWith('-'); i++) if (TIMEOUT_OPT_ARG.test(w[i])) i++; i++; }
      else if (/^\d*<(?!<)/.test(w[i] ?? '')) i += /^\d*<$/.test(w[i]) ? 2 : 1; // a redirect before the command
      else break;
    }
    if (i >= w.length) continue;
    const n = cmdName(w[i]), a = w.slice(i + 1, i + 41);
    if (n === 'cd' || n === 'set-location' || n === 'sl') {
      const p = a.find((x) => x !== '--' && x !== '-LiteralPath' && x !== '-Path');
      if (p && !/[$`*?]/.test(p)) cwd = scriptPath(cwd, p);
      continue;
    }
    if (FEEDS.has(n)) { feed = a.filter((x) => !x.startsWith('-')).map((p) => ({ path: scriptPath(cwd, p), cwd, deployHost: vps })); continue; }
    if (n === 'source' || n === '.' || n === 'call') { add(a[0]); continue; }
    if (SCRIPT_SHELLS.has(n)) {
      if (piped) { out.push(...feed); feed = []; }
      for (const r of seg.matchAll(/(?:^|\s)0?<[ \t]*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) add(pathWord(r[1]));
      for (let j = 0; j < a.length; j++) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a[j])) { // the code it is given may run a script too
          let c = j + 1;
          while (a[c]?.startsWith('-')) c++;
          if (a[c] !== undefined) out.push(...scriptCalls(unquote(raw[i + 1 + c]), cwd, vps, depth + 1));
          if (out.length > 32) throw new Error(TOO_MANY_SCRIPTS);
          break;
        }
        if (/^[-+]O$|^[-+]o$|^--(?:rcfile|init-file)$/.test(a[j])) { j++; continue; }
        if (/^[-+]/.test(a[j])) continue;
        if (/^\d*[<>]/.test(a[j])) break;
        add(a[j]);
        break;
      }
    } else if (n === 'pwsh' || n === 'powershell') {
      const f = a.findIndex((x) => /^[-/]f(?:ile)?$/i.test(x));
      if (f >= 0) add(a[f + 1]); else if (a[0] && SCRIPT_EXT.test(a[0])) add(a[0]);
    } else if (n === 'cmd') {
      const c = a.findIndex((x) => /^\/[ck]$/i.test(x));
      if (c >= 0 && a[c + 1] && SCRIPT_EXT.test(a[c + 1])) add(a[c + 1]);
    } else if (SCRIPT_EXT.test(w[i]) || /^\.{1,2}[\\/]/.test(w[i])) add(w[i]);
  }
  return out;
}
export const scriptRuns = (command) => scriptCalls(command).map((call) => call.path);
// as bash tells a binary from a script: a NUL byte before the first newline, and no #! line. A reader that cannot look
// says text, so the limit still holds
function binaryFile(f, fs) {
  if (typeof fs.openSync !== 'function') return false;
  const head = Buffer.alloc(8192);
  const fd = fs.openSync(f, 'r');
  let n;
  try { n = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const start = head.subarray(0, n), nul = start.indexOf(0), line = start.indexOf(10);
  return start.toString('latin1', 0, 2) !== '#!' && nul >= 0 && (line < 0 || nul < line);
}
/** The shims' readScript: a missing file is null; an existing script beyond the read limit fails closed. */
export function scriptReader(cwd, fs) {
  return (p) => {
    let f, st;
    try {
      f = fs.resolve(cwd || '.', p);
      st = fs.statSync(f);
    } catch { return null; }
    if (!st.isFile()) return null;
    if (st.size > 256 * 1024) {
      if (!SCRIPT_EXT.test(f) && binaryFile(f, fs)) return null; // a large program run by its path is not a script
      throw new Error('shell script exceeds the guard read limit (256 KB): split it before running');
    }
    return fs.readFileSync(f, 'utf8');
  };
}

const SEAT_VARS_CHANGE = 'changing CB_ROLE or CB_AGENT (assigning, unsetting or removing either, or clearing the environment with env -i or the like): those two variables are what make this pane a seat, so a command or a child CLI (codex exec, opencode run, claude -p, agy) started without them runs with the dangerous-command rules only, and the guard installer would run. Reading them is fine (echo $CB_ROLE). A test that needs other values sets them in its own child\'s env inside the test file. Only changing the text of a file? Use your file editing tool: a script run from the shell is judged as code, its quoted strings too, so an ordinary word there (unset, env:) can read as this. A change to your seat: cb ask';
const FENCE = 'the fence (#4345): the hook settings (.claude/settings*.json), the .claude folder itself, ~/.claude-board (the guard, the runner config) and the other agents\' hook and config files (~/.codex hooks.json and *.toml, .agents/hooks.json, ~/.gemini, opencode.json, OpenCode plugins) are Ahmed\'s; a squad seat never writes them or runs the guard installer. Reading them is fine. A change there is his: cb ask';
// a hidden spelling as plain text: quote pairs and a backslash between letters go (only ever an extra test: the
// original is tested too, so a Windows path keeps its separators)
const unhide = (t) => t.replace(/""|''/g, '').replace(/(?<=[a-z])\\(?=[a-z])/gi, '');
// review 68-I2: /./ and seg/../ folded, so ~/.codex/./hooks.json and ~/.codex/x/../hooks.json name the file they reach
// (bounded: a few passes, each linear)
// #4551 (review 68-m3): a segment of three or more dots goes too (Windows drops a segment's trailing dots, so
// ~/.codex/.../hooks.json is ~/.codex/hooks.json there)
const fold = (t) => {
  let s = t.replace(/(?<=[\\/])\.{3,}(?:[\\/]+|(?=[\s"';&|)>]|$))/g, '').replace(/(?<=[\\/])(?:\.[\\/]+)+/g, '');
  for (let i = 0; i < 8; i++) {
    const n = s.replace(/(?<![^\\/\s"'=:(>])(?!\.\.?(?:[\\/]|$))[^\\/\s"';&|)>]+[\\/]+\.\.(?:[\\/]+|(?=[\s"';&|)>]|$))/g, '');
    if (n === s) break;
    s = n;
  }
  return s;
};
// #4551 (review 68-m3): an NTFS stream suffix names the file or folder itself (hooks.json::$DATA is hooks.json's main
// stream, .codex::$INDEX_ALLOCATION or .codex:$I30:$INDEX_ALLOCATION the folder), and a shell that expands $DATA to
// nothing leaves hooks.json:: behind
const noStream = (t) => t.replace(/:(?:\$I30)?:(?:\$(?:DATA|INDEX_ALLOCATION))?(?=[\\/\s"';&|)>]|$)/gi, '');
const forms = (t) => { const u = unhide(t), n = noStream(t); return [t, u, fold(t), fold(u), n, fold(n), noStream(fold(u))]; };
const fencePath = (t) => forms(t).some((f) => FENCE_PATH.test(f) || AGENT_FENCE.test(f) || HOME_AGENT_FENCE.test(f));
function redirects(seg, anyTarget) {
  for (const m of seg.matchAll(REDIRECT_TARGET)) {
    const target = m[1] ?? '';
    if (!target || target.startsWith('&') || NULL_DEVICE.test(target)) continue;
    if (anyTarget || fencePath(` ${target}`)) return true;
  }
  return false;
}
// Stripping only removes text, so a raw command naming neither a fence path nor the installer cannot name one stripped:
// skip the second stripMessages (the costly step on big heredocs) for nearly every command.
const RAW_HINT = /\.c[\w.\\"'*?[-]*|claude~\d|codex~\d|openco~\d|\.agents|gemini|opencode/i;
// a URL names a remote file, never a local one (review 68-I1: curl https://x/.agents/hooks.json -o /tmp/h.json is a read)
// (a scheme of two or more letters: C://Users/... is a drive, not a URL)
const URL_WORD = /(?<![\w+.-])[a-z][a-z\d+.-]+:\/\/[^\s"';&|)>]*/gi;
// a definition in command position: name() {, function name, alias [--] name=, hash -p, PowerShell Set-Alias / New-Alias / sal / nal
// judged with quoted text blanked (round 2: grep -E "a|function b" opencode.json is a search, not a definition)
const DEFINES_FN = /(?:^|[;&|\n({])\s*(?:[\w.:-]+\s*\(\s*\)\s*[{(\n]|function\s+[\w.:-]+|alias\s+(?:-\S*\s+)*[\w.-]+=|hash\s+-p\s|(?:set-alias|new-alias|sal|nal)\s)/i;
// #4587: a line continuation, joined as the shell joins it, before anything reads the command (the prefilter too: a
// split open\<newline>code.json names no fence word). bash drops a backslash-newline with nothing between, so
// .cla\<newline>ude is .claude: SHELL_ESCAPES's space would leave that split. Only an odd run of backslashes continues
// (\\<newline> is a backslash, then a real line end), read from the run's first backslash, so the pass stays linear.
// PowerShell's ` continuation reads as a space, as in SHELL_ESCAPES.
// PR 83 review I1: the joined text is judged as well as the raw lines, never instead of them. Which shell runs the
// command is not known here, and a trailing \ is not always a continuation: in PowerShell it ends a path (Set-Location
// C:\tmp\<newline>Copy-Item ...), and in a bash comment the newline still ends the line (ls # x\<newline>cp ...). Each
// reading blocks on its own; the joined one runs only when joining changed something, so the cost is at most two passes.
const joinLines = (t) => t.replace(/(?<!\\)((?:\\\\)*)\\\r?\n/g, '$1').replace(/`\r?\n/g, ' ');
const rawAndJoined = (check) => (raw) => {
  const joined = joinLines(raw);
  return check(raw) ?? (joined === raw ? null : check(joined));
};
// #4594: >| (n>| too) is bash's noclobber override, a redirect: read as > before the split, or its | cut the target off
// into a segment of its own. #4631: zsh's clobber forms too (Mac seat panes run zsh): >!, >>|, >>!, &>|, &>!, >&|,
// &>>|, each read as the redirect without its | or !. In bash &>| and >>| are syntax errors and >! writes a file named
// !, so nothing bash runs is read as a write it is not. Rewriting only merges, never hides.
const NOCLOBBER = /(&?>>?&?)[|!]/g;
// #4631: >&word sends both streams to the file word, unless word is an fd number or - (>&1, >&-: a duplication). Read
// as > before the split, or its & cut the target off into a segment of its own
const BOTH_TO = />&(?![ \t]*[\d-])/g;
const fenceWrite = rawAndJoined(fenceWriteOne);
const seatVarChange = rawAndJoined(seatVarChangeOne);
function fenceWriteOne(command) {
  if (!RAW_HINT.test(command) && !GUARD_INSTALL.test(command)) return null;
  const text = stripMessages(command).replace(URL_WORD, ' ').replace(NOCLOBBER, '$1 ').replace(BOTH_TO, '> ');
  if (GUARD_INSTALL.test(text) && (SEAT_VARS.test(text) || !(text.match(SEGMENTS) ?? []).every((s) => !INSTALLER.test(s) || CHECK_WORD(s)))) return FENCE;
  if (!fencePath(text)) return null;
  // PR 77 review M1: a function or alias defined on the same line moves the writer into another segment (f() { cp x "$1";
  // }; f .claude/settings.json; alias c=cp; c x opencode.json), so a line that names a fence path and defines one writes
  if (DEFINES_FN.test(blankQuoted(text))) return FENCE;
  let inFence = false;
  for (const seg of text.match(SEGMENTS) ?? []) {
    // #4590: a cd's own redirect is opened by the shell before cd runs, so it is judged by its own target, never skipped
    if (CD.test(seg)) {
      if (redirects(seg, false)) return FENCE;
      inFence = fenceDir(seg);
      continue;
    }
    const names = fencePath(seg);
    if (!names && !inFence) continue;
    if (redirects(seg, inFence && !names)) return FENCE;
    if (writes(seg)) return FENCE;
  }
  return null;
}

// An edit tool's target paths (#4002 install gate): for an adapter whose agent edits files natively (Codex apply_patch,
// OpenCode edit/write/patch), so the fence and the secret rule reach edits, not only shell commands. Read from the path
// keys the CLIs use and from patch headers (*** Add/Update/Delete File:, *** Move to:) in any string of the input,
// recursively (Codex sends apply_patch as {command: "<patch>"} or {command: ["apply_patch", "<patch>"]}). [] when none:
// evaluate then blocks the edit, never allows an edit whose target it cannot see.
// #4663 (PR 109 review M2, PR 110 M1): a rename's destination and source too (new_path, new_file_path, old_path,
// old_file_path: names agy's binary holds): moving the hook settings away is as much a write as writing them
const PATH_KEYS = new Set(['file_path', 'filepath', 'path', 'targetfile', 'absolutepath', 'notebook_path', 'move_path',
  'new_path', 'new_file_path', 'old_path', 'old_file_path']);
/** A key that names a file an edit writes, in any case (agy, a Go binary, decodes keys case-insensitively: PR 110 S1). */
export const isPathKey = (k) => typeof k === 'string' && PATH_KEYS.has(k.toLowerCase());
// leading whitespace allowed (review 68-M1): an indented header is still read, never skipped
const PATCH_FILE = /^[ \t]*\*\*\*[ \t]*(?:Add File|Update File|Delete File|Move to)[ \t]*:[ \t]*(.+?)[ \t]*$/gim;
export function editTargets(input) {
  const out = new Set();
  const walk = (v, key, depth) => {
    if (depth > 6) return;
    if (typeof v === 'string') {
      if (key !== null && PATH_KEYS.has(key.toLowerCase()) && v.trim()) out.add(v.trim());
      for (const m of v.matchAll(PATCH_FILE)) out.add(m[1]);
    } else if (Array.isArray(v)) for (const x of v) walk(x, null, depth + 1);
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(input, null, 0);
  return [...out];
}
// null, or why an edit tool may not write this path: a fence path (the hook settings, ~/.claude-board, another agent's
// hook or config file) or a secret file.
// Review 68-I2: every spelling of the path is judged, folded (/./, seg/../) and with each segment's trailing dots and
// spaces dropped (Windows drops them: .codex.\hooks.json is .codex\hooks.json). The shims add the resolved and real forms
// (editPathForms), since core has no fs.
const trimSegments = (p) => p.split(/([\\/]+)/).map((s, i) => (i % 2 || /^\.\.?$/.test(s) ? s : s.replace(/[. ]+$/, '') || s)).join('');
export function editFence(path) {
  if (typeof path !== 'string' || !path.trim()) return 'the edit names an empty target path';
  if (path.startsWith(UNEXPANDED)) return `the guard could not expand the Windows short name in ${path.slice(UNEXPANDED.length)} to the file it writes (PR 110 S3): name the file by its long name`;
  for (const p of new Set([path, trimSegments(path), fold(trimSegments(path))])) {
    if (fencePath(` ${p}`)) return FENCE;
    if (secretPath(p)) return SECRET;
  }
  return null;
}
// A Windows 8.3 short-name segment (SETTIN~1.JSO, GIT~1) and the mark of a path whose short names could not be expanded
export const SHORT_SEGMENT = /(^|[\\/])[^\\/]*~\d/;
const UNEXPANDED = 'unexpanded short name:';
/** The forms of an edit target a shim passes to evaluate (review 68-I2): as given, resolved against the cwd (folds ./ and
 *  ../ in absolute paths too), and through the real path of its nearest existing folder or itself, so a link is judged at
 *  its target. fs is the shim's { resolve, dirname, basename, join, realpathSync }: core stays import-free. */
export function editPathForms(path, cwd, fs) {
  const out = new Set([path]);
  let abs = null;
  try { abs = fs.resolve(cwd || '.', trimSegments(path)); } catch { /* the given form stays */ }
  if (abs) {
    out.add(abs);
    const rest = [];
    for (let dir = abs, i = 0; i < 64; i++) {
      try {
        out.add(fs.join(fs.realpathSync(dir), ...rest));
        // #4663: Node's JS realpath keeps a Windows 8.3 short name (.claude\SETTIN~1.JSO); the native one expands it to the
        // file it writes (settings.json)
        // PR 110 S3: native failing, a short-name segment (~1) cannot be judged by its long name: a form editFence blocks
        if (typeof fs.realpathSync.native === 'function') try { out.add(fs.join(fs.realpathSync.native(dir), ...rest)); } catch {
          if (SHORT_SEGMENT.test(abs)) out.add(UNEXPANDED + abs);
        }
        break;
      } catch { /* not there yet: one folder up */ }
      const up = fs.dirname(dir);
      if (up === dir) break;
      rest.unshift(fs.basename(dir));
      dir = up;
    }
  }
  return [...out];
}

// #4575: cb squad trust writes the agents' own config files (the fence's ~/.claude.json, ~/.codex/config.toml and agy
// settings) to mark folders trusted: Ahmed's one step, never a seat's, for every role including the lead. Read where a
// shell runs it (runnerArg), so a message or a grep that names it is text. Kept apart from the fence on purpose.
const CB_NAMES = new Set(['cb', 'cb.cmd', 'cb.ps1', 'cb.ts', 'cb.mjs', 'cb.js']);
const SQUAD_TRUST = 'cb squad trust writes the agents\' own config files to mark folders trusted (#4575): Ahmed runs it once in his own terminal, never a squad seat. A folder that needs it: cb ask';
// Fail closed (review 89 M1): cb takes its options anywhere (cb squad --machine pc trust x, cb --tag squad squad trust x),
// so any cb command holding both words is blocked, in any case. A PowerShell backtick escape inside a word (squa`d) is
// dropped first, as pwsh does.
function squadTrustRun(command) {
  return scanCommands(String(command ?? '').replace(/`(?=\w)/g, ''), CB_NAMES, (w, i) => {
    let squad = false, trust = false;
    for (let j = i + 1; j < w.length; j++) { const x = w[j].toLowerCase(); squad ||= x === 'squad'; trust ||= x === 'trust'; }
    return squad && trust ? SQUAD_TRUST : null;
  }, runnerArg);
}

// The reason a role may not run this shell command, or null. An unset or empty role: no role rules (a hand-started
// session); a role outside ROLES: blocked (evaluate checks that first). A quoted string is a command here only where a
// shell runs it (runnerArg), except for main/master: like the protected-branch scan, they read every quoted string, so
// a mention of pushing main (grep -rn "git push origin main" docs) blocks too.
export function checkRole(command, role, { readScript = null, hosts = [], deployHost } = {}) {
  if (!role) return null;
  if (!ROLES.includes(role)) return `unknown CB_ROLE "${role}"`;
  const hostList = Array.isArray(hosts) ? hosts : [];
  const seatVars = seatVarChange(String(command ?? '')) ?? freshEnv(String(command ?? ''), hostList, role, deployHost);
  if (seatVars) return seatVars;
  if (typeof readScript === 'function') {
    const pending = calledIn(String(command ?? ''), '', deployHost), seen = new Set();
    let bytes = 0;
    for (let i = 0; i < pending.length; i++) {
      if (i >= 32) return 'shell script traversal exceeds the guard limit (32 files): split the command';
      const { path: p, cwd, deployHost: vps } = pending[i], key = `${cwd}\n${p}\n${vps}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = readScript(p);
      if (typeof text !== 'string') continue;
      bytes += text.length;
      if (bytes > 1024 * 1024) return 'shell scripts exceed the guard read limit (1 MB): split the command';
      const read = readings(text); // #4776: bash drops a script's carriage returns too
      for (const t of read.flatMap((r) => unredirected(r))) {
        const why = seatVarChange(t) ?? freshEnv(t, hostList, role, vps);
        if (why) return `running ${p.slice(0, 120)}, whose text is ${why}`;
      }
      // other languages quote their own way, so only a shell's script is held to this
      if (shellScript(p, text) && read.some(unplacedRedirect)) return `running ${p.slice(0, 120)}: ${UNPLACED}`;
      // the scripts it runs, as read without them, so a CRLF script's calls count once; with a CR alone (PowerShell ends
      // a line there) as written too
      const named = /\r(?!\n)/.test(text) ? read : read.slice(-1);
      for (const t of named) pending.push(...calledIn(t, cwd, vps));
    }
  }
  const secret = secretRead(String(command ?? ''));
  if (secret) return secret;
  const fence = fenceWrite(String(command ?? ''));
  if (fence) return fence;
  const gitConfig = gitConfigFileWrite(String(command ?? '')); // #4661 S1
  if (gitConfig) return gitConfig;
  const trust = squadTrustRun(command);
  if (trust) return trust;
  const readOnly = READ_ONLY_ROLES.includes(role);
  const git = scanCommands(unbrace(command), GIT, (w, i) => {
    const j = gitSub(w, i);
    const hides = gitHides(w, i, j, role, command); // #4638: aliases, push and commit plumbing, a read-only role's git ci
    if (hides) return hides;
    if (w[j] !== 'push') return null;
    if (readOnly) return `git push: ${readsOnly(role)}`;
    const { words, opts, del } = pushArgs(w, j);
    if (opts.some((x) => FORCE_OPT.test(x)) || words.some((x) => x.startsWith('+'))) {
      return 'force push (-f, --force, --force-with-lease, --force-if-includes or a +refspec) rewrites a shared branch: push new commits instead';
    }
    if (opts.some((x) => EVERY_BRANCH_OPT.test(x))) return `git push ${opts.find((x) => EVERY_BRANCH_OPT.test(x))} writes every branch: push one branch by name, ${NAME_IT}`;
    if (words.length < 2) return `git push that names no branch (git's config picks one, maybe main): name it, ${NAME_IT}`;
    const head = words.slice(1).map((r) => destination(r, del)).find((d) => d === 'HEAD' || d === '@');
    if (head) return `git push to ${head} writes the current branch under its own name, maybe main: name the destination, e.g. git push origin HEAD:feat/my-card`;
    return null;
  }, runnerArg);
  if (git) return git;
  const branch = protectedPush(command, ['main', 'master']);
  if (branch) return pushReason(branch);
  if (role === 'lead') return null;
  // #4638: a brace group with no space in it outside quotes (gh's {owner}, {repo}, {branch}; ${OWNER}, ${env:X}) read
  // without its braces, or the braces end the segment and hide the rest of a gh api call (gh api
  // repos/{owner}/{repo}/pulls/5/merge -X PUT)
  const gh = scanCommands(unbrace(command), GH, (w, i) => {
    let j = pastOpts(w, i + 1, GH_OPT_ARG);
    const runs = ghRuns(w, i, j); // #4661 L2
    if (runs) return runs;
    if (w[j] === 'api') return ghApiWrites(w, j) ? GH_WRITES : null; // #4638
    if (w[j] === 'alias' && /^(?:set|import)$/.test(w[pastOpts(w, j + 1, GH_OPT_ARG)] ?? '')) return `gh alias ${w[pastOpts(w, j + 1, GH_OPT_ARG)]} renames a gh command past the merge rule: ${LEAD_MERGES}`;
    if (w[j] !== 'pr') return null;
    j = pastOpts(w, j + 1, GH_OPT_ARG);
    return w[j] === 'merge' ? `gh pr merge: ${LEAD_MERGES}` : null;
  }, runnerArg);
  if (gh) return gh;
  return scanCommands(command, AZ, (w, i) => {
    let j = pastOpts(w, i + 1, AZ_OPT_ARG);
    if (w[j] !== 'repos') return null;
    j = pastOpts(w, j + 1, AZ_OPT_ARG);
    if (w[j] !== 'pr') return null;
    j = pastOpts(w, j + 1, AZ_OPT_ARG);
    if (w[j] !== 'update' && w[j] !== 'create') return null;
    return w.slice(j + 1).some(MERGES_PR)
      ? `az repos pr ${w[j]} with complete, auto-complete or bypass-policy merges the pull request: ${LEAD_MERGES}` : null;
  }, runnerArg);
}

const ASK = `interactive ask-user tools (AskUserQuestion and the like) are disabled here: they stop this session until Ahmed answers, and he is often away.
Ask on Agents Board instead, then KEEP WORKING on something else:

  cb ask <project> "<question>" -o "<Label>=<why / tradeoff>" -o "<Label (Recommended)>=<why>" [-c "<context, markdown>"] [--multi]

- Give the same options and explanations you would have put in the ask tool. Options are required;
  --free (no options) only for a fact: a URL, a name, a number.
- Add --blocking -t <task id> only if that task truly cannot continue; it parks the task in Blocked.
- The answer arrives in this session by itself (cb relay); without a relay, check with \`cb pending\`. More: cb help ask`;

// #4737: the command with split or built spellings of git, gh and az read out, judged beside the command as written (never
// instead of it: which shell runs it is not known here, so this reading can only add a block). In order: $'...' decoded
// ($'g\x69t'); $(echo g) and its backtick form read as the word; {gi,} as gi; the name's letters joined across what a
// shell can drop between them (a backtick, ^, "", '', a backslash, $(), $(true), ${x}, $@, $*, $!, $1); and $x where the
// same command sets x to one of the names. A name built any other way (from two variables, a file, a decoder) is not
// read: server-side branch protection is the fence for those.
const ANSI_C = /\$'((?:\\.|[^'\\])*)'/g;
const ANSI_ESCAPE = new RegExp(String.raw`${ANSI_NUMBER.source}|\\([\s\S])`, 'g');
const ANSI_NAMED = { n: '\n', t: '\t', r: '\r' };
const ansiText = (body) => body.replace(ANSI_ESCAPE, (all, x, u, long, oct, ch) => (ch !== undefined ? ANSI_NAMED[ch] ?? ch
  : ansiChar(all, x, u, long, oct)));
const requote = (s) => (s.includes("'") ? `"${s.replace(/["\\$`]/g, '\\$&')}"` : `'${s}'`);
// every run of blanks below is bounded: two open-ended ones side by side were quadratic (30 s on 200 KB, past the hook's
// timeout, and a timed-out hook allows; PR 135 review)
const PRINTS = String.raw`(?:-[neE]{1,3}|--|'%[sb](?:\\n)?'|"%[sb](?:\\n)?"|%[sb])`; // echo's options, printf's format
const SAYS = String.raw`(?:echo|printf)(?:[ \t]{1,4}${PRINTS}){0,3}[ \t]{1,4}`;
const ECHOED = new RegExp(String.raw`\$\([ \t]{0,4}${SAYS}(["']?)([\w.-]+)\1[ \t]{0,4}\)|\`${SAYS}(["']?)([\w.-]+)\3\``, 'g');
const EMPTY_BRACE = /\{([a-z]{1,3}),\}/gi;
// what a shell leaves out of a word: a command that prints nothing, and an expansion with nothing in it, quoted or not
const NOTHING = String.raw`(?:(?:echo|printf)[ \t]{1,4}(?:""|'')|true|false|echo|:)`;
const EMPTY = String.raw`(?:\$\([ \t]{0,4}(?:${NOTHING}[ \t]{0,4})?\)|\$\{(?:\w+|[@*])(?::?[-=+])?\}|\$[@*!1-9])`;
const EMPTIES = new RegExp(EMPTY, 'g');
const GAP = String.raw`(?:\`[ \t]{0,4}${NOTHING}[ \t]{0,4}\`|\`|\^|"${EMPTY}{1,4}"|\$?""|\$?''|\\|${EMPTY})`;
// no gap holds a name's first letter except inside ${...}, where a word character or { is before it: so a match never
// starts inside another's gaps, and the unbounded * stays linear
// (cmd drops a caret before the first letter too: ^g^i^t)
const SPLIT_NAME = new RegExp(String.raw`(?<![\w{$])\^?(?:g${GAP}*i${GAP}*t|g${GAP}*h|a${GAP}*z)(?!\w)`, 'gi');
const GAPS = new RegExp(GAP, 'g');
const NAME_SET = /(?<![\w$-])\$?([a-z_]\w*)[ \t]*=[ \t]*(["']?)(git|gh|az)\2(?![\w=./\\-])/gi;
const VAR_USE = /\$(?:\{(\w+)\}|(\w+))/g;
export function revealed(command) {
  const text = command.replace(ANSI_C, (_all, body) => requote(ansiText(body)))
    .replace(ECHOED, (_all, _q, a, _p, b) => a ?? b)
    .replace(EMPTY_BRACE, '$1')
    .replace(SPLIT_NAME, (m) => m.replace(GAPS, ''))
    .replace(/\$(?=(["'])(?:git|gh|az)\1)/gi, ''); // $"git" is git: the dollar goes with the locale quote
  const set = new Map([...text.matchAll(NAME_SET)].map((m) => [m[1], m[3]]));
  return set.size ? text.replace(VAR_USE, (all, a, b) => set.get(a ?? b) ?? all) : text;
}

// One decision for one tool call. req: { tool: 'shell' | 'edit' | 'ask' | 'unknown'; command?; role?; protectedBranches?;
// allowAsk?; agent? (CB_AGENT); paths? (an edit's targets, editTargets) }. Returns { allow: true } or { allow: false, kind, reason }: kind 'dangerous' (a dangerous command or a
// CB_PROTECTED_BRANCHES push), 'role' (a role rule), 'input' (unreadable input, unknown tool or role) or 'ask'. The
// shim words the reason for its CLI. It fails closed: anything it cannot read or decide blocks.
// #4626: an interactive session in a board seat. Codex's exec_command can leave a process running, and write_stdin then
// types into it with no hook at all (rust-v0.160.0), so a shell, REPL, database client, editor, pager or remote login
// opened through an allowed command would run, unjudged, whatever the seat types next: a full fence bypass. Claude's Bash
// has no stdin, so a seat gets the same here: a command that reads the seat's input as commands is refused, and its
// one-shot form (bash -c, python x.py, psql -c, ssh -n host cmd, input from < file or a heredoc) is allowed. Only for
// a shim that says the tool has a stdin (stdin: true, Codex), and only in a role seat. What counts:
// - in a pipeline's first stage, with no < redirect, heredoc or herestring, not in a loop whose input is redirected or
//   piped: a shell with no -c or script (sh -, bash -s, sudo -s, su), an interpreter with no code or script (python,
//   node -i, perl, php -a), a REPL, client or debugger (psql, mysql, sqlite3 app.db, redis-cli, gdb), an editor or pager
//   (vim, less, man), a multiplexer (tmux, script), a remote login (ssh host, ssh host bash, telnet, nc), docker or
//   kubectl exec/run/attach with -i (the command inside judged the same way), xargs and awk with no input file, and the
//   shell's read, mapfile and select;
// - cat, tee, head and other pass-throughs reading that input into a stage that runs it (cat | sh);
// - anywhere: /dev/tty, and a PowerShell console read (Read-Host, [Console]::ReadLine, $input piped on);
// - all of this inside bash -c "...", pwsh -Command "...", cmd /c "...", su -c, $(...) and backticks.
// One pass over the words, and an inner command is a substring read at most SESSION_DEPTH times deeper: linear. Fail
// closed: an unknown option to docker or kubectl -i, a docker run -i, or a nesting past the limit counts as a session.
const SESSION_DEPTH = 4;
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'fish', 'csh', 'tcsh']);
const PYTHON = /^(?:python[\d.]*|py|pypy[\d.]*|ipython[\d.]*)$/;
// Interpreters: s = short options, l = long ones; code ends the options with code or an exit (a one-shot), inter makes it
// interactive, arg takes a value. A first word that is not an option is a script (one-shot); '-' is the input (a session).
const SESSION_INTERP = {
  python: { s: { code: 'cmVh', inter: 'i', arg: 'WXQ' }, l: { code: ['--version', '--help'], arg: ['--check-hash-based-pycs'] } },
  node: { s: { code: 'epcvh', inter: 'i', arg: 'rC' }, l: { code: ['--eval', '--print', '--test', '--run', '--check', '--version', '--help', '--v8-options'], inter: ['--interactive'], arg: ['--require', '--import', '--loader', '--experimental-loader', '--conditions', '--input-type', '--title', '--env-file'] } },
  perl: { s: { code: 'eEvhV', inter: 'd', arg: '' }, l: { code: ['--version', '--help'] } },
  ruby: { s: { code: 'evh', inter: '', arg: 'rIC' }, l: { code: ['--version', '--help'] } },
  php: { s: { code: 'rfvhimlS', inter: 'a', arg: 'cdz' }, l: { code: ['--version', '--help', '--run', '--file'], inter: ['--interactive'] } },
  lua: { s: { code: 'ev', inter: 'i', arg: 'l' }, l: {} },
  julia: { s: { code: 'eEvh', inter: 'i', arg: 'pJt' }, l: { code: ['--eval', '--print', '--version', '--help'], inter: ['--interactive'], arg: ['--project', '--threads'] } },
  r: { s: { code: 'efh', inter: '', arg: '' }, l: { code: ['--version', '--help', '--file'] } },
  expect: { s: { code: 'cfv', inter: 'i', arg: '' }, l: {} },
  tclsh: { s: { code: '', inter: '', arg: '' }, l: {} }, // #4658 I3: a script is a one-shot, none is a REPL
  wish: { s: { code: '', inter: '', arg: '' }, l: {} },
};
// #4658 I1: a one-shot whose own code opens a session. For a shell, a call whose first string is the bare shell: the
// string closes right after the name, or what follows still gives it nothing to run (-i; an options object; an argument
// list that is empty or only the shell or -i; a Python keyword other than input= and stdin=). So system('sh build.sh')
// and ['bash', '-c', ...] pass. Blanks are bounded, so a long run of them stays linear. Code that builds these names is
// not read: --disable unified_exec_tty is what stops a seat typing into what it starts (PR 104).
const SHELL_PATH = String.raw`(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:(?:ba|z|da|k|c|tc|fi)?sh|(?:pwsh|powershell|cmd)(?:\.exe)?)`;
// the numbered groups count across SPAWNS_SHELL: \1 the shell string's quote, \2 a list item's, \3 the next string's
const BARE_LIST = String.raw`[\[(][ \t]{0,4}(?:(["'])(?:${SHELL_PATH}|-i)\2[ \t]{0,4},?[ \t]{0,4})?[\])]`;
const BARE_NEXT = String.raw`\{|${BARE_LIST}|(?!(?:input|stdin)\b)[A-Za-z_]\w{0,30}[ \t]{0,4}=|(["'])(?:-i\3|(?:ba|z)?sh\3[ \t]{0,4}[)\]])`;
const SPAWNS_SHELL = new RegExp(String.raw`(?<!\w)(?:exec\w*|system|spawn\w*|popen|Popen|call|check_call|check_output|run|Command)[ \t]{0,4}\(?[ \t]{0,4}\[?[ \t]{0,4}(["'])${SHELL_PATH}(?:[ \t]{1,4}-i)?\1[ \t]{0,4}(?:$|[)\];}]|,[ \t]{0,4}(?:${BARE_NEXT}))`);
const CODE_OPENS = {
  python: /\b(?:pty\.spawn|code\.interact|InteractiveConsole|InteractiveInterpreter|pdb\.(?:set_trace|run\w{0,8}|pm|post_mortem))[ \t]{0,4}\(|(?<![\w.'"])breakpoint[ \t]{0,4}\(/,
  node: /\b(?:require|import)[ \t]{0,4}\([ \t]{0,4}["'](?:node:)?repl["']|\bfrom[ \t]{1,4}["'](?:node:)?repl["']/,
  ruby: /\bbinding\.(?:irb|pry)\b|\b(?:IRB|Pry)\.start\b/,
};
const REPL_MODULES = new Set(['code', 'pdb', 'asyncio', 'IPython', 'bpython', 'ptpython']);
// the module python -m runs: options are read up to the script or -c
function pythonModule(args) {
  for (let i = 0; i < args.length && args[i].startsWith('-'); i++) {
    const m = /^-[bBdEhiIOPqRsSuvx]*([mcWX])(.*)$/.exec(args[i]);
    if (!m) continue;
    if (m[1] === 'm') return m[2] || args[i + 1] || null;
    if (m[1] === 'c') return null;
    if (!m[2]) i++;
  }
  return null;
}
// #4658 I2: a package runner starts the command that follows. sub: the subcommands that do; before: options with a value
// ahead of the subcommand; val: options with a value ahead of the command; call: options whose value is a command string
const SESSION_RUNNERS = {
  npx: { val: new Set(['-p', '--package', '-w', '--workspace']), call: new Set(['-c', '--call']) },
  bunx: { val: new Set(['-p', '--package']) },
  bun: { sub: new Set(['x']), before: new Set(['--cwd']), val: new Set(['-p', '--package']) },
  npm: { sub: new Set(['exec', 'x']), before: new Set(['--prefix', '-w', '--workspace']), val: new Set(['-p', '--package', '-w', '--workspace']), call: new Set(['-c', '--call']) },
  pnpm: { sub: new Set(['exec', 'dlx']), before: new Set(['--filter', '-F', '-C', '--dir']), val: new Set(['--filter', '-F', '-C', '--dir', '--package']) },
  yarn: { sub: new Set(['exec', 'dlx']), before: new Set(['--cwd']), val: new Set(['-p', '--package']) },
  uv: { sub: new Set(['run']), before: new Set(['--directory', '--project']), val: new Set(['--with', '--python', '-p', '--project', '--directory', '--env-file', '--extra', '--group']) },
  poetry: { sub: new Set(['run']), before: new Set(['-C', '--directory', '-P', '--project']), val: new Set() },
  pipenv: { sub: new Set(['run']), before: new Set(), val: new Set() },
  bundle: { sub: new Set(['exec']), before: new Set(), val: new Set() },
};
// what a runner starts: { text } (a command string), { words }, or null when this call starts nothing the guard reads
function runnerStarts(spec, args) {
  let sub = !spec.sub, i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      if (sub) break;
      if (!spec.sub.has(a)) return null;
      sub = true;
      continue;
    }
    if (a === '--') { i++; break; }
    // a call option takes its command string as the next word or after =, before or after the subcommand
    const eq = a.indexOf('=');
    if (spec.call?.has(eq < 0 ? a : a.slice(0, eq))) return { text: eq < 0 ? args[i + 1] ?? '' : a.slice(eq + 1) };
    if ((sub ? spec.val : spec.before).has(a)) i++;
  }
  return sub && i < args.length ? { words: args.slice(i) } : null;
}
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const INTERP_OF = (n) => (PYTHON.test(n) ? 'python' : n === 'nodejs' ? 'node' : n === 'luajit' ? 'lua' : n === 'rscript' ? null : SESSION_INTERP[n] ? n : null);
// always a session, unless --version or --help comes first
const SESSION_ALWAYS = new Set(['tmux', 'screen', 'byobu', 'script', 'irb', 'pry', 'ghci', 'jshell', 'erl', 'scala', 'sbcl', 'guile', 'racket', 'clj',
  'clojure', 'ocaml', 'utop', 'swipl', 'groovysh', 'jdb', 'evcxr', 'gore','telnet', 'mosh', 'rlogin', 'ftp', 'lftp', 'vim', 'vi', 'nvim', 'view', 'vimdiff', 'nano', 'pico', 'micro',
  'joe', 'ed', 'ex', 'less', 'more', 'most', 'pg', 'man', 'info', 'mc', 'lldb', 'pdb', 'mongo', 'bc', 'dc']);
// clients: a session unless one of these options (a query, a file, an exit) is given; '-' as a value reads the input
const SESSION_CLIENT = {
  psql: /^(?:-[A-Za-z]*[cfl]|--command|--file|--list|-V|--version|--help|-\?)(?:=|$)/,
  mysql: /^(?:-e.*|--execute|-V|--version|--help|-\?)(?:=|$)/,
  mariadb: /^(?:-e.*|--execute|-V|--version|--help|-\?)(?:=|$)/,
  mongosh: /^(?:--eval|-f|--file|--version|--help|.*\.js)(?:=|$)/,
  sqlcmd: /^(?:-Q|-i|-\?|--version)(?:=|$)/,
  cqlsh: /^(?:-e|--execute|-f|--file|--version|--help)(?:=|$)/,
  'clickhouse-client': /^(?:-q|--query|--queries-file|--version|--help)(?:=|$)/,
  emacs: /^(?:--batch|-batch|--script|-script|--version|--help)(?:=|$)/,
  gdb: /^(?:-batch|--batch|--version|--help)(?:=|$)/,
  sftp: /^-b$/,
  top: /^-[A-Za-z]*b|^--batch/,
  nc: /^-[A-Za-z]*z/, ncat: /^-[A-Za-z]*z/, netcat: /^-[A-Za-z]*z/,
};
// one-shot once a word that is not an option follows (the SQL, the command); options here take a value
const SESSION_POSITIONAL = {
  sqlite3: { need: 2, arg: new Set(['-cmd', '-separator', '-newline', '-nullvalue', '-init', '-mmap']), exit: /^-(?:version|help)$/ },
  duckdb: { need: 2, arg: new Set(['-cmd', '-separator', '-newline', '-nullvalue', '-init']), exit: /^-(?:version|help|c)$/ },
  nslookup: { need: 1, arg: new Set(), exit: /^-version$/ }, // #4658 I3
  'redis-cli': { need: 1,arg: new Set(['-h', '-p', '-s', '-a', '-u', '-n', '-r', '-i', '-d', '--user', '--pass', '--eval']), exit: /^--(?:version|help|eval)$/ },
};
// a wrapper runs the next command: opts take a value; shell = options that open a shell when no command follows
const SESSION_WRAP = {
  sudo: { opts: new Set(['-u', '-g', '-C', '-D', '-p', '-r', '-t', '-U', '-T', '-R', '-h', '--user', '--group', '--chdir', '--prompt', '--role', '--type', '--other-user', '--command-timeout', '--chroot', '--close-from', '--host']), shell: /^-[A-Za-z]*[si]|^--(?:shell|login)$/ },
  doas: { opts: new Set(['-u', '-C']), shell: /^-[A-Za-z]*s/ },
  env: { opts: new Set(['-u', '-C', '--unset', '--chdir']) },
  nohup: {}, command: { lookup: /^-[A-Za-z]*[vV]/ }, builtin: {}, exec: { opts: new Set(['-a']) }, time: { opts: new Set(['-f', '-o', '--format', '--output']) },
  nice: { opts: new Set(['-n', '--adjustment']) }, ionice: { opts: new Set(['-c', '-n', '-t', '--class', '--classdata']) },
  timeout: { opts: new Set(['-s', '-k', '--signal', '--kill-after']), positional: 1 }, gtimeout: { opts: new Set(['-s', '-k', '--signal', '--kill-after']), positional: 1 },
  stdbuf: { opts: new Set(['-i', '-o', '-e']) }, setsid: {}, chronic: {}, unbuffer: {}, winpty: {}, busybox: {}, coproc: {},
};
const LOOP_START = new Set(['while', 'until', 'for', 'select']);
const PASS_THROUGH = new Set(['cat', 'tac', 'tee', 'dd', 'head', 'tail', 'tr', 'cut', 'sed', 'grep', 'sort', 'uniq', 'base64', 'xxd', 'rev', 'nl', 'fold', 'paste']);
const PASS_FILES = new Set(['cat', 'tac', 'base64', 'xxd', 'rev', 'nl', 'sort', 'uniq', 'fold', 'paste']); // every plain word is a file
const RUNS_INPUT = new Set([...POSIX_SHELLS, 'pwsh', 'powershell', 'cmd', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'luajit', 'julia', 'r',
  'rscript', 'iex', 'invoke-expression', 'xargs', 'awk', 'gawk', 'mawk', 'nawk', 'source', '.', 'psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd',
  'mongosh', 'redis-cli', 'ssh', 'su', 'sudo', 'doas', 'expect', 'tclsh', 'wish']);
const STDIN_DEV = /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
const STDIN_REDIR = /\d*<&[ \t]*\d+|\d*<[ \t]*(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)(?![\w/])/g;
// a redirect word (<&0, 2>&1, >out, and a bare < or > whose target is the next word): never an argument to judge
const REDIR_WORD = /^\d*(?:<<?<?|>>?|<>|>\||&>>?|[<>]&)(.*)$/;
const dropRedirects = (args) => { const out = []; for (let i = 0; i < args.length; i++) { const m = REDIR_WORD.exec(args[i]); if (!m) out.push(args[i]); else if (!m[1]) i++; } return out; };
// B3: these take the terminal whatever feeds them (ls | vim -, git log | less), so a pipe or < is no way out
const SESSION_TTY = new Set(['vim', 'vi', 'nvim', 'view', 'vimdiff', 'nano', 'pico', 'micro', 'joe', 'less', 'more', 'most', 'pg', 'man', 'info', 'mc',
  'tmux', 'screen', 'byobu', 'fzf', 'sk', 'peco', 'tig', 'htop', 'btop', 'lazygit', 'ranger', 'nnn', 'lynx', 'w3m', 'dialog', 'whiptail']);
// B3: git's interactive modes read hunks or a todo list from the seat (add -p, rebase -i): short letters and long names
const GIT_INTERACTIVE = { add: ['ipe', ['--interactive', '--patch', '--edit']], commit: ['p', ['--interactive', '--patch']], clean: ['i', ['--interactive']],
  rebase: ['i', ['--interactive']], checkout: ['p', ['--patch']], reset: ['p', ['--patch']], restore: ['p', ['--patch']], stash: ['p', ['--patch']] };
// B1: a literal assignment earlier in the command (X=bash, export X="python -i"), read through when $X is the command word
const VAR_SET = /(?:^|[\s;&|(])(?:(?:export|local|readonly|declare|typeset)[ \t]+(?:-\w+[ \t]+)*)?([A-Za-z_]\w*)=('[^']*'|"[^"$`\\]*"|[^\s;&|()$`'"\\]*)/g;
const VAR_WORD = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/;
// B1: a substitution as the command word ($(echo bash), `echo bash`), past assignments and a few wrappers
const SUBST_CMD = /^[\s{(!]*(?:(?:[A-Za-z_]\w*=\S*|exec|command|builtin|eval|sudo|env|nohup|time|then|do|else)[ \t]+)*["']?(?:\$\(|`)/;
const PS_READ = /(?<![\w-])read-host(?![\w-])|\[(?:system\.)?console\]::(?:readline|readkey|read|in|openstandardinput)(?!\w)|\$host\.ui\.(?:readline|rawui\.readkey)|\$input\s*\||\bin\s+\$input(?!\w)/i;
// a segment's words, quote-aware; ( ) and a backtick end a piece (a new command position: $(...), (...), `...`)
const SESSION_TOKEN = /"(?:\\.|[^"\\])*"?|'[^']*'?|\\[\s\S]|[()`]|\s+|[^\s()`"'\\]+/g;

const SESSION = (what) => `${what} opens an interactive session, and what a seat types into it later (Codex write_stdin) is never checked by the guard (#4626). Run it one-shot instead: bash -c "...", python x.py or -c, psql -c, ssh -n host cmd, or give it its input with < file or a heredoc`;
/** The interactive session a command opens, as a short name, or null (see above). */
export function stdinSession(command) {
  const cmd = String(command ?? ''), vars = new Map();
  for (const m of cmd.matchAll(VAR_SET)) vars.set(m[1], m[2].replace(/^(['"])([^]*)\1$/, '$2'));
  return sessionIn(cmd, false, 0, vars);
}

function sessionIn(cmd, fed, depth, vars = new Map()) {
  if (depth > SESSION_DEPTH) return 'a command nested deeper than the guard reads';
  // B2: a stdin copy (<&0, exec 3<&0; <&3, < /dev/stdin) goes before the split (its & would cut the segment): removing it
  // only takes a feed away, never adds one
  // #4658: find's {} is a word of its own, not a brace that ends the command (-exec bash {} runs each file as a script)
  const text = cmd.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ').replace(STDIN_REDIR, ' ').replace(/(?<=[ \t])\{\}(?=[\s;+\\]|$)/g, '__found__');
  if (PS_READ.test(replaceQuoted(text.replace(/'[^']*'/g, "''"), (q) => (q[0] === '"' ? '""' : q), PS_STRING_AT, PS_STRING_BODY))) return 'a PowerShell console read (Read-Host, [Console]::ReadLine, $input)';
  const segs = [...text.matchAll(SEGMENT)].map((m) => ({ start: m.index, end: m.index + m[0].length, s: m[0] }));
  const n = segs.length;
  const piped = new Uint8Array(n), joined = new Uint8Array(n), redir = new Uint8Array(n), loopFed = new Uint8Array(n);
  const pieces = segs.map((g) => piecesOf(g.s));
  const lead = (k) => { const p = pieces[k][0]; if (!p) return ''; const i = p.w.findIndex((x) => !ASSIGNMENT.test(x)); return i < 0 ? '' : p.w[i]; };
  const stack = [];
  for (let k = 0; k < n; k++) {
    const gap = k ? text.slice(segs[k - 1].end, segs[k].start) : '';
    // | or |& carries the pipeline on (a blank stage before a newline too); & right after > or < is 2>&1, not a new command
    joined[k] = k > 0 && (/^\|&?$/.test(gap) || (gap === '&' && /[<>]\s*$/.test(segs[k - 1].s)) || (/^\n+$/.test(gap) && !segs[k - 1].s.trim() && joined[k - 1]));
    piped[k] = joined[k] && (gap !== '&' || piped[k - 1]);
    // PR 104 review B2: <&0, <&3 (a copy of some descriptor, maybe the input: exec 3<&0) and < /dev/stdin read the seat's
    // own input, so they are no feed (fail closed on any <&N)
    redir[k] = /</.test(replaceQuoted(segs[k].s, () => '').replace(/<\(/g, '').replace(STDIN_REDIR, ''));
    const w0 = lead(k);
    if (LOOP_START.has(w0)) stack.push(k);
    else if (w0 === 'done' && stack.length) { const j = stack.pop(); loopFed[j] = redir[k] || piped[j]; }
  }
  const loops = [];
  let feeding = 0, pass = null;
  for (let k = 0; k < n; k++) {
    if (SUBST_CMD.test(segs[k].s)) return 'a command named by a substitution ($(...) or `...` as the command word)';
    const w0 = lead(k);
    if (LOOP_START.has(w0)) { loops.push(loopFed[k]); feeding += loopFed[k]; }
    const here = fed || piped[k] || redir[k] || feeding > 0;
    if (w0 === 'done' && loops.length) feeding -= loops.pop();
    if (!joined[k]) pass = null;
    for (const p of pieces[k]) {
      for (const q of p.inner) { const r = sessionIn(q, here, depth + 1, vars); if (r) return r; }
      if (p.w.some((x) => x === '/dev/tty')) return '/dev/tty';
      if (!here && p.w.some((x) => STDIN_DEV.test(x))) return p.w.find((x) => STDIN_DEV.test(x));
      const at = commandAt(p);
      if (at.shell) { if (!here) return at.shell; continue; }
      if (at.subst) return 'a command named by a substitution ($(...) or `...` as the command word)';
      if (at.i < 0) continue;
      let name = cmdName(p.raw[at.i]), args = dropRedirects(p.w.slice(at.i + 1));
      if (/[$`]/.test(p.w[at.i])) {
        // B1: $X read through a literal assignment in the command; any other variable or expansion is unreadable
        const v = VAR_WORD.exec(p.w[at.i]), val = v && vars.get(v[1] ?? v[2]);
        if (val === undefined || val === null) return `a command named by a variable (${p.w[at.i].slice(0, 40)}), which the guard cannot read: name the program`;
        const words = val.trim().split(/[ \t]+/).filter(Boolean);
        if (!words.length) continue;
        name = cmdName(words[0]);
        args = [...words.slice(1), ...args];
        if (/[$`]/.test(words[0])) return `a command named by a variable (${p.w[at.i].slice(0, 40)}), which the guard cannot read: name the program`;
      }
      if (pass && (RUNS_INPUT.has(name) || PYTHON.test(name))) return `${pass} | ${name}`;
      if (!here && !joined[k] && PASS_THROUGH.has(name) && passReads(name, args)) pass = name;
      const r = judge(name, args, here, depth, vars);
      if (r) return r;
    }
  }
  return null;
}

// pieces of one segment: { raw, w, inner }; inner holds the text of a double-quoted "$(...)" or "`...`" (a command too)
function piecesOf(seg) {
  const out = [];
  let cur = { raw: [], w: [], inner: [] }, word = null;
  const endWord = () => { if (word !== null) { cur.raw.push(word); cur.w.push(unquote(word)); word = null; } };
  const endPiece = () => { endWord(); if (cur.raw.length || cur.inner.length) out.push(cur); cur = { raw: [], w: [], inner: [] }; };
  for (const [t] of seg.matchAll(SESSION_TOKEN)) {
    if (/^\s/.test(t)) endWord();
    else if (t === '(' || t === ')' || t === '`') endPiece();
    else {
      if (t[0] === '"' && /\$\(|`/.test(t)) cur.inner.push(t.slice(1, t.endsWith('"') && t.length > 1 ? -1 : undefined).replace(/^[^]*?(?:\$\(|`)/, '').replace(/[)`][^)`]*$/, ''));
      word = (word ?? '') + t;
    }
  }
  endPiece();
  return out;
}

// the index of a piece's command word, past VAR=x, shell keywords and wrappers (sudo -u x, env -u X, timeout 5, nohup);
// { shell } when a wrapper opens a shell with no command (sudo -s, sudo -i, doas -s); i = -1 when nothing runs
function commandAt({ raw, w }) {
  let i = 0, shell = null;
  while (i < w.length) {
    const lower = cmdName(raw[i]);
    if (w[i] === '$' && i === w.length - 1 && raw[i] === '$') return { subst: true, i: -1 }; // $( as the command word
    if (ASSIGNMENT.test(w[i]) || SHELL_KEYWORD.has(lower) || LOOP_START.has(lower) && lower !== 'select' || w[i] === '$' || w[i] === '{' || w[i] === '}') { i++; continue; }
    const spec = SESSION_WRAP[lower];
    if (!spec) return { i };
    i++;
    let positional = spec.positional ?? 0;
    for (; i < w.length; i++) {
      const a = w[i];
      if (a === '--') { i++; break; }
      if (lower === 'env' && ASSIGNMENT.test(a)) continue;
      if (!a.startsWith('-') || a === '-') { if (positional > 0) { positional--; continue; } break; }
      if (spec.lookup?.test(a)) return { i: -1 };
      if (spec.shell?.test(a)) shell = `${lower} ${a}`;
      if (spec.opts?.has(a)) i++;
    }
  }
  return shell ? { shell, i: -1 } : { i: -1 };
}

// does a pass-through stage read its input (no file given)?
// PR 104 review B4: grep, sed, head, tail and cut are read option by option, so a file after the pattern, script or count
// is a file (grep foo file | awk); -r with no file searches the folder. tr never takes a file. Unknown: reads (fail closed)
const PASS_ARGS = {
  grep: { val: 'mABCdD', code: 'ef', lval: ['--max-count', '--after-context', '--before-context', '--context', '--devices', '--directories', '--label', '--include', '--exclude', '--exclude-dir', '--color', '--colour', '--binary-files'], lcode: ['--regexp', '--file'] },
  sed: { val: 'l', code: 'ef', lval: ['--line-length'], lcode: ['--expression', '--file'], suffix: 'i' },
  head: { val: 'nc', code: '', lval: ['--lines', '--bytes'], lcode: [], count: true },
  tail: { val: 'ncs', code: '', lval: ['--lines', '--bytes', '--sleep-interval', '--pid', '--max-unchanged-stats'], lcode: [], count: true },
  cut: { val: 'dfcb', code: '', lval: ['--delimiter', '--fields', '--characters', '--bytes', '--output-delimiter'], lcode: [] },
};
PASS_ARGS.egrep = PASS_ARGS.grep; PASS_ARGS.fgrep = PASS_ARGS.grep;
function passOperands(spec, args) {
  const pos = [];
  let code = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (spec.count && /^[-+]\d+$/.test(a)) continue; // head -5, tail +5
    if (a.startsWith('--')) {
      const n = a.split('=')[0];
      if (spec.lcode.includes(n)) code = true;
      if ((spec.lval.includes(n) || spec.lcode.includes(n)) && !a.includes('=')) i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let c = 1; c < a.length; c++) {
        const ch = a[c];
        if (ch === spec.suffix) break; // sed -i.bak: the rest is the suffix
        if (spec.code.includes(ch)) code = true;
        if (spec.val.includes(ch) || spec.code.includes(ch)) { if (c === a.length - 1) i++; break; }
      }
      continue;
    }
    pos.push(a);
  }
  return { pos, code };
}
function passReads(name, args) {
  if (name === 'tee' || name === 'tr') return true;
  if (name === 'dd') return !args.some((a) => /^if=/.test(a));
  if (PASS_FILES.has(name)) return !args.some((a) => a !== '-' && !a.startsWith('-')) || args.includes('-');
  const spec = PASS_ARGS[name];
  if (!spec) return true;
  const { pos, code } = passOperands(spec, args);
  const files = (name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'sed') && !code ? pos.slice(1) : pos;
  if (files.includes('-')) return true;
  if (files.length) return false;
  return !((name === 'grep' || name === 'egrep' || name === 'fgrep') && args.some((a) => /^-[A-Za-z]*[rR]/.test(a) && !a.startsWith('--') || a === '--recursive' || a === '--dereference-recursive'));
}

// an interpreter's options: 'session', 'oneshot', or the index of its script word
function interpMode(spec, args) {
  let inter = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-') return 'session';
    if (a === '--') return i + 1 < args.length && !inter ? 'oneshot' : 'session';
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (spec.l.inter?.includes(name)) inter = true;
      else if (spec.l.code?.includes(name)) return inter ? 'session' : 'oneshot';
      else if (spec.l.arg?.includes(name) && !a.includes('=')) i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let c = 1; c < a.length; c++) {
        const ch = a[c];
        if (spec.s.inter.includes(ch)) inter = true;
        else if (spec.s.code.includes(ch)) return inter ? 'session' : 'oneshot';
        else if (spec.s.arg.includes(ch)) { if (c === a.length - 1) i++; break; }
      }
      continue;
    }
    return inter ? 'session' : 'oneshot'; // the script
  }
  return 'session';
}

const isI = (a) => /^-[A-Za-z]*i[A-Za-z]*$/.test(a) && !a.startsWith('--') || /^--interactive(?:=true)?$/.test(a) || /^--stdin(?:=true)?$/.test(a);
// docker or podman exec/compose exec: past its options to the command inside; unknown option = null (fail closed)
function innerAfter(args, from, valued, flags) {
  let i = from;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    const name = a.split('=')[0];
    if (valued.has(name)) { if (!a.includes('=')) i++; continue; }
    if (flags.test(a)) continue;
    return null;
  }
  return i < args.length ? args.slice(i + 1).join(' ') : null; // args[i] is the container or service
}
const DOCKER_EXEC_ARG = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys']);
const DOCKER_EXEC_FLAG = /^(?:-[ditT]+|--detach|--interactive(?:=true)?|--tty|--privileged)$/;
const COMPOSE_EXEC_ARG = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--index']);
const COMPOSE_EXEC_FLAG = /^(?:-[dT]+|--detach|--no-TTY|--no-tty|--privileged|--dry-run)$/;
const COMPOSE_RUN_ARG = new Set([...COMPOSE_EXEC_ARG, '--name', '--entrypoint', '-p', '--publish', '-v', '--volume', '-l', '--label', '--pull', '--cap-add', '--cap-drop']);
const COMPOSE_RUN_FLAG = /^(?:-[dTP]+|--detach|--rm|--no-TTY|--no-tty|--no-deps|--service-ports|--use-aliases|--build|--quiet-pull|--remove-orphans|--dry-run)$/;
const DOCKER_GLOBAL_ARG = new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '--url', '--connection']);
const COMPOSE_GLOBAL_ARG = new Set(['-f', '--file', '-p', '--project-name', '--project-directory', '--profile', '--env-file', '--ansi', '--parallel', '--progress']);
const firstWord = (args, from, valued) => {
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) return i;
    if (valued.has(a)) i++;
  }
  return -1;
};

// a session's name, or null; inner commands (bash -c, ssh host cmd, docker exec -i c cmd) are read the same way
function judge(name, args, fed, depth, vars = new Map()) {
  if (args[0] === '--version' || args[0] === '--help') return null;
  const inner = (text) => (text === null || !text.trim() ? null : sessionIn(text, fed, depth + 1, vars));
  if (name === 'eval') return inner(args.join(' ')); // B1: eval's words are a command
  if (SESSION_TTY.has(name)) return name; // B3: fed or not
  // #4658 I2: a runner or find -exec starts a command that gets this one's input, so it is judged the same way
  const started = (words) => {
    if (depth >= SESSION_DEPTH) return 'a command nested deeper than the guard reads';
    const word = words[0].replace(/(?<=.)@[^@/]*$/, ''); // node@20 is node
    // a scoped package (@types/node) is not the program its last part names
    return /^@[^/\\]+\/[^/\\]+$/.test(word) ? null : judge(cmdName(word), words.slice(1), fed, depth + 1, vars);
  };
  if (Object.hasOwn(SESSION_RUNNERS, name)) {
    const r = runnerStarts(SESSION_RUNNERS[name], args);
    if (r) return r.words ? started(r.words) : inner(r.text);
  }
  if (name === 'find') {
    for (let i = 0; i < args.length; i++) {
      if (!FIND_RUNS.has(args[i])) continue;
      let end = i + 1;
      while (end < args.length && args[end] !== ';' && args[end] !== '+') end++;
      const hit = end > i + 1 ? started(args.slice(i + 1, end)) : null;
      if (hit) return hit;
      i = end; // each word is read once
    }
    return null;
  }
  if (name === 'read' || name === 'mapfile' || name === 'readarray' || name === 'select') return fed ? null : name;
  if (POSIX_SHELLS.has(name)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-' || /^-[A-Za-z]*s/.test(a) && !a.startsWith('--')) return fed ? null : `${name} ${a}`;
      if (/^-[A-Za-z]*c/.test(a) && !a.startsWith('--') || a === '--command') return inner(args[i + 1] ?? '');
      if (/^[-+][oO]$/.test(a) || a === '--rcfile' || a === '--init-file') { i++; continue; }
      if (a.startsWith('-') || a.startsWith('+')) continue;
      return null; // a script file
    }
    return fed ? null : name;
  }
  if (name === 'pwsh' || name === 'powershell') {
    if (args.some((a) => /^[-/]noe/i.test(a))) return `${name} -NoExit`;
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === '-') return fed ? null : `${name} -`;
      if (/^[-/](?:c|co|com|comm|comma|comman|command|commandwithargs|cwa|f|fi|fil|file)$/.test(a)) {
        if (args[i + 1] === '-') return fed ? null : `${name} ${args[i]} -`;
        return /^[-/]f/.test(a) ? null : inner(args.slice(i + 1).join(' '));
      }
      if (/^[-/](?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/.test(a)) return null;
      if (/^[-/](?:ex|ep|executionpolicy|wd|workingdirectory|o|outputformat|if|inputformat|w|windowstyle|settingsfile|configurationname|configurationfile|custompipename)$/.test(a)) { i++; continue; }
      if (a.startsWith('-') || a.startsWith('/')) continue;
      return null; // a script
    }
    return fed ? null : name;
  }
  if (name === 'cmd') {
    for (let i = 0; i < args.length; i++) {
      if (/^\/k/i.test(args[i])) return 'cmd /k';
      if (/^\/c/i.test(args[i])) return inner([args[i].slice(2), ...args.slice(i + 1)].join(' '));
    }
    return fed ? null : 'cmd';
  }
  if (name === 'su') {
    const c = args.findIndex((a) => a === '-c' || a === '--command');
    if (c >= 0) return inner(args[c + 1] ?? '');
    return fed ? null : 'su';
  }
  if (name === 'ssh') {
    let host = -1;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-')) {
        if (/^-[A-Za-z]*[nfN]/.test(a)) return null; // no input (-n, -f) or no command (-N)
        if (/^-[A-Za-z]*[BbcDEeFIiJLlmOopQRSWw]$/.test(a)) i++;
        continue;
      }
      host = i;
      break;
    }
    if (host < 0) return null;
    const rest = args.slice(host + 1).join(' ');
    return rest.trim() ? inner(rest) : fed ? null : 'ssh';
  }
  if (name === 'docker' || name === 'podman' || name === 'nerdctl' || name === 'docker-compose' || name === 'podman-compose') {
    let s = name.endsWith('compose') ? -1 : firstWord(args, 0, DOCKER_GLOBAL_ARG);
    let compose = name.endsWith('compose');
    if (s >= 0 && args[s] === 'compose') { compose = true; }
    if (compose) {
      const c = firstWord(args, s + 1, COMPOSE_GLOBAL_ARG);
      if (c < 0) return null;
      const sub = args[c];
      if (sub === 'attach') return `${name} compose attach`;
      if (sub !== 'exec' && sub !== 'run') return null;
      if (args.slice(c + 1).some((a) => /^(?:-i|--interactive)=false$/.test(a))) return null;
      const r = innerAfter(args, c + 1, sub === 'exec' ? COMPOSE_EXEC_ARG : COMPOSE_RUN_ARG, sub === 'exec' ? COMPOSE_EXEC_FLAG : COMPOSE_RUN_FLAG);
      return r === null ? `${name} compose ${sub}` : inner(r);
    }
    if (s < 0) return null;
    const sub = args[s], opts = args.slice(s + 1);
    if (sub === 'attach') return `${name} attach`;
    if (sub === 'start') return opts.some((a) => isI(a)) && opts.some((a) => /^-[A-Za-z]*a|^--attach/.test(a)) ? `${name} start -ai` : null;
    if (sub !== 'exec' && sub !== 'run' && sub !== 'create') return null;
    if (!opts.some((a) => isI(a))) return null; // no -i: the command inside gets no input
    if (sub !== 'exec') return `${name} ${sub} -i`;
    const r = innerAfter(args, s + 1, DOCKER_EXEC_ARG, DOCKER_EXEC_FLAG);
    return r === null ? `${name} exec -i` : inner(r);
  }
  if (name === 'kubectl' || name === 'oc') {
    const s = firstWord(args, 0, new Set(['-n', '--namespace', '--context', '--kubeconfig', '--cluster', '--user', '-s', '--server']));
    if (s < 0) return null;
    const sub = args[s], dd = args.indexOf('--', s);
    const opts = args.slice(s + 1, dd < 0 ? undefined : dd);
    if (sub !== 'exec' && sub !== 'attach' && sub !== 'run' && sub !== 'debug') return null;
    if (!opts.some((a) => isI(a))) return null;
    if (sub !== 'exec' || dd < 0) return `${name} ${sub} -i`;
    return inner(args.slice(dd + 1).join(' ')) ;
  }
  if (fed) return null;
  if (SESSION_ALWAYS.has(name)) return name;
  if (name === 'git') {
    const w = ['git', ...args], j = gitSub(w, 0), spec = GIT_INTERACTIVE[w[j]];
    if (spec) {
      for (const a of w.slice(j + 1)) {
        if (a === '--') break;
        if (a.startsWith('--') ? spec[1].includes(a.split('=')[0]) : /^-[A-Za-z]+$/.test(a) && [...a.slice(1)].some((c) => spec[0].includes(c))) return `git ${w[j]} ${a}`;
      }
    }
    return null;
  }
  if (name === 'crontab') return args.some((a) => /^-[A-Za-z]*e/.test(a)) ? 'crontab -e' : null;
  const interp = INTERP_OF(name);
  if (interp) {
    if (interpMode(SESSION_INTERP[interp], args) === 'session') return name;
    const module = interp === 'python' ? pythonModule(args) : null; // #4658 I1
    if (module && REPL_MODULES.has(module)) return `${name} -m ${module}`;
    const code = args.join(' ');
    return SPAWNS_SHELL.test(code) || CODE_OPENS[interp]?.test(code) ? `${name} code that opens a shell, REPL or debugger` : null;
  }
  if (name === 'deno' || name === 'bun') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub === 'repl' || (name === 'deno' && sub === undefined)) return `${name}${sub ? ` ${sub}` : ''}`;
    // #4658: code given on the command line is read like Node's
    const code = args.some((a) => /^(?:-e|-p|--eval|--print|eval)(?:=|$)/.test(a)) ? args.join(' ') : '';
    return SPAWNS_SHELL.test(code) || CODE_OPENS.node.test(code) ? `${name} code that opens a shell or REPL` : null;
  }
  if (SESSION_CLIENT[name]) return args.includes('-') || !args.some((a) => SESSION_CLIENT[name].test(a)) ? name : null;
  const pos = SESSION_POSITIONAL[name];
  if (pos) {
    let count = 0;
    for (let i = 0; i < args.length; i++) {
      if (pos.exit.test(args[i])) return null;
      if (pos.arg.has(args[i])) { i++; continue; }
      if (!args[i].startsWith('-')) count++;
    }
    return count >= pos.need ? null : name;
  }
  if (name === 'xargs') return args.some((a) => /^(?:-a|--arg-file)(?:=|$)/.test(a) || /^-a./.test(a)) ? null : 'xargs';
  if (name === 'awk' || name === 'gawk' || name === 'mawk' || name === 'nawk') {
    let prog = false, files = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-f' || a === '-e' || a === '--file' || a === '--source') { prog = true; i++; continue; }
      if (a === '-F' || a === '-v' || a === '--assign' || a === '--field-separator') { i++; continue; }
      if (a.startsWith('-') && a !== '-') continue;
      if (!prog) { prog = true; continue; }
      if (a === '-') return name;
      files++;
    }
    return files ? null : name;
  }
  if (name === 'socat') return args.some((a) => a === '-' || /^(?:stdin|stdio|readline|-)(?:[,:]|$)/i.test(a)) ? 'socat' : null;
  return null;
}

// #4776: Git Bash drops every carriage return, quoted ones too, in -c text, a script file and stdin, so a word split by
// one runs. Text holding any is judged without them as well as as written, never instead: PowerShell ends a line at one
function readings(text) { return text.includes('\r') ? [text, text.replaceAll('\r', '')] : [text]; }

// #4803: bash takes a redirect anywhere in a command. One before the command word was read as the command, and the & in
// one (2>&1, &>log) cut the command in two. Text holding a redirect is judged without them too, never instead. << (a
// heredoc) stays. Messages and heredoc data are dropped first: which text is data depends on the redirect (cat > notes
// <<EOF writes its text away). Two readings, since neither is enough: one counts no quotes, so it holds after text that
// throws the count off; one counts them as bash does, into quoted command strings, so a target glued from any pieces
// ("my "log) is one word. A line continuation is also read joined
// a file descriptor of any length: digits are tried from the start of their run only, so a long run is read once
const REDIRECT_MARK = String.raw`(?:(?<!\d)\d+|\*|&|\{[A-Za-z_]\w*\})?(?:<<<|>>|>\||<>|>&|<&|>|(?<!<)<(?![<#(]))&?[ \t]*`;
// part of a target: a substitution (bounded, so the scan stays linear), an escape or a plain character (\x60: a backtick)
const TARGET_PART = String.raw`\$\{[^{}\n]{0,200}\}|\$\([^()\n]{0,200}\)|[<>]\([^()\n]{0,200}\)|\x60[^\x60\n]{0,200}\x60|\\[\s\S]|[^\s"'\x60\\;&|<>(){}]`;
// with no quote count, a quoted part is one where its closing quote ends the word, or a short one with no blank or separator
const LOOSE_QUOTED = String.raw`"(?:\\.|[^"\\\n])*"(?=[\s;&|)]|$)|'[^'\n]*'(?=[\s;&|)]|$)|'[^'\s;&|()<>]{0,200}'|"[^"\\\s;&|()<>$\x60]{0,200}"`;
const REDIRECT = new RegExp(`${REDIRECT_MARK}(?:${LOOSE_QUOTED}|${TARGET_PART})+`, 'g');
const SHELL_NEXT = String.raw`('[^']*'|"(?:\\[\s\S]|[^"\\])*")|\\[\s\S]|${REDIRECT_MARK}`;
const CASE_WORD = /(?<![\w.-])case(?![\w.-])/y; // case.txt and my.case are names
// where the redirect target at i ends, read as one shell word: quotes, $( ), ${ }, <( ), >( ) and backticks nest. -1: it
// does not close. -2: a substitution holds what this count cannot follow (case, a comment, a heredoc). powershell: the
// backtick is the escape and a backslash is plain. One pass
function wordEnd(text, i, powershell) {
  const open = []; // what each open quote or bracket waits for
  if ((text[i] === '<' || text[i] === '>') && text[i + 1] === '(') { open.push(')'); i += 2; }
  for (; i < text.length; i++) {
    const c = text[i], want = open[open.length - 1];
    if (want === "'") { if (c === "'") open.pop(); continue; }
    if (c === (powershell ? '`' : '\\')) { i++; continue; }
    if (want === "$'") { if (c === "'") open.pop(); continue; }
    if (c === '`' && !powershell) { if (want === '`') open.pop(); else open.push('`'); continue; }
    if (c === '$') {
      const next = text[i + 1];
      if (next === '(') { open.push(')'); i++; } else if (next === '{') { open.push('}'); i++; } else if (next === "'" && want !== '"') { open.push("$'"); i++; }
      continue;
    }
    if (c === '"') { if (want === '"') open.pop(); else open.push('"'); continue; }
    if (want === '"') continue;
    if (c === "'") { open.push("'"); continue; }
    if (want === ')') {
      CASE_WORD.lastIndex = i;
      if ((c === '#' && /[\s;&|()]/.test(text[i - 1])) || (c === '<' && text[i + 1] === '<') || CASE_WORD.test(text)) return -2;
      if (c === ')') open.pop(); else if (c === '(') open.push(')');
      continue;
    }
    if (want === '}') { if (c === '}') open.pop(); else if (c === '{') open.push('}'); continue; }
    if (want === '`') continue;
    if (/[\s;&|<>()]/.test(c)) break;
  }
  return open.length ? -1 : Math.min(i, text.length);
}
// a string handed to a shell, as the text just before its quote shows: the shell (or its .exe), any unquoted words, the
// option holding c and any options after it; or eval. The c option splits at its first c, so a long one is read once
const SHELL_STRING = /(?<![\w-])(?:(?:ba|da|z|k)?sh(?:\.[eE][xX][eE])?["']?(?:[ \t]+[^\s"';&|<>()]+)*?[ \t]+-[abd-zA-Z0-9_]*c\w*(?:[ \t]+-[^\s"';&|<>()]*)*|eval(?:[ \t]+--)?)[ \t]+$/;
const SHELL_STRING_REACH = 300; // how far back the shell's name is looked for
// as bash counts quotes: each redirect goes with its whole target. A quoted piece that is no target is read the same way
// inside, a few deep: a command string's own redirects go too. At a target that does not end the reading stops and, for
// shell text (this command's, or a string handed to a shell), says so (lost.found). A target that does not close under
// bash's count is read with PowerShell's, switching at most once, so it stays linear
function shellUnredirected(text, left, depth = 0, lost = {}) {
  const next = new RegExp(SHELL_NEXT, 'g');
  let out = '', done = 0, powershell = false;
  for (let m = next.exec(text); m; m = next.exec(text)) {
    const [match, quoted] = m;
    let swap = match, end = next.lastIndex;
    if (quoted !== undefined) {
      if (depth < 3 && /[<>]/.test(quoted)) {
        const handed = SHELL_STRING.test(text.slice(Math.max(0, m.index - SHELL_STRING_REACH), m.index));
        swap = quoted[0] + shellUnredirected(quoted.slice(1, -1), left, depth + 1, handed ? lost : {}) + quoted[0];
      }
    } else if (!match.startsWith('\\')) {
      let to = wordEnd(text, end, powershell);
      if (to === -1 && !powershell) { powershell = true; to = wordEnd(text, end, true); }
      if (to < 0) {
        lost.found = true;
        break;
      }
      if (to > end) { swap = left(text.slice(m.index, to), m.index, text); end = to; }
    }
    if (swap !== match || end !== next.lastIndex) {
      out += text.slice(done, m.index) + swap;
      done = end;
      next.lastIndex = end;
    }
  }
  return done === 0 ? text : out + text.slice(done);
}
// bash takes a heredoc header before the command word too (<<x cmd), and reads the same with it at the line's end
const HEREDOC_ANY = /(?<!<)<<(?!<)-?[ \t]*(?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s"'\\;&|<>()])+/g;
function headersLast(line) {
  const headers = line.includes('<<') ? line.match(HEREDOC_ANY) : null;
  if (!headers) return line;
  const after = line.slice(line.indexOf(headers[0])).replace(HEREDOC_ANY, ' ');
  return /^[ \t]*[^ \t;&|<>()#]/.test(after) ? `${line.replace(HEREDOC_ANY, ' ')} ${headers.join(' ')}` : line;
}
// a redirect of this shell's whose target does not end: the command behind it cannot be found. Heredoc bodies are another
// program's text, and comments are none
function unplacedRedirect(text) {
  if (!/[<>]/.test(text)) return false;
  const lost = {};
  shellUnredirected(blankComments(replaceHeredocs(stripMessages(text), (_all, line, id) => `${line}\n${id}`)), () => ' ', 0, lost);
  return lost.found === true;
}
// a shell's script by its #! line, or with none by its name: .sh and the like, or no extension at all
const shellScript = (path, text) => (text.startsWith('#!') ? /^#![^\n]*[/ \t](?:ba|da|z|k)?sh(?=\s|$)/.test(text) : /(?:\.(?:sh|bash|zsh|ksh)|(?:^|[\\/])[^\\/.]+)$/i.test(path));
const UNPLACED = 'the guard cannot find where a redirect\'s target ends, so it cannot see the command behind it: split the command, or give the target a plain name';
// cat >file <<WORD at a line's start, with nothing after the header, hides nothing: left as written, so the usual huge
// command, a file written from a heredoc, is judged once. Each test reads a bounded piece
const catToFile = (redirect, at, text) => /^>>?[ \t]*[A-Za-z0-9_./-]+$/.test(redirect) && /(?:^|\n)[ \t]*cat[ \t]+$/.test(text.slice(Math.max(0, at - 40), at))
  && /^[ \t]*<<-?[ \t]*(["']?)\w{1,40}\1[ \t]*(?:\n|$)/.test(text.slice(at + redirect.length, at + redirect.length + 80));
function unredirected(text, left = (redirect, at, all) => (catToFile(redirect, at, all) ? redirect : ' ')) {
  if (!/[<>]/.test(text)) return [text];
  const kept = stripMessages(text), forms = new Set([text]);
  for (const source of new Set([kept, joinLines(kept)])) {
    const lost = {};
    let counted = shellUnredirected(source, left, 0, lost);
    if (lost.found) counted = shellUnredirected(blankComments(source), left); // a comment may be what did not end
    for (const read of [source.replace(REDIRECT, left), counted]) {
      const bare = read.split('\n').map(headersLast).join('\n');
      if (bare !== source) forms.add(bare);
    }
  }
  return [...forms];
}
// for the stdin-session rule only output redirects are left out: an input one is what gives the command its input
const outputOnly = (redirect) => (/^(?:\d+|\*|&|\{\w+\})?>/.test(redirect) ? ' ' : redirect);
// the scripts a text calls, read with and without its redirects; a call both readings show is listed once
function calledIn(text, cwd, deployHost) {
  const calls = scriptCalls(text, cwd, deployHost), [, ...bare] = unredirected(text);
  if (bare.length === 0) return calls;
  const key = (c) => `${c.cwd}\n${c.path}\n${c.deployHost}`, listed = new Set(calls.map(key));
  for (const call of bare.flatMap((b) => scriptCalls(b, cwd, deployHost))) {
    if (listed.has(key(call))) continue;
    listed.add(key(call));
    calls.push(call);
  }
  return calls;
}

export function evaluate(req) {
  const block = (kind, reason) => ({ allow: false, kind, reason });
  try {
    const { tool, command, role = null, protectedBranches = [], allowAsk = false, agent = null, paths, readScript = null, hosts = [], deployHost, stdin = false } = req ?? {};
    if (role !== null && role !== undefined && role !== '' && !ROLES.includes(role)) {
      return block('input', `unknown CB_ROLE ${JSON.stringify(role)}: a squad seat's role is one of ${ROLES.join(', ')}`);
    }
    // #4002 install gate: a pane with CB_AGENT is a board seat (cb squad up sets CB_AGENT and CB_ROLE together), so no
    // role there means a broken launch, never a hand-started session: block rather than skip every role rule.
    if (!role && typeof agent === 'string' && agent.trim()) {
      return block('input', `CB_ROLE is not set in this board seat (CB_AGENT=${JSON.stringify(agent.trim()).slice(0, 40)} is), so no role rule could apply: start the session with cb squad up, which sets both`);
    }
    if (tool === 'shell') {
      if (typeof command !== 'string') return block('input', 'guard could not read hook input (the command is not a string)');
      const spellings = readings(command).flatMap((r) => unredirected(r)); // #4776, #4803
      for (const written of spellings) {
        // #4737: judged as written, then with split and built names read out (only when that changes something)
        const shown = revealed(written);
        for (const text of shown === written ? [written] : [written, shown]) {
          const danger = check(text);
          if (danger) return block('dangerous', danger);
          const branch = protectedPush(text, Array.isArray(protectedBranches) ? protectedBranches : []);
          if (branch) return block('dangerous', pushReason(branch));
          const byRole = checkRole(text, role, { readScript, hosts, deployHost });
          if (byRole) return block('role', byRole);
        }
      }
      if (readings(command).some(unplacedRedirect)) return block('input', UNPLACED);
      // #4626: only where the tool keeps a stdin open (Codex's exec_command) and only in a role seat
      const typed = stdin === true && role ? readings(command).flatMap((r) => unredirected(r, outputOnly)) : [];
      const session = typed.map((text) => stdinSession(text)).find(Boolean) ?? null;
      return session ? block('role', SESSION(session)) : { allow: true };
    }
    // a plan update (Codex update_plan) changes nothing outside the session, like Claude's own plan tool
    if (tool === 'plan') return { allow: true };
    if (tool === 'edit') {
      if (READ_ONLY_ROLES.includes(role)) return block('role', `editing files: ${readsOnly(role)}`);
      // A shim that passes paths (an adapter's native edit tool, #4002) gets the fence and the secret rule on each, as a
      // shell command does; no target it could read blocks. Like the shell fence, only for a role seat.
      if (role && paths !== undefined) {
        if (!Array.isArray(paths) || paths.length === 0) return block('input', 'guard could not read the edit\'s target path: an edit whose target the guard cannot see is blocked');
        for (const p of paths) {
          const why = editFence(p);
          if (why) return block('role', why);
        }
      }
      return { allow: true };
    }
    // an adapter's native read tool (OpenCode read, grep, glob, list): no secret file into the context (#4347), like a
    // shell read; reading is otherwise open to every role
    if (tool === 'read') {
      if (role && Array.isArray(paths) && paths.some((p) => secretPath(p))) return block('role', SECRET);
      return { allow: true };
    }
    if (tool === 'ask') return allowAsk === true ? { allow: true } : block('ask', ASK);
    return block('input', `unrecognized tool (${JSON.stringify(tool) ?? 'none'})`);
  } catch (e) {
    return block('input', `guard error (${String(e?.message ?? e).slice(0, 200)})`);
  }
}
