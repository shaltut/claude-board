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

alter table cb.events drop constraint if exists events_kind_check;
alter table cb.events add constraint events_kind_check check (kind in ('task_created','moved','updated','done','note','asked','answered','delivered','withdrawn','broadcast','message'));

-- Old or alternative names for a project: "tawuniya" → ihop. New work through an alias gets its tags.
create table if not exists cb.project_aliases (
  alias text primary key,
  slug  text not null references cb.projects(slug) on update cascade on delete cascade,
  tags  text[] not null default '{}'
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

alter table cb.questions add column if not exists multi boolean not null default false;

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
drop function if exists cb.norm_status cascade;
drop function if exists cb.norm_priority cascade;
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
drop function if exists cb.broadcast_seen cascade;
drop function if exists cb._broadcasts cascade;

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
    update cb.project_aliases pa set slug = t where pa.slug = a;
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
  if tg_op = 'UPDATE' and new.updated_at is not distinct from old.updated_at
     and (to_jsonb(new) - 'rank' - 'updated_at' - 'created_at') is distinct from (to_jsonb(old) - 'rank' - 'updated_at' - 'created_at') then
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
      and n.key not in ('rank', 'updated_at', 'status', 'done_at', 'blocked_on', 'created_at', 'created_by', 'id'));
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

