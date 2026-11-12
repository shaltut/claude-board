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
  // goal_rank / goal_id (#663): the active goal that lifts a card; the order is cb.task_claim's (web/src/lib/rank.ts byQueue)
  return sql`select *, cb._waits_on(id) as waits_on, cb._goal_rank(id) as goal_rank,
      (select gt.goal_id from cb.goal_tasks gt join cb.goals g on g.id = gt.goal_id
        where gt.task_id = t.id and gt.state = 'in' and g.status = 'active' order by g.rank, g.id limit 1) as goal_id
    from cb.tasks t where ${filter} ${proj(project)}
    order by status, priority <> 'P0', case when priority <> 'P0' then cb._goal_rank(id) end nulls last, priority, rank, id`;
}

export async function task(id: number) {
  const [t] = await sql`select *, cb._waits_on(id) as waits_on from cb.tasks where id = ${id}`;
  if (!t) return null;
  const [events, questions, blockers, blocks, [epic]] = await Promise.all([
    sql`select * from cb.events where task_id = ${id} order by at desc, id desc`,
    sql`select * from cb.questions where task_id = ${id} order by id desc`,
    sql`select t.id, t.title, t.status, t.assignee from cb.task_blockers b join cb.tasks t on t.id = b.blocker where b.task = ${id} order by t.id`,
    sql`select t.id, t.title, t.status, t.assignee from cb.task_blockers b join cb.tasks t on t.id = b.task where b.blocker = ${id} order by t.id`,
    sql`select id, title from cb.epics where id = ${t.epic_id ?? 0}`,
  ]);
  return { task: t, events, questions, blockers, blocks, epic: epic ?? null };
}

export async function epics(project?: string) {
  const [{ l }] = await sql`select cb.epics_list(${project ?? null}) as l`;
  return l;
}

/** One epic with its progress, and its steps in Ahmed's order. */
export async function epic(id: number) {
  const [{ l }] = await sql`select cb.epics_list(null) as l`;
  const e = l.find((x: any) => x.id === id);
  if (!e) return null;
  const steps = await sql`select *, cb._waits_on(id) as waits_on from cb.tasks where epic_id = ${id} order by epic_rank, id`;
  return { epic: e, steps };
}

/** Goals (#663), every status: active in Ahmed's order, then paused, then done. */
export async function goals(project?: string) {
  const [{ l }] = await sql`select cb.goals_list(${project ?? null}, true) as l`;
  return l;
}

/** One goal and its cards: in before out, open before closed, then work order. */
export async function goal(id: number) {
  const [{ l }] = await sql`select cb.goals_list(null, true) as l`;
  const g = l.find((x: any) => x.id === id);
  if (!g) return null;
  const cards = await sql`select t.*, gt.state, gt.via, gt.new, gt.added_at from cb.goal_tasks gt join cb.tasks t on t.id = gt.task_id
    where gt.goal_id = ${id} order by gt.state = 'out', t.status in ('done', 'cancelled'), t.priority, t.rank, t.id`;
  return { goal: g, cards };
}

/** Follow-ups (#472): what the parent was answered, and the dormant branches still to come. A guest sees only their
 *  own branches, and the parent's answer only when the parent was theirs too (Ahmed's answer and note are his). */
const followups = (user?: string) => sql`
  (select p.answer from cb.questions p where p.id = q.parent_id ${user ? sql`and p.assigned_to = ${user}` : sql``}) as parent_answer,
  (select jsonb_agg(jsonb_build_object('id', c.id, 'if_answer', c.if_answer, 'body', c.body) order by c.id) from cb.questions c
    where c.parent_id = q.id and c.status = 'dormant' ${user ? sql`and c.assigned_to = ${user}` : sql``}) as branches`;

/** status 'answered_today' (#1346): every answer not yet delivered, and the ones delivered in the last 24 h. */
export function questions(project?: string, status?: string) {
  const which = status === 'answered_today'
    ? sql`and (status = 'answered' or (status = 'delivered' and answered_at > now() - interval '24 hours'))`
    : status ? sql`and status = ${status}` : sql``;
  return sql`select q.*, ${followups()} from cb.questions q where true ${proj(project)} ${which}
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

/** A guest's own page: questions handed to them (open, and answered this week) and their open tasks, on their projects. */
export async function me(user: string, scope: ReturnType<typeof sql>) {
  const [rows, tasks] = await Promise.all([
    sql`select q.*, ${followups(user)} from cb.questions q where assigned_to = ${user} and ${scope}
          and (status in ('open', 'sent_back') or answered_at > now() - interval '7 days') order by status = 'open' desc, id desc`,
    // only the guest's own notes come back: session notes on the same task can hold anything
    sql`select t.*, coalesce((select jsonb_agg(jsonb_build_object('summary', e.summary, 'at', e.at) order by e.at)
          from cb.events e where e.task_id = t.id and e.kind = 'note' and e.actor = ${user}), '[]') as my_notes
        from cb.tasks t where t.assignee = ${user} and ${scope} and t.status not in ('done', 'cancelled') order by t.priority, t.rank, t.id`,
  ]);
  // earlier answers and who they were delivered to are the board's (#1346), not the guest's
  const questions = rows.map(({ answer_history, delivered_to, ...q }: any) => q);
  return { questions, tasks };
}

/** The People page (local only: it carries the link tokens). What waits on each person, and when they last answered or wrote. */
export const people = () => sql`
  select u.name, u.display, u.role, case when u.role = 'admin' then null else u.token end as token, u.created_at, u.password is not null as has_password,
    array(select up.project from cb.user_projects up where up.user_name = u.name order by up.project) as projects,
    coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'project', q.project, 'body', q.body, 'blocking', q.blocking, 'created_at', q.created_at)
               order by q.blocking desc, q.created_at)
       from cb.questions q where q.assigned_to = u.name and q.status = 'open'), '[]') as questions,
    coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'project', t.project, 'title', t.title, 'status', t.status, 'priority', t.priority)
               order by t.priority, t.rank, t.id)
       from cb.tasks t where t.assignee = u.name and t.status not in ('done', 'cancelled')), '[]') as tasks,
    (select max(e.at) from cb.events e where e.actor = u.name) as last_active
  from cb.users u order by u.created_at, u.name`;
