-- Claude Board schema. Idempotent: safe to re-run on a live database.
-- NOTE: "create table if not exists" never alters an existing table;
-- column changes need an explicit "alter table" below the create.

create schema if not exists cb;
-- Guest passwords (bcrypt). Qualified as public.crypt / public.gen_salt wherever used.
create extension if not exists pgcrypto with schema public;

create table if not exists cb.projects (
  slug       text primary key,
  name       text not null,
  repo_path  text,
  color      text,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);


-- Old or alternative names for a project: "tawuniya" → ihop. New work through an alias gets its tags.
create table if not exists cb.project_aliases (
  alias text primary key,
  slug  text not null references cb.projects(slug) on update cascade on delete cascade,
  tags  text[] not null default '{}'
);

create table if not exists cb.users (
  name       text primary key,
  display    text not null,
  token      text not null unique default gen_random_uuid()::text,
  created_at timestamptz not null default now()
);
alter table cb.users add column if not exists password text; -- bcrypt hash; null = sign in by link only

-- The projects a person works on (#315). Questions and tasks reach them only on these; a new person has none.
create table if not exists cb.user_projects (
  user_name text not null references cb.users(name) on update cascade on delete cascade,
  project   text not null references cb.projects(slug) on update cascade on delete cascade,
  primary key (user_name, project)
);

create table if not exists cb.questions (
  id           bigint generated always as identity primary key,
  project      text not null references cb.projects(slug) on update cascade,
  task_id      bigint,
  asked_by     text not null,
  body         text not null,
  context      text,
  options      jsonb,
  blocking     boolean not null default false,
  status       text not null default 'open' check (status in ('open','answered','delivered','withdrawn')),
  answer       text,
  answered_at  timestamptz,
  delivered_at timestamptz,
  delivered_to text,
  reply_to     jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists cb.tasks (
  id         bigint generated always as identity primary key,
  project    text not null references cb.projects(slug) on update cascade,
  title      text not null,
  body       text not null default '',
  status     text not null default 'backlog'
             check (status in ('backlog','next','in_progress','blocked','review','done','cancelled')),
  priority   text not null default 'P2' check (priority in ('P0','P1','P2','P3')),
  rank       double precision not null default 0,
  assignee   text,
  labels     text[] not null default '{}',
  links      jsonb not null default '{}',
  blocked_on bigint references cb.questions(id) on delete set null,
  created_by text not null default 'unknown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at    timestamptz
);

create table if not exists cb.events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       text not null,
  project     text,
  task_id     bigint,
  question_id bigint,
  kind        text not null check (kind in ('task_created','moved','updated','done','note','asked','answered','delivered','withdrawn','broadcast')),
  summary     text not null default '',
  data        jsonb not null default '{}'
);
alter table cb.events drop constraint if exists events_kind_check;
alter table cb.events add constraint events_kind_check check (kind in ('task_created','moved','updated','done','note','asked','answered','delivered','withdrawn','broadcast','message','huddle','user','epic','memory','sent_back','rewritten','goal','ask'));

alter table cb.questions add column if not exists multi boolean not null default false;

-- Follow-up questions (#472): a question asked --after another (parent_id) waits 'dormant' until that one is
-- answered. Then it opens if the answer chose if_answer (one of the parent's option labels; null = any answer),
-- else it waits on: until the parent's answer is delivered (the answer may still change and re-route it), then it
-- is skipped (withdrawn). Dormant is invisible: not open, not pending, no asked event, no task held.
alter table cb.questions add column if not exists parent_id bigint references cb.questions(id);
alter table cb.questions add column if not exists if_answer text;
-- A blocking follow-up that opened: its task's {task, status, blocked_on} before it took the task, so a changed
-- parent answer that sends it back to dormant can put the task back exactly.
alter table cb.questions add column if not exists hold_before jsonb;
alter table cb.questions drop constraint if exists questions_status_check;
alter table cb.questions add constraint questions_status_check check (status in ('open','answered','delivered','withdrawn','dormant','sent_back'));
create index if not exists questions_parent on cb.questions (parent_id) where parent_id is not null;

-- Send back (#616): Ahmed (or the person it is for) returns an open question to its asker, 'sent_back' until the asker
-- rewrites it (cb.reask), then it is open again under the same id. sent_back: {reason, note, by, at, delivered_at,
-- delivered_to} while it waits (delivered_at: the asker was told, as an answer is delivered). versions: the earlier
-- texts, oldest first, each with the send-back that led to its rewrite (reason null: rewritten while open).
alter table cb.questions add column if not exists sent_back jsonb;
alter table cb.questions add column if not exists versions jsonb;

-- What kind of work a task is. 'task' (unclassified) is the default: existing rows were never typed,
-- and calling them features would be a lie. The list lives in the check and in cb.norm_type.
alter table cb.tasks add column if not exists type text not null default 'task';
alter table cb.tasks drop constraint if exists tasks_type_check;
alter table cb.tasks add constraint tasks_type_check check (type in ('task','bug','feature','change','chore','research'));

-- Epics (#341): one level of ordered steps (tasks) inside one project. Only Ahmed creates, renames, closes and
-- deletes them (dashboard_only); sessions add their own tasks. status is Ahmed's close; the status shown
-- (cb.epics_list) is done when he closed it or every step is done or cancelled. Order (epic_rank) never blocks.
create table if not exists cb.epics (
  id         bigint generated always as identity primary key,
  project    text not null references cb.projects(slug) on update cascade,
  title      text not null,
  goal       text not null default '',
  status     text not null default 'open' check (status in ('open', 'done')),
  created_by text not null default 'ahmed',
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);
alter table cb.tasks add column if not exists epic_id bigint references cb.epics(id) on delete set null;
alter table cb.tasks add column if not exists epic_rank double precision not null default 0;
create index if not exists tasks_epic on cb.tasks (epic_id, epic_rank) where epic_id is not null;

-- Goals (#663): what matters now, as a description plus match rules {labels, words, epics} (plain SQL, no LLM).
-- Every card that matches an active goal joins it, including cards filed later, and is handed out right after P0,
-- in goal order (rank). project null = every project. Only Ahmed (dashboard_only) creates, edits, orders or closes.
create table if not exists cb.goals (
  id          bigint generated always as identity primary key,
  title       text not null,
  description text not null default '',
  project     text references cb.projects(slug) on update cascade,
  rules       jsonb not null default '{"labels": [], "words": [], "epics": []}',
  status      text not null default 'active' check (status in ('active', 'paused', 'done')),
  rank        double precision not null default 0,
  created_by  text not null default 'ahmed',
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);
-- A goal's cards. out = Ahmed unticked it: the row holds the key, so matching never adds it again.
-- new = it joined by matching since Ahmed last opened the goal.
create table if not exists cb.goal_tasks (
  goal_id  bigint not null references cb.goals(id) on delete cascade,
  task_id  bigint not null references cb.tasks(id) on delete cascade,
  state    text not null default 'in' check (state in ('in', 'out')),
  via      text not null default 'match' check (via in ('match', 'ahmed')),
  new      boolean not null default false,
  added_at timestamptz not null default now(),
  primary key (goal_id, task_id)
);
create index if not exists goal_tasks_task on cb.goal_tasks (task_id);

-- Task-on-task blockers (#341): task waits on blocker. Same project only, no self-links, no cycles (cb.task_blockers_check).
-- How they combine with a question block (tasks.blocked_on): a task is held while blocked_on is set OR any of its
-- blockers is open (not done/cancelled). Whichever clears last releases it: a question's answer or withdrawal
-- clears blocked_on and keeps the task Blocked while a blocker is open; a blocker finishing (or being removed)
-- releases the task only when no blocker is open and blocked_on is null. The release target differs on purpose:
-- the question path keeps its old rule (in_progress if assigned, else next); the blocker path always goes to Next
-- (the assignee keeps it, and is told). Ahmed may still drag a task out of Blocked by hand: the release only
-- touches tasks whose status is still blocked. A manual Blocked (no question, no blocker) counts as released.
create table if not exists cb.task_blockers (
  task       bigint not null references cb.tasks(id) on delete cascade,
  blocker    bigint not null references cb.tasks(id) on delete cascade,
  created_by text not null default 'unknown',
  created_at timestamptz not null default now(),
  primary key (task, blocker),
  constraint task_blockers_not_self check (task <> blocker)
);
create index if not exists task_blockers_blocker on cb.task_blockers (blocker);

-- Which actor a session (herdr pane on a machine) is: set by `cb iam`, used by the CLI and the relay.
create table if not exists cb.sessions (
  machine    text not null,
  pane       text not null,
  actor      text not null,
  started_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (machine, pane)
);
-- Projects are namespaces: a session works in one project; cb defaults to it.
alter table cb.sessions add column if not exists project text references cb.projects(slug) on update cascade on delete set null;
-- last broadcast event this session was given
alter table cb.sessions add column if not exists broadcast_seen bigint not null default 0;

create table if not exists cb.settings (
  key   text primary key,
  value jsonb
);

create index if not exists tasks_project_status_rank on cb.tasks (project, status, rank);
create index if not exists events_at on cb.events (at desc);
create index if not exists events_task on cb.events (task_id);
create index if not exists questions_status on cb.questions (status);

-- ===========================================================================
-- Functions. Dropped and re-created on every setup so signature changes apply.
-- "cascade" also drops the triggers that use them; they are re-created below.
-- All parameters are unprefixed (they are the RPC/CLI argument names), so every
-- body uses "#variable_conflict use_variable" and qualifies table columns.
-- ===========================================================================

drop function if exists cb.set_actor cascade;
drop function if exists cb.not_ahmed cascade;
drop function if exists cb.dashboard_only cascade;
drop function if exists cb.ahmed_like cascade;
drop function if exists cb.norm_status cascade;
drop function if exists cb.norm_priority cascade;
drop function if exists cb.norm_type cascade;
drop function if exists cb.triagers cascade;
drop function if exists cb.norm_id cascade;
drop function if exists cb.ensure_project cascade;
drop function if exists cb.slug cascade;
drop function if exists cb.read_project cascade;
drop function if exists cb.resolve cascade;
drop function if exists cb.project_alias cascade;
drop function if exists cb.tasks_before cascade;
drop function if exists cb.tasks_history cascade;
drop function if exists cb.notify cascade;
drop function if exists cb.task_add cascade;
drop function if exists cb.norm_tag cascade;
drop function if exists cb.task_tag cascade;
drop function if exists cb.task_move cascade;
drop function if exists cb.task_update cascade;
drop function if exists cb.task_done cascade;
drop function if exists cb.log cascade;
drop function if exists cb.task_claim cascade;
drop function if exists cb.mine cascade;
drop function if exists cb.iam cascade;
drop function if exists cb.inbox cascade;
drop function if exists cb.broadcast cascade;
drop function if exists cb.sessions_overview cascade;
drop function if exists cb.tell cascade;
drop function if exists cb.huddle_open cascade;
drop function if exists cb.huddle_add cascade;
drop function if exists cb.huddle_say cascade;
drop function if exists cb.huddle_close cascade;
drop function if exists cb.huddles_list cascade;
drop function if exists cb._huddle_post cascade;
drop function if exists cb._huddle_join cascade;
drop function if exists cb.broadcast_seen cascade;
drop function if exists cb._broadcasts cascade;
drop function if exists cb.tick cascade;
drop function if exists cb._is_review cascade;
drop function if exists cb._pr_no cascade;
drop function if exists cb._has_reviewer cascade;
drop function if exists cb.lock_take cascade;
drop function if exists cb.lock_release cascade;
drop function if exists cb.lock_queue cascade;
drop function if exists cb.norm_epic cascade;
drop function if exists cb.epic_create cascade;
drop function if exists cb.epic_update cascade;
drop function if exists cb.epic_close cascade;
drop function if exists cb.epic_delete cascade;
drop function if exists cb._epic_event cascade;
drop function if exists cb.epics_list cascade;
drop function if exists cb._waits_on cascade;
drop function if exists cb.task_blockers_check cascade;
drop function if exists cb.task_block cascade;
drop function if exists cb.task_unblock cascade;
drop function if exists cb.tasks_unblock cascade;
drop function if exists cb._goal_rank cascade;
drop function if exists cb.norm_goal cascade;
drop function if exists cb._goal_rules cascade;
drop function if exists cb._goal_match cascade;
drop function if exists cb._goal_pull cascade;
drop function if exists cb._goal_event cascade;
drop function if exists cb._goal_autoclose cascade;
drop function if exists cb.tasks_goals cascade;
drop function if exists cb.tasks_goals_close cascade;
drop function if exists cb.goal_create cascade;
drop function if exists cb.goal_update cascade;
drop function if exists cb.goal_status cascade;
drop function if exists cb.goal_tick cascade;
drop function if exists cb.goal_opened cascade;
drop function if exists cb.goal_preview cascade;
drop function if exists cb.goal_propose cascade;
drop function if exists cb.goals_list cascade;

-- Only Ahmed's dashboard (the web server sets application_name 'cb-web' on its writes) may act as
-- ahmed: the relay tells sessions to act on his lines, so a session must not be able to speak as him.
-- Any name with ahmed as a whole word counts (Ahmed (boss), ahmed-x@pc, the ahmed); ahmedx, mohammed_ahmed don't.
-- ponytail: a deterrent, not auth. Known bypasses: PGAPPNAME=cb-web (or set application_name) on any
-- psql/postgres connection, and a local POST to /api/rpc with a forged same-host Origin header. It stops
-- accidents and prompt-injected sessions, not a determined local process. Real auth = a Postgres role per client.
create function cb.ahmed_like(a text) returns boolean language sql immutable as $$ select coalesce(a, '') ~* '\mahmed\M' $$;
create function cb.not_ahmed(a text) returns void language plpgsql as $$
begin
  if cb.ahmed_like(a) and current_setting('application_name') <> 'cb-web' then
    raise exception 'only Ahmed''s dashboard can act as ahmed: sessions use their own name';
  end if;
end $$;

-- Things only Ahmed does, from his dashboard, whatever name the caller gives (or none): guest links, epics.
-- ponytail: the same deterrent as not_ahmed (PGAPPNAME=cb-web gets past it), not auth.
create function cb.dashboard_only(page text default 'People') returns void language plpgsql as $$
begin
  if current_setting('application_name') <> 'cb-web' then
    raise exception 'only Ahmed can do this, on the % page of the dashboard', page;
  end if;
end $$;

-- Effective actor for this transaction; triggers read it back from cb.actor.
create function cb.set_actor(actor text) returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := coalesce(nullif(trim(actor), ''), nullif(current_setting('cb.actor', true), ''), 'unknown');
begin
  perform cb.not_ahmed(a);
  perform set_config('cb.actor', a, true);
  return a;
end $$;

create function cb.norm_status(s text) returns text language plpgsql immutable as $$
#variable_conflict use_variable
declare v text := replace(replace(lower(trim(coalesce(s, ''))), '-', '_'), ' ', '_');
begin
  v := case v
    when 'todo' then 'next' when 'ready' then 'next'
    when 'wip' then 'in_progress' when 'doing' then 'in_progress' when 'progress' then 'in_progress'
    when 'inprogress' then 'in_progress' when 'active' then 'in_progress'
    when 'block' then 'blocked' when 'waiting' then 'blocked'
    when 'pr' then 'review' when 'reviewing' then 'review'
    when 'complete' then 'done' when 'completed' then 'done' when 'closed' then 'done' when 'finished' then 'done'
    when 'cancel' then 'cancelled' when 'canceled' then 'cancelled' when 'dropped' then 'cancelled'
    when 'later' then 'backlog' when 'icebox' then 'backlog'
    else v end;
  if v not in ('backlog','next','in_progress','blocked','review','done','cancelled') then
    raise exception 'unknown status "%"; use one of backlog, next, in_progress, blocked, review, done, cancelled', s;
  end if;
  return v;
end $$;

create function cb.norm_priority(p text) returns text language plpgsql immutable as $$
#variable_conflict use_variable
declare v text := upper(trim(coalesce(p, 'P2')));
begin
  if v ~ '^[0-3]$' then v := 'P' || v; end if;
  if v not in ('P0','P1','P2','P3') then
    raise exception 'unknown priority "%"; use P0, P1, P2 or P3', p;
  end if;
  return v;
end $$;

create function cb.norm_type(t text) returns text language plpgsql immutable as $$
#variable_conflict use_variable
declare v text := lower(trim(coalesce(t, 'task')));
begin
  if v not in ('task','bug','feature','change','chore','research') then
    raise exception 'unknown type "%"; use one of task, bug, feature, change, chore, research', t;
  end if;
  return v;
end $$;

-- Who triages a project's new bugs: its orchestrator(s) (orch@*, seen in the last day), else every
-- session bound to it and seen in the last day. A day, not the 90s relay liveness: a relay restart or
-- a sleeping Mac must not hand the orchestrator's bugs to every worker; session rows are never deleted.
-- One rule for the relay push (cb.inbox) and for what `cb bug` prints.
create function cb.triagers(project text) returns text[] language sql stable as $$
  select coalesce(
    nullif(array(select s.actor from cb.sessions s
                  where s.project = $1 and (s.actor like 'orch@%' or s.actor = 'orch')
                    and s.last_seen > now() - interval '1 day' order by s.actor), '{}'),
    array(select distinct s.actor from cb.sessions s
           where s.project = $1 and s.last_seen > now() - interval '1 day' order by s.actor))
$$;

create function cb.norm_id(id text) returns bigint language plpgsql immutable as $$
#variable_conflict use_variable
declare v text := ltrim(trim(coalesce(id, '')), '#');
begin
  if v !~ '^[0-9]+$' then raise exception 'bad id "%"; use a number like 12 or #12', id; end if;
  return v::bigint;
end $$;

-- One normalization for every path: "Demo API" → demo-api.
create function cb.slug(project text) returns text language sql immutable as $$
  select regexp_replace(lower(trim(coalesce(project, ''))), '[^a-z0-9_.-]+', '-', 'g')
$$;

-- Tags (stored in tasks.labels): "Arabic RTL " → arabic-rtl.
create function cb.norm_tag(tag text) returns text language sql immutable as $$
  select regexp_replace(lower(trim(coalesce($1, ''))), '[[:space:]]+', '-', 'g')
$$;

-- slug, then follow an alias: "OCR Arena" → ocr-arena → ihop.
create function cb.resolve(project text) returns text language sql stable as $$
  select coalesce((select a.slug from cb.project_aliases a where a.alias = cb.slug(project)), cb.slug(project))
$$;

-- Register alias → target. If a project already exists under the alias, merge it into the target:
-- its tasks (tagged with tags), questions and history move over quietly, with one summary event.
create function cb.project_alias(alias text, target text, tags jsonb default '[]') returns text language plpgsql as $$
#variable_conflict use_variable
declare
  a text := cb.slug(alias); t text := cb.resolve(target); n int := 0;
  tg text[] := array(select jsonb_array_elements_text(coalesce(tags, '[]')));
begin
  if a = '' or t = '' then raise exception 'alias and target are required'; end if;
  if a = t then raise exception 'a project cannot be an alias of itself'; end if;
  perform cb.ensure_project(t);
  if exists (select 1 from cb.projects p where p.slug = a) then
    perform set_config('cb.quiet', 'on', true);
    update cb.tasks x set project = t, labels = x.labels || array(select g from unnest(tg) g where g <> all(x.labels))
     where x.project = a;
    get diagnostics n = row_count;
    update cb.questions q set project = t where q.project = a;
    update cb.events e set project = t where e.project = a;
    update cb.epics e set project = t where e.project = a; -- epics follow their steps
    update cb.goals g set project = t where g.project = a;
    update cb.project_aliases pa set slug = t where pa.slug = a;
    -- people on the merged project follow their work (#315 review); the FK cascade would drop them
    insert into cb.user_projects (user_name, project) select up.user_name, t from cb.user_projects up where up.project = a
    on conflict do nothing;
    delete from cb.projects p where p.slug = a;
    perform set_config('cb.quiet', '', true);
    insert into cb.events (actor, project, kind, summary, data)
    values (coalesce(nullif(current_setting('cb.actor', true), ''), 'ahmed'), t, 'note',
            format('Merged %s into %s: %s tasks moved%s', a, t, n,
                   case when cardinality(tg) > 0 then ', tagged ' || array_to_string(tg, ', ') else '' end),
            jsonb_build_object('merged', a, 'tags', tg));
  end if;
  insert into cb.project_aliases (alias, slug, tags) values (a, t, tg)
  on conflict on constraint project_aliases_pkey do update set slug = excluded.slug, tags = excluded.tags;
  return t;
end $$;

-- Read-side project filter: null/empty = all projects; an unknown slug is an error, not empty work.
create function cb.read_project(project text) returns text language plpgsql stable as $$
#variable_conflict use_variable
declare s text := nullif(cb.resolve(project), '');
begin
  if s is null or exists (select 1 from cb.projects p where p.slug = s) then return s; end if;
  raise exception 'unknown project "%"; known: %', s,
    coalesce((select string_agg(p.slug, ', ' order by p.slug) from cb.projects p), 'none yet (cb add creates one)');
end $$;

create function cb.ensure_project(project text) returns text language plpgsql as $$
#variable_conflict use_variable
declare slug text := cb.resolve(project);
begin
  if slug = '' then raise exception 'project is required'; end if;
  if slug ~ '^#?[0-9]+$' then
    raise exception '"%" looks like a task number, not a project: use cb log <project> "..." -t %', project, ltrim(project, '#');
  end if;
  insert into cb.projects (slug, name) values (slug, initcap(replace(slug, '-', ' ')))
  on conflict do nothing;
  return slug;
end $$;

-- Before-row trigger: rank on entering a status, done_at, blocked_on, epic (same project, joins at the end), updated_at.
create function cb.tasks_before() returns trigger language plpgsql as $$
declare ep text;
begin
  -- only when epic_id itself changes: a project slug rename cascades to both tables and must not trip it
  if new.epic_id is not null and (tg_op = 'INSERT' or new.epic_id is distinct from old.epic_id) then
    select e.project into ep from cb.epics e where e.id = new.epic_id;
    if ep is distinct from new.project then
      raise exception 'E% is in %, #% in %: an epic holds one project''s tasks', new.epic_id, ep, new.id, new.project;
    end if;
    if tg_op = 'INSERT' or new.epic_rank is not distinct from old.epic_rank then
      select coalesce(max(t.epic_rank) + 1024, 0) into new.epic_rank from cb.tasks t where t.epic_id = new.epic_id and t.id <> new.id;
    end if;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if tg_op = 'INSERT' or new.rank is not distinct from old.rank then
      select case when new.priority = 'P0' then coalesce(min(t.rank) - 1024, 0)
                  else coalesce(max(t.rank) + 1024, 0) end
        into new.rank
        from cb.tasks t where t.project = new.project and t.status = new.status and t.id <> new.id;
    end if;
    new.done_at := case when new.status = 'done' then now() else null end;
    if new.status <> 'blocked' then new.blocked_on := null; end if;
  end if;
  if tg_op = 'UPDATE' and new.updated_at is not distinct from old.updated_at
     and (to_jsonb(new) - 'rank' - 'epic_rank' - 'updated_at' - 'created_at') is distinct from (to_jsonb(old) - 'rank' - 'epic_rank' - 'updated_at' - 'created_at') then
    new.updated_at := now();
  end if;
  return new;
end $$;

-- After-row trigger: writes the history. cb.note / cb.data carry the caller's
-- summary and extra data (set by task_move/task_done/task_claim).
create function cb.tasks_history() returns trigger language plpgsql as $$
declare
  a text := coalesce(nullif(current_setting('cb.actor', true), ''), 'unknown');
  note text := nullif(current_setting('cb.note', true), '');
  extra jsonb := coalesce(nullif(current_setting('cb.data', true), '')::jsonb, '{}');
  changed text[];
begin
  if current_setting('cb.quiet', true) = 'on' then return null; end if;  -- bulk moves log one summary event
  if tg_op = 'INSERT' then
    insert into cb.events (actor, project, task_id, kind, summary, data)
    values (a, new.project, new.id, 'task_created', coalesce(note, new.title),
            jsonb_build_object('status', new.status, 'priority', new.priority) || extra);
    return null;
  end if;
  changed := array(
    select n.key from jsonb_each(to_jsonb(new)) n
    where n.value is distinct from to_jsonb(old) -> n.key
      and n.key not in ('rank', 'epic_rank', 'updated_at', 'status', 'done_at', 'blocked_on', 'created_at', 'created_by', 'id'));
  -- Who had it before: lets cb.mine show a task taken from you.
  if new.assignee is distinct from old.assignee then
    extra := jsonb_build_object('assignee', jsonb_build_object('from', old.assignee, 'to', new.assignee)) || extra;
  end if;
  if new.status is distinct from old.status then
    insert into cb.events (actor, project, task_id, kind, summary, data)
    values (a, new.project, new.id, case when new.status = 'done' then 'done' else 'moved' end,
            coalesce(note, old.status || ' → ' || new.status),
            jsonb_build_object('from', old.status, 'to', new.status)
              || case when cardinality(changed) > 0 then jsonb_build_object('fields', changed) else '{}' end
              || extra);
  elsif cardinality(changed) > 0 then
    insert into cb.events (actor, project, task_id, kind, summary, data)
    values (a, new.project, new.id, 'updated', coalesce(note, 'edited ' || array_to_string(changed, ', ')),
            jsonb_build_object('fields', changed) || extra);
  elsif note is not null then
    insert into cb.events (actor, project, task_id, kind, summary, data)
    values (a, new.project, new.id, 'note', note, extra);
  end if;
  return null;
end $$;

create function cb.notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('cb', tg_table_name);
  return null;
end $$;

create or replace trigger tasks_before before insert or update on cb.tasks
  for each row execute function cb.tasks_before();
create or replace trigger tasks_history after insert or update on cb.tasks
  for each row execute function cb.tasks_history();
create or replace trigger tasks_notify after insert or update or delete on cb.tasks
  for each statement execute function cb.notify();
create or replace trigger questions_notify after insert or update or delete on cb.questions
  for each statement execute function cb.notify();
create or replace trigger events_notify after insert on cb.events
  for each statement execute function cb.notify();
create or replace trigger projects_notify after insert or update or delete on cb.projects
  for each statement execute function cb.notify();
create or replace trigger epics_notify after insert or update or delete on cb.epics
  for each statement execute function cb.notify();
create or replace trigger task_blockers_notify after insert or update or delete on cb.task_blockers
  for each statement execute function cb.notify();

-- The open blockers a task waits on (not done or cancelled), lowest id first: "waits on #12".
create function cb._waits_on(tid bigint) returns bigint[] language sql stable as $$
  select array(select b.blocker from cb.task_blockers b join cb.tasks x on x.id = b.blocker
                where b.task = $1 and x.status not in ('done', 'cancelled') order by b.blocker)
$$;

create function cb.task_add(project text, title text, body text default '', status text default 'backlog',
                            priority text default 'P2', labels jsonb default '[]', links jsonb default '{}',
                            assignee text default null, actor text default null, type text default null, epic text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.ensure_project(project); new_id bigint;
  l text[] := array(select distinct cb.norm_tag(x) from jsonb_array_elements_text(coalesce(labels, '[]')) x where cb.norm_tag(x) <> '');
begin
  if coalesce(trim(title), '') = '' then raise exception 'title is required'; end if;
  -- work added through an alias ("tawuniya") keeps that stream's tags
  l := l || array(select g from cb.project_aliases pa, unnest(pa.tags) g where pa.alias = cb.slug(project) and g <> all(l));
  insert into cb.tasks (project, title, body, status, priority, labels, links, assignee, created_by, type, epic_id)
  values (p, trim(title), coalesce(body, ''), cb.norm_status(status), cb.norm_priority(priority),
          l, coalesce(links, '{}'),
          coalesce(assignee, case when cb.norm_status(status) = 'in_progress' then a end), a, cb.norm_type(type), cb.norm_epic(epic))
  returning cb.tasks.id into new_id;
  return new_id;
end $$;

create function cb.task_move(id text, status text, note text default null, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare tid bigint := cb.norm_id(id); s text := cb.norm_status(status);
begin
  perform cb.set_actor(actor);
  perform set_config('cb.note', coalesce(note, ''), true);
  update cb.tasks t set status = s where t.id = tid;
  if not found then raise exception 'task #% not found', tid; end if;
  perform set_config('cb.note', '', true);
end $$;

create function cb.task_update(id text, fields jsonb, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare tid bigint := cb.norm_id(id); bad text; cur cb.tasks; ep bigint;
begin
  perform cb.set_actor(actor);
  select string_agg(k, ', ') into bad from jsonb_object_keys(coalesce(fields, '{}')) k
   where k not in ('title','body','priority','assignee','labels','links','project','rank','type','epic','epic_rank');
  if bad is not null then
    raise exception 'unknown field(s) %; allowed: title, body, priority, assignee, labels, links, project, rank, type, epic, epic_rank', bad;
  end if;
  select * into cur from cb.tasks t where t.id = tid;
  if not found then raise exception 'task #% not found', tid; end if;
  ep := case when fields ? 'epic' then cb.norm_epic(fields ->> 'epic') else cur.epic_id end;
  -- an epic and its blockers stay in one project: moving the task alone would split them
  if fields ? 'project' and cb.resolve(fields ->> 'project') <> cur.project then
    if ep is not null then
      raise exception '#% is in epic E%: take it out first (cb edit % --epic none)', tid, ep, tid;
    end if;
    if exists (select 1 from cb.task_blockers b where b.task = tid or b.blocker = tid) then
      raise exception '#% has blockers or blocks other tasks in %: cb unblock them first', tid, cur.project;
    end if;
  end if;
  if ep is distinct from cur.epic_id then
    perform set_config('cb.note', case when ep is null then 'removed from epic E' || cur.epic_id
                                       when cur.epic_id is null then 'added to epic E' || ep
                                       else 'moved from epic E' || cur.epic_id || ' to E' || ep end, true);
  end if;
  update cb.tasks t set
    epic_id   = case when fields ? 'epic' then ep else t.epic_id end,
    epic_rank = case when fields ? 'epic_rank' then (fields ->> 'epic_rank')::double precision else t.epic_rank end,
    type     = case when fields ? 'type' then cb.norm_type(fields ->> 'type') else t.type end,
    title    = case when fields ? 'title' then fields ->> 'title' else t.title end,
    body     = case when fields ? 'body' then coalesce(fields ->> 'body', '') else t.body end,
    priority = case when fields ? 'priority' then cb.norm_priority(fields ->> 'priority') else t.priority end,
    assignee = case when fields ? 'assignee' then fields ->> 'assignee' else t.assignee end,
    labels   = case when fields ? 'labels' then array(select jsonb_array_elements_text(fields -> 'labels')) else t.labels end,
    links    = case when fields ? 'links' then t.links || (fields -> 'links') else t.links end,
    project  = case when fields ? 'project' then cb.ensure_project(fields ->> 'project') else t.project end,
    rank     = case when fields ? 'rank' then (fields ->> 'rank')::double precision else t.rank end
  where t.id = tid;
  perform set_config('cb.note', '', true);
end $$;

create function cb.task_done(id text, summary text, links jsonb default '{}', actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare tid bigint := cb.norm_id(id);
begin
  perform cb.set_actor(actor);
  perform set_config('cb.note', coalesce(summary, ''), true);
  if links is not null and links <> '{}' then
    perform set_config('cb.data', jsonb_build_object('links', links)::text, true);
  end if;
  update cb.tasks t set status = 'done', links = t.links || coalesce(links, '{}') where t.id = tid;
  if not found then raise exception 'task #% not found', tid; end if;
  perform set_config('cb.note', '', true);
  perform set_config('cb.data', '', true);
end $$;

create function cb.log(project text, summary text, task_id text default null, data jsonb default '{}', actor text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.ensure_project(project); new_id bigint;
begin
  if coalesce(trim(summary), '') = '' then raise exception 'summary is required'; end if;
  insert into cb.events (actor, project, task_id, kind, summary, data)
  values (a, p, case when task_id is null then null else cb.norm_id(task_id) end, 'note', trim(summary), coalesce(data, '{}'))
  returning cb.events.id into new_id;
  return new_id;
end $$;

-- Goals (#663): the lowest rank of an active goal this card is in (null: none). Work order (cb next, cb brief,
-- cb tick, cb start): P0 first, untouched by goals; then goal cards in goal order; then priority, rank, id.
create function cb._goal_rank(tid bigint) returns double precision language sql stable as $$
  select min(g.rank) from cb.goal_tasks gt join cb.goals g on g.id = gt.goal_id
   where gt.task_id = $1 and gt.state = 'in' and g.status = 'active'
$$;

-- Atomically take the top task in Next (P0, then goals: cb._goal_rank, then lowest rank). skip locked: two
-- sessions claiming at once never get the same task.
create function cb.task_claim(project text default null, actor text default null)
returns setof cb.tasks language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.read_project(project); tid bigint;
begin
  select t.id into tid from cb.tasks t
   where t.status = 'next' and (p is null or t.project = p)
     and (t.assignee is null or t.assignee = a)  -- never take a task queued for someone else
   order by t.priority <> 'P0', case when t.priority <> 'P0' then cb._goal_rank(t.id) end nulls last, t.priority, t.rank, t.id limit 1
   for update skip locked;
  if tid is null then return; end if;
  perform set_config('cb.note', 'claimed by ' || a, true);
  return query update cb.tasks t set status = 'in_progress', assignee = a where t.id = tid returning t.*;
  perform set_config('cb.note', '', true);
end $$;

-- My open tasks, plus anything of mine that changed in the last 24h, so a
-- cancelled or reassigned task is seen at least once.
create function cb.mine(actor text default null)
returns setof cb.tasks language plpgsql as $$
#variable_conflict use_variable
declare a text := coalesce(nullif(trim(actor), ''), nullif(current_setting('cb.actor', true), ''), 'unknown');
begin
  return query select t.* from cb.tasks t
   where (t.assignee = a
          and (t.status not in ('done', 'cancelled') or t.updated_at > now() - interval '24 hours'))
      or (t.assignee is distinct from a and exists (
            select 1 from cb.events e where e.task_id = t.id and e.data -> 'assignee' ->> 'from' = a
               and e.at > now() - interval '24 hours'))
   order by t.status, t.priority, t.rank;
end $$;

-- ---------------------------------------------------------------- questions

drop function if exists cb.questions_history cascade;
alter table cb.questions add column if not exists assigned_to text references cb.users(name) on update cascade on delete set null;
alter table cb.questions add column if not exists answered_by text;
drop function if exists cb.ask cascade;
drop function if exists cb.user_add cascade;
drop function if exists cb.user_rotate cascade;
drop function if exists cb.user_remove cascade;
drop function if exists cb._user_hand_back cascade;
drop function if exists cb._handed_back cascade;
drop function if exists cb.user_project_add cascade;
drop function if exists cb.user_project_remove cascade;
drop function if exists cb.user_password cascade;
drop function if exists cb.assignee_on_project cascade;
drop function if exists cb.question_assign cascade;
drop function if exists cb.answer cascade;
drop function if exists cb.send_back cascade;
drop function if exists cb.reask cascade;
drop function if exists cb._options cascade;
drop function if exists cb.withdraw cascade;
drop function if exists cb._label cascade;
drop function if exists cb._dormant_withdraw cascade;
drop function if exists cb._followups_route cascade;
drop function if exists cb._picked cascade;
drop function if exists cb.answers_pending cascade;
drop function if exists cb.answer_delivered cascade;
drop function if exists cb.brief cascade;
drop function if exists cb.seen cascade;
drop function if exists cb.last_seen cascade;

create function cb.questions_history() returns trigger language plpgsql as $$
declare a text := coalesce(nullif(current_setting('cb.actor', true), ''), 'unknown');
begin
  -- a follow-up is asked when it opens (its asker asked it, not whoever answered the parent); dormant says nothing
  if tg_op = 'INSERT' or (old.status = 'dormant' and new.status = 'open') then
    if new.status = 'open' then
      insert into cb.events (actor, project, task_id, question_id, kind, summary, data)
      values (case when tg_op = 'INSERT' then a else new.asked_by end, new.project, new.task_id, new.id, 'asked', left(new.body, 120),
              jsonb_build_object('blocking', new.blocking, 'options', new.options));
    end if;
  elsif new.status = 'answered' and (old.status <> 'answered' or new.answer is distinct from old.answer) then
    insert into cb.events (actor, project, task_id, question_id, kind, summary, data)
    values (a, new.project, new.task_id, new.id, 'answered', left(new.answer, 120),
            jsonb_build_object('edited', old.status = 'answered'));
  elsif new.status is distinct from old.status and new.status <> 'sent_back' and (new.status in ('delivered', 'withdrawn') or old.status = 'open') then
    -- open → dormant (the parent's answer changed) reads as a withdrawal: the question left the board
    insert into cb.events (actor, project, task_id, question_id, kind, summary, data)
    values (a, new.project, new.task_id, new.id, case when new.status = 'dormant' then 'withdrawn' else new.status end,
            case when new.status = 'delivered' then 'delivered to ' || coalesce(new.delivered_to, '?')
                 else coalesce(nullif(current_setting('cb.note', true), ''), 'withdrew: ' || left(new.body, 100)) end, '{}');
  end if;
  return null;
end $$;

create or replace trigger questions_history after insert or update on cb.questions
  for each row execute function cb.questions_history();

-- Ask Ahmed (the non-blocking replacement for AskUserQuestion).
-- options: jsonb array of strings or {label, description}; stored as [{label, description}].
-- Blocking + task_id parks the task in Blocked until delivery.
-- Follow-up (#472): parent (Q12 or 12) makes it a dormant follow-up of that open or dormant question in the same
-- project; if_answer limits it to one of the parent's option labels (stored as the parent spells it). Task, reply_to
-- and recipient come from the parent unless given; blocking holds the task only once it opens.
create function cb.ask(project text, body text, options jsonb default null, blocking boolean default false,
                       task_id text default null, context text default null, reply_to jsonb default null,
                       multi boolean default false, actor text default null, to_user text default null,
                       parent text default null, if_answer text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.ensure_project(project);
        tid bigint := case when task_id is null or trim(task_id) = '' then null else cb.norm_id(task_id) end;
        qid bigint; par cb.questions; label text;
begin
  if coalesce(trim(body), '') = '' then raise exception 'question body is required'; end if;
  if nullif(trim(if_answer), '') is not null and nullif(trim(parent), '') is null then
    raise exception '--if needs --after: name the question whose answer it waits for (cb ask ... --after Q12 --if "Yes")';
  end if;
  if nullif(trim(parent), '') is not null then
    -- locked: an answer landing now either committed (we refuse) or waits for this follow-up and then fires it
    select * into par from cb.questions q where q.id = cb.norm_id(regexp_replace(trim(parent), '^[qQ]', '')) for update;
    if par.id is null then raise exception 'question Q% not found', regexp_replace(trim(parent), '^[qQ#]', ''); end if;
    if par.project <> p then raise exception 'Q% is in %: a follow-up is asked in its parent''s project', par.id, par.project; end if;
    if par.status not in ('open', 'dormant', 'sent_back') then
      raise exception 'Q% is already %: a follow-up needs an open question, so ask a new one instead', par.id, par.status;
    end if;
    if nullif(trim(if_answer), '') is not null then
      if coalesce(jsonb_array_length(par.options), 0) = 0 then
        raise exception 'Q% has no options (free text): drop --if and the follow-up comes after any answer', par.id;
      end if;
      select o ->> 'label' into label from jsonb_array_elements(par.options) o
       where cb._label(o ->> 'label') = cb._label(if_answer) or lower(trim(o ->> 'label')) = lower(trim(if_answer)) limit 1;
      if label is null then
        raise exception '"%" is not one of Q%''s options: %', trim(if_answer), par.id,
          (select string_agg(o ->> 'label', ', ') from jsonb_array_elements(par.options) o);
      end if;
    end if;
    tid := coalesce(tid, par.task_id);
    reply_to := coalesce(reply_to, par.reply_to);
    to_user := coalesce(to_user, par.assigned_to);
  end if;
  if to_user is not null and not exists (select 1 from cb.users u where u.name = to_user) then
    raise exception 'unknown user %: see cb users', to_user;
  end if;
  if tid is not null and not exists (select 1 from cb.tasks t where t.id = tid) then
    raise exception 'task #% not found', tid;
  end if;
  if options is not null and jsonb_typeof(options) <> 'array' then
    raise exception 'options must be a JSON array of strings or {label, description} objects';
  end if;
  insert into cb.questions (project, task_id, asked_by, body, context, options, blocking, reply_to, multi, assigned_to,
                            parent_id, if_answer, status)
  values (p, tid, a, trim(body), context, cb._options(options),
          coalesce(blocking, false), reply_to, coalesce(multi, false), to_user,
          par.id, label, case when par.id is null then 'open' else 'dormant' end)
  returning cb.questions.id into qid;
  if coalesce(blocking, false) and tid is not null and par.id is null then
    perform set_config('cb.note', 'blocked on Q' || qid, true);
    update cb.tasks t set status = 'blocked', blocked_on = qid where t.id = tid;
    perform set_config('cb.note', '', true);
  end if;
  return qid;
end $$;

-- Options as stored: jsonb array of strings or {label, description} -> [{label, description}].
create function cb._options(options jsonb) returns jsonb language sql immutable as $$
  select jsonb_agg(case when jsonb_typeof(o) = 'string' then jsonb_build_object('label', o #>> '{}', 'description', null)
                        else jsonb_build_object('label', o ->> 'label', 'description', o ->> 'description') end order by i)
    from jsonb_array_elements(options) with ordinality as e(o, i)
$$;

-- Editable until delivered. ruled_by (M12): "Already ruled" (#553): the answer is that live memory entry, so the asking
-- session gets the rule itself; questions.ruled_by keeps the link for the weekly metric. A typed answer clears it.
create function cb.answer(id text, answer text default null, actor text default 'ahmed', ruled_by text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
-- no cb.memories row type: it is created further down
declare qid bigint := cb.norm_id(id); cur text; a text; par bigint; qp text; rid bigint; rst text; rp text; stale boolean; asker text;
begin
  a := cb.set_actor(actor);
  select q.status, q.parent_id, q.project, q.asked_by into cur, par, qp, asker from cb.questions q where q.id = qid for update;
  if cur is null then raise exception 'question Q% not found', qid; end if;
  if nullif(trim(ruled_by), '') is not null then
    perform cb.dashboard_only('Today');  -- the metric counts Ahmed's "Already ruled", and the answer carries his authority
    select x.id, x.status, x.project, coalesce(x.review_after < current_date, false),
           'Already ruled: M' || x.id || ' ' || x.title || coalesce(' — ' || nullif(left(x.body, 500), ''), '')
      into rid, rst, rp, stale, answer from cb.memories x where x.id = cb.norm_mem(ruled_by);
    if rst <> 'active' then raise exception 'M% is %: only a live entry answers a question', rid, rst; end if;
    if stale then raise exception 'M% is past its review date: renew it on the Memory page first', rid; end if;
    if rp is not null and rp <> qp then raise exception 'M% is in %, not %: only a global entry or one in Q%''s project', rid, rp, qp, qid; end if;
  end if;
  if coalesce(trim(answer), '') = '' then raise exception 'answer is required'; end if;
  if cur in ('delivered', 'withdrawn') then raise exception 'question Q% is already %', qid, cur; end if;
  if cur = 'dormant' then raise exception 'Q% waits on Q%: it opens when that one is answered', qid, par; end if;
  if cur = 'sent_back' then raise exception 'Q% was sent back to %: it comes back when they rewrite it', qid, asker; end if;
  update cb.questions q set status = 'answered', answer = trim(answer), answered_at = now(), answered_by = a, ruled_by = rid where q.id = qid;
  perform cb._followups_route(qid);  -- first answer or a change: the follow-ups follow it
end $$;

-- The option labels (as the parent spells them) an answer picked. The dashboard sends "Label — note" (label without
-- "(Recommended)") and, for --multi, the raw labels joined by "; " plus the note. Labels may hold " — " or ";", so the
-- answer is read against the known labels: at each step the longest label that ends at the end, "; " or " — ".
-- A typed answer that starts with no label picks nothing.
create function cb._picked(options jsonb, answer text, multi boolean) returns text[] language plpgsql immutable as $$
#variable_conflict use_variable
declare s text := lower(trim(coalesce(answer, ''))); got text[] := '{}'; best text; n int; rest text; c record;
begin
  loop
    best := null; n := 0;
    for c in select o ->> 'label' as l, f from jsonb_array_elements(coalesce(options, '[]')) o,
                    unnest(array[lower(trim(o ->> 'label')), cb._label(o ->> 'label')]) f loop
      rest := substr(s, length(c.f) + 1);
      if c.f <> '' and length(c.f) > n and left(s, length(c.f)) = c.f and (rest = '' or left(rest, 1) = ';' or left(rest, 3) = ' — ') then
        best := c.l; n := length(c.f);
      end if;
    end loop;
    exit when best is null;
    got := got || best;
    s := substr(s, n + 1);
    exit when not coalesce(multi, false) or left(s, 1) <> ';';
    s := ltrim(substr(s, 2));
  end loop;
  return got;
end $$;

-- An option label as answers compare it: case, spaces and the "(Recommended)" marker don't count.
create function cb._label(x text) returns text language sql immutable as $$
  select lower(trim(regexp_replace(coalesce(x, ''), '\s*\(recommended\)\s*$', '', 'i')))
$$;

-- Withdraw dormant follow-ups and, down the chain, theirs. why is the history line ("skipped: Q12 answered No").
-- One level per statement, until a level finds nothing: each statement sees follow-ups committed meanwhile (a
-- cb.ask that held the parent's lock), and a cb.ask after this sees its parent withdrawn and refuses.
create function cb._dormant_withdraw(ids bigint[], why text) returns void language plpgsql as $$
#variable_conflict use_variable
declare lv bigint[] := ids; done bigint[];
begin
  perform set_config('cb.note', why, true);
  while cardinality(lv) > 0 loop
    with w as (update cb.questions q set status = 'withdrawn' where q.id = any(lv) and q.status = 'dormant' returning q.id)
    select array(select w.id from w) into done;
    lv := array(select q.id from cb.questions q where q.parent_id = any(done) and q.status = 'dormant');
  end loop;
  perform set_config('cb.note', '', true);
end $$;

-- Q pid's answer is new or changed (not delivered yet): its follow-ups follow it.
--  - open, unanswered follow-ups it no longer picks go back to dormant, and give back the task they held;
--  - dormant follow-ups it picks (or with no if_answer) open, asked now so they sort fresh; blocking ones hold the task;
--  - a follow-up it no longer picks that is already answered refuses the change (withdraw it first).
-- The rest stay dormant until the answer is delivered (cb.answer_delivered skips them).
create function cb._followups_route(pid bigint) returns void language plpgsql as $$
#variable_conflict use_variable
declare par cb.questions; picked text[]; c record; t cb.tasks; h jsonb; live bigint;
begin
  select * into par from cb.questions q where q.id = pid;
  picked := cb._picked(par.options, par.answer, par.multi);
  select q.id, q.if_answer, q.status into c from cb.questions q
   where q.parent_id = pid and q.status in ('answered', 'delivered') and q.if_answer is not null and q.if_answer <> all(picked)
   order by q.id limit 1;
  if found then
    raise exception 'Q% (the "%" follow-up) is already %; %', c.id, c.if_answer, c.status,
      case when c.status = 'answered' then 'withdraw it first (cb withdraw Q' || c.id || ') to change the answer to Q' || pid
           else 'the answer to Q' || pid || ' can no longer change' end;
  end if;

  perform set_config('cb.note', 'waiting again: Q' || pid || ' now answered ' || left(par.answer, 100), true);
  for c in update cb.questions q set status = 'dormant', sent_back = null
            where q.parent_id = pid and q.status in ('open', 'sent_back') and q.if_answer is not null and q.if_answer <> all(picked)
            returning q.id, q.hold_before loop
    h := c.hold_before;
    continue when h is null;
    -- put the task back as it was before this follow-up took it; a question that held it then and has since been
    -- delivered or withdrawn no longer holds it (released as its delivery would have)
    live := (select x.id from cb.questions x where x.id = (h ->> 'blocked_on')::bigint and x.status in ('open', 'answered', 'sent_back'));
    perform set_config('cb.note', 'Q' || c.id || ' waits again: back as before it asked', true);
    update cb.tasks x set blocked_on = live,
           status = case when live is not null then 'blocked'
                         when h ->> 'blocked_on' is null then h ->> 'status'
                         when cardinality(cb._waits_on(x.id)) > 0 then 'blocked'
                         when x.assignee is null then 'next' else 'in_progress' end
     where x.id = (h ->> 'task')::bigint and x.blocked_on = c.id and x.status = 'blocked';
  end loop;
  perform set_config('cb.note', '', true);

  for c in update cb.questions q set status = 'open', created_at = now(), hold_before = null, sent_back = null
            where q.parent_id = pid and q.status = 'dormant' and (q.if_answer is null or q.if_answer = any(picked))
            returning q.id, q.blocking, q.task_id loop
    if c.blocking and c.task_id is not null then  -- as cb.ask does, unless the task finished while it waited
      select * into t from cb.tasks x where x.id = c.task_id for update;
      if found and t.status not in ('done', 'cancelled') then
        update cb.questions q set hold_before = jsonb_build_object('task', t.id, 'status', t.status, 'blocked_on', t.blocked_on) where q.id = c.id;
        perform set_config('cb.note', 'blocked on Q' || c.id, true);
        update cb.tasks x set status = 'blocked', blocked_on = c.id where x.id = t.id;
        perform set_config('cb.note', '', true);
      end if;
    end if;
  end loop;
end $$;

create function cb.withdraw(id text, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(id);
begin
  perform cb.set_actor(actor);
  update cb.questions q set status = 'withdrawn' where q.id = qid and q.status in ('open', 'answered', 'dormant', 'sent_back');
  if not found then raise exception 'question Q% not found or already delivered/withdrawn', qid; end if;
  perform cb._dormant_withdraw(array(select q.id from cb.questions q where q.parent_id = qid and q.status = 'dormant'),
                               'withdrawn with Q' || qid);
  -- the blockers lock (see cb.tasks_unblock) before deciding: a blocker finishing at the same moment either has
  -- committed (the statements below see it) or waits for this transaction and then sees blocked_on cleared
  perform pg_advisory_xact_lock(hashtext('cb.blockers:' || x.project))
     from (select distinct t.project from cb.tasks t where t.blocked_on = qid order by 1) x;
  -- still waiting on a task (see cb.task_blockers): the question no longer holds it, the blocker does
  perform set_config('cb.note', 'Q' || qid || ' withdrawn; still waits on its blocking tasks', true);
  update cb.tasks t set blocked_on = null where t.blocked_on = qid and t.status = 'blocked' and cardinality(cb._waits_on(t.id)) > 0;
  perform set_config('cb.note', '', true);
  update cb.tasks t set status = case when t.assignee is null then 'next' else 'in_progress' end
   where t.blocked_on = qid and t.status = 'blocked';
end $$;

-- Send an open question back to its asker (#616). reason: details (more details) | clarify (note = his own question,
-- required) | simplify | reask (the options are wrong). It leaves the waiting lists until the asker rewrites it with
-- cb.reask; the inbox and cb pending carry it to the asker as they carry answers, cb.answer_delivered marks it told.
-- A blocking question keeps its task held throughout: only an answer's delivery or a withdrawal releases it.
-- Ahmed's dashboard only: the server runs a guest's send-back there too, once it has checked the question is theirs.
-- The note reaches a session: one line, at most 500 characters, no secrets or personal data (cb._sensitive).
create function cb.send_back(id text, reason text, note text default null, actor text default 'ahmed')
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(regexp_replace(trim(coalesce(id, '')), '^[qQ]', '')); a text := cb.set_actor(actor);
        r text := lower(trim(coalesce(reason, '')));
        n text := nullif(trim(regexp_replace(coalesce(note, ''), '[\s\u0085\u2028\u2029]+', ' ', 'g')), ''); cur text; hit text;
begin
  perform cb.dashboard_only('Today');
  if length(n) > 500 then raise exception 'the note is at most 500 characters (this one is %)', length(n); end if;
  hit := cb._sensitive(n);
  if hit is not null then
    raise exception 'that looks like %; the note goes to a session: say where the value lives, not the value', hit;
  end if;
  if r not in ('details', 'clarify', 'simplify', 'reask') then
    raise exception '"%" is not a reason: details, clarify, simplify or reask', trim(coalesce(reason, ''));
  end if;
  if r = 'clarify' and n is null then raise exception 'clarify needs your question in the note'; end if;
  select q.status into cur from cb.questions q where q.id = qid for update;
  if cur is null then raise exception 'question Q% not found', qid; end if;
  if cur <> 'open' then raise exception 'Q% is %: only an open question can be sent back', qid, cur; end if;
  update cb.questions q set status = 'sent_back', sent_back = jsonb_build_object('reason', r, 'note', n, 'by', a, 'at', now())
   where q.id = qid;
  insert into cb.events (actor, project, task_id, question_id, kind, summary)
  select a, q.project, q.task_id, q.id, 'sent_back', 'sent back: ' || r || coalesce(' — ' || left(n, 200), '')
    from cb.questions q where q.id = qid;
end $$;

-- The asker rewrites its question in place (#616): same id, open again, asked now (it sorts fresh and rings). From
-- sent_back, or from open to improve a question nobody answered yet. Only the asker, or Ahmed's dashboard. Each given
-- part replaces the old one: body, options (or free: no options), multi (null keeps it; new options reset it to
-- false), context. The old text, options and context, with the send-back that asked for this, go to versions.
-- A dormant follow-up waiting on one of its option labels keeps it (compared as answers compare labels, cb._label)
-- and takes the new spelling, so the answer still routes to it; dropping it is refused.
create function cb.reask(id text, body text default null, options jsonb default null, free boolean default false,
                         multi boolean default null, context text default null, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(regexp_replace(trim(coalesce(id, '')), '^[qQ]', '')); a text := cb.set_actor(actor);
        q cb.questions; opts jsonb; c record; label text; b text := nullif(trim(body), ''); fr boolean := coalesce(free, false);
begin
  select * into q from cb.questions x where x.id = qid for update;
  if q.id is null then raise exception 'question Q% not found', qid; end if;
  if not cb._is_dashboard() and a <> q.asked_by then
    raise exception 'only Q%''s asker (%) or Ahmed can rewrite it', qid, q.asked_by;
  end if;
  if q.status not in ('open', 'sent_back') then
    raise exception 'Q% is %: only an open or sent-back question can be rewritten', qid, q.status;
  end if;
  if b is null and options is null and not fr and multi is null and context is null then
    raise exception 'nothing to rewrite: give the new question, -o options, --free, --multi or -c context';
  end if;
  if options is not null and fr then raise exception 'give options or --free, not both'; end if;
  if options is not null and jsonb_typeof(options) <> 'array' then
    raise exception 'options must be a JSON array of strings or {label, description} objects';
  end if;
  opts := case when fr then null when options is not null then cb._options(options) else q.options end;
  for c in select x.id, x.if_answer from cb.questions x
            where x.parent_id = qid and x.status = 'dormant' and x.if_answer is not null order by x.id loop
    label := (select o ->> 'label' from jsonb_array_elements(coalesce(opts, '[]')) o where cb._label(o ->> 'label') = cb._label(c.if_answer) limit 1);
    if label is null then
      raise exception 'Q% waits on the "%" option of Q%: keep that option, or withdraw Q% first (cb withdraw Q%)', c.id, c.if_answer, qid, c.id, c.id;
    end if;
    update cb.questions x set if_answer = label where x.id = c.id;
  end loop;
  update cb.questions x set status = 'open', created_at = now(), sent_back = null,
         versions = coalesce(x.versions, '[]') || jsonb_build_array(jsonb_build_object(
           'body', x.body, 'options', x.options, 'multi', x.multi, 'context', x.context, 'asked_at', x.created_at,
           'reason', x.sent_back ->> 'reason', 'note', x.sent_back ->> 'note', 'by', x.sent_back ->> 'by',
           'rewritten_at', now(), 'rewritten_by', a)),
         body = coalesce(b, x.body), options = opts, context = coalesce(context, x.context),
         multi = case when multi is not null then multi when options is not null or fr then false else x.multi end
   where x.id = qid;
  insert into cb.events (actor, project, task_id, question_id, kind, summary)
  values (a, q.project, q.task_id, qid, 'rewritten', 'Q' || qid || ' rewritten'
          || coalesce(' (' || case q.sent_back ->> 'reason' when 'details' then 'more details' when 'clarify' then 'clarified'
                                   when 'simplify' then 'simplified' when 'reask' then 'new options' end || ')', '')
          || ': ' || left(coalesce(b, q.body), 100));
end $$;

create function cb.answers_pending(project text default null)
returns setof cb.questions language plpgsql as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  -- and send-backs not yet delivered (#616): the asker rewrites those (cb reask)
  return query select q.* from cb.questions q
   where (q.status = 'answered' or (q.status = 'sent_back' and q.sent_back ->> 'delivered_at' is null)) and (p is null or q.project = p)
   order by coalesce(q.answered_at, (q.sent_back ->> 'at')::timestamptz), q.id;
end $$;

-- Orchestrator: answer handed to the session. Idempotent. Unblocks the task.
-- sent_back_at (#616): the relay delivers that send-back only (its sent_back.at); a question rewritten (or sent back
-- again) since is left as it is, quietly.
create function cb.answer_delivered(id text, delivered_to text default null, actor text default null, sent_back_at text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(id); cur text; ans text;
begin
  perform cb.set_actor(actor);
  select q.status, q.answer into cur, ans from cb.questions q where q.id = qid for update;
  if cur is null then raise exception 'question Q% not found', qid; end if;
  if cur = 'delivered' then return; end if;
  if cur = 'sent_back' then  -- the asker was told (#616); the question waits for its rewrite and keeps holding its task
    update cb.questions q set sent_back = q.sent_back || jsonb_build_object('delivered_at', now(), 'delivered_to', delivered_to)
     where q.id = qid and q.sent_back ->> 'delivered_at' is null and (sent_back_at is null or q.sent_back ->> 'at' = sent_back_at);
    return;
  end if;
  if sent_back_at is not null then return; end if;
  if cur <> 'answered' then raise exception 'question Q% is %, not answered', qid, cur; end if;
  update cb.questions q set status = 'delivered', delivered_at = now(), delivered_to = delivered_to where q.id = qid;
  -- the answer is final now: follow-ups it did not pick are skipped, down the chain
  perform cb._dormant_withdraw(array(select q.id from cb.questions q where q.parent_id = qid and q.status = 'dormant'),
                               'skipped: Q' || qid || ' answered ' || left(ans, 100));
  -- the blockers lock (see cb.tasks_unblock) before deciding: a blocker finishing at the same moment either has
  -- committed (the statements below see it) or waits for this transaction and then sees blocked_on cleared
  perform pg_advisory_xact_lock(hashtext('cb.blockers:' || x.project))
     from (select distinct t.project from cb.tasks t where t.blocked_on = qid order by 1) x;
  -- still waiting on a task (see cb.task_blockers): the question no longer holds it, the blocker does
  perform set_config('cb.note', 'Q' || qid || ' answered; still waits on its blocking tasks', true);
  update cb.tasks t set blocked_on = null where t.blocked_on = qid and t.status = 'blocked' and cardinality(cb._waits_on(t.id)) > 0;
  perform set_config('cb.note', 'unblocked: Q' || qid || ' answered', true);
  update cb.tasks t set status = case when t.assignee is null then 'next' else 'in_progress' end
   where t.blocked_on = qid and t.status = 'blocked';
  perform set_config('cb.note', '', true);
end $$;

-- Snapshot a session reads at start.
create function cb.brief(project text default null, tag text default null, type text default null)
returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); tg text := nullif(cb.norm_tag(tag), '');
  ty text := case when nullif(trim(type), '') is null then null else cb.norm_type(type) end;
begin
  return jsonb_build_object(
    'in_progress', cb._brief_tasks(p, tg, 'in_progress', 50, ty),
    'next', cb._brief_tasks(p, tg, 'next', 10, ty),
    'blocked', cb._brief_tasks(p, tg, 'blocked', 50, ty),
    'review', cb._brief_tasks(p, tg, 'review', 50, ty),
    'open_questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'project', q.project, 'body', q.body,
        'blocking', q.blocking, 'asked_by', q.asked_by, 'task_id', q.task_id, 'options', q.options, 'assigned_to', q.assigned_to) order by q.blocking desc, q.id)
      from cb.questions q where q.status = 'open' and (p is null or q.project = p)), '[]'),
    'answered_pending', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'project', q.project, 'body', q.body,
        'answer', q.answer, 'asked_by', q.asked_by, 'reply_to', q.reply_to, 'task_id', q.task_id) order by q.id)
      from cb.questions q where q.status = 'answered' and (p is null or q.project = p)), '[]'),
    'broadcasts', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'project', e.project, 'summary', e.summary, 'at', e.at)
                                               order by e.id desc)
      from cb.events e where e.kind = 'broadcast' and e.at > now() - interval '24 hours'
                         and (p is null or e.project is null or e.project = p)), '[]'),
    'goals', cb.goals_list(p),  -- active goals for this project and every-project ones, in order
    'memory', cb.mem_pack(p));  -- no project: the global entries only
end $$;

drop function if exists cb._brief_tasks cascade;
create function cb._brief_tasks(p text, tg text, s text, lim int, ty text default null) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(x) - 'o' order by x.o), '[]') from (
    select t.id, t.project, t.title, t.priority, t.assignee, t.updated_at, t.blocked_on, t.rank, t.labels, t.type,
           t.epic_id, cb._waits_on(t.id) as waits_on,
           row_number() over (order by t.priority <> 'P0', case when t.priority <> 'P0' then cb._goal_rank(t.id) end nulls last,
                                       t.priority, t.rank, t.id) as o
      from cb.tasks t where t.status = s and (p is null or t.project = p) and (tg is null or tg = any(t.labels))
                        and (ty is null or t.type = ty)
     order by o limit lim) x
$$;

create function cb.seen(at timestamptz default now()) returns void language plpgsql as $$
#variable_conflict use_variable
begin
  insert into cb.settings (key, value) values ('owner_last_seen_at', to_jsonb(at))
  on conflict (key) do update set value = excluded.value;
end $$;

create function cb.last_seen() returns timestamptz language plpgsql stable as $$
begin
  return coalesce((select (s.value #>> '{}')::timestamptz from cb.settings s where s.key = 'owner_last_seen_at'),
                  now() - interval '24 hours');
end $$;

-- Bind a session (machine + herdr pane) to an actor. Machine names compare case-insensitively.
create function cb.iam(machine text, pane text, actor text, project text default null) returns text language plpgsql as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);  -- unknown project raises; null keeps the session's current one
begin
  if coalesce(trim(actor), '') = '' or coalesce(trim(pane), '') = '' then raise exception 'pane and actor are required'; end if;
  perform cb.not_ahmed(actor);
  -- a new session starts from now: it never gets broadcasts or messages sent before it existed
  insert into cb.sessions (machine, pane, actor, project, broadcast_seen)
  values (lower(trim(machine)), trim(pane), trim(actor), p, coalesce((select max(e.id) from cb.events e), 0))
  on conflict on constraint sessions_pkey do update
    set actor = excluded.actor, project = coalesce(excluded.project, cb.sessions.project), started_at = now(), last_seen = now();
  return trim(actor);
end $$;

-- What the relay pushes into a session: answers addressed to its pane, and changes other people
-- made to its actor's tasks (moves, edits, done, notes) after event `after_event`.
create function cb.inbox(machine text, pane text, after_event bigint default 0) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare m text := lower(trim(machine)); me text; proj text; seen bigint;
begin
  -- a new session (relay before cb iam) starts from now; until it joins a project it hears no broadcasts
  insert into cb.sessions (machine, pane, actor, broadcast_seen)
  -- a pane or machine named like ahmed must not make a session named like him
  values (m, pane, case when cb.ahmed_like(pane || '@' || m) then 'session-' || left(md5(pane || '@' || m), 8) else pane || '@' || m end,
          coalesce((select max(e.id) from cb.events e), 0))
  on conflict on constraint sessions_pkey do update set last_seen = now()
  returning cb.sessions.actor, cb.sessions.project, cb.sessions.broadcast_seen into me, proj, seen;
  return jsonb_build_object(
    'actor', me,
    'broadcasts', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'project', e.project, 'summary', e.summary) order by e.id)
                              from cb.events e
                             where e.kind = 'broadcast' and e.id > seen and proj is not null and (e.project is null or e.project = proj)
                               and e.actor is distinct from me), '[]'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'summary', e.summary) order by e.id)
                            from cb.events e
                           where e.kind = 'message' and e.data ->> 'to' = me and e.id > seen
                             and e.at > now() - interval '24 hours'), '[]'),
    -- the orchestrator (orch@*, same convention as huddle admin) gets a copy of Ahmed's answers to its workers
    'answer_copies', coalesce((select jsonb_agg(jsonb_build_object('event_id', e.id, 'id', q.id, 'task_id', q.task_id, 'asked_by', q.asked_by, 'answered_by', q.answered_by,
                                                                   'body', q.body, 'answer', q.answer) order by e.id)
                                 from cb.events e join cb.questions q on q.id = e.question_id
                                where e.kind = 'answered' and (me like 'orch@%' or me = 'orch') and e.project = proj
                                  and q.asked_by <> me and e.id > seen and e.at > now() - interval '24 hours'), '[]'),
    -- new unassigned bugs filed in my project, if I triage it (cb.triagers: its orchestrator, else everyone bound)
    'bugs', coalesce((select jsonb_agg(jsonb_build_object('event_id', e.id, 'id', t.id, 'project', t.project, 'title', t.title,
                                                          'body', t.body, 'priority', t.priority, 'actor', e.actor) order by e.id)
                        from cb.events e join cb.tasks t on t.id = e.task_id
                       where e.kind = 'task_created' and t.type = 'bug' and t.assignee is null and t.status not in ('done', 'cancelled')
                         and t.project = proj and e.actor <> me and e.id > seen and e.at > now() - interval '24 hours'
                         and me = any(cb.triagers(proj))), '[]'),
    -- huddle lines for huddles I'm in; a member added later hears only from its own 'add' on
    'huddles', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'huddle', h.id, 'topic', h.topic, 'action', e.data ->> 'action',
                                                             'actor', e.actor, 'summary', e.summary) order by e.id)
                           from cb.events e
                           join cb.huddles h on h.id = (e.data ->> 'huddle')::bigint
                           join cb.huddle_members hm on hm.huddle_id = h.id and hm.actor = me
                          where e.kind = 'huddle' and e.actor <> me and e.id > seen and e.id >= hm.from_event
                            and e.at > now() - interval '24 hours'), '[]'),
    'answers', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'task_id', q.task_id, 'project', q.project,
                                                             'body', q.body, 'answer', q.answer, 'answered_by', q.answered_by,
                                                             'parent_id', q.parent_id, 'parent_body', pq.body, 'parent_answer', pq.answer,
                                                             'parent_answered_by', pq.answered_by) order by q.id)
                           from cb.questions q left join cb.questions pq on pq.id = q.parent_id  -- a follow-up quotes what it followed
                          where q.status = 'answered' and ((lower(q.reply_to ->> 'machine') = m and q.reply_to ->> 'pane' = pane)
                                 or (coalesce(q.reply_to ->> 'pane', '') = '' and q.asked_by = me))), '[]'),
    -- questions sent back to me (#616), until delivered; same addressing as answers
    'sent_back', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'task_id', q.task_id, 'project', q.project, 'body', q.body,
                                                               'reason', q.sent_back ->> 'reason', 'note', q.sent_back ->> 'note',
                                                               'by', q.sent_back ->> 'by', 'at', q.sent_back ->> 'at') order by q.id)
                             from cb.questions q
                            where q.status = 'sent_back' and q.sent_back ->> 'delivered_at' is null
                              and ((lower(q.reply_to ->> 'machine') = m and q.reply_to ->> 'pane' = pane)
                                   or (coalesce(q.reply_to ->> 'pane', '') = '' and q.asked_by = me))), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'task_id', e.task_id, 'kind', e.kind, 'summary', e.summary,
                                                            'actor', e.actor, 'title', t.title, 'status', t.status) order by e.id)
                          from cb.events e join cb.tasks t on t.id = e.task_id
                         where me is not null and e.id > after_event and e.actor <> me
                           and e.kind in ('task_created', 'moved', 'updated', 'done', 'note')
                           and (t.assignee = me or e.data -> 'assignee' ->> 'from' = me)), '[]'),
    -- New work in my project's Next (unassigned or mine), only while I have nothing in progress.
    -- A new unassigned bug goes to triage ('bugs') instead: one decision, not every idle worker racing for it.
    'next_work', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'priority', t.priority)
                                            order by t.priority <> 'P0', case when t.priority <> 'P0' then cb._goal_rank(t.id) end nulls last, t.priority, t.rank, t.id)
                             from cb.tasks t
                            where me is not null and proj is not null and t.project = proj and t.status = 'next'
                              and (t.assignee is null or t.assignee = me) and not (t.type = 'bug' and t.assignee is null)
                              and exists (select 1 from cb.events e where e.task_id = t.id and e.id > after_event and e.actor <> me
                                            and ((e.kind = 'task_created' and e.data ->> 'status' = 'next')
                                                 or (e.kind = 'moved' and e.data ->> 'to' = 'next')))
                              and not exists (select 1 from cb.tasks w where w.assignee = me and w.status = 'in_progress')), '[]'),
    -- Shared memory changes (#553), same audience as broadcasts: bound sessions on the entry's project, every bound
    -- session for a global one, only that machine's for a machine-scoped one. Live on add, Ahmed's confirm, a
    -- supersede (one line naming the replacement: its add is skipped), a retire with its why. Never a proposal, a
    -- reject or a renew (none of those changed what sessions are told), and never back to the session that made it.
    'memory', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'action', e.data ->> 'action', 'actor', e.actor, 'memory', x.id,
                                                            'kind', x.kind, 'title', x.title,
                                                            'why', case when e.data ? 'why_flagged' then null else e.data ->> 'why' end,
                                                            'why_hidden', e.data ? 'why_flagged',
                                                            'replaces', x.source ->> 'supersedes', 'by', n.id, 'by_title', n.title) order by e.id)
                          from cb.events e join cb.memories x on x.id = (e.data ->> 'memory')::bigint
                          left join cb.memories n on n.id = x.superseded_by
                         where e.kind = 'memory' and me is not null and proj is not null and e.id > after_event and e.actor <> me
                           and e.data ->> 'action' in ('add', 'confirm', 'supersede', 'retire')
                           and not (e.data ->> 'action' = 'add' and x.source ? 'supersedes')
                           and (e.data ->> 'action' not in ('add', 'confirm') or x.status = 'active')  -- retired since: old news
                           and (x.project is null or x.project = proj) and (x.machine is null or x.machine = m)), '[]'),
    -- Ahmed's asks to me (#936): his lines not yet pushed, or once, late with no reply, a reminder of his lines since
    -- my last reply. upto: the event the relay marks delivered (cb.ask_delivered).
    'asks', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'task_id', a.task_id, 'upto', i.last_ahmed, 'reminder', i.delivered,
                                                          'lines', (select jsonb_agg(jsonb_build_object('action', e.data ->> 'action', 'text', e.summary) order by e.id)
                                                                      from cb.events e where e.kind = 'ask' and (e.data ->> 'ask')::bigint = a.id
                                                                       and e.data ->> 'action' in ('open', 'say')
                                                                       and e.id > case when i.delivered then coalesce(i.last_reply, 0) else a.delivered_upto end))
                                        order by a.id)
                        from cb.asks a cross join lateral cb._ask_info(a.id) i
                       where me is not null and a.status = 'open' and a.to_actor = me
                         and (not i.delivered or (i.late and a.repushed_at is null))), '[]'),
    'last_event', (select coalesce(max(e.id), 0) from cb.events e));