create function cb.task_add(project text, title text, body text default '', status text default 'backlog',
                            priority text default 'P2', labels jsonb default '[]', links jsonb default '{}',
                            assignee text default null, actor text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.ensure_project(project); new_id bigint;
  l text[] := array(select distinct cb.norm_tag(x) from jsonb_array_elements_text(coalesce(labels, '[]')) x where cb.norm_tag(x) <> '');
begin
  if coalesce(trim(title), '') = '' then raise exception 'title is required'; end if;
  -- work added through an alias ("tawuniya") keeps that stream's tags
  l := l || array(select g from cb.project_aliases pa, unnest(pa.tags) g where pa.alias = cb.slug(project) and g <> all(l));
  insert into cb.tasks (project, title, body, status, priority, labels, links, assignee, created_by)
  values (p, trim(title), coalesce(body, ''), cb.norm_status(status), cb.norm_priority(priority),
          l, coalesce(links, '{}'),
          coalesce(assignee, case when cb.norm_status(status) = 'in_progress' then a end), a)
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
declare a text := cb.set_actor(actor); p text := cb.read_project(project); tid bigint;
begin
  select t.id into tid from cb.tasks t
   where t.status = 'next' and (p is null or t.project = p)
     and (t.assignee is null or t.assignee = a)  -- never take a task queued for someone else
   order by t.priority, t.rank, t.id limit 1
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
drop function if exists cb.ask cascade;
drop function if exists cb.answer cascade;
drop function if exists cb.withdraw cascade;
drop function if exists cb.answers_pending cascade;
drop function if exists cb.answer_delivered cascade;
drop function if exists cb.brief cascade;
drop function if exists cb.seen cascade;
drop function if exists cb.last_seen cascade;

create function cb.questions_history() returns trigger language plpgsql as $$
declare a text := coalesce(nullif(current_setting('cb.actor', true), ''), 'unknown');
begin
  if tg_op = 'INSERT' then
    insert into cb.events (actor, project, task_id, question_id, kind, summary, data)
    values (a, new.project, new.task_id, new.id, 'asked', left(new.body, 120),
            jsonb_build_object('blocking', new.blocking, 'options', new.options));
  elsif new.status = 'answered' and (old.status <> 'answered' or new.answer is distinct from old.answer) then
    insert into cb.events (actor, project, task_id, question_id, kind, summary, data)
    values (a, new.project, new.task_id, new.id, 'answered', left(new.answer, 120),
            jsonb_build_object('edited', old.status = 'answered'));
  elsif new.status is distinct from old.status and new.status in ('delivered', 'withdrawn') then
    insert into cb.events (actor, project, task_id, question_id, kind, summary, data)
    values (a, new.project, new.task_id, new.id, new.status,
            case when new.status = 'delivered' then 'delivered to ' || coalesce(new.delivered_to, '?')
                 else 'withdrew: ' || left(new.body, 100) end, '{}');
  end if;
  return null;
end $$;

create or replace trigger questions_history after insert or update on cb.questions
  for each row execute function cb.questions_history();

-- Ask Ahmed (the non-blocking replacement for AskUserQuestion).
-- options: jsonb array of strings or {label, description}; stored as [{label, description}].
-- Blocking + task_id parks the task in Blocked until delivery.
create function cb.ask(project text, body text, options jsonb default null, blocking boolean default false,
                       task_id text default null, context text default null, reply_to jsonb default null,
                       multi boolean default false, actor text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.ensure_project(project);
        tid bigint := case when task_id is null or trim(task_id) = '' then null else cb.norm_id(task_id) end;
        qid bigint;
begin
  if coalesce(trim(body), '') = '' then raise exception 'question body is required'; end if;
  if tid is not null and not exists (select 1 from cb.tasks t where t.id = tid) then
    raise exception 'task #% not found', tid;
  end if;
  if options is not null and jsonb_typeof(options) <> 'array' then
    raise exception 'options must be a JSON array of strings or {label, description} objects';
  end if;
  insert into cb.questions (project, task_id, asked_by, body, context, options, blocking, reply_to, multi)
  values (p, tid, a, trim(body), context,
          (select jsonb_agg(case when jsonb_typeof(o) = 'string'
                                 then jsonb_build_object('label', o #>> '{}', 'description', null)
                                 else jsonb_build_object('label', o ->> 'label', 'description', o ->> 'description') end
                            order by i)
             from jsonb_array_elements(options) with ordinality as e(o, i)),
          coalesce(blocking, false), reply_to, coalesce(multi, false))
  returning cb.questions.id into qid;
  if coalesce(blocking, false) and tid is not null then
    perform set_config('cb.note', 'blocked on Q' || qid, true);
    update cb.tasks t set status = 'blocked', blocked_on = qid where t.id = tid;
    perform set_config('cb.note', '', true);
  end if;
  return qid;
end $$;

-- Editable until delivered.
create function cb.answer(id text, answer text, actor text default 'ahmed')
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(id); cur text;
begin
  perform cb.set_actor(actor);
  if coalesce(trim(answer), '') = '' then raise exception 'answer is required'; end if;
  select q.status into cur from cb.questions q where q.id = qid for update;
  if cur is null then raise exception 'question Q% not found', qid; end if;
  if cur in ('delivered', 'withdrawn') then raise exception 'question Q% is already %', qid, cur; end if;
  update cb.questions q set status = 'answered', answer = trim(answer), answered_at = now() where q.id = qid;
end $$;

create function cb.withdraw(id text, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(id);
begin
  perform cb.set_actor(actor);
  update cb.questions q set status = 'withdrawn' where q.id = qid and q.status in ('open', 'answered');
  if not found then raise exception 'question Q% not found or already delivered/withdrawn', qid; end if;
  update cb.tasks t set status = case when t.assignee is null then 'next' else 'in_progress' end
   where t.blocked_on = qid and t.status = 'blocked';
end $$;

create function cb.answers_pending(project text default null)
returns setof cb.questions language plpgsql as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  return query select q.* from cb.questions q
   where q.status = 'answered' and (p is null or q.project = p)
   order by q.answered_at, q.id;
end $$;

-- Orchestrator: answer handed to the session. Idempotent. Unblocks the task.
create function cb.answer_delivered(id text, delivered_to text default null, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(id); cur text;
begin
  perform cb.set_actor(actor);
  select q.status into cur from cb.questions q where q.id = qid for update;
  if cur is null then raise exception 'question Q% not found', qid; end if;
  if cur = 'delivered' then return; end if;
  if cur <> 'answered' then raise exception 'question Q% is %, not answered', qid, cur; end if;
  update cb.questions q set status = 'delivered', delivered_at = now(), delivered_to = delivered_to where q.id = qid;
  perform set_config('cb.note', 'unblocked: Q' || qid || ' answered', true);
  update cb.tasks t set status = case when t.assignee is null then 'next' else 'in_progress' end
   where t.blocked_on = qid and t.status = 'blocked';
  perform set_config('cb.note', '', true);
end $$;

-- Snapshot a session reads at start.
create function cb.brief(project text default null, tag text default null)
returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); tg text := nullif(cb.norm_tag(tag), '');
begin
  return jsonb_build_object(
    'in_progress', cb._brief_tasks(p, tg, 'in_progress', 50),
    'next', cb._brief_tasks(p, tg, 'next', 10),
    'blocked', cb._brief_tasks(p, tg, 'blocked', 50),
    'review', cb._brief_tasks(p, tg, 'review', 50),
    'open_questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'project', q.project, 'body', q.body,
        'blocking', q.blocking, 'asked_by', q.asked_by, 'task_id', q.task_id, 'options', q.options) order by q.blocking desc, q.id)
      from cb.questions q where q.status = 'open' and (p is null or q.project = p)), '[]'),
    'answered_pending', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'project', q.project, 'body', q.body,
        'answer', q.answer, 'asked_by', q.asked_by, 'reply_to', q.reply_to, 'task_id', q.task_id) order by q.id)
      from cb.questions q where q.status = 'answered' and (p is null or q.project = p)), '[]'),
    'broadcasts', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'project', e.project, 'summary', e.summary, 'at', e.at)
                                               order by e.id desc)
      from cb.events e where e.kind = 'broadcast' and e.at > now() - interval '24 hours'
                         and (p is null or e.project is null or e.project = p)), '[]'));
