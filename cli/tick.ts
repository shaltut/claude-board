// cb tick: the actions due now in one project, most urgent first, one person and one command per line.
// Board data from cb.tick (read-only); PR state from GitHub through gh, cached 5 minutes (1 for a PR about to be merged).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callFn } from '../server/rpc.ts';
import { dotenv } from '../server/db.ts';
import { backWhy, reaskHint, flat } from './help.ts';

export const dur = (m: number) => (m === Infinity ? 'never' : m < 60 ? `${Math.round(m)}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`);
const mins = (t: any) => (t ? (Date.now() - +new Date(t)) / 60000 : Infinity);
const ago = (t: any) => dur(mins(t));
const cut = (s: any, n = 100) => { const v = String(s ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
// One shell argument, inert in bash and PowerShell: a safe word as is, else single-quoted with every quote doubled.
// PowerShell also reads ‘ ’ ‚ ‛ as single quotes; in bash '' just closes and reopens the quote.
export const q = (s: any) => { const v = String(s); return /^\w[\w@.:/=-]*$/.test(v) ? v : `'${v.replace(/['‘’‚‛]/g, "''")}'`; };

type Item = { section: string; who: string; text: string; cmd: string | null; detail?: string };
type Pr = { state: string; head: string; mergeable: string };

const SECTIONS: [string, string][] = [
  ['asks', "AHMED'S ASKS, LATE"], ['answers', 'ANSWERS NOT ACTED ON'], ['questions', 'YOUR OPEN QUESTIONS'], ['ready', 'READY TO MERGE'],
  ['conditional', 'GO WITH CONDITIONS (check first)'], ['stuck', 'STUCK'],
  ['idle', 'IDLE'], ['github', 'BOARD VS GITHUB'], ['locks', 'LOCKS'], ['huddles', 'HUDDLES'],
];
// ponytail: wording heuristic until Ahmed sets a GO policy (e.g. a GO-IF marker): a condition word or a Q<n> after the GO
const CONDITION = /\b(if|after|once|until|pending|conditional|conditions?|waits?|blocked on)\b|\bQ\d+\b/i;
const conditional = (verdict: string) => { const i = verdict.search(/\bGO\b/); return i >= 0 && CONDITION.test(verdict.slice(i + 2)); };
const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

/** owner/repo and number of a PR link: a GitHub URL, or "#2800" with GITHUB_REPO_<PROJECT> from the env or .env. */
function prRef(link: string, project: string) {
  const u = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(link);
  const key = `GITHUB_REPO_${project.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const repo = u ? u[1] : process.env[key] || dotenv(key), n = u ? u[2] : /(\d+)\/?$/.exec(link)?.[1];
  return n && repo && REPO.test(repo) ? { repo, n } : null;  // a repo that isn't owner/name never reaches gh
}

/** State of each PR ("owner/repo#n" → Pr): one gh graphql call per repo for what the cache doesn't hold fresh
 *  (ttl per PR). A repo gh can't read is skipped, and its failure cached a minute. */
function github(refs: { repo: string; n: string }[], ttl: (key: string) => number) {
  const file = process.env.CB_GH_CACHE || join(tmpdir(), 'cb-gh-cache.json');
  let cache: Record<string, any> = {};
  try { const c = JSON.parse(readFileSync(file, 'utf8')); if (c && typeof c === 'object' && !Array.isArray(c)) cache = c; } catch {}
  const age = (e: any) => (e && typeof e === 'object' && typeof e.at === 'number' && e.at <= Date.now() ? Date.now() - e.at : Infinity);
  const isPr = (e: any) => typeof e?.state === 'string' && typeof e?.head === 'string' && SHA.test(e.head);
  const prs: Record<string, Pr> = {}, skipped: string[] = [], want = new Map<string, Set<string>>();
  for (const { repo, n } of refs) {
    const k = `${repo}#${n}`;
    if (isPr(cache[k]) && age(cache[k]) < ttl(k)) prs[k] = cache[k];
    else (want.get(repo) ?? want.set(repo, new Set()).get(repo)!).add(n);
  }
  for (const [repo, ns] of want) {
    const failed = cache[`!${repo}`];
    if (typeof failed?.error === 'string' && age(failed) < 60_000) { skipped.push(`${repo}: ${failed.error}`); continue; }
    const [owner, name] = repo.split('/'), list = [...ns];
    for (let i = 0; i < list.length; i += 50) {
      const fields = list.slice(i, i + 50).map((n) => `p${n}: pullRequest(number: ${n}) { state headRefOid mergeable }`).join(' ');
      const args = ['api', 'graphql', '-f', `query=query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`];
      // CB_GH: a node script standing in for gh (tests)
      const r = process.env.CB_GH ? spawnSync(process.execPath, [process.env.CB_GH, ...args], { encoding: 'utf8', timeout: 20_000 })
        : spawnSync('gh', args, { encoding: 'utf8', timeout: 20_000 });
      // gh exits 1 when one PR number doesn't exist but still prints the others: trust the JSON, not the exit code
      let data: any;
      try { data = JSON.parse(r.stdout).data?.repository; } catch {}
      if (!data || typeof data !== 'object') {
        const error = r.error ? `gh not runnable (${r.error.message})` : `gh failed (${cut(r.stderr.trim().split('\n')[0] || `exit ${r.status}`, 120)})`;
        cache[`!${repo}`] = { error, at: Date.now() };
        skipped.push(`${repo}: ${error}`);
        break;
      }
      for (const [k, v] of Object.entries<any>(data)) {
        const pr = { state: v?.state, head: String(v?.headRefOid ?? '').toLowerCase(), mergeable: v?.mergeable };
        if (!isPr(pr)) continue;
        prs[`${repo}#${k.slice(1)}`] = pr;
        // GitHub computes mergeability lazily: an open PR's UNKNOWN is asked again next time, never cached
        if (!(pr.state === 'OPEN' && pr.mergeable === 'UNKNOWN')) cache[`${repo}#${k.slice(1)}`] = { ...pr, at: Date.now() };
      }
    }
  }
  if (want.size) try { writeFileSync(file, JSON.stringify(cache)); } catch {}
  return { prs, skipped };
}

export async function tick(project: string, actor: string) {
  const b: any = await callFn('tick', { project, actor });
  const items: Item[] = [];
  const add = (section: string, who: string, text: string, cmd: string | null, detail?: string) => items.push({ section, who, text, cmd, ...(detail ? { detail } : {}) });
  const P = q(project);

  // #936: Ahmed asked this session, it was pushed (and pushed once more), and still no reply
  for (const a of b.late_asks ?? [])
    add('asks', actor, `A${a.id} ${a.from_terminal ? 'asked in your terminal' : 'from Ahmed'}, no reply for ${ago(a.delivered_at)}: ${cut(flat(a.body))}`, `cb reply A${a.id} "<reply>"`);

  for (const a of b.answered) {
    const mine = a.who === actor;
    add('answers', a.who, `Q${a.id} answered ${ago(a.answered_at)} ago, ${a.who} acts`,
      mine ? `cb delivered ${a.id}` : `cb tell ${q(a.who)} ${q(`Q${a.id}: ${cut(a.answer, 300)}`)} && cb delivered ${a.id} ${q(a.who)}`,
      `asked: ${cut(a.body)}${mine ? ` · answer: ${cut(a.answer, 300)}` : ''}`);
  }
  for (const x of b.my_questions)
    if (x.status === 'sent_back') { const s = x.sent_back; // #616: it waits on me now
      add('questions', actor, `Q${x.id} sent back ${ago(s.at)}, ${s.by}: ${cut(backWhy(s.reason, s.note), 300)}`, reaskHint(x.id), `asked: ${cut(x.body)}`);
    } else add('questions', x.for, `Q${x.id} open ${ago(x.created_at)}, ${x.for}: ${cut(x.body)}${x.no_options ? ' ⚠ no options' : ''}`,
      x.no_options ? `cb withdraw ${x.id}` : null, x.no_options ? 'then ask again with -o "Label (Recommended)=why" -o ...' : undefined);

  const prs = b.prs.map((t: any) => ({ ...t, ref: prRef(t.pr, project) }));
  const prKey = (t: any) => (t.ref ? `${t.ref.repo}#${t.ref.n}` : `?${t.pr}`);
  const link = (t: any) => `--link ${q(`pr=${t.pr}`)}`;
  const R = (t: any) => `-R ${q(t.ref.repo)}`;

  // Ready to merge (board side): per PR, the latest finished review decides; skipped while another review of it is open.
  const byPr = new Map<string, any[]>();
  for (const t of prs.filter((t: any) => t.review && t.ref)) (byPr.get(prKey(t)) ?? byPr.set(prKey(t), []).get(prKey(t))!).push(t);
  const ready = [...byPr.values()].flatMap((reviews) => {
    if (reviews.some((t: any) => !['done', 'cancelled'].includes(t.status))) return [];
    const last = reviews.filter((t: any) => t.status === 'done').sort((x: any, y: any) => +new Date(y.done_at) - +new Date(x.done_at))[0];
    return last?.go && last.commit ? [last] : [];
  });

  // GitHub: one lookup for every PR the board mentions; a PR about to be merged is re-checked if over a minute old
  const refs = prs.filter((t: any) => t.ref).map((t: any) => t.ref);
  const soon = new Set(ready.map(prKey));
  const gh = refs.length ? github(refs, (k) => (soon.has(k) ? 60_000 : 5 * 60_000)) : { prs: {} as Record<string, Pr>, skipped: [] };
  const stateOf = (t: any) => (t.ref ? gh.prs[prKey(t)] : undefined);
  // A merge candidate GitHub hasn't computed mergeability for: our query just triggered it, so ask once more shortly.
  const unknown = ready.filter((t: any) => stateOf(t)?.state === 'OPEN' && stateOf(t)?.mergeable === 'UNKNOWN').map((t: any) => t.ref);
  if (unknown.length) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    Object.assign(gh.prs, github(unknown, () => 0).prs);
  }

  for (const last of ready) {
    const pr = stateOf(last);
    if (pr?.state !== 'OPEN') continue;
    const n = last.ref.n, c = String(last.commit).toLowerCase();
    const author = prs.filter((t: any) => !t.review && prKey(t) === prKey(last) && t.assignee).pop()?.assignee;
    // only a real merge command goes in READY; a conflict or a moved head is work (STUCK)
    const merge = `gh pr merge ${n} ${R(last)} --match-head-commit ${pr.head}`;  // gh refuses if the head moved after this check
    const said = `"${cut(last.verdict, 70)}"`;
    if (pr.mergeable === 'CONFLICTING')
      add('stuck', author ?? actor, `#${n} GO@${last.commit} CONFLICTING`,
        author ? `cb tell ${q(author)} ${q(`#${n} conflicts with its base: rebase it, then ask for a delta review`)}`
          : `cb add ${P} ${q(`Rebase #${n} (conflicts with its base)`)} -s next ${link(last)}`);
    else if (!(/^[0-9a-f]{7,40}$/.test(c) && pr.head.startsWith(c)))
      add('stuck', actor, `#${n} GO@${last.commit}, HEAD MOVED to ${pr.head.slice(0, 10)}`,
        `cb add ${P} ${q(`Delta review #${n} ${last.commit}..${pr.head.slice(0, 10)}`)} -s next -l review ${link(last)}`);
    else if (conditional(last.verdict ?? ''))
      add('conditional', actor, `#${n} GO (conditional): ${said}`, `check, then ${merge}`);
    else if (pr.mergeable === 'UNKNOWN')
      add('conditional', actor, `#${n} GO@${last.commit} = head, GitHub has not computed mergeability yet: ${said}`, `check, then ${merge}`);
    else
      add('ready', actor, `#${n} GO@${last.commit} = head (review #${last.id}): ${said}`, merge);
  }

  for (const t of b.silent)
    add('stuck', t.assignee, `#${t.id} ${t.assignee} silent ${ago(t.last_at)} (in progress)`,
      `cb tell ${q(t.assignee)} ${q(`#${t.id} ${cut(t.title, 60)}: still on it? cb log, or cb move it`)}`);
  for (const t of b.blocked) {
    const onQ = t.question && t.question_status === 'open', back = t.question && t.question_status === 'sent_back';
    const reason = t.question ? `on Q${t.question} (${back ? 'sent back, waiting for the rewrite' : t.question_status}${onQ ? `, ${t.question_for}` : ''}): ${cut(t.question_body, 80)}`
      : /→ blocked$/.test(t.note ?? '') || !t.note ? 'no reason given' : cut(t.note, 100);
    add('stuck', onQ ? t.question_for : t.assignee ?? actor, `#${t.id} blocked ${ago(t.since)}, ${t.assignee ?? 'unassigned'}: ${reason}`,
      onQ || back ? null : t.assignee ? `cb tell ${q(t.assignee)} ${q(`#${t.id} blocked ${ago(t.since)}: what unblocks it?`)}` : `cb move ${t.id} next`);
  }
  for (const t of b.unreviewed)
    add('stuck', actor, `#${t.id} in review, no reviewer task (${t.assignee ?? 'unassigned'})`,
      `cb add ${P} ${q(`Review #${t.id} (${t.assignee ?? 'unassigned'}): ${cut(t.title, 60)}`)} -s next -l review${t.pr ? ` ${link(t)}` : ''}`);
  for (const t of prs.filter((t: any) => !t.review && !t.reviewed && t.status === 'done' && stateOf(t)?.state === 'OPEN'))
    add('stuck', actor, `#${t.id} done, PR #${t.ref.n} open, no reviewer task (${t.assignee ?? 'unassigned'})`,
      `cb add ${P} ${q(`Review #${t.ref.n} (${t.assignee ?? 'unassigned'}, #${t.id}): ${cut(t.title, 60)}`)} -s next -l review ${link(t)}`);
  for (const t of b.misheld)
    add('stuck', actor, `#${t.id} assigned ${t.assignee}, ${t.by} works it`, `cb edit ${t.id} --assignee ${q(t.by)}`);

  // Idle: the first unassigned Next task sharing a tag, else the first unassigned one; each task offered once.
  const free = b.next.filter((t: any) => !t.assignee), workless: string[] = [];
  for (const s of b.idle) {
    const i = Math.max(0, free.findIndex((t: any) => t.labels.some((l: string) => s.tags.includes(l))));
    const t = free.splice(i, 1)[0];
    if (t) add('idle', s.actor, `${s.actor} idle`, `cb tell ${q(s.actor)} ${q(`take #${t.id} ${cut(t.title, 60)}`)}`);
    else workless.push(s.actor);
  }
  if (workless.length) add('idle', actor, `${workless.join(', ')} idle, nothing unassigned in Next`, `cb add ${P} '<title>' -s next`);

  for (const t of prs) {
    const pr = stateOf(t);
    if (!pr) continue;
    const n = t.ref.n, open = !['done', 'cancelled'].includes(t.status);
    if (open && pr.state === 'MERGED') add('github', actor, `#${t.id} ${t.status} but PR #${n} merged`, `cb done ${t.id} ${q(`PR #${n} merged`)}`);
    else if (open && pr.state === 'CLOSED') add('github', actor, `#${t.id} ${t.status} but PR #${n} closed unmerged`, `cb move ${t.id} cancelled ${q(`PR #${n} closed unmerged`)}`);
    else if (t.status === 'cancelled' && pr.state === 'OPEN') add('github', actor, `#${t.id} cancelled but PR #${n} open`, `gh pr close ${n} ${R(t)}`);
    else if (t.status === 'done' && !t.review && pr.state === 'CLOSED') add('github', actor, `#${t.id} done but PR #${n} closed unmerged`, `cb move ${t.id} next ${q(`PR #${n} closed unmerged`)}`);
  }

  // Locks: someone waiting, held over an hour, or a holder silent 30 minutes (no relay, no event: likely dead → --force)
  for (const l of b.locks) {
    const silent = mins(l.holder_seen) > 30;
    if (!l.holder || !(l.queue.length || mins(l.held_at) > 60 || silent)) continue;
    add('locks', silent ? actor : l.holder,
      `lock ${l.name}: ${l.holder} holds it ${ago(l.held_at)}${l.queue.length ? `, queue ${l.queue.join(', ')}` : ''}${silent ? `, holder silent ${ago(l.holder_seen)}` : ''}`,
      silent ? `cb lock release ${q(l.name)} --force`
        : `cb tell ${q(l.holder)} ${q(l.queue.length ? `release lock ${l.name} when done: ${l.queue.length} waiting` : `still need lock ${l.name}? cb lock release ${l.name}`)}`);
  }
  for (const h of b.huddles)
    add('huddles', actor, `huddle #${h.id} ${q(cut(h.topic, 60))} quiet ${ago(h.last_at)}`, `cb huddle close ${h.id} '<outcome>'`);

  const out = SECTIONS.flatMap(([k, title]) => {
    const rows = items.filter((i) => i.section === k);
    return rows.length ? [title, ...rows.flatMap((i) => [`  ${i.text}${i.cmd ? ` → ${i.cmd}` : ''}`, ...(i.detail ? [`    ${i.detail}`] : [])])] : [];
  });
  for (const s of gh.skipped) out.push(`GitHub checks skipped for ${s}`);
  const order = SECTIONS.map(([k]) => k);
  items.sort((x, y) => order.indexOf(x.section) - order.indexOf(y.section));
  return { out: out.join('\n'), json: { project, actor, items, github: { checked: refs.length, skipped: gh.skipped } } };
}