end $$;

-- A message to every session (project null) or to one project's sessions. Relays push it; cb brief lists 24h.
create function cb.broadcast(message text, project text default null, actor text default null) returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.read_project(project); new_id bigint;
begin
  if coalesce(trim(message), '') = '' then raise exception 'message is required'; end if;
  insert into cb.events (actor, project, kind, summary) values (a, p, 'broadcast', trim(message))
  returning cb.events.id into new_id;
  return new_id;
end $$;

create function cb.broadcast_seen(machine text, pane text, upto bigint) returns void language sql as $$
  -- positional: in a SQL function a bare "pane" would mean the column
  update cb.sessions s set broadcast_seen = greatest(s.broadcast_seen, $3)
   where s.machine = lower(trim($1)) and s.pane = $2
$$;

-- Add and remove tags in one call (the orchestrator tags work streams: ocr, tawuniya, ...). Returns the new tags.
create function cb.task_tag(id text, add jsonb default '[]', remove jsonb default '[]', actor text default null)
returns text[] language plpgsql as $$
#variable_conflict use_variable
declare
  a text := cb.set_actor(actor); tid bigint := cb.norm_id(id); cur text[];
  ad text[] := array(select n from (select cb.norm_tag(x) n, min(o) o from jsonb_array_elements_text(coalesce(add, '[]')) with ordinality j(x, o) group by 1) z
                     where n <> '' order by o);
  rm text[] := array(select cb.norm_tag(x) from jsonb_array_elements_text(coalesce(remove, '[]')) x);
