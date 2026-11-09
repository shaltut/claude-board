// cb tick: the actions due now in one project, most urgent first, one person and one command per line.
// Board data from cb.tick (read-only); PR state from GitHub through gh, cached 5 minutes.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callFn } from '../server/rpc.ts';
import { dotenv } from '../server/db.ts';

export const dur = (m: number) => (m === Infinity ? 'never' : m < 60 ? `${Math.round(m)}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`);
const mins = (t: any) => (t ? (Date.now() - +new Date(t)) / 60000 : Infinity);
const ago = (t: any) => dur(mins(t));
const cut = (s: any, n = 100) => { const v = String(s ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
// A single-quoted shell argument: nothing expands in bash or PowerShell.
const q = (s: string) => `'${s.replace(/'/g, '’')}'`;

type Item = { section: string; who: string; text: string; cmd: string | null; detail?: string };
type Pr = { state: string; head: string; mergeable: string };

const SECTIONS: [string, string][] = [
  ['answers', 'ANSWERS NOT ACTED ON'], ['questions', 'YOUR OPEN QUESTIONS'], ['ready', 'READY TO MERGE'], ['stuck', 'STUCK'],
  ['idle', 'IDLE'], ['github', 'BOARD VS GITHUB'], ['locks', 'LOCKS'], ['huddles', 'HUDDLES'],
];

/** owner/repo and number of a PR link: a GitHub URL, or "#2800" with GITHUB_REPO_<PROJECT> from the env or .env. */
function prRef(link: string, project: string) {
  const u = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(link);
  if (u) return { repo: u[1], n: u[2] };
  const n = /(\d+)\/?$/.exec(link)?.[1];
  const key = `GITHUB_REPO_${project.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const repo = process.env[key] || dotenv(key);
  return n && repo ? { repo, n } : null;
}

/** State of each PR ("owner/repo#n" → Pr): one gh graphql call per repo for what the cache doesn't hold. */
function github(refs: { repo: string; n: string }[]): { prs: Record<string, Pr>; skipped: string | null } {
  const file = process.env.CB_GH_CACHE || join(tmpdir(), 'cb-gh-cache.json');
  let cache: Record<string, Pr & { at: number }> = {};
  try { cache = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  const fresh = (k: string) => cache[k] && Date.now() - cache[k].at < 5 * 60_000;
  const want = new Map<string, Set<string>>();
  for (const r of refs) if (!fresh(`${r.repo}#${r.n}`)) (want.get(r.repo) ?? want.set(r.repo, new Set()).get(r.repo)!).add(r.n);
  const prs: Record<string, Pr> = {};
  for (const r of refs) if (fresh(`${r.repo}#${r.n}`)) prs[`${r.repo}#${r.n}`] = cache[`${r.repo}#${r.n}`];
  let skipped: string | null = null;
  for (const [repo, ns] of want) {
    const [owner, name] = repo.split('/');
    const list = [...ns];
    for (let i = 0; i < list.length && !skipped; i += 50) {
      const fields = list.slice(i, i + 50).map((n) => `p${n}: pullRequest(number: ${n}) { state headRefOid mergeable }`).join(' ');
      const args = ['api', 'graphql', '-f', `query=query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`];
      // CB_GH: a node script standing in for gh (tests)
      const r = process.env.CB_GH ? spawnSync(process.execPath, [process.env.CB_GH, ...args], { encoding: 'utf8', timeout: 20_000 })
        : spawnSync('gh', args, { encoding: 'utf8', timeout: 20_000 });
      // gh exits 1 when one PR number doesn't exist but still prints the others: trust the JSON, not the exit code
      let data: any;
      try { data = JSON.parse(r.stdout).data?.repository; } catch {}
      if (!data) { skipped = r.error ? `gh not runnable (${r.error.message})` : `gh failed (${cut(r.stderr.trim().split('\n')[0] || `exit ${r.status}`, 120)})`; break; }
      for (const [k, v] of Object.entries<any>(data)) {
        if (!v) continue;
        // mergeable is often UNKNOWN (GitHub computes it lazily): it reads as not conflicting; gh pr merge says if it is
        const key = `${repo}#${k.slice(1)}`;
        prs[key] = { state: v.state, head: v.headRefOid, mergeable: v.mergeable };
        cache[key] = { ...prs[key], at: Date.now() };
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

  for (const a of b.answered) {
    const mine = a.who === actor;
    add('answers', a.who, `Q${a.id} answered ${ago(a.answered_at)} ago, ${a.who} acts`,
      mine ? `cb delivered ${a.id}` : `cb tell ${a.who} ${q(`Q${a.id}: ${cut(a.answer, 300)}`)} && cb delivered ${a.id} ${a.who}`,
      `asked: ${cut(a.body)}${mine ? ` · answer: ${cut(a.answer, 300)}` : ''}`);
  }
  for (const x of b.my_questions)
    add('questions', x.for, `Q${x.id} open ${ago(x.created_at)}, ${x.for}: ${cut(x.body)}${x.no_options ? ' ⚠ no options' : ''}`,
      x.no_options ? `cb withdraw ${x.id}` : null, x.no_options ? 'then ask again with -o "Label (Recommended)=why" -o ...' : undefined);

  // GitHub: one lookup for every PR the board mentions
  const prs = b.prs.map((t: any) => ({ ...t, ref: prRef(t.pr, project) }));
  const refs = prs.filter((t: any) => t.ref).map((t: any) => t.ref);
  const gh = refs.length ? github(refs) : { prs: {}, skipped: null };
  const stateOf = (t: any) => (t.ref ? gh.prs[`${t.ref.repo}#${t.ref.n}`] : undefined);
  const prKey = (t: any) => (t.ref ? `${t.ref.repo}#${t.ref.n}` : `?${t.pr}`);
  const flag = (t: any) => (t.ref ? ` -R ${t.ref.repo}` : '');

  // Ready to merge: per PR, the latest finished review decides; skipped while another review of it is open.
  const byPr = new Map<string, any[]>();
  for (const t of prs.filter((t: any) => t.review)) (byPr.get(prKey(t)) ?? byPr.set(prKey(t), []).get(prKey(t))!).push(t);
  for (const reviews of byPr.values()) {
    if (reviews.some((t: any) => !['done', 'cancelled'].includes(t.status))) continue;
    const last = reviews.filter((t: any) => t.status === 'done').sort((x: any, y: any) => +new Date(y.done_at) - +new Date(x.done_at))[0];
    const pr = last && stateOf(last);
    if (!last?.go || !last.commit || pr?.state !== 'OPEN') continue;
    const n = last.ref.n, c = String(last.commit).toLowerCase(), head = pr.head.toLowerCase();
    const author = prs.filter((t: any) => !t.review && prKey(t) === prKey(last) && t.assignee).pop()?.assignee;
    if (pr.mergeable === 'CONFLICTING')
      add('ready', author ?? actor, `#${n} GO@${last.commit} CONFLICTING`,
        author ? `cb tell ${author} ${q(`#${n} conflicts with its base: rebase it, then ask for a delta review`)}`
          : `cb add ${project} ${q(`Rebase #${n} (conflicts with its base)`)} -s next --link pr=${last.pr}`);
    else if (head.startsWith(c) || c.startsWith(head))
      add('ready', actor, `#${n} GO@${last.commit} = head (review #${last.id})`, `gh pr merge ${n}${flag(last)}`);
    else
      add('ready', actor, `#${n} GO@${last.commit}, HEAD MOVED to ${head.slice(0, 10)}`,
        `cb add ${project} ${q(`Delta review #${n} ${last.commit}..${head.slice(0, 10)}`)} -s next -l review --link pr=${last.pr}`);
  }

  for (const t of b.silent)
    add('stuck', t.assignee, `#${t.id} ${t.assignee} silent ${ago(t.last_at)} (in progress)`,
      `cb tell ${t.assignee} ${q(`#${t.id} ${cut(t.title, 60)}: still on it? cb log, or cb move it`)}`);
  for (const t of b.blocked) {
    const onQ = t.question && t.question_status === 'open';
    const reason = t.question ? `on Q${t.question} (${t.question_status}${onQ ? `, ${t.question_for}` : ''}): ${cut(t.question_body, 80)}`
      : /→ blocked$/.test(t.note ?? '') || !t.note ? 'no reason given' : cut(t.note, 100);
    add('stuck', onQ ? t.question_for : t.assignee ?? actor, `#${t.id} blocked ${ago(t.since)}, ${t.assignee ?? 'unassigned'}: ${reason}`,
      onQ ? null : t.assignee ? `cb tell ${t.assignee} ${q(`#${t.id} blocked ${ago(t.since)}: what unblocks it?`)}` : `cb move ${t.id} next`);
  }
  for (const t of b.unreviewed)
    add('stuck', actor, `#${t.id} in review, no reviewer task (${t.assignee ?? 'unassigned'})`,
      `cb add ${project} ${q(`Review #${t.id} (${t.assignee ?? 'unassigned'}): ${cut(t.title, 60)}`)} -s next -l review${t.pr ? ` --link pr=${t.pr}` : ''}`);
  for (const t of prs.filter((t: any) => !t.review && !t.reviewed && t.status === 'done' && stateOf(t)?.state === 'OPEN'))
    add('stuck', actor, `#${t.id} done, PR #${t.ref.n} open, no reviewer task (${t.assignee ?? 'unassigned'})`,
      `cb add ${project} ${q(`Review #${t.ref.n} (${t.assignee ?? 'unassigned'}, #${t.id}): ${cut(t.title, 60)}`)} -s next -l review --link pr=${t.pr}`);
  for (const t of b.misheld)
    add('stuck', actor, `#${t.id} assigned ${t.assignee}, ${t.by} works it`, `cb edit ${t.id} --assignee ${t.by}`);

  // Idle: the first unassigned Next task sharing a tag, else the first unassigned one; each task offered once.
  const free = b.next.filter((t: any) => !t.assignee), workless: string[] = [];
  for (const s of b.idle) {
    const i = Math.max(0, free.findIndex((t: any) => t.labels.some((l: string) => s.tags.includes(l))));
    const t = free.splice(i, 1)[0];
    if (t) add('idle', s.actor, `${s.actor} idle`, `cb tell ${s.actor} ${q(`take #${t.id} ${cut(t.title, 60)}`)}`);
    else workless.push(s.actor);
  }
  if (workless.length) add('idle', actor, `${workless.join(', ')} idle, nothing unassigned in Next`, `cb add ${project} '<title>' -s next`);

  for (const t of prs) {
    const pr = stateOf(t);
    if (!pr) continue;
    const n = t.ref.n, open = !['done', 'cancelled'].includes(t.status);
    if (open && pr.state === 'MERGED') add('github', actor, `#${t.id} ${t.status} but PR #${n} merged`, `cb done ${t.id} ${q(`PR #${n} merged`)}`);
    else if (open && pr.state === 'CLOSED') add('github', actor, `#${t.id} ${t.status} but PR #${n} closed unmerged`, `cb move ${t.id} cancelled ${q(`PR #${n} closed unmerged`)}`);
    else if (t.status === 'cancelled' && pr.state === 'OPEN') add('github', actor, `#${t.id} cancelled but PR #${n} open`, `gh pr close ${n}${flag(t)}`);
    else if (t.status === 'done' && !t.review && pr.state === 'CLOSED') add('github', actor, `#${t.id} done but PR #${n} closed unmerged`, `cb move ${t.id} next ${q(`PR #${n} closed unmerged`)}`);
  }

  for (const l of b.locks.filter((l: any) => l.holder && (l.queue.length || mins(l.held_at) > 60)))
    add('locks', l.holder, `lock ${l.name}: ${l.holder} holds it ${ago(l.held_at)}${l.queue.length ? `, queue ${l.queue.join(', ')}` : ''}`,
      `cb tell ${l.holder} ${q(l.queue.length ? `release lock ${l.name} when done: ${l.queue.length} waiting` : `still need lock ${l.name}? cb lock release ${l.name}`)}`);
  for (const h of b.huddles)
    add('huddles', actor, `huddle #${h.id} ${q(cut(h.topic, 60))} quiet ${ago(h.last_at)}`, `cb huddle close ${h.id} '<outcome>'`);

  const order = SECTIONS.map(([k]) => k);
  items.sort((x, y) => order.indexOf(x.section) - order.indexOf(y.section));
  const skip = gh.skipped ? `GitHub checks skipped: ${gh.skipped}` : '';
  const out = SECTIONS.flatMap(([k, title]) => {
    const rows = items.filter((i) => i.section === k);
    return rows.length ? [title, ...rows.flatMap((i) => [`  ${i.text}${i.cmd ? ` → ${i.cmd}` : ''}`, ...(i.detail ? [`    ${i.detail}`] : [])])] : [];
  });
  if (skip) out.push(skip);
  return { out: out.join('\n'), json: { project, actor, items, github: { checked: refs.length, skipped: gh.skipped } } };
}
