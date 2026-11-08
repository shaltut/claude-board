-- Claude Board schema. Idempotent: safe to re-run on a live database.
-- NOTE: "create table if not exists" never alters an existing table;
-- column changes need an explicit "alter table" below the create.

create schema if not exists cb;

create table if not exists cb.projects (
  slug       text primary key,
  name       text not null,
  repo_path  text,
  color      text,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
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
  kind        text not null check (kind in ('task_created','moved','updated','done','note','asked','answered','delivered','withdrawn')),
  summary     text not null default '',
  data        jsonb not null default '{}'
);

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
drop function if exists cb.norm_status cascade;
drop function if exists cb.norm_priority cascade;
drop function if exists cb.norm_id cascade;
drop function if exists cb.ensure_project cascade;
drop function if exists cb.tasks_before cascade;
drop function if exists cb.tasks_history cascade;
drop function if exists cb.notify cascade;
drop function if exists cb.task_add cascade;
drop function if exists cb.task_move cascade;
drop function if exists cb.task_update cascade;
drop function if exists cb.task_done cascade;
drop function if exists cb.log cascade;
drop function if exists cb.task_claim cascade;
drop function if exists cb.mine cascade;

-- Effective actor for this transaction; triggers read it back from cb.actor.
create function cb.set_actor(actor text) returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := coalesce(nullif(trim(actor), ''), nullif(current_setting('cb.actor', true), ''), 'unknown');
begin
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

create function cb.norm_id(id text) returns bigint language plpgsql immutable as $$
#variable_conflict use_variable
declare v text := ltrim(trim(coalesce(id, '')), '#');
begin
  if v !~ '^[0-9]+$' then raise exception 'bad id "%"; use a number like 12 or #12', id; end if;
  return v::bigint;
end $$;

create function cb.ensure_project(project text) returns text language plpgsql as $$
#variable_conflict use_variable
declare slug text := regexp_replace(lower(trim(coalesce(project, ''))), '[^a-z0-9_.-]+', '-', 'g');
begin
  if slug = '' then raise exception 'project is required'; end if;
  insert into cb.projects (slug, name) values (slug, initcap(replace(slug, '-', ' ')))
  on conflict do nothing;
  return slug;
end $$;

-- Before-row trigger: rank on entering a status, done_at, blocked_on, updated_at.
create function cb.tasks_before() returns trigger language plpgsql as $$
begin
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
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'rank' - 'updated_at') is distinct from (to_jsonb(old) - 'rank' - 'updated_at') then
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
  if tg_op = 'INSERT' then
    insert into cb.events (actor, project, task_id, kind, summary, data)
    values (a, new.project, new.id, 'task_created', coalesce(note, new.title),
            jsonb_build_object('status', new.status, 'priority', new.priority) || extra);
    return null;
  end if;
  changed := array(
    select n.key from jsonb_each(to_jsonb(new)) n
    where n.value is distinct from to_jsonb(old) -> n.key
      and n.key not in ('rank', 'updated_at', 'status', 'done_at', 'blocked_on'));
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

create function cb.task_add(project text, title text, body text default '', status text default 'backlog',
                            priority text default 'P2', labels text[] default '{}', links jsonb default '{}',
                            assignee text default null, actor text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.ensure_project(project); new_id bigint;
begin
  if coalesce(trim(title), '') = '' then raise exception 'title is required'; end if;
  insert into cb.tasks (project, title, body, status, priority, labels, links, assignee, created_by)
  values (p, trim(title), coalesce(body, ''), cb.norm_status(status), cb.norm_priority(priority),
          coalesce(labels, '{}'), coalesce(links, '{}'), assignee, a)
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
declare tid bigint := cb.norm_id(id); bad text;
begin
  perform cb.set_actor(actor);
  select string_agg(k, ', ') into bad from jsonb_object_keys(coalesce(fields, '{}')) k
   where k not in ('title','body','priority','assignee','labels','links','project','rank');
  if bad is not null then
    raise exception 'unknown field(s) %; allowed: title, body, priority, assignee, labels, links, project, rank', bad;
  end if;
  update cb.tasks t set
    title    = case when fields ? 'title' then fields ->> 'title' else t.title end,
    body     = case when fields ? 'body' then coalesce(fields ->> 'body', '') else t.body end,
    priority = case when fields ? 'priority' then cb.norm_priority(fields ->> 'priority') else t.priority end,
    assignee = case when fields ? 'assignee' then fields ->> 'assignee' else t.assignee end,
    labels   = case when fields ? 'labels' then array(select jsonb_array_elements_text(fields -> 'labels')) else t.labels end,
    links    = case when fields ? 'links' then t.links || (fields -> 'links') else t.links end,
    project  = case when fields ? 'project' then cb.ensure_project(fields ->> 'project') else t.project end,
    rank     = case when fields ? 'rank' then (fields ->> 'rank')::double precision else t.rank end
  where t.id = tid;
  if not found then raise exception 'task #% not found', tid; end if;
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

-- Atomically take the top task in Next (lowest rank). skip locked: two
-- sessions claiming at once never get the same task.
create function cb.task_claim(project text default null, actor text default null)
returns setof cb.tasks language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := nullif(lower(trim(coalesce(project, ''))), ''); tid bigint;
begin
  select t.id into tid from cb.tasks t
   where t.status = 'next' and (p is null or t.project = p)
   order by t.rank, t.id limit 1
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
   where t.assignee = a
     and (t.status not in ('done', 'cancelled') or t.updated_at > now() - interval '24 hours')
   order by t.status, t.rank;
end $$;