begin
  select t.labels into cur from cb.tasks t where t.id = tid;
  if not found then raise exception 'no task #%', tid; end if;
  cur := array(select x from unnest(cur) with ordinality u(x, o) where x <> all(rm) order by o);
  cur := cur || array(select x from unnest(ad) with ordinality u(x, o) where x <> all(cur) order by o);
  update cb.tasks t set labels = cur where t.id = tid;
  return cur;
end $$;

-- One row per session/worker: bound sessions (cb iam), plus anyone who acted or holds open work in
-- the last week. live = its relay checked in within 90s (relays poll every 30s).
create function cb.sessions_overview(project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  return coalesce((select jsonb_agg(x.r order by (x.r ->> 'live') desc, x.r ->> 'actor') from (
    select jsonb_build_object(
      'actor', a.actor, 'project', s.project, 'machine', s.machine, 'pane', s.pane, 'last_seen', s.last_seen,
      'live', coalesce(s.last_seen > now() - interval '90 seconds', false),
      'doing', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'priority', t.priority, 'status', t.status) order by t.updated_at desc)
                           from cb.tasks t where t.assignee = a.actor and t.status in ('in_progress', 'blocked', 'review') and (p is null or t.project = p)), '[]'),
      'queued', (select count(*) from cb.tasks t where t.assignee = a.actor and t.status = 'next' and (p is null or t.project = p)),
      'done_24h', (select count(*) from cb.tasks t where t.assignee = a.actor and t.status = 'done' and t.done_at > now() - interval '24 hours' and (p is null or t.project = p)),
      'open_questions', (select count(*) from cb.questions q where q.asked_by = a.actor and q.status = 'open' and (p is null or q.project = p)),
      'last', (select jsonb_build_object('at', e.at, 'kind', e.kind, 'summary', e.summary, 'task_id', e.task_id)
                 from cb.events e where e.actor = a.actor and (p is null or e.project = p) order by e.id desc limit 1)) as r
    from (
      select s2.actor from cb.sessions s2 where p is null or s2.project = p
      union select e.actor from cb.events e where e.at > now() - interval '7 days' and (p is null or e.project = p)
      union select t.assignee from cb.tasks t where t.assignee is not null and t.status not in ('done', 'cancelled') and (p is null or t.project = p)
    ) a
    left join lateral (select * from cb.sessions s3 where s3.actor = a.actor order by s3.last_seen desc limit 1) s on true
    where a.actor is not null and a.actor not in ('ahmed', 'relay', 'unknown', 'board') and a.actor not in (select u.name from cb.users u)
  ) x), '[]');