end $$;

drop function if exists cb._brief_tasks cascade;
create function cb._brief_tasks(p text, tg text, s text, lim int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x order by x.priority, x.rank), '[]') from (
    select t.id, t.project, t.title, t.priority, t.assignee, t.updated_at, t.blocked_on, t.rank, t.labels
      from cb.tasks t where t.status = s and (p is null or t.project = p) and (tg is null or tg = any(t.labels))
     order by t.priority, t.rank limit lim) x
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
  insert into cb.sessions (machine, pane, actor, project) values (lower(trim(machine)), trim(pane), trim(actor), p)
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
  -- a new session (relay before cb iam) starts with the last 24h of broadcasts
  insert into cb.sessions (machine, pane, actor, broadcast_seen)
  values (m, pane, pane || '@' || m, coalesce((select max(e.id) from cb.events e where e.kind = 'broadcast' and e.at < now() - interval '24 hours'), 0))
  on conflict on constraint sessions_pkey do update set last_seen = now()
  returning cb.sessions.actor, cb.sessions.project, cb.sessions.broadcast_seen into me, proj, seen;
  return jsonb_build_object(
    'actor', me,
    'broadcasts', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'project', e.project, 'summary', e.summary) order by e.id)
                              from cb.events e
                             where e.kind = 'broadcast' and e.id > seen and (e.project is null or e.project = proj)
                               and e.actor is distinct from me), '[]'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'summary', e.summary) order by e.id)
                            from cb.events e
                           where e.kind = 'message' and e.data ->> 'to' = me and e.id > seen
                             and e.at > now() - interval '24 hours'), '[]'),
    'answers', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'task_id', q.task_id, 'project', q.project,
                                                             'body', q.body, 'answer', q.answer) order by q.id)
                           from cb.questions q
                          where q.status = 'answered' and lower(q.reply_to ->> 'machine') = m and q.reply_to ->> 'pane' = pane), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'task_id', e.task_id, 'kind', e.kind, 'summary', e.summary,
                                                            'actor', e.actor, 'title', t.title, 'status', t.status) order by e.id)
                          from cb.events e join cb.tasks t on t.id = e.task_id
                         where me is not null and e.id > after_event and e.actor <> me
                           and e.kind in ('task_created', 'moved', 'updated', 'done', 'note')
                           and (t.assignee = me or e.data -> 'assignee' ->> 'from' = me)), '[]'),
    -- New work in my project's Next (unassigned or mine), only while I have nothing in progress.
    'next_work', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'priority', t.priority) order by t.priority, t.rank)
                             from cb.tasks t
                            where me is not null and proj is not null and t.project = proj and t.status = 'next'
                              and (t.assignee is null or t.assignee = me)
                              and exists (select 1 from cb.events e where e.task_id = t.id and e.id > after_event and e.actor <> me
                                            and ((e.kind = 'task_created' and e.data ->> 'status' = 'next')
                                                 or (e.kind = 'moved' and e.data ->> 'to' = 'next')))
                              and not exists (select 1 from cb.tasks w where w.assignee = me and w.status = 'in_progress')), '[]'),
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
    where a.actor is not null and a.actor not in ('ahmed', 'relay', 'unknown')
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
