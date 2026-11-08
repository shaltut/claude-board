// Read queries for the UI. Writes always go through cb.* functions.
import { sql } from './db.ts';

const proj = (p?: string) => (p ? sql`and project = ${p}` : sql``);

export const projects = () => sql`
  select p.slug, p.name, p.color, p.repo_path,
    (select count(*)::int from cb.tasks t where t.project = p.slug and t.status not in ('done','cancelled','backlog')) as open_count,
    (select count(*)::int from cb.questions q where q.project = p.slug and q.status = 'open') as question_count
  from cb.projects p where not p.archived order by p.name`;

export function tasks(project?: string, status?: string) {
  const filter = status
    ? sql`status = ${status}`
    : sql`status <> 'cancelled' and (status <> 'done' or done_at > now() - interval '7 days')`;
  return sql`select * from cb.tasks where ${filter} ${proj(project)} order by status, priority, rank, id`;
}

export async function task(id: number) {
  const [t] = await sql`select * from cb.tasks where id = ${id}`;
  if (!t) return null;
  const [events, questions] = await Promise.all([
    sql`select * from cb.events where task_id = ${id} order by at desc, id desc`,
    sql`select * from cb.questions where task_id = ${id} order by id desc`,
  ]);
  return { task: t, events, questions };
}

export function questions(project?: string, status?: string) {
  return sql`select * from cb.questions where true ${proj(project)} ${status ? sql`and status = ${status}` : sql``}
    order by (status = 'open') desc, blocking desc, created_at`;
}

export function events(f: { project?: string; actor?: string; kind?: string; notKind?: string; since?: string; before?: string; q?: string; limit?: number }) {
  const kinds = f.kind ? f.kind.split(',') : null;
  return sql`select * from cb.events where true ${proj(f.project)}
    ${f.actor ? sql`and actor = ${f.actor}` : sql``}
    ${kinds ? sql`and kind in ${sql(kinds)}` : sql``}
    ${f.notKind ? sql`and kind <> ${f.notKind}` : sql``}
    ${f.since ? sql`and at > ${f.since}` : sql``}
    ${f.before ? sql`and at < ${f.before}` : sql``}
    ${f.q ? sql`and summary ilike ${'%' + f.q + '%'}` : sql``}
    order by at desc, id desc limit ${Math.min(f.limit ?? 100, 500)}`;
}

export async function today(project: string | undefined, since: string) {
  const [[counts], evs] = await Promise.all([
    sql`select
        (select count(*)::int from cb.tasks where status = 'done' and done_at > ${since} ${proj(project)}) as done,
        (select count(*)::int from cb.tasks where status = 'in_progress' ${proj(project)}) as active,
        (select count(*)::int from cb.tasks where status = 'blocked' ${proj(project)}) as blocked`,
    events({ project, since, limit: 500, notKind: 'huddle' }), // huddle chatter lives on its task and the Huddles page
  ]);
  return { since, counts, events: evs };
}

export async function lastSeen() {
  const [r] = await sql`select cb.last_seen() as at`;
  return { at: r.at };
}

export async function sessions(project?: string) {
  const [{ o }] = await sql`select cb.sessions_overview(${project ?? null}) as o`;
  return o;
}

export async function huddles(project?: string) {
  const [{ l }] = await sql`select cb.huddles_list(${project ?? null}) as l`;
  return l;
}

export async function huddle(id: number) {
  const [h] = await sql`select h.*, (select coalesce(json_agg(m.actor order by m.added_at), '[]') from cb.huddle_members m where m.huddle_id = h.id) as members
                         from cb.huddles h where h.id = ${id}`;
  if (!h) return null;
  const lines = await sql`select id, at, actor, summary, data ->> 'action' as action from cb.events
                           where kind = 'huddle' and (data ->> 'huddle')::bigint = ${id} order by id`;
  return { ...h, lines };
}