end $$;

-- A direct message to one session (orchestrator → worker, or back). The relay pushes it like a
-- broadcast and broadcast_seen marks both read; held 24h for a session whose relay is down.
create function cb.tell(to_actor text, message text, actor text default null) returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text; new_id bigint;
begin
  if coalesce(trim(message), '') = '' then raise exception 'message is required'; end if;
  select s.project into p from cb.sessions s where s.actor = to_actor order by s.last_seen desc limit 1;
  if not found and not exists (select 1 from cb.events e where e.actor = to_actor)
                and not exists (select 1 from cb.tasks t where t.assignee = to_actor) then
    raise exception 'unknown session %: see cb sessions for names', to_actor;
  end if;
  insert into cb.events (actor, project, kind, summary, data) values (a, p, 'message', trim(message), jsonb_build_object('to', to_actor))
  returning cb.events.id into new_id;
  return new_id;
end $$;

-- Huddles: a discussion group of sessions on one topic (optionally one task). Lines are events
-- (kind 'huddle'), so they carry the task id and land on that task's timeline; the relay pushes each
-- line to the other members.
create table if not exists cb.huddles (
  id         bigint generated always as identity primary key,
  project    text not null references cb.projects(slug) on update cascade,
  topic      text not null,
  task_id    bigint references cb.tasks(id) on delete set null,
  opened_by  text not null,
  status     text not null default 'open' check (status in ('open', 'closed')),
  summary    text,
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz
);
create table if not exists cb.huddle_members (
  huddle_id  bigint not null references cb.huddles(id) on delete cascade,
  actor      text not null,
  added_by   text not null,
  from_event bigint not null default 0, -- the line that added them: they're pushed lines from here on
  added_at   timestamptz not null default now(),
  primary key (huddle_id, actor)
);
create or replace trigger huddles_notify after insert or update or delete on cb.huddles
  for each statement execute function cb.notify();

-- ponytail: admin = Ahmed or the orchestrator by naming convention (orch@<machine>); a roles table if that stops holding.
create function cb._huddle_post(h cb.huddles, action text, message text, a text) returns bigint language plpgsql as $$
declare new_id bigint;
begin
  if h.status = 'closed' then raise exception 'huddle #% is closed', h.id; end if;
  if not (a = 'ahmed' or a like 'orch@%' or a = 'orch'
          or exists (select 1 from cb.huddle_members m where m.huddle_id = h.id and m.actor = a)) then
    raise exception '% is not in huddle #% (members can talk; cb huddle show %)', a, h.id, h.id;
  end if;
  insert into cb.events (actor, project, task_id, kind, summary, data)
  values (a, h.project, h.task_id, 'huddle', message, jsonb_build_object('huddle', h.id, 'action', action))
  returning id into new_id;
  return new_id;
end $$;

-- Add members (must be known sessions of the huddle's project). Returns the names actually added.
create function cb._huddle_join(h cb.huddles, members jsonb, a text, from_event bigint) returns text[] language plpgsql as $$
declare who text; p text; added text[] := '{}';
begin
  for who in select trim(x) from jsonb_array_elements_text(coalesce(members, '[]')) x where trim(x) <> '' loop
    select s.project into p from cb.sessions s where s.actor = who order by s.last_seen desc limit 1;
    if not found then
      if not exists (select 1 from cb.events e where e.actor = who) and not exists (select 1 from cb.tasks t where t.assignee = who)
        then raise exception 'unknown session %: see cb sessions for names', who; end if;
    elsif p is distinct from h.project then
      raise exception '% works in %, not %: huddles stay inside one project', who, coalesce(p, 'no project'), h.project;
    end if;
    insert into cb.huddle_members (huddle_id, actor, added_by, from_event) values (h.id, who, a, from_event)
    on conflict do nothing;
    if found then added := added || who; end if;
  end loop;
  return added;
end $$;

create function cb.huddle_open(topic text, members jsonb default '[]', task text default null, actor text default null, project text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); tid bigint := case when task is null then null else cb.norm_id(task) end; p text; h cb.huddles; ev bigint;
begin
  if coalesce(trim(topic), '') = '' then raise exception 'topic is required'; end if;
  if tid is not null then
    select t.project into p from cb.tasks t where t.id = tid;
    if not found then raise exception 'no task #%', tid; end if;
  end if;
  p := coalesce(p, cb.read_project(project), (select s.project from cb.sessions s where s.actor = a order by s.last_seen desc limit 1));
  if p is null then raise exception 'which project? pass a task (-t) or bind this session (cb iam)'; end if;
  insert into cb.huddles (project, topic, task_id, opened_by) values (p, trim(topic), tid, a) returning * into h;
  insert into cb.huddle_members (huddle_id, actor, added_by) values (h.id, a, a);
  ev := cb._huddle_post(h, 'open', 'opened: ' || h.topic, a);
  perform cb._huddle_join(h, members, a, ev);
  return h.id;
end $$;

create function cb.huddle_add(id text, members jsonb, actor text default null) returns text[] language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); h cb.huddles; ev bigint;
begin
  select * into h from cb.huddles x where x.id = cb.norm_id(id);
  if not found then raise exception 'no huddle #%', id; end if;
  ev := cb._huddle_post(h, 'add', 'added ' || (select string_agg(trim(x), ', ') from jsonb_array_elements_text(members) x), a);
  return cb._huddle_join(h, members, a, ev);
end $$;

create function cb.huddle_say(id text, message text, actor text default null) returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); h cb.huddles;
begin
  if coalesce(trim(message), '') = '' then raise exception 'message is required'; end if;
  select * into h from cb.huddles x where x.id = cb.norm_id(id);
  if not found then raise exception 'no huddle #%', id; end if;
  return cb._huddle_post(h, 'say', trim(message), a);
end $$;

create function cb.huddle_close(id text, summary text default null, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); h cb.huddles; s text := nullif(trim(summary), '');
begin
  select * into h from cb.huddles x where x.id = cb.norm_id(id);
  if not found then raise exception 'no huddle #%', id; end if;
  perform cb._huddle_post(h, 'close', coalesce('closed: ' || s, 'closed'), a);
  update cb.huddles x set status = 'closed', closed_at = now(), summary = s where x.id = h.id;
end $$;

-- Open huddles first, then the last week's closed ones.
create function cb.huddles_list(project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', h.id, 'project', h.project, 'topic', h.topic, 'task_id', h.task_id, 'opened_by', h.opened_by, 'status', h.status,
      'summary', h.summary, 'opened_at', h.opened_at, 'closed_at', h.closed_at,
      'members', (select coalesce(jsonb_agg(m.actor order by m.added_at), '[]') from cb.huddle_members m where m.huddle_id = h.id),
      'messages', (select count(*) from cb.events e where e.kind = 'huddle' and (e.data ->> 'huddle')::bigint = h.id),
      'last', (select jsonb_build_object('actor', e.actor, 'summary', e.summary, 'at', e.at) from cb.events e
                where e.kind = 'huddle' and (e.data ->> 'huddle')::bigint = h.id order by e.id desc limit 1))
    order by h.status desc, h.opened_at desc)
    from cb.huddles h
   where (p is null or h.project = p) and (h.status = 'open' or h.closed_at > now() - interval '7 days')), '[]');
end $$;

-- People who answer through a guest link (Omar, Iman). The link carries the token.
create function cb.user_add(name text, display text default null, actor text default null) returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); n text := lower(trim(name)); t text; was text; now_d text;
begin
  if n !~ '^[a-z][a-z0-9_-]*$' then raise exception 'user name: lowercase letters, digits, - or _ (e.g. omar)'; end if;
  if n = 'ahmed' then raise exception 'ahmed is the board owner, not a guest user: pick another name'; end if;
  select u.display into was from cb.users u where u.name = n;
  insert into cb.users (name, display) values (n, coalesce(nullif(trim(display), ''), initcap(n)))
  on conflict on constraint users_pkey do update set display = coalesce(nullif(trim(user_add.display), ''), cb.users.display)
  returning cb.users.token, cb.users.display into t, now_d;
  if was is null or was <> now_d then
    insert into cb.events (actor, kind, summary, data)
    values (a, 'user', case when was is null then 'added ' || now_d || ' (' || n || ')' else 'renamed ' || was || ' to ' || now_d || ' (' || n || ')' end,
            jsonb_build_object('user', n, 'action', case when was is null then 'add' else 'rename' end));
  end if;
  -- The token is the guest's whole login: only Ahmed's dashboard gets it back. A session adds people, Ahmed sends the link.
  return case when current_setting('application_name') = 'cb-web' then t end;
end $$;

-- A new link for a user. The old one stops working at once, in signed-in browsers too (the cookie holds the token).
create function cb.user_rotate(name text, actor text default null) returns text language plpgsql as $$
#variable_conflict use_variable
declare a text; n text := lower(trim(name)); t text; d text;
begin
  perform cb.dashboard_only();
  a := cb.set_actor(actor);
  update cb.users u set token = gen_random_uuid()::text where u.name = n returning u.token, u.display into t, d;
  if t is null then raise exception 'unknown user %: see cb users', name; end if;
  insert into cb.events (actor, kind, summary, data)
  values (a, 'user', 'new link for ' || d || ' (' || n || '): the old one no longer works', jsonb_build_object('user', n, 'action', 'rotate'));
  return t;
end $$;

-- Hand a person's open work back: open questions to Ahmed, open tasks unassigned (status kept, so a task held
-- on one of those questions stays held; in progress goes back to Next, since nobody is working it).
-- project null = everywhere. why ends the history note: "unassigned: <why>".
create function cb._user_hand_back(n text, why text, project text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare nq int; nt int; nt2 int;
begin
  update cb.questions q set assigned_to = null where q.assigned_to = n and q.status = 'open' and (project is null or q.project = project);
  get diagnostics nq = row_count;
  -- follow-ups not asked yet, and questions sent back for a rewrite, go back too, uncounted: not waiting on anyone now
  update cb.questions q set assigned_to = null where q.assigned_to = n and q.status in ('dormant', 'sent_back') and (project is null or q.project = project);
  perform set_config('cb.note', 'unassigned and back to Next: ' || why, true);
  update cb.tasks t set assignee = null, status = 'next' where t.assignee = n and t.status = 'in_progress' and (project is null or t.project = project);
  get diagnostics nt = row_count;
  perform set_config('cb.note', 'unassigned: ' || why, true);
  update cb.tasks t set assignee = null where t.assignee = n and t.status not in ('done', 'cancelled') and (project is null or t.project = project);
  get diagnostics nt2 = row_count;
  perform set_config('cb.note', '', true);
  return jsonb_build_object('questions', nq, 'tasks', nt + nt2);
end $$;

-- "1 open question back to Ahmed, 2 open tasks unassigned"
create function cb._handed_back(r jsonb) returns text language sql immutable as $$
  select (r ->> 'questions') || ' open question' || case when (r ->> 'questions') = '1' then '' else 's' end || ' back to Ahmed, '
      || (r ->> 'tasks') || ' open task' || case when (r ->> 'tasks') = '1' then '' else 's' end || ' unassigned'
$$;

-- Remove a user: their link stops working and their open work is handed back (cb._user_hand_back).
-- Answers and notes they left stay under their name. Returns the counts.
create function cb.user_remove(name text, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text; n text := lower(trim(name)); d text; r jsonb;
begin
  perform cb.dashboard_only();
  a := cb.set_actor(actor);
  select u.display into d from cb.users u where u.name = n for update;
  if d is null then raise exception 'unknown user %: see cb users', name; end if;
  r := cb._user_hand_back(n, d || ' was removed');
  delete from cb.users u where u.name = n; -- the FK clears assigned_to on their closed questions too
  insert into cb.events (actor, kind, summary, data)
  values (a, 'user', 'removed ' || d || ' (' || n || '): ' || cb._handed_back(r), jsonb_build_object('user', n, 'action', 'remove') || r);
  return r;
end $$;

-- Put a person on a project: questions and tasks there may now go to them.
create function cb.user_project_add(name text, project text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; n text := lower(trim(name)); d text; p text;
begin
  perform cb.dashboard_only();
  a := cb.set_actor(actor);
  select u.display into d from cb.users u where u.name = n;
  if d is null then raise exception 'unknown user %: see cb users', name; end if;
  p := cb.read_project(project);
  if p is null then raise exception 'project is required'; end if;
  insert into cb.user_projects (user_name, project) values (n, p) on conflict do nothing;
  if found then
    insert into cb.events (actor, project, kind, summary, data)
    values (a, p, 'user', d || ' (' || n || ') is now on ' || p, jsonb_build_object('user', n, 'action', 'project_add', 'project', p));
  end if;
end $$;

-- Take a person off a project: their open work there is handed back (cb._user_hand_back). Returns the counts.
create function cb.user_project_remove(name text, project text, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text; n text := lower(trim(name)); d text; p text; r jsonb;
begin
  perform cb.dashboard_only();
  a := cb.set_actor(actor);
  select u.display into d from cb.users u where u.name = n;
  if d is null then raise exception 'unknown user %: see cb users', name; end if;
  p := cb.read_project(project);
  delete from cb.user_projects up where up.user_name = n and up.project = p;
  if not found then raise exception '% is not on project %', n, p; end if;
  r := cb._user_hand_back(n, d || ' was taken off ' || p, p);
  insert into cb.events (actor, project, kind, summary, data)
  values (a, p, 'user', d || ' (' || n || ') taken off ' || p || ': ' || cb._handed_back(r),
          jsonb_build_object('user', n, 'action', 'project_remove', 'project', p) || r);
  return r;
end $$;

-- Set or reset a person's password for the login page. Stored as a bcrypt hash; the link keeps working too.
create function cb.user_password(name text, password text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; n text := lower(trim(name)); d text;
begin
  perform cb.dashboard_only();
  a := cb.set_actor(actor);
  if length(coalesce(password, '')) < 8 then raise exception 'password: at least 8 characters'; end if;
  update cb.users u set password = public.crypt(password, public.gen_salt('bf', 10)) where u.name = n returning u.display into d;
  if d is null then raise exception 'unknown user %: see cb users', name; end if;
  insert into cb.events (actor, kind, summary, data)
  values (a, 'user', 'password set for ' || d || ' (' || n || ')', jsonb_build_object('user', n, 'action', 'password'));
end $$;

-- A question or task goes to a person only on one of their projects. Checked when the assignee changes, not when
-- the project does: an alias merge or a slug rename moves assigned work and must not be blocked (the guest page
-- shows only their projects anyway). Session names (W1@pc) aren't people and pass.
create function cb.assignee_on_project() returns trigger language plpgsql as $$
declare who text := to_jsonb(new) ->> tg_argv[0];
begin
  if who is null or (tg_op = 'UPDATE' and who is not distinct from to_jsonb(old) ->> tg_argv[0])
     or not exists (select 1 from cb.users u where u.name = who)
     or exists (select 1 from cb.user_projects up where up.user_name = who and up.project = new.project) then
    return new;
  end if;
  raise exception '% is not on project %: Ahmed adds people to projects on the People page', who, new.project;
end $$;

create or replace trigger tasks_assignee_project before insert or update of assignee on cb.tasks
  for each row execute function cb.assignee_on_project('assignee');
create or replace trigger questions_assignee_project before insert or update of assigned_to on cb.questions
  for each row execute function cb.assignee_on_project('assigned_to');

-- The People page refreshes when someone runs cb user add from a session.
create or replace trigger users_notify after insert or update or delete on cb.users
  for each statement execute function cb.notify();
create or replace trigger user_projects_notify after insert or update or delete on cb.user_projects
  for each statement execute function cb.notify();

-- Hand an open question to a user (null hands it back to Ahmed).
create function cb.question_assign(id text, to_user text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); qid bigint := cb.norm_id(id);
begin
  if to_user is not null and not exists (select 1 from cb.users u where u.name = to_user) then
    raise exception 'unknown user %: see cb users', to_user;
  end if;
  update cb.questions q set assigned_to = to_user where q.id = qid;
  if not found then raise exception 'question Q% not found', qid; end if;
end $$;

-- ---------------------------------------------------------------- locks and tick

-- Shared locks (the Mac's DB test lock): per name, the row with held_at holds it, the rest queue by id.
create table if not exists cb.locks (
  id        bigint generated always as identity primary key,
  name      text not null,
  actor     text not null,
  queued_at timestamptz not null default now(),
  held_at   timestamptz,
  unique (name, actor)
);

-- [{name, holder, held_at, holder_seen, queue: [actor...]}] for one lock or all. holder_seen: the holder's last sign
-- of life (relay heartbeat, any event, or taking the lock).
create function cb.lock_queue(name text default null) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', g.name, 'holder', g.holder, 'held_at', g.held_at, 'queue', g.queue,
           'holder_seen', greatest(g.held_at, (select max(s.last_seen) from cb.sessions s where s.actor = g.holder),
                                   (select max(e.at) from cb.events e where e.actor = g.holder))) order by g.name), '[]')
    from (select l.name, max(l.actor) filter (where l.held_at is not null) as holder, max(l.held_at) as held_at,
                 coalesce(jsonb_agg(l.actor order by l.id) filter (where l.held_at is null), '[]') as queue
            from cb.locks l where $1 is null or l.name = lower(trim($1)) group by l.name) g
$$;

-- Take a lock, or join its queue (idempotent). Returns the lock's state.
create function cb.lock_take(name text, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); n text := lower(trim(coalesce(name, '')));
begin
  if n = '' then raise exception 'lock name is required'; end if;
  perform pg_advisory_xact_lock(hashtext('cb.lock:' || n));
  insert into cb.locks (name, actor) values (n, a) on conflict do nothing;
  update cb.locks l set held_at = now()
   where l.id = (select min(x.id) from cb.locks x where x.name = n)
     and not exists (select 1 from cb.locks h where h.name = n and h.held_at is not null);
  return cb.lock_queue(n) -> 0;
end $$;

-- Release a lock (or leave its queue). The next in the queue holds it and gets a message. Returns the new holder.
-- force: any session takes the lock off its holder (a dead session); logged, and the old holder is told.
create function cb.lock_release(name text, actor text default null, force boolean default false) returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); n text := lower(trim(coalesce(name, ''))); nxt text; old text;
begin
  perform pg_advisory_xact_lock(hashtext('cb.lock:' || n));
  if coalesce(force, false) then
    delete from cb.locks l where l.name = n and l.held_at is not null returning l.actor into old;
    if old is null then raise exception 'lock % is not held', n; end if;
    if old <> a then
      insert into cb.events (actor, kind, summary, data)
      values (a, 'note', format('force-released lock %s from %s', n, old), jsonb_build_object('lock', n, 'from', old)),
             (a, 'message', format('%s force-released your lock %s (you seemed gone); cb lock take %s to queue again', a, n, n), jsonb_build_object('to', old));
    end if;
  else
    delete from cb.locks l where l.name = n and l.actor = a;
    if not found then raise exception '% does not hold or wait for lock %', a, n; end if;
  end if;
  if not exists (select 1 from cb.locks h where h.name = n and h.held_at is not null) then
    update cb.locks l set held_at = now() where l.id = (select min(x.id) from cb.locks x where x.name = n)
    returning l.actor into nxt;
    if nxt is not null then
      insert into cb.events (actor, kind, summary, data)
      values (a, 'message', format('lock %s is yours now (released by %s); cb lock release %s when done', n, a, n), jsonb_build_object('to', nxt));
    end if;
  end if;
  return nxt;
end $$;

-- A reviewer's task: tagged review (what the orchestrator does), or titled "Review/Cross-review/Delta review/Re-check ...".
create function cb._is_review(labels text[], title text) returns boolean language sql immutable as $$
  select 'review' = any($1) or $2 ~* '^((cross-|delta )?review|re-check)'
$$;

-- PR number from links.pr: "https://github.com/o/r/pull/2800" or "#2800" → 2800.
create function cb._pr_no(links jsonb) returns text language sql immutable as $$
  select substring($1 ->> 'pr' from '([0-9]+)/?$')
$$;

-- Some reviewer task (not cancelled) covers this task: same PR, or "#<task id>"/"#<pr>" in its title.
create function cb._has_reviewer(t cb.tasks) returns boolean language sql stable as $$
  select exists (select 1 from cb.tasks r
                  where r.project = t.project and r.id <> t.id and r.status <> 'cancelled' and cb._is_review(r.labels, r.title)
                    and (r.title ~ ('#' || t.id || '([^0-9]|$)')
                         or (cb._pr_no(t.links) is not null
                             and (cb._pr_no(r.links) = cb._pr_no(t.links) or r.title ~ ('#' || cb._pr_no(t.links) || '([^0-9]|$)')))))
$$;

-- cb tick, board side (read-only): what needs someone now. The CLI adds GitHub's view and one command per line.
-- GO rule: a reviewer task's verdict is its latest done/note summary that says GO; "NO-GO"/"NO GO" is not GO.
-- The reviewed commit is links.commit (cb done --commit), the PR links.pr.
create function cb.tick(project text default null, actor text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); me text := coalesce(nullif(trim(actor), ''), 'unknown');
begin
  return jsonb_build_object(
    -- answered, not delivered: whoever the answer is addressed to (reply_to's session, else the asker) acts
    'answered', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'body', q.body, 'answer', q.answer, 'answered_by', q.answered_by,
        'answered_at', q.answered_at, 'who', coalesce(s.actor, q.asked_by)) order by q.answered_at, q.id)
      from cb.questions q
      left join cb.sessions s on s.machine = lower(q.reply_to ->> 'machine') and s.pane = q.reply_to ->> 'pane'
     where q.status = 'answered' and (p is null or q.project = p)), '[]'),
    -- and the ones sent back to me to rewrite (#616)
    'my_questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'body', q.body, 'created_at', q.created_at,
        'for', coalesce(q.assigned_to, 'ahmed'), 'no_options', coalesce(jsonb_array_length(q.options), 0) = 0,
        'status', q.status, 'sent_back', q.sent_back) order by q.id)
      from cb.questions q where q.status in ('open', 'sent_back') and q.asked_by = me and (p is null or q.project = p)), '[]'),
    -- in progress, and the holder has written nothing anywhere for 30 minutes (relay heartbeats don't count)
    'silent', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'assignee', t.assignee, 'last_at', l.at) order by l.at nulls first, t.id)
      from cb.tasks t cross join lateral (select max(e.at) as at from cb.events e where e.actor = t.assignee) l
     where t.status = 'in_progress' and (p is null or t.project = p) and t.assignee is not null and t.assignee <> 'ahmed'
       and t.assignee not in (select u.name from cb.users u) and (l.at is null or l.at < now() - interval '30 minutes')), '[]'),
    'blocked', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'assignee', t.assignee, 'since', coalesce(b.at, t.updated_at),
        'note', b.summary, 'question', q.id, 'question_body', q.body, 'question_status', q.status, 'question_for', coalesce(q.assigned_to, 'ahmed'))
        order by coalesce(b.at, t.updated_at))
      from cb.tasks t
      left join cb.questions q on q.id = t.blocked_on
      left join lateral (select e.at, e.summary from cb.events e where e.task_id = t.id and e.kind = 'moved' and e.data ->> 'to' = 'blocked'
                          order by e.id desc limit 1) b on true
     where t.status = 'blocked' and (p is null or t.project = p) and coalesce(b.at, t.updated_at) < now() - interval '1 hour'
       -- waiting on an open task blocker is by design, not stuck (a question it also holds on still shows)
       and (t.blocked_on is not null or cardinality(cb._waits_on(t.id)) = 0)), '[]'),
    'unreviewed', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'assignee', t.assignee, 'pr', t.links ->> 'pr') order by t.id)
      from cb.tasks t where t.status = 'review' and (p is null or t.project = p)
       and not cb._is_review(t.labels, t.title) and not cb._has_reviewer(t)
       -- held by Ahmed, a user or an orchestrator, "review" means waiting on a person, not on a code review
       and coalesce(t.assignee, '') not in ('ahmed', 'orch') and coalesce(t.assignee, '') not like 'orch@%'
       and coalesce(t.assignee, '') not in (select u.name from cb.users u)), '[]'),
    -- in progress, but the last one to move it or write on it is another worker (not Ahmed, the relay or an orchestrator)
    'misheld', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'assignee', t.assignee, 'by', l.actor) order by t.id)
      from cb.tasks t cross join lateral (select e.actor from cb.events e where e.task_id = t.id and e.kind in ('moved', 'note', 'done')
                                           order by e.id desc limit 1) l
     where t.status = 'in_progress' and (p is null or t.project = p) and t.assignee is not null and l.actor <> t.assignee
       and l.actor not in ('ahmed', 'relay', 'unknown', 'orch') and l.actor not like 'orch@%'
       and l.actor not in (select u.name from cb.users u)), '[]'),
    -- live sessions (relay within 90s) holding nothing in progress; tags = what they worked on this week
    'idle', coalesce((select jsonb_agg(jsonb_build_object('actor', s.actor, 'tags',
          (select coalesce(jsonb_agg(distinct g), '[]') from cb.tasks t, unnest(t.labels) g where t.assignee = s.actor and t.updated_at > now() - interval '7 days'))
        order by s.actor)
      from (select distinct s2.actor from cb.sessions s2 where (p is null or s2.project = p) and s2.last_seen > now() - interval '90 seconds') s
     where s.actor <> me and s.actor <> 'orch' and s.actor not like 'orch@%'
       and not exists (select 1 from cb.tasks t where t.assignee = s.actor and t.status = 'in_progress')), '[]'),
    'next', cb._brief_tasks(p, null, 'next', 50),
    'huddles', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'topic', h.topic, 'last_at', l.at) order by l.at)
      from cb.huddles h cross join lateral (select coalesce(max(e.at), h.opened_at) as at from cb.events e
                                             where e.kind = 'huddle' and (e.data ->> 'huddle')::bigint = h.id) l
     where h.status = 'open' and (p is null or h.project = p) and l.at < now() - interval '20 minutes'), '[]'),
    'locks', cb.lock_queue(null),
    -- Ahmed's asks to me (#936) still without a reply 15 minutes after delivery
    'late_asks', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'delivered_at', a.delivered_at) order by a.id)
      from cb.asks a cross join lateral cb._ask_info(a.id) i where a.to_actor = me and i.late), '[]'),
    -- tasks with a PR, open or touched this week: the CLI asks GitHub about these
    'prs', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'assignee', t.assignee, 'labels', t.labels,
        'pr', t.links ->> 'pr', 'commit', t.links ->> 'commit', 'done_at', t.done_at,
        'review', cb._is_review(t.labels, t.title), 'reviewed', cb._has_reviewer(t),
        'go', v.summary ~ '\mGO\M' and v.summary !~ 'NO[- ]?GO', 'verdict', v.summary)
        order by t.id)
      from cb.tasks t
      left join lateral (select e.summary from cb.events e where e.task_id = t.id and e.kind in ('done', 'note') and e.summary ~ '\mGO\M'
                          order by e.id desc limit 1) v on true
     where (p is null or t.project = p) and cb._pr_no(t.links) is not null
       and (t.status not in ('done', 'cancelled') or t.updated_at > now() - interval '7 days')), '[]'));
end $$;

-- ---------------------------------------------------------------- epics and blockers (#341)

-- "E3", "e3", "#3" or "3" → 3; null, '' or "none" → null (out of its epic). An unknown epic is an error.
create function cb.norm_epic(epic text) returns bigint language plpgsql stable as $$
#variable_conflict use_variable
declare v text := lower(trim(coalesce(epic, '')));
begin
  if v in ('', 'none', 'null') then return null; end if;
  v := ltrim(ltrim(v, '#'), 'e');
  if v !~ '^[0-9]+$' then raise exception 'bad epic "%"; use E3 (or none to take it out)', epic; end if;
  if not exists (select 1 from cb.epics e where e.id = v::bigint) then raise exception 'no epic E%: cb epics lists them', v; end if;
  return v::bigint;
end $$;

-- One audit row per epic change (kind epic, data.action). Sessions are not pushed these: epics are Ahmed's plan.
create function cb._epic_event(e cb.epics, action text, summary text, a text) returns void language sql as $$
  insert into cb.events (actor, project, kind, summary, data)
  values ($4, $1.project, 'epic', $3, jsonb_build_object('epic', $1.id, 'action', $2))
$$;

create function cb.epic_create(project text, title text, goal text default '', actor text default null) returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text; p text; e cb.epics;
begin
  perform cb.dashboard_only('Epics');
  a := cb.set_actor(actor);
  p := cb.read_project(project);
  if p is null then raise exception 'project is required'; end if;
  if coalesce(trim(title), '') = '' then raise exception 'title is required'; end if;
  insert into cb.epics (project, title, goal, created_by) values (p, trim(title), coalesce(trim(goal), ''), a) returning * into e;
  perform cb._epic_event(e, 'create', 'E' || e.id || ' created: ' || e.title, a);
  return e.id;
end $$;

-- Rename (title) and/or change the goal; null leaves a field as it is.
create function cb.epic_update(id text, title text default null, goal text default null, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; was cb.epics; e cb.epics;
begin
  perform cb.dashboard_only('Epics');
  a := cb.set_actor(actor);
  if title is not null and trim(title) = '' then raise exception 'title is required'; end if;
  select * into was from cb.epics x where x.id = cb.norm_epic(id);
  update cb.epics x set title = coalesce(trim(title), x.title), goal = coalesce(trim(goal), x.goal) where x.id = was.id returning * into e;
  if e.title <> was.title then
    perform cb._epic_event(e, 'rename', 'E' || e.id || ' renamed: ' || was.title || ' → ' || e.title, a);
  elsif e.goal <> was.goal then
    perform cb._epic_event(e, 'goal', 'E' || e.id || ' goal: ' || left(e.goal, 120), a);
  end if;
end $$;

-- Close (done) or reopen. Its steps keep their status.
create function cb.epic_close(id text, closed boolean default true, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; e cb.epics; c boolean := coalesce(closed, true);
begin
  perform cb.dashboard_only('Epics');
  a := cb.set_actor(actor);
  update cb.epics x set status = case when c then 'done' else 'open' end, closed_at = case when c then now() end
   where x.id = cb.norm_epic(id) and x.status <> case when c then 'done' else 'open' end returning * into e;
  if e.id is not null then
    perform cb._epic_event(e, case when c then 'close' else 'reopen' end, 'E' || e.id || case when c then ' closed: ' else ' reopened: ' end || e.title, a);
  end if;
end $$;

-- Delete an epic; its tasks stay, out of any epic (one summary event, not one per task).
create function cb.epic_delete(id text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; e cb.epics; n int;
begin
  perform cb.dashboard_only('Epics');
  a := cb.set_actor(actor);
  select * into e from cb.epics x where x.id = cb.norm_epic(id) for update;
  perform set_config('cb.quiet', 'on', true);
  update cb.tasks t set epic_id = null where t.epic_id = e.id;
  get diagnostics n = row_count;
  perform set_config('cb.quiet', '', true);
  delete from cb.epics x where x.id = e.id;
  perform cb._epic_event(e, 'delete', 'E' || e.id || ' deleted: ' || e.title || ' (' || n || ' tasks kept)', a);
end $$;

-- Epics with progress, open first. finished = done + cancelled; status done = Ahmed closed it, or every step finished.
create function cb.epics_list(project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.status = 'done', x.id desc) from (
    select e.id, e.project, e.title, e.goal, e.created_by, e.created_at, e.closed_at, e.status = 'done' as closed,
           c.total, c.done, c.cancelled, c.done + c.cancelled as finished,
           case when e.status = 'done' or (c.total > 0 and c.done + c.cancelled = c.total) then 'done' else 'open' end as status
      from cb.epics e
      cross join lateral (select count(*)::int as total, (count(*) filter (where t.status = 'done'))::int as done,
                                 (count(*) filter (where t.status = 'cancelled'))::int as cancelled
                            from cb.tasks t where t.epic_id = e.id) c
     where p is null or e.project = p) x), '[]');
end $$;

-- Same project, no self-link, no cycle (however long), on every insert, whoever writes it.
create function cb.task_blockers_check() returns trigger language plpgsql as $$
declare tp text; bp text;
begin
  if new.task = new.blocker then raise exception '#% cannot block itself', new.task; end if;
  select t.project into tp from cb.tasks t where t.id = new.task;
  if not found then raise exception 'task #% not found', new.task; end if;
  select t.project into bp from cb.tasks t where t.id = new.blocker;
  if not found then raise exception 'task #% not found', new.blocker; end if;
  if tp <> bp then raise exception '#% is in %, #% in %: blockers stay inside one project', new.blocker, bp, new.task, tp; end if;
  -- one writer per project at a time, so two sessions can't each add half of a cycle
  perform pg_advisory_xact_lock(hashtext('cb.blockers:' || tp));
  if exists (with recursive up(id) as (select new.blocker
                                       union select b.blocker from cb.task_blockers b join up on b.task = up.id)
             select 1 from up where up.id = new.task) then
    raise exception 'a cycle: #% already waits on #%, directly or through other tasks', new.blocker, new.task;
  end if;
  return new;
end $$;

create or replace trigger task_blockers_check before insert or update on cb.task_blockers
  for each row execute function cb.task_blockers_check();

-- task waits on blocker. An open blocker moves the task to Blocked (one event: moved, or a note if it already was).
create function cb.task_block(task text, blocker text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); tid bigint := cb.norm_id(task); bid bigint := cb.norm_id(blocker); tp text; ts text; bs text;
begin
  select t.project into tp from cb.tasks t where t.id = tid;
  if not found then raise exception 'task #% not found', tid; end if;
  -- the blockers lock before reading the blocker: one finishing right now has either committed (we read done) or
  -- waits for us in cb.tasks_unblock and then releases the task. No `for share` on the blocker: done holds its row
  -- while it waits for this lock, so that would deadlock the common "block on a task being finished" case.
  perform pg_advisory_xact_lock(hashtext('cb.blockers:' || tp));
  select t.status into ts from cb.tasks t where t.id = tid;
  select t.status into bs from cb.tasks t where t.id = bid;
  if not found then raise exception 'task #% not found', bid; end if;
  if ts in ('done', 'cancelled') then raise exception '#% is %: a finished task waits on nothing', tid, ts; end if;
  insert into cb.task_blockers (task, blocker, created_by) values (tid, bid, a) on conflict do nothing;
  if not found then return; end if; -- already there
  perform set_config('cb.note', 'blocked by #' || bid || case when bs in ('done', 'cancelled') then ' (already ' || bs || ')' else '' end, true);
  perform set_config('cb.data', jsonb_build_object('blocker', bid, 'action', 'block')::text, true);
  update cb.tasks t set status = case when bs in ('done', 'cancelled') then t.status else 'blocked' end where t.id = tid;
  perform set_config('cb.note', '', true);
  perform set_config('cb.data', '', true);
end $$;

-- Remove a blocker. The last open hold gone (no other open blocker, no blocking question) → Next.
create function cb.task_unblock(task text, blocker text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); tid bigint := cb.norm_id(task); bid bigint := cb.norm_id(blocker); free boolean;
begin
  perform pg_advisory_xact_lock(hashtext('cb.blockers:' || t.project)) from cb.tasks t where t.id = tid; -- see cb.tasks_unblock
  delete from cb.task_blockers b where b.task = tid and b.blocker = bid;
  if not found then raise exception '#% is not blocked by #%', tid, bid; end if;
  select t.status = 'blocked' and t.blocked_on is null and cardinality(cb._waits_on(t.id)) = 0 into free from cb.tasks t where t.id = tid;
  perform set_config('cb.note', case when free then 'unblocked: #' || bid || ' removed as a blocker' else 'no longer blocked by #' || bid end, true);
  perform set_config('cb.data', jsonb_build_object('blocker', bid, 'action', 'unblock')::text, true);
  update cb.tasks t set status = case when free then 'next' else t.status end where t.id = tid;
  perform set_config('cb.note', '', true);
  perform set_config('cb.data', '', true);
end $$;

-- A blocker finished (done or cancelled): every task it held with nothing else holding it goes to Next. The moved
-- event ("unblocked: #12 is done") reaches the assignee through the relay's events channel; a task with no assignee
-- is a message to the project's orchestrators (orch@*, seen in the last day). Named after tasks_history on purpose:
-- after-row triggers run in name order, so the blocker's own event is written before this changes cb.note.
create function cb.tasks_unblock() returns trigger language plpgsql as $$
declare note text := current_setting('cb.note', true); data text := current_setting('cb.data', true);
        a text := coalesce(nullif(current_setting('cb.actor', true), ''), 'unknown');
        why text := '#' || new.id || case when new.status = 'done' then ' is done' else ' was cancelled' end;
begin
  -- Every release decision (here, task_unblock, answer_delivered, withdraw) and task_block take this per-project lock
  -- first, then decide in a later statement, which reads committed data as of after the lock. Without it two blockers
  -- finishing at once each see the other still open and neither releases the task. Taken on every done/cancel, not
  -- only when this task blocks something: a link added concurrently isn't visible until its writer commits.
  -- ponytail: one lock per project, held to commit; per-task locks if done/cancel ever contends.
  perform pg_advisory_xact_lock(hashtext('cb.blockers:' || new.project));
  perform set_config('cb.note', 'unblocked: ' || why, true);
  perform set_config('cb.data', jsonb_build_object('blocker', new.id)::text, true); -- not the blocker's links
  with freed as (
    update cb.tasks t set status = 'next'
     where t.id in (select b.task from cb.task_blockers b where b.blocker = new.id)
       and t.status = 'blocked' and t.blocked_on is null and cardinality(cb._waits_on(t.id)) = 0
    returning t.id, t.title, t.project, t.assignee)
  insert into cb.events (actor, project, kind, summary, data)
  select a, f.project, 'message',
         format('unblocked: #%s "%s" is in Next with no assignee (%s). Hand it out: cb edit %s --assignee <worker>', f.id, left(f.title, 80), why, f.id),
         jsonb_build_object('to', s.actor, 'task', f.id)
    from freed f
    join (select distinct s2.actor, s2.project from cb.sessions s2
           where (s2.actor like 'orch@%' or s2.actor = 'orch') and s2.last_seen > now() - interval '1 day') s on s.project = f.project
   where f.assignee is null;
  perform set_config('cb.note', coalesce(note, ''), true);
  perform set_config('cb.data', coalesce(data, ''), true);
  return null;
end $$;

create or replace trigger tasks_unblock after update of status on cb.tasks
  for each row when (new.status in ('done', 'cancelled') and old.status not in ('done', 'cancelled'))
  execute function cb.tasks_unblock();

-- ===========================================================================
-- Shared memory (#167): short operational knowledge every session on every machine reads through cb.
-- Kinds: rule (standing practice), ruling (Ahmed's decision, usually from an answered question), fact (system or
-- environment state), gotcha (a known trap), runbook (a long procedure: listed by title, never pushed whole).
-- Authority: only Ahmed's dashboard makes an entry 'ahmed' (he adds it, or confirms a proposal). A session's project
-- fact or gotcha is live at once as 'team' (shown as "team, not Ahmed") and goes stale at review_after. A session's
-- rule, ruling, runbook, global entry, or anything that reads like a command waits as 'proposed' and reaches no
-- session until Ahmed confirms it. Rows are never deleted: superseded and retired ones stay readable (cb mem show).
-- ===========================================================================
create table if not exists cb.memories (
  id            bigint generated always as identity primary key,
  project       text references cb.projects(slug) on update cascade,   -- null = global: how we work, never client content
  machine       text,                                                  -- null = every machine
  kind          text not null check (kind in ('rule','ruling','fact','gotcha','runbook')),
  title         text not null,
  body          text not null default '',
  status        text not null default 'proposed' check (status in ('proposed','active','superseded','retired')),
  authority     text not null default 'team' check (authority in ('ahmed','team')),
  source        jsonb not null default '{}',   -- {question_id, task_id, supersedes, flagged}
  links         jsonb not null default '{}',
  tags          text[] not null default '{}',
  created_by    text not null,
  confirmed_by  text,
  confirmed_at  timestamptz,
  review_after  date,                          -- facts and gotchas: stale after this (out of the pack, still searchable)
  superseded_by bigint references cb.memories(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored
);
create index if not exists memories_tsv on cb.memories using gin (tsv);
create index if not exists memories_scope on cb.memories (project, status, kind);
create or replace trigger memories_notify after insert or update or delete on cb.memories
  for each statement execute function cb.notify();
-- "Already ruled" (#553): the memory entry Ahmed answered a question with (cb.answer ruled_by). Here, not with the
-- other questions columns: cb.memories must exist first.
alter table cb.questions add column if not exists ruled_by bigint references cb.memories(id);

drop function if exists cb._is_dashboard cascade;
drop function if exists cb.norm_mem cascade;
drop function if exists cb._mem_scope cascade;
drop function if exists cb._mem_check cascade;
drop function if exists cb._sensitive cascade;
drop function if exists cb._mem_text cascade;
drop function if exists cb._mem_flagged cascade;
drop function if exists cb._mem_event cascade;
drop function if exists cb._mem_json cascade;
drop function if exists cb._mem_visible cascade;
drop function if exists cb._mem_similar cascade;
drop function if exists cb._mem_new cascade;
drop function if exists cb.mem_add cascade;
drop function if exists cb.mem_rule cascade;
drop function if exists cb.mem_confirm cascade;
drop function if exists cb.mem_retire cascade;
drop function if exists cb.mem_supersede cascade;
drop function if exists cb.mem_find cascade;
drop function if exists cb.mem_list cascade;
drop function if exists cb.mem_show cascade;
drop function if exists cb.mem_pack cascade;
drop function if exists cb.mem_stats cascade;

create function cb._is_dashboard() returns boolean language sql stable as $$ select current_setting('application_name') = 'cb-web' $$;

-- M12, m12 or 12 → 12; an unknown id is an error.
create function cb.norm_mem(id text) returns bigint language plpgsql stable as $$
#variable_conflict use_variable
declare n bigint;
begin
  if coalesce(trim(id), '') !~* '^m?[0-9]+$' then raise exception 'bad memory id "%"; use one like M12', id; end if;
  n := regexp_replace(trim(id), '^[mM]', '')::bigint;
  if not exists (select 1 from cb.memories m where m.id = n) then raise exception 'memory M% not found', n; end if;
  return n;
end $$;

-- 'global' (or nothing) = no project; anything else must be a known project: a memory never creates one.
create function cb._mem_scope(project text) returns text language plpgsql stable as $$
#variable_conflict use_variable
begin
  if coalesce(lower(trim(project)), '') in ('', 'global') then return null; end if;
  return cb.read_project(project);
end $$;

-- Secrets and personal data never go in (memory reaches every session): record the shape and where it lives.
-- Deliberately narrow so normal notes pass: a commit SHA, or the board's own passwordless postgres://cb@host URL.
-- A credential is key=value / key: value / "key": "value" / --key value, where the key may be prefixed (DB_PASSWORD,
-- PGPASSWORD) and the value looks secret (6+ characters with a digit or symbol): "password: none" and "token: see
-- the vault" pass. Service logins in addresses (git@github.com, opc@vps2..., postgres://cb@host) are not emails.
create function cb._sensitive(t text) returns text language plpgsql immutable as $$
declare u text := regexp_replace(t, '[a-z][a-z0-9+.-]*://[^/\s:@]+@', '://', 'gi');  -- drop passwordless URL logins
        hit text := case
    when t ~ '\m(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})' then 'an access token'
    when t ~* '\mbearer\s+[a-z0-9._~+/=-]{20,}' then 'a bearer token'
    when t ~ 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}' then 'a JWT'
    when t ~ '-----BEGIN [A-Z ]*PRIVATE KEY' then 'a private key'
    when t ~* '[a-z][a-z0-9+.-]*://[^/\s:@]*:[^/\s@]+@' then 'a connection string with a password'
    when exists (select 1 from regexp_matches(t, '(?:^|[^a-z0-9])[a-z0-9_]*(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|accountkey|token)["'']?\s*[=:]\s*["'']?([^\s<"'',;]{6,})', 'gi') m
                  where m[1] ~ '[0-9!@#$%^&*+=/_.-]')
      or t ~* '--(password|passwd|secret|token|api-key)[ =][^\s<]' then 'a credential'
    when regexp_replace(t, '\m214748364[78]\M', '', 'g') ~ '\m[12][0-9]{9}\M' then 'a 10-digit ID number'
    when exists (select 1 from regexp_matches(u, '([a-z0-9._%+-]+)@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\M', 'gi') m
                  where lower(m[1]) not in ('git', 'cb', 'opc', 'ubuntu', 'root', 'admin', 'postgres', 'ec2-user', 'azureuser', 'debian', 'deploy')) then 'an email address'
    when t ~ '(\+[0-9][0-9 -]{8,}[0-9]|\m05[0-9]{8}\M)' then 'a phone number'
  end;
begin
  return hit;
end $$;

create function cb._mem_check(t text) returns void language plpgsql immutable as $$
declare hit text := cb._sensitive(t);
begin
  if hit is not null then
    raise exception 'that looks like %; memory is shared with every session, so record the shape and where it lives (e.g. "the key is in the vault"), not the value', hit;
  end if;
end $$;

-- Reads like an order to the agent, claims Ahmed's say-so, or points somewhere to fetch: Ahmed sees it before any
-- session does (a new entry waits as a flagged proposal; a retire reason is kept but not pushed).
create function cb._mem_flagged(t text) returns boolean language sql immutable as $$
  select coalesce($1, '') ~* ('(\mignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\M|\mdisregard\M|\malways\s+run\M|\mrun\s+this\M'
    || '|\mcurl\M|\mwget\M|(https?|ftp)://|\mahmed\s+(said|says|approved|agreed|wants)\M|\mfrom\s+now\s+on\M|--no-verify|\mforce[- ]?push'
    || '|\myou\s+(must|should|need\s+to)\M|\mbypass\M|\mskip(ping)?\s+(the\s+)?(tests?|review|hooks?|ci)\M)')
$$;

-- One-line title (≤ 200), body ≤ 500 unless a runbook, no secrets. Returns {title, body} cleaned.
create function cb._mem_text(k text, t text, b text) returns text[] language plpgsql immutable as $$
begin
  t := regexp_replace(trim(coalesce(t, '')), '\s+', ' ', 'g');
  b := trim(coalesce(b, ''));
  if t = '' then raise exception 'title is required: one line, what a session needs to know'; end if;
  if length(t) > 200 then raise exception 'title is % characters: keep it to one line under 200 and put the rest in -b', length(t); end if;
  if k <> 'runbook' and length(b) > 500 then raise exception 'body is % characters; the limit is 500 (a runbook has none)', length(b); end if;
  perform cb._mem_check(t || ' ' || b);
  return array[t, b];
end $$;

-- One audit row per change (kind memory, data.action: add propose confirm renew supersede retire reject).
-- extra: more data for the relay push (a retire's why).
create function cb._mem_event(m cb.memories, action text, summary text, a text, extra jsonb default '{}') returns void language sql as $$
  insert into cb.events (actor, project, kind, summary, data)
  values ($4, $1.project, 'memory', $3, jsonb_build_object('memory', $1.id, 'action', $2, 'kind', $1.kind) || $5)
$$;

-- A flagged proposal (reads like an order, claims Ahmed's say-so, carries a URL) is for Ahmed's eyes only: no
-- session reads it through find, list, show or "similar", so a poisoned note can't reach an agent before he looks.
create function cb._mem_visible(m cb.memories) returns boolean language sql stable as $$
  select cb._is_dashboard() or not ($1.status = 'proposed' and coalesce(($1.source ->> 'flagged')::boolean, false))
$$;

create function cb._mem_json(m cb.memories) returns jsonb language sql stable as $$
  select (to_jsonb($1) - 'tsv') || jsonb_build_object('expired', $1.status = 'active' and coalesce($1.review_after < current_date, false))
$$;

-- Up to three live or proposed entries in the same scope that share words with this one's title: near-duplicates
-- the writer should supersede instead of adding beside.
create function cb._mem_similar(mid bigint) returns jsonb language plpgsql stable as $$
declare m cb.memories; q tsquery;
begin
  select * into m from cb.memories x where x.id = mid;
  q := nullif(replace(plainto_tsquery('english', m.title)::text, '&', '|'), '')::tsquery;
  if q is null then return '[]'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'kind', o.kind, 'title', o.title, 'status', o.status) order by o.r desc, o.id desc)
    from (select x.id, x.kind, x.title, x.status, ts_rank(x.tsv, q) as r from cb.memories x
           where x.id <> m.id and x.status in ('active', 'proposed') and (x.project is not distinct from m.project or x.project is null)
             and x.tsv @@ q and cb._mem_visible(x)
           order by r desc, x.id desc limit 3) o), '[]');
end $$;

-- Every new entry goes through here. hold = a proposal whatever the kind (a session replacing Ahmed's entry).
create function cb._mem_new(p text, k text, t text, b text, src jsonb, lk jsonb, mach text, tg text[], days int, a text, hold boolean default false)
returns cb.memories language plpgsql as $$
declare dash boolean := cb._is_dashboard(); tb text[]; flagged boolean; live boolean; m cb.memories;
begin
  k := lower(trim(coalesce(k, '')));
  if k not in ('rule', 'ruling', 'fact', 'gotcha', 'runbook') then
    raise exception 'kind "%" is not one of rule, ruling, fact, gotcha, runbook', k;
  end if;
  if days is not null and (days < 1 or days > 365) then raise exception 'review must be 1 to 365 days, e.g. --review 30d'; end if;
  tb := cb._mem_text(k, t, b);
  lk := coalesce(lk, '{}');
  if jsonb_typeof(lk) <> 'object' or length(lk::text) > 500 then raise exception 'links must be a few name=value pairs (under 500 characters)'; end if;
  perform cb._mem_check(lk::text);
  mach := nullif(lower(trim(mach)), '');
  if mach !~ '^[a-z0-9][a-z0-9_.-]{0,31}$' then raise exception 'machine "%" is not a machine name like macbook', mach; end if;
  -- reads like an order to the agent, claims Ahmed's say-so, or points somewhere to fetch: Ahmed sees it before any session does
  flagged := cb._mem_flagged(tb[1] || ' ' || tb[2] || ' ' || lk::text);
  live := dash or (k in ('fact', 'gotcha') and p is not null and not flagged and not hold);
  insert into cb.memories (project, machine, kind, title, body, status, authority, source, links, tags, created_by,
                           confirmed_by, confirmed_at, review_after)
  values (p, mach, k, tb[1], tb[2], case when live then 'active' else 'proposed' end,
          case when dash then 'ahmed' else 'team' end,
          coalesce(src, '{}') || case when flagged and not dash then '{"flagged": true}'::jsonb else '{}' end,
          lk, coalesce(tg, '{}'), a,
          case when dash then a end, case when dash then now() end,
          case when k in ('fact', 'gotcha') then current_date + coalesce(days, 14) end)
  returning * into m;
  perform cb._mem_event(m, case when live then 'add' else 'propose' end,
    'M' || m.id || ' ' || k || case when live then ' added: ' else ' proposed: ' end || m.title, a);
  return m;
end $$;

-- project: a slug, or 'global'. review: days a fact or gotcha stays live ('30' or '30d'; default 14).
-- Returns the entry plus up to three similar ones (supersede instead of adding a duplicate).
create function cb.mem_add(project text, title text, kind text, body text default '', task_id text default null,
                           review text default null, links jsonb default '{}', machine text default null,
                           tags jsonb default '[]', actor text default null, propose boolean default false)
returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); tid bigint; days int; m cb.memories;
begin
  if nullif(trim(task_id), '') is not null then
    tid := cb.norm_id(task_id);
    if not exists (select 1 from cb.tasks t where t.id = tid) then raise exception 'task #% not found', tid; end if;
  end if;
  if nullif(trim(review), '') is not null then
    if trim(review) !~* '^[0-9]+d?$' then raise exception 'review "%" is not a number of days, e.g. 30d', review; end if;
    days := rtrim(lower(trim(review)), 'd')::int;
  end if;
  m := cb._mem_new(cb._mem_scope(project), kind, title, body,
         case when tid is null then '{}'::jsonb else jsonb_build_object('task_id', tid) end, links, machine,
         array(select cb.norm_tag(x) from jsonb_array_elements_text(coalesce(tags, '[]')) x), days, a,
         coalesce(propose, false)); -- --propose (#635): a fact or gotcha waits for Ahmed like a rule
  return cb._mem_json(m) || jsonb_build_object('similar', cb._mem_similar(m.id));
end $$;

-- An answered question becomes a ruling: from the dashboard ("Make it a rule") it is live at once; from a session it
-- is a proposal. Title defaults to the answer, the body is the answer, source.question_id points back. One live or
-- proposed entry per question.
create function cb.mem_rule(question text, title text default null, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); q cb.questions; dup bigint; m cb.memories;
begin
  select * into q from cb.questions x where x.id = cb.norm_id(regexp_replace(trim(coalesce(question, '')), '^[qQ]', ''));
  if q.id is null then raise exception 'question % not found', question; end if;
  if q.status not in ('answered', 'delivered') then raise exception 'Q% has no answer yet (it is %)', q.id, q.status; end if;
  perform pg_advisory_xact_lock(hashtext('cb.mem_rule:' || q.id));  -- a double click makes one ruling, not two
  select x.id into dup from cb.memories x where x.source ->> 'question_id' = q.id::text and x.status in ('active', 'proposed') limit 1;
  if dup is not null then raise exception 'Q% is already M%: cb mem show M%', q.id, dup, dup; end if;
  m := cb._mem_new(q.project, 'ruling', coalesce(nullif(trim(title), ''), left(regexp_replace(q.answer, '\s+', ' ', 'g'), 200)),
         left(q.answer, 500), jsonb_build_object('question_id', q.id),  -- the answer only: the question may hold anything
         '{}', null, '{}', null, a);
  return cb._mem_json(m) || jsonb_build_object('similar', cb._mem_similar(m.id));
end $$;

-- Ahmed confirms a proposal (title/body edit it first), or renews a stale fact or gotcha for another 14 days.
-- A confirmed replacement (source.supersedes) retires the entry it replaces.
create function cb.mem_confirm(id text, title text default null, body text default null, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; m cb.memories; was text; tb text[];
begin
  perform cb.dashboard_only('Memory');
  a := cb.set_actor(actor);
  select * into m from cb.memories x where x.id = cb.norm_mem(id) for update;
  was := m.status;
  if was not in ('proposed', 'active') then raise exception 'M% is %; only a proposed or live entry can be confirmed', m.id, was; end if;
  tb := cb._mem_text(m.kind, coalesce(title, m.title), coalesce(body, m.body));
  update cb.memories x set status = 'active', authority = 'ahmed', confirmed_by = a, confirmed_at = now(), updated_at = now(),
         title = tb[1], body = tb[2],
         review_after = case when x.kind in ('fact', 'gotcha') then greatest(x.review_after, current_date + 14) end
   where x.id = m.id returning * into m;
  if was = 'proposed' and m.source ? 'supersedes' then
    update cb.memories x set status = 'superseded', superseded_by = m.id, updated_at = now()
     where x.id = (m.source ->> 'supersedes')::bigint and x.status = 'active';
  end if;
  perform cb._mem_event(m, case when was = 'proposed' then 'confirm' else 'renew' end,
    'M' || m.id || ' ' || m.kind || case when was = 'proposed' then ' confirmed: ' else ' renewed: ' end || m.title, a);
end $$;

-- Retire a live entry, or reject a proposal. Ahmed's entries only from his dashboard; a session retires team ones.
-- ponytail: any session may retire any team entry (the design said orchestrators); narrow it if that gets abused.
create function cb.mem_retire(id text, why text default null, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); m cb.memories; was text;
begin
  -- the reason is pushed to the project's sessions (#553): one line, ≤ 200, no secrets; order-shaped = kept, not pushed
  why := nullif(left(regexp_replace(trim(coalesce(why, '')), '\s+', ' ', 'g'), 200), '');
  perform cb._mem_check(coalesce(why, ''));
  select * into m from cb.memories x where x.id = cb.norm_mem(id) for update;
  was := m.status;
  if was in ('superseded', 'retired') then raise exception 'M% is already %', m.id, was; end if;
  if m.authority = 'ahmed' and not cb._is_dashboard() then
    raise exception 'M% is Ahmed''s: only he retires it, on the Memory page. To change it, propose a replacement: cb mem supersede M% "<new title>"', m.id, m.id;
  end if;
  update cb.memories x set status = 'retired', updated_at = now() where x.id = m.id returning * into m;
  perform cb._mem_event(m, case when was = 'proposed' then 'reject' else 'retire' end,
    'M' || m.id || case when was = 'proposed' then ' rejected: ' else ' retired: ' end || m.title
      || coalesce(' (' || why || ')', ''), a,
    jsonb_build_object('why', why) || case when cb._mem_flagged(why) then '{"why_flagged": true}'::jsonb else '{}' end);
end $$;

-- Replace a live entry; the old one stays readable with a pointer. A session replacing Ahmed's entry only proposes:
-- his stays live until he confirms the replacement.
create function cb.mem_supersede(id text, title text, body text default null, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); old cb.memories; m cb.memories;
begin
  select * into old from cb.memories x where x.id = cb.norm_mem(id) for update;
  if old.status <> 'active' then raise exception 'M% is %; only a live entry can be superseded', old.id, old.status; end if;
  m := cb._mem_new(old.project, old.kind, title, coalesce(body, old.body), jsonb_build_object('supersedes', old.id),
         old.links, old.machine, old.tags, null, a, old.authority = 'ahmed' and not cb._is_dashboard());
  if m.status = 'active' then
    update cb.memories x set status = 'superseded', superseded_by = m.id, updated_at = now() where x.id = old.id;
    perform cb._mem_event(old, 'supersede', 'M' || old.id || ' superseded by M' || m.id || ': ' || old.title, a);
  end if;
  return cb._mem_json(m) || jsonb_build_object('similar', '[]'::jsonb);
end $$;

-- Search titles and bodies (full text, plus a plain substring match for words FTS drops). A project includes the
-- global entries; no project = everywhere. Live and proposed entries; include_old adds superseded and retired;
-- live_only keeps live entries not past review (the "Already ruled" picker: what an answer may cite).
create function cb.mem_find(q text, project text default null, include_old boolean default false, live_only boolean default false) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb._mem_scope(project); s text := trim(coalesce(q, '')); tq tsquery;
begin
  if s = '' then raise exception 'what to look for is required: cb mem find "<words>"'; end if;
  tq := websearch_to_tsquery('english', s);
  return coalesce((select jsonb_agg(cb._mem_json(y.m) order by y.n) from (
    select m, row_number() over (order by ts_rank(m.tsv, tq) desc, m.id desc) as n
      from cb.memories m
     where (m.tsv @@ tq or m.title ilike '%' || s || '%' or m.body ilike '%' || s || '%')
       and (p is null or m.project = p or m.project is null) and cb._mem_visible(m)
       and (coalesce(include_old, false) or m.status in ('active', 'proposed'))
       and (not coalesce(live_only, false) or (m.status = 'active' and not coalesce(m.review_after < current_date, false)))) y
   where y.n <= 20), '[]');
end $$;

-- Browse: rules and rulings, facts and gotchas, runbooks; proposals and stale entries are marked.
create function cb.mem_list(project text default null, kind text default null, include_old boolean default false) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb._mem_scope(project); k text := nullif(lower(trim(kind)), '');
begin
  return coalesce((select jsonb_agg(cb._mem_json(m) order by
      case m.kind when 'rule' then 0 when 'ruling' then 1 when 'fact' then 2 when 'gotcha' then 3 else 4 end, m.project nulls first, m.id)
    from cb.memories m
   where (p is null or m.project = p or m.project is null) and (k is null or m.kind = k) and cb._mem_visible(m)
     and (coalesce(include_old, false) or m.status in ('active', 'proposed'))), '[]');
end $$;

create function cb.mem_show(id text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare m cb.memories;
begin
  select * into m from cb.memories x where x.id = cb.norm_mem(id);
  if not cb._mem_visible(m) then raise exception 'memory M% not found', m.id; end if;
  -- why it was retired: the relay leaves an order-shaped reason out and points here
  return cb._mem_json(m) || jsonb_build_object('retired_why', (select e.data ->> 'why' from cb.events e
    where e.kind = 'memory' and e.data ->> 'memory' = m.id::text and e.data ->> 'action' in ('retire', 'reject') order by e.id desc limit 1));
end $$;

-- What a session is told when it binds (cb iam) and in cb brief: Ahmed's rules and rulings (global first), then live
-- facts and gotchas not past review (Ahmed's first, then newest), then runbook titles. Never a proposal. Hard cap of
-- 20 entries and 2000 characters of titles, because ~20 sessions pay for it; total says how many exist (cb mem find).
create function cb.mem_pack(project text default null, machine text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb._mem_scope(project); mc text := nullif(lower(trim(machine)), '');
begin
  return (with c as (
    select m.id, m.project, m.kind, m.title, m.authority, m.created_by, m.review_after,
           row_number() over (order by case when m.kind in ('rule', 'ruling') then 0 when m.kind in ('fact', 'gotcha') then 1 else 2 end,
                                       m.project is not null, m.authority <> 'ahmed', m.id desc) as n
      from cb.memories m
     where m.status = 'active' and (m.project is null or m.project = p) and (m.machine is null or m.machine = mc)
       and not (m.kind in ('fact', 'gotcha') and coalesce(m.review_after < current_date, false))
  ), s as (select c.*, sum(length(c.title)) over (order by c.n) as chars from c)
  select jsonb_build_object('project', p, 'total', (select count(*) from c),
    'entries', coalesce((select jsonb_agg(to_jsonb(s) - 'chars' - 'n' order by s.n) from s where s.n <= 20 and s.chars <= 2000), '[]')));
end $$;

-- How we'd know memory works (#553), last 7 days: questions answered "Already ruled", notes (cb log) reporting a
-- correction or a stale finding, and the share of live facts and gotchas past review (target under 15%). Plus the
-- Today card: proposals waiting and live entries past review. Counts only, so flagged proposals count too.
-- A project includes the global entries (as mem_list); no project = everything.
create function cb.mem_stats(project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb._mem_scope(project); r jsonb;
begin
  select jsonb_build_object(
      'proposed', count(*) filter (where m.status = 'proposed'),
      'past_review', count(*) filter (where m.status = 'active' and m.review_after < current_date),
      'live_facts', count(*) filter (where m.status = 'active' and m.kind in ('fact', 'gotcha')),
      'stale_pct', round(100.0 * count(*) filter (where m.status = 'active' and m.kind in ('fact', 'gotcha') and m.review_after < current_date)
                         / nullif(count(*) filter (where m.status = 'active' and m.kind in ('fact', 'gotcha')), 0)))
    into r from cb.memories m where p is null or m.project = p or m.project is null;
  return r || jsonb_build_object(
    'already_ruled', (select count(*) from cb.questions q
                       where q.ruled_by is not null and q.answered_at > now() - interval '7 days' and (p is null or q.project = p)),
    'corrections', (select count(*) from cb.events e
                     where e.kind = 'note' and e.at > now() - interval '7 days' and (e.summary ~* '^\W*correction\M' or e.summary ~* '\mwas wrong\M'
                            or e.summary ~* '\mstale\s+(finding|review|claim|comment|report)'
                            or e.summary ~* '\m(finding|review|claim|comment|report)s?\W+(is|was|were|are)\s+stale\M')
                       and (p is null or e.project = p)));
end $$;

-- ---------------------------------------------------------------- goals (#663)

-- "G3", "g3", "#3" or "3" → 3. An unknown goal is an error.
create function cb.norm_goal(id text) returns bigint language plpgsql stable as $$
#variable_conflict use_variable
declare v text := ltrim(ltrim(lower(trim(coalesce(id, ''))), '#'), 'g');
begin
  if v !~ '^[0-9]+$' then raise exception 'bad goal "%"; use G3', id; end if;
  if not exists (select 1 from cb.goals g where g.id = v::bigint) then raise exception 'no goal G%: cb goals lists them', v; end if;
  return v::bigint;
end $$;

-- Rules as stored: labels as tags, words lowercased, epics as ids (an unknown epic is an error); blanks and repeats dropped.
create function cb._goal_rules(r jsonb) returns jsonb language sql stable strict as $$
  select jsonb_build_object(
    'labels', coalesce((select jsonb_agg(distinct n) from (select cb.norm_tag(x) n from jsonb_array_elements_text(coalesce($1 -> 'labels', '[]')) x) z where n <> ''), '[]'),
    'words', coalesce((select jsonb_agg(distinct n) from (select lower(trim(x)) n from jsonb_array_elements_text(coalesce($1 -> 'words', '[]')) x) z where n <> ''), '[]'),
    'epics', coalesce((select jsonb_agg(distinct n) from (select cb.norm_epic(x) n from jsonb_array_elements_text(coalesce($1 -> 'epics', '[]')) x) z where n is not null), '[]'))
$$;

-- Does an open card fit a goal: one of its labels, OR one of its words in the title/body (full text, plus a plain
-- substring match for words full text drops, as cb.mem_find), OR one of its epics; and in its project, if it has one.
-- ponytail: to_tsvector per card per goal, no index; fine for a board's few thousand cards. A tsv column if it slows.
create function cb._goal_match(r jsonb, gp text, t cb.tasks) returns boolean language sql stable as $$
  select t.status not in ('done', 'cancelled') and ($2 is null or t.project = $2) and (
    t.labels && array(select jsonb_array_elements_text(coalesce($1 -> 'labels', '[]')))
    or coalesce(t.epic_id in (select (x)::bigint from jsonb_array_elements_text(coalesce($1 -> 'epics', '[]')) x), false)
    or exists (select 1 from jsonb_array_elements_text(coalesce($1 -> 'words', '[]')) w
                where to_tsvector('english', t.title || ' ' || t.body) @@ websearch_to_tsquery('english', w)
                   or t.title ilike '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                   or t.body ilike '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
$$;

-- Add every card the goal matches now, as in. A card already listed (in, or out: Ahmed unticked it) is left alone.
create function cb._goal_pull(g cb.goals, fresh boolean) returns int language plpgsql as $$
declare n int;
begin
  insert into cb.goal_tasks (goal_id, task_id, state, via, new)
  select g.id, t.id, 'in', 'match', fresh from cb.tasks t where cb._goal_match(g.rules, g.project, t)
  on conflict (goal_id, task_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- One audit row per goal change (kind goal, data.action).
create function cb._goal_event(g cb.goals, action text, summary text, a text) returns void language sql as $$
  insert into cb.events (actor, project, kind, summary, data)
  values ($4, $1.project, 'goal', $3, jsonb_build_object('goal', $1.id, 'action', $2))
$$;

-- Close the active goals among these whose in cards are all done or cancelled (at least one: an empty goal stays
-- open), and tell their project. The board says it, not whoever finished the last card.
create function cb._goal_autoclose(ids bigint[]) returns void language plpgsql as $$
declare g cb.goals; n int; i bigint;
begin
  -- one closer per goal at a time (ids in order, so two closers never wait on each other): two sessions finishing
  -- the last two cards at once each wait here, and the second one's check (a new snapshot) sees the first's card done
  foreach i in array array(select distinct x from unnest(ids) x order by x) loop
    perform pg_advisory_xact_lock(hashtext('cb.goal:' || i));
  end loop;
  for g in update cb.goals x set status = 'done', closed_at = now()
            where x.id = any(ids) and x.status = 'active'
              and exists (select 1 from cb.goal_tasks gt where gt.goal_id = x.id and gt.state = 'in')
              and not exists (select 1 from cb.goal_tasks gt join cb.tasks t on t.id = gt.task_id
                               where gt.goal_id = x.id and gt.state = 'in' and t.status not in ('done', 'cancelled'))
           returning * loop
    select count(*) into n from cb.goal_tasks gt where gt.goal_id = g.id and gt.state = 'in';
    perform cb._goal_event(g, 'close', 'G' || g.id || ' done: every card closed', 'board');
    insert into cb.events (actor, project, kind, summary)
    values ('board', g.project, 'broadcast', 'Goal G' || g.id || ' is done: ' || g.title || ' (' || case when n = 1 then 'its card' else 'all ' || n || ' cards' end || ' closed).');
  end loop;
end $$;

-- A card filed or changed (title, body, labels, epic, project) joins every active goal it now matches, marked new.
create function cb.tasks_goals() returns trigger language plpgsql as $$
begin
  insert into cb.goal_tasks (goal_id, task_id, state, via, new)
  select g.id, new.id, 'in', 'match', true from cb.goals g where g.status = 'active' and cb._goal_match(g.rules, g.project, new)
  on conflict (goal_id, task_id) do nothing;
  return null;
end $$;

-- A card done or cancelled may finish its goals.
create function cb.tasks_goals_close() returns trigger language plpgsql as $$
begin
  if new.status in ('done', 'cancelled') and old.status not in ('done', 'cancelled') then
    perform cb._goal_autoclose(array(select gt.goal_id from cb.goal_tasks gt where gt.task_id = new.id and gt.state = 'in'));
  end if;
  return null;
end $$;

create or replace trigger tasks_goals after insert or update of title, body, labels, epic_id, project on cb.tasks
  for each row execute function cb.tasks_goals();
create or replace trigger tasks_goals_close after update of status on cb.tasks
  for each row execute function cb.tasks_goals_close();
create or replace trigger goals_notify after insert or update or delete on cb.goals
  for each statement execute function cb.notify();
create or replace trigger goal_tasks_notify after insert or update or delete on cb.goal_tasks
  for each statement execute function cb.notify();

-- Ahmed sets a goal. Its first list is every card it matches now, less the ones he unticked in the preview (skip: they
-- stay out). It goes last in the order and is broadcast to its project (every session when it has none).
create function cb.goal_create(title text, description text default '', project text default null, rules jsonb default null,
                               skip jsonb default '[]', actor text default null) returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text; p text; g cb.goals; n int;
begin
  perform cb.dashboard_only('Goals');
  a := cb.set_actor(actor);
  p := cb.read_project(project);
  if coalesce(trim(title), '') = '' then raise exception 'title is required'; end if;
  insert into cb.goals (title, description, project, rules, rank, created_by)
  values (regexp_replace(trim(title), '\s+', ' ', 'g'), coalesce(trim(description), ''), p,
          coalesce(cb._goal_rules(rules), '{"labels": [], "words": [], "epics": []}'),
          coalesce((select max(x.rank) + 1024 from cb.goals x), 0), a)
  returning * into g;
  insert into cb.goal_tasks (goal_id, task_id, state, via, new)
  select g.id, t.id, 'out', 'match', false from cb.tasks t
   where t.id in (select cb.norm_id(x) from jsonb_array_elements_text(coalesce(skip, '[]')) x) and cb._goal_match(g.rules, g.project, t);
  n := cb._goal_pull(g, false);
  perform cb._goal_event(g, 'create', 'G' || g.id || ' set: ' || g.title, a);
  perform cb.broadcast('Goal G' || g.id || ' is active: ' || g.title || ' (' || n || case when n = 1 then ' card' else ' cards' end || '). Its cards come right after P0; cb goals lists it.', g.project, a);
  return g.id;
end $$;

-- Edit title, description, rules, or order (rank); null leaves a field as it is. New rules pull in the cards they
-- now match (Ahmed saw them in the preview, so not new); cards that stopped matching stay until he unticks them.
create function cb.goal_update(id text, title text default null, description text default null, rules jsonb default null,
                               rank double precision default null, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; was cb.goals; g cb.goals;
begin
  perform cb.dashboard_only('Goals');
  a := cb.set_actor(actor);
  if title is not null and trim(title) = '' then raise exception 'title is required'; end if;
  select * into was from cb.goals x where x.id = cb.norm_goal(id);
  update cb.goals x set title = coalesce(regexp_replace(trim(title), '\s+', ' ', 'g'), x.title),
                        description = coalesce(trim(description), x.description),
                        rules = coalesce(cb._goal_rules(rules), x.rules), rank = coalesce(rank, x.rank)
   where x.id = was.id returning * into g;
  if g.rules is distinct from was.rules and g.status = 'active' then perform cb._goal_pull(g, false); end if;
  if (g.title, g.description, g.rules) is distinct from (was.title, was.description, was.rules) then
    perform cb._goal_event(g, 'edit', 'G' || g.id || ' edited: ' || g.title, a);
  end if;  -- a reorder alone is silent, as an epic's
end $$;

-- active | paused | done. Paused keeps its list but stops ordering and matching; active again catches up on the
-- cards that matched meanwhile (marked new) and is broadcast like a new goal.
create function cb.goal_status(id text, status text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; s text := lower(trim(coalesce(status, ''))); g cb.goals; n int;
begin
  perform cb.dashboard_only('Goals');
  a := cb.set_actor(actor);
  if s not in ('active', 'paused', 'done') then raise exception 'bad goal status "%"; use active, paused or done', status; end if;
  update cb.goals x set status = s, closed_at = case when s = 'done' then now() end
   where x.id = cb.norm_goal(id) and x.status <> s returning * into g;
  if g.id is null then return; end if;
  perform cb._goal_event(g, case s when 'active' then 'activate' when 'paused' then 'pause' else 'close' end,
                         'G' || g.id || case s when 'active' then ' active: ' when 'paused' then ' paused: ' else ' closed: ' end || g.title, a);
  if s = 'active' then
    perform cb._goal_pull(g, true);
    select count(*) into n from cb.goal_tasks gt join cb.tasks t on t.id = gt.task_id
     where gt.goal_id = g.id and gt.state = 'in' and t.status not in ('done', 'cancelled');
    perform cb.broadcast('Goal G' || g.id || ' is active: ' || g.title || ' (' || n || case when n = 1 then ' open card' else ' open cards' end || '). Its cards come right after P0; cb goals lists it.', g.project, a);
  end if;
end $$;

-- Ahmed ticks a card in (via ahmed) or out of a goal. Out stays out: matching never adds it back.
create function cb.goal_tick(goal text, task text, state text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; gid bigint; tid bigint := cb.norm_id(task); st text := lower(trim(coalesce(state, ''))); gp text; tp text;
begin
  perform cb.dashboard_only('Goals');
  a := cb.set_actor(actor);
  gid := cb.norm_goal(goal);
  if st not in ('in', 'out') then raise exception 'bad state "%"; use in or out', state; end if;
  select t.project into tp from cb.tasks t where t.id = tid;
  if not found then raise exception 'task #% not found', tid; end if;
  select g.project into gp from cb.goals g where g.id = gid;
  if gp is not null and gp <> tp then raise exception 'G% is for %, #% is in %', gid, gp, tid, tp; end if;
  insert into cb.goal_tasks (goal_id, task_id, state, via, new) values (gid, tid, st, 'ahmed', false)
  on conflict (goal_id, task_id) do update
    set state = excluded.state, new = false, via = case when excluded.state = 'in' then 'ahmed' else cb.goal_tasks.via end;
  perform cb._goal_autoclose(array[gid]);
end $$;

-- Ahmed opened the goal: its cards are no longer new.
create function cb.goal_opened(id text) returns void language plpgsql as $$
#variable_conflict use_variable
begin
  perform cb.dashboard_only('Goals');
  update cb.goal_tasks gt set new = false where gt.goal_id = cb.norm_goal(id) and gt.new;
end $$;

-- What these rules match right now (the live preview before saving), in work order.
create function cb.goal_preview(rules jsonb, project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); r jsonb := coalesce(cb._goal_rules(rules), '{}');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'project', t.project, 'title', t.title, 'status', t.status,
                                                       'priority', t.priority, 'labels', t.labels, 'assignee', t.assignee)
                                    order by t.priority, t.rank, t.id)
                     from cb.tasks t where cb._goal_match(r, p, t)), '[]');
end $$;

-- Rules proposed from a description: the existing labels (of its project, or any) it names, plus its other
-- words that are not English stopwords (to_tsvector drops those), 3+ characters, in the order written.
create function cb.goal_propose(description text, project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); w text[]; labs text[];
begin
  w := array(select x from (select trim(x, '-_') x, min(o) o
                              from regexp_split_to_table(lower(coalesce(description, '')), '[^[:alnum:]_-]+') with ordinality s(x, o) group by 1) z
              where x <> '' order by o);
  labs := array(select distinct l from cb.tasks t, unnest(t.labels) l where (p is null or t.project = p) and l = any(w) order by l);
  return jsonb_build_object('labels', to_jsonb(labs), 'epics', '[]'::jsonb,
    'words', to_jsonb(array(select x from unnest(w) with ordinality u(x, o)
                             where length(x) >= 3 and x <> all(labs) and to_tsvector('english', x) <> ''::tsvector order by o)));
end $$;

-- Goals with progress: total = cards in, closed = those done or cancelled, new = joined since Ahmed last looked.
-- A project includes the every-project goals. Active only, in order, unless include_all (then paused, then done).
create function cb.goals_list(project text default null, include_all boolean default false) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.status = 'done', x.status = 'paused', x.rank, x.id) from (
    select g.id, g.title, g.description, g.project, g.rules, g.status, g.rank, g.created_by, g.created_at, g.closed_at,
           c.total, c.closed, c.new
      from cb.goals g
      cross join lateral (select (count(*) filter (where gt.state = 'in'))::int as total,
                                 (count(*) filter (where gt.state = 'in' and t.status in ('done', 'cancelled')))::int as closed,
                                 (count(*) filter (where gt.state = 'in' and gt.new))::int as new
                            from cb.goal_tasks gt join cb.tasks t on t.id = gt.task_id where gt.goal_id = g.id) c
     where (p is null or g.project is null or g.project = p) and (coalesce(include_all, false) or g.status = 'active')) x), '[]');
end $$;

-- ---------------------------------------------------------------- Ahmed's asks (#936)
-- Ahmed asks one session something from Today (A<n>). The relay pushes it as "[Ahmed asks] A<n>: ..." and the
-- session answers with cb reply. The thread is events of kind 'ask', data {ask, action, to}: action open (the ask),
-- say (Ahmed in the thread), reply (done: true when it closed the ask), close (Ahmed), reroute (from, to).
-- delivered_upto: the last of Ahmed's thread events pushed to to_actor (delivered_at: when). repushed_at: the one
-- reminder for his latest line (a new line clears it). Only the dashboard asks, writes, closes and re-routes.
create table if not exists cb.asks (
  id             bigint generated always as identity primary key,
  project        text references cb.projects(slug) on update cascade on delete set null,
  task_id        bigint references cb.tasks(id) on delete set null,
  to_actor       text not null,
  body           text not null,
  status         text not null default 'open' check (status in ('open', 'done')),
  created_at     timestamptz not null default now(),
  delivered_at   timestamptz,
  delivered_to   text,
  delivered_upto bigint not null default 0,
  repushed_at    timestamptz,
  closed_at      timestamptz
);
create index if not exists asks_open_to on cb.asks (to_actor) where status = 'open';
create index if not exists events_ask on cb.events (((data ->> 'ask')::bigint)) where kind = 'ask';
create or replace trigger asks_notify after insert or update or delete on cb.asks
  for each statement execute function cb.notify();

drop function if exists cb.norm_ask cascade;
drop function if exists cb._ask_get cascade;
drop function if exists cb._ask_session cascade;
drop function if exists cb._ask_event cascade;
drop function if exists cb._ask_info cascade;
drop function if exists cb.ask_open cascade;
drop function if exists cb.ask_say cascade;
drop function if exists cb.ask_reply cascade;
drop function if exists cb.ask_close cascade;
drop function if exists cb.ask_reroute cascade;
drop function if exists cb.ask_delivered cascade;
drop function if exists cb.asks_list cascade;

-- "A12", "a12", "#12" or "12" → 12.
create function cb.norm_ask(id text) returns bigint language plpgsql immutable as $$
#variable_conflict use_variable
declare v text := regexp_replace(trim(coalesce(id, '')), '^[aA#]', '');
begin
  if v !~ '^[0-9]+$' then raise exception 'bad ask id "%"; use A12 or 12', id; end if;
  return v::bigint;
end $$;

-- The open ask, locked; a closed one is refused (Ahmed opens a new ask instead).
create function cb._ask_get(id text) returns cb.asks language plpgsql as $$
#variable_conflict use_variable
declare r cb.asks;
begin
  select * into r from cb.asks x where x.id = cb.norm_ask(id) for update;
  if not found then raise exception 'ask A% not found', cb.norm_ask(id); end if;
  if r.status <> 'open' then raise exception 'A% is closed', r.id; end if;
  return r;
end $$;

-- A session to ask: one cb.sessions knows (its latest pane), never Ahmed or a guest.
create function cb._ask_session(to_actor text) returns cb.sessions language plpgsql stable as $$
#variable_conflict use_variable
declare s cb.sessions;
begin
  select * into s from cb.sessions x where x.actor = trim(coalesce(to_actor, '')) order by x.last_seen desc limit 1;
  if not found or cb.ahmed_like(s.actor) or exists (select 1 from cb.users u where u.name = s.actor) then
    raise exception 'unknown session %: pick one on the Sessions page', to_actor;
  end if;
  return s;
end $$;

create function cb._ask_event(r cb.asks, action text, summary text, a text, extra jsonb default '{}') returns bigint language sql as $$
  insert into cb.events (actor, project, task_id, kind, summary, data)
  values ($4, $1.project, $1.task_id, 'ask', $3, jsonb_build_object('ask', $1.id, 'action', $2, 'to', $1.to_actor) || $5)
  returning id
$$;

-- Where an ask stands. awaiting: no reply after Ahmed's latest line; delivered: that line reached the session;
-- late: open, awaiting, and delivered over 15 minutes ago (the relay pushes it once more, then only flags it).
-- A reply counts only after the latest re-route: the session it was handed to owes one of its own.
create function cb._ask_info(aid bigint, out last_ahmed bigint, out last_reply bigint, out awaiting boolean, out delivered boolean, out late boolean)
language sql stable as $$
  select m.la, m.lr, m.lr is null or m.lr < m.la, a.delivered_upto >= m.la,
         a.status = 'open' and (m.lr is null or m.lr < m.la) and a.delivered_upto >= m.la and a.delivered_at < now() - interval '15 minutes'
    from cb.asks a
    cross join lateral (select max(e.id) filter (where e.data ->> 'action' = 'reroute') as rr
                          from cb.events e where e.kind = 'ask' and (e.data ->> 'ask')::bigint = a.id) r
    cross join lateral (select max(e.id) filter (where e.data ->> 'action' in ('open', 'say')) as la,
                               max(e.id) filter (where e.data ->> 'action' = 'reply' and e.id > coalesce(r.rr, 0)) as lr
                          from cb.events e where e.kind = 'ask' and (e.data ->> 'ask')::bigint = a.id) m
   where a.id = $1
$$;

-- Ahmed asks one session (the dashboard only). The ask's project is the session's, else the one he is looking at.
create function cb.ask_open(to_actor text, body text, task text default null, project text default null, actor text default 'ahmed')
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text; s cb.sessions; tid bigint; r cb.asks;
begin
  perform cb.dashboard_only('Today');
  a := cb.set_actor(actor);
  if coalesce(trim(body), '') = '' then raise exception 'the ask text is required'; end if;
  s := cb._ask_session(to_actor);
  if nullif(trim(coalesce(task, '')), '') is not null then
    tid := cb.norm_id(task);
    if not exists (select 1 from cb.tasks t where t.id = tid) then raise exception 'task #% not found', tid; end if;
  end if;
  insert into cb.asks (project, task_id, to_actor, body)
  values (coalesce(s.project, cb.read_project(project)), tid, s.actor, trim(body)) returning * into r;
  perform cb._ask_event(r, 'open', r.body, a);
  return r.id;
end $$;

-- Ahmed writes in the thread: delivered like a new ask line, with its own reminder.
create function cb.ask_say(id text, message text, actor text default 'ahmed') returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text; r cb.asks; e bigint;
begin
  perform cb.dashboard_only('Today');
  a := cb.set_actor(actor);
  r := cb._ask_get(id);
  if coalesce(trim(message), '') = '' then raise exception 'the message is required'; end if;
  e := cb._ask_event(r, 'say', trim(message), a);
  update cb.asks x set repushed_at = null where x.id = r.id;
  return e;
end $$;

-- A reply in the thread, from the session it was asked of (or the dashboard). done closes the ask.
create function cb.ask_reply(id text, message text, done boolean default false, actor text default null) returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); r cb.asks; e bigint;
begin
  r := cb._ask_get(id);
  if not cb._is_dashboard() and a <> r.to_actor then
    raise exception 'A% is for %: only that session (or Ahmed) replies', r.id, r.to_actor;
  end if;
  if coalesce(trim(message), '') = '' then raise exception 'the reply text is required'; end if;
  e := cb._ask_event(r, 'reply', trim(message), a, case when coalesce(done, false) then '{"done": true}'::jsonb else '{}'::jsonb end);
  if coalesce(done, false) then update cb.asks x set status = 'done', closed_at = now() where x.id = r.id; end if;
  return e;
end $$;

create function cb.ask_close(id text, actor text default 'ahmed') returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; r cb.asks;
begin
  perform cb.dashboard_only('Today');
  a := cb.set_actor(actor);
  r := cb._ask_get(id);
  update cb.asks x set status = 'done', closed_at = now() where x.id = r.id;
  perform cb._ask_event(r, 'close', 'closed', a);
end $$;

-- Hand the ask to another session (or the same one again): it is delivered from the start, reminder and all.
create function cb.ask_reroute(id text, to_actor text, actor text default 'ahmed') returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; r cb.asks; s cb.sessions; was text;
begin
  perform cb.dashboard_only('Today');
  a := cb.set_actor(actor);
  r := cb._ask_get(id);
  s := cb._ask_session(to_actor);
  was := r.to_actor;
  update cb.asks x set to_actor = s.actor, project = coalesce(s.project, x.project), delivered_at = null, delivered_to = null,
                       delivered_upto = 0, repushed_at = null
   where x.id = r.id returning * into r;
  perform cb._ask_event(r, 'reroute', 're-routed to ' || s.actor, a, jsonb_build_object('from', was));
end $$;

-- The relay pushed Ahmed's lines up to event `upto` (or the reminder) into delivered_to. Marks nothing if the ask
-- was re-routed or closed meanwhile: the new session still gets it.
create function cb.ask_delivered(id text, upto bigint, delivered_to text, reminder boolean default false) returns void language plpgsql as $$
#variable_conflict use_variable
begin
  update cb.asks x set delivered_at = case when upto > x.delivered_upto then now() else x.delivered_at end,
                       delivered_upto = greatest(x.delivered_upto, upto), delivered_to = delivered_to,
                       repushed_at = case when coalesce(reminder, false) then now() else x.repushed_at end
   where x.id = cb.norm_ask(id) and x.to_actor = delivered_to and x.status = 'open';
end $$;

-- Asks with their threads: open ones (newest first), then those closed in the last 24 hours unless include_closed
-- is false. to_actor narrows to one session's. state: sent | seen | replied | done; live: its relay checked in.
create function cb.asks_list(project text default null, to_actor text default null, include_closed boolean default true)
returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'project', a.project, 'task_id', a.task_id, 'to_actor', a.to_actor, 'body', a.body, 'status', a.status,
      'created_at', a.created_at, 'delivered_at', a.delivered_at, 'closed_at', a.closed_at,
      'state', case when a.status = 'done' then 'done' when not i.awaiting then 'replied' when i.delivered then 'seen' else 'sent' end,
      'awaiting', a.status = 'open' and i.awaiting, 'late', i.late,
      'live', exists (select 1 from cb.sessions s where s.actor = a.to_actor and s.last_seen > now() - interval '90 seconds'),
      'lines', (select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'actor', e.actor, 'action', e.data ->> 'action',
                                                    'text', e.summary, 'done', coalesce((e.data ->> 'done')::boolean, false)) order by e.id)
                  from cb.events e where e.kind = 'ask' and (e.data ->> 'ask')::bigint = a.id))
      order by a.status = 'open' desc, a.id desc)
    from cb.asks a cross join lateral cb._ask_info(a.id) i
   where (p is null or a.project = p) and (to_actor is null or a.to_actor = to_actor)
     and (a.status = 'open' or (coalesce(include_closed, true) and a.closed_at > now() - interval '24 hours'))), '[]');
end $$;
