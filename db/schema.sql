-- Agents Board schema. Idempotent: safe to re-run on a live database.
-- NOTE: "create table if not exists" never alters an existing table;
-- column changes need an explicit "alter table" below the create.

create schema if not exists cb;

-- #4726: every start re-applies this file beside live readers. Dropping and re-adding a check takes ACCESS EXCLUSIVE and
-- rescans the table, so it happens only when the rule changed: the constraint's comment keeps the text it was made from
-- (Postgres rewrites the definition itself, so that cannot be compared).
drop function if exists cb._ensure_check(regclass, text, text) cascade;
create function cb._ensure_check(tbl regclass, con text, expr text) returns void language plpgsql as $$
begin
  if exists (select 1 from pg_constraint c where c.conrelid = tbl and c.conname = con
             and obj_description(c.oid, 'pg_constraint') = expr) then return; end if;
  execute format('alter table %s drop constraint if exists %I', tbl, con);
  execute format('alter table %s add constraint %I check (%s)', tbl, con, expr);
  execute format('comment on constraint %I on %s is %L', con, tbl, expr);
end $$;
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
-- #4531: the board's own project shows as Agents Board; its slug stays claude-board (every cb bug claude-board keeps
-- working). Only the name cb.ensure_project made moves: a name set by hand is kept, and a re-run touches no row.
update cb.projects set name = 'Agents Board' where slug = 'claude-board' and name = 'Claude Board';
-- #4559: a project is enabled (gets work), disabled (no new work; nothing lost) or archived (disabled, and nothing new
-- is filed). Only Ahmed changes it (cb.project_state). state_by and state_at say who and when; state_at is also where
-- every quiet clock (reminders, stall nudges, the digest) starts again after an enable. archived is kept and always
-- written with the state: an older server reads it, and a rollback keeps columns.
alter table cb.projects add column if not exists state text not null default 'enabled';
alter table cb.projects add column if not exists state_by text;
alter table cb.projects add column if not exists state_at timestamptz;
select cb._ensure_check('cb.projects', 'projects_state_check', $c$state in ('enabled', 'disabled', 'archived')$c$);

-- #4763: the model names one machine's agent CLI listed when it last sent them (cb models report). The settings page
-- offers the chosen machine's list; squad_set does not depend on it, so a model typed by hand still saves.
create table if not exists cb.machine_models (
  machine     text not null,
  agent       text not null,
  models      jsonb not null,
  reported_at timestamptz not null default now(),
  reported_by text not null,
  primary key (machine, agent)
);
-- one-time: a project archived by hand before #4559 is archived. Once a state was set (state_at), archived follows it,
-- so a re-run never archives a project Ahmed enabled again.
update cb.projects set state = 'archived', state_at = now(), state_by = 'board' where archived and state = 'enabled' and state_at is null;


-- Old or alternative names for a project: "tamarind" → iris. New work through an alias gets its tags.
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
-- #1749 (the board on a VPS: everyone signs in). admin = the whole board, by password only; member = their own
-- questions and tasks (the guest page). Ahmed, the owner, is the user named ahmed: always an admin.
alter table cb.users add column if not exists role text not null default 'member';
do $$ begin
  alter table cb.users add constraint users_role check (role in ('admin', 'member'));
exception when duplicate_object then null; end $$;

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
create index if not exists events_actor_at on cb.events (actor, at desc);
-- "An actor's latest event" (sessions_overview's `last`, order by id desc limit 1): without it the planner walks events_pkey
-- backwards and, for an actor with no events (a fresh squad session), reads the whole table: 25 s per call, 504s on every page (2026-11-26).
create index if not exists events_actor_id on cb.events (actor, id desc);
select cb._ensure_check('cb.events', 'events_kind_check', $c$kind in ('task_created','moved','updated','done','note','asked','answered','delivered','withdrawn','broadcast','message','huddle','user','epic','memory','sent_back','rewritten','goal','ask','supervisor')$c$);

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
select cb._ensure_check('cb.questions', 'questions_status_check', $c$status in ('open','answered','delivered','withdrawn','dormant','sent_back')$c$);
create index if not exists questions_parent on cb.questions (parent_id) where parent_id is not null;

-- Send back (#616): Ahmed (or the person it is for) returns an open question to its asker, 'sent_back' until the asker
-- rewrites it (cb.reask), then it is open again under the same id. sent_back: {reason, note, by, at, delivered_at,
-- delivered_to} while it waits (delivered_at: the asker was told, as an answer is delivered). versions: the earlier
-- texts, oldest first, each with the send-back that led to its rewrite (reason null: rewritten while open).
alter table cb.questions add column if not exists sent_back jsonb;
alter table cb.questions add column if not exists versions jsonb;
-- A delivered answer changed (#1346): the answers the session was told before, oldest first, each
-- {answer, answered_by, answered_at, delivered_at, delivered_to, changed_at, changed_by}. Set: the answer now waiting is
-- a correction, pushed as "CHANGED ... was <the last one>".
alter table cb.questions add column if not exists answer_history jsonb;

-- What kind of work a task is. 'task' (unclassified) is the default: existing rows were never typed,
-- and calling them features would be a lie. The list lives in the check and in cb.norm_type.
alter table cb.tasks add column if not exists type text not null default 'task';
select cb._ensure_check('cb.tasks', 'tasks_type_check', $c$type in ('task','bug','feature','change','chore','research')$c$);

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
-- the session's squad role (its check is with the squad pipeline below); here because cb.triagers, a sql function whose
-- body is checked when created, reads it (#3746)
alter table cb.sessions add column if not exists role text;
-- the agent CLI the session runs (#4002); every session before it was claude
alter table cb.sessions add column if not exists agent text not null default 'claude';
select cb._ensure_check('cb.sessions', 'sessions_agent_check', $c$agent in ('claude','codex','opencode','agy')$c$);
-- the agent session in this pane (#4379), as its relay last saw it (Claude: the session id its SessionStart hook wrote
-- with the endpoint). Another id in the same pane is another session: cb.inbox resets the row. Null (a row from before
-- it, or one a cb iam just bound) takes the next id as it is
alter table cb.sessions add column if not exists session_id text;
-- #4786: the model the seat's relay last read off its agent's screen (cb.seat_model). model is what the session was bound
-- with; an agent can change model inside its pane. Cleared by cb.iam and when another session takes the pane
alter table cb.sessions add column if not exists running_model text;
-- #3221: a relay holding low-priority notices (runner results, GitHub, digests, nudges, card edits, broadcasts, memory)
-- marks it here: hold_from is the card-event cursor (`after`) the held read used, hold_at when the hold began. A relay
-- that restarts mid-hold reads from hold_from again and keeps the window's clock, so nothing held is lost or doubled.
-- Null: nothing held. Set and cleared by cb.relay_hold; reset with broadcast_seen when the row starts again.
alter table cb.sessions add column if not exists hold_from bigint;
alter table cb.sessions add column if not exists hold_at timestamptz;

create table if not exists cb.settings (
  key   text primary key,
  value jsonb
);

create index if not exists tasks_project_status_rank on cb.tasks (project, status, rank);
-- a session's own cards (inbox's "nothing in progress", mine, claim): without it every relay's inbox check read the
-- whole table, 13 billion rows in 6 days (2026-11-19)
create index if not exists tasks_assignee_status on cb.tasks (assignee, status);
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
drop function if exists cb._freed_status cascade;
drop function if exists cb.slug cascade;
drop function if exists cb.read_project cascade;
drop function if exists cb._live cascade;
drop function if exists cb._state_words cascade;
drop function if exists cb._wait_words cascade;
drop function if exists cb.project_state cascade;
drop function if exists cb.project_state_preview cascade;
drop function if exists cb.resolve cascade;
drop function if exists cb.project_alias cascade;
drop function if exists cb.tasks_before cascade;
drop function if exists cb.tasks_history cascade;
drop function if exists cb.notify cascade;
drop function if exists cb.sessions_bind_notify cascade;
drop function if exists cb.task_add cascade;
drop function if exists cb.norm_tag cascade;
drop function if exists cb.task_tag cascade;
drop function if exists cb.task_move cascade;
drop function if exists cb.task_update cascade;
drop function if exists cb.task_done cascade;
drop function if exists cb.log cascade;
drop function if exists cb.guest_text cascade;
drop function if exists cb.task_claim cascade;
drop function if exists cb.mine cascade;
drop function if exists cb._seat_name cascade;
drop function if exists cb.iam cascade;
drop function if exists cb.seat_model cascade;
drop function if exists cb._running_model cascade;
drop function if exists cb._model_differs cascade;
drop function if exists cb.inbox cascade;
drop function if exists cb._person cascade;
drop function if exists cb.broadcast cascade;
drop function if exists cb.sessions_overview cascade;
drop function if exists cb.tell cascade;
drop function if exists cb.type_to cascade;
drop function if exists cb.task_ping_set cascade;
drop function if exists cb.task_ping_bulk cascade;
drop function if exists cb.pings_due cascade;
drop function if exists cb.huddle_open cascade;
drop function if exists cb.huddle_add cascade;
drop function if exists cb.huddle_say cascade;
drop function if exists cb.huddle_close cascade;
drop function if exists cb.huddles_list cascade;
drop function if exists cb._huddle_post cascade;
drop function if exists cb._huddle_join cascade;
drop function if exists cb.broadcast_seen cascade;
drop function if exists cb.relay_hold cascade;
drop function if exists cb._broadcasts cascade;
drop function if exists cb.tick cascade;
drop function if exists cb._is_review cascade;
drop function if exists cb._pr_no cascade;
drop function if exists cb._has_reviewer cascade;
drop function if exists cb.lock_take cascade;
drop function if exists cb.lock_release cascade;
drop function if exists cb.lock_queue cascade;
drop function if exists cb.norm_epic cascade;
drop function if exists cb._norm_assignee cascade;
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
-- #4356: what a guest (a member) writes reaches sessions, so the invisible format characters (Unicode Cf: zero-width,
-- bidi overrides, tag characters) come out where it is written: answers, send-back notes, log lines. The class is every
-- Cf code point of Unicode 17, written as \u escapes so it can be read and diffed (Postgres regexes have no \p{};
-- test/guest-text.test.ts pins it and checks it against Node's). Cf only, by design: other invisible or confusable
-- letters and marks (Hangul fillers, U+034F, variation selectors, braille blank) are ordinary text and stay.
-- Control characters go too (review I2: a terminal acts on an ESC sequence, \r, a backspace): a line break of any
-- kind (\r\n, \r, U+0085) becomes \n, which the relay indents; the other C0 and C1 controls but \n and \t are removed.
-- The owner's and admins' text stays as typed (a right-to-left mark, an emoji joiner).
create function cb.guest_text(actor text, t text) returns text language sql stable as $$
  select case when t is not null and exists (select 1 from cb.users u where lower(u.name) = lower(trim(coalesce(actor, ''))) and u.role = 'member')
    then regexp_replace(regexp_replace(regexp_replace(t, '\r\n?|\u0085', E'\n', 'g'),
           '[\u0001-\u0008\u000b-\u001f\u007f-\u009f]', '', 'g'),
           '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]', '', 'g')
    else t end $$;
create function cb.ahmed_like(a text) returns boolean language sql immutable as $$ select coalesce(a, '') ~* '\mahmed\M' $$;
create function cb.not_ahmed(a text) returns void language plpgsql as $$
begin
  if cb.ahmed_like(a) and current_setting('application_name') <> 'cb-web' then
    raise exception 'only Ahmed''s dashboard can act as ahmed: sessions use their own name';
  end if;
end $$;

-- Things only Ahmed does, from his dashboard, whatever name the caller gives (or none): guest links, epics.
-- ponytail: the same deterrent as not_ahmed (PGAPPNAME=cb-web gets past it), not auth.
create function cb.dashboard_only(page text default 'Users') returns void language plpgsql as $$
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

-- Who triages a project's new bugs: its lead(s) (a session bound to it with the lead role, whatever its name; an orch@*
-- one with no role, as cb._role; seen in the last day), else every
-- session bound to it and seen in the last day. A day, not the 90s relay liveness: a relay restart or
-- a sleeping Mac must not hand the orchestrator's bugs to every worker; session rows are never deleted.
-- One rule for the relay push (cb.inbox) and for what `cb bug` prints. The role is read off the session row here: a
-- sql body may not call cb._role, which is defined further down (#3746).
-- #3779: each name by its latest session, as cb._is_lead: a lead that has since bound another project (in another pane,
-- so its old row stays) no longer triages this one, and cb bug's "no orchestrator there" note agrees with the list.
create function cb.triagers(project text) returns text[] language sql stable as $$
  with s as (select distinct on (x.actor) x.actor, x.project, x.role, x.last_seen from cb.sessions x order by x.actor, x.last_seen desc)
  select coalesce(
    nullif(array(select s.actor from s
                  where s.project = $1 and coalesce(s.role, case when s.actor = 'orch' or s.actor like 'orch@%' then 'lead' end) = 'lead'
                    and s.last_seen > now() - interval '1 day' order by s.actor), '{}'),
    array(select s.actor from s where s.project = $1 and s.last_seen > now() - interval '1 day' order by s.actor))
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

-- slug, then follow an alias: "OCR Arena" → ocr-arena → iris.
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
  -- #4559: merged work would land where nothing picks it up
  if not cb._live(t) then raise exception '%: nothing is merged into it until Ahmed enables it on Projects', cb._state_words(t); end if;
  -- #4621: nor is such a project merged away: its cards would be handed out again under the other name
  if not cb._live(a) then raise exception '%: it is not merged into another project until Ahmed enables it', cb._state_words(a); end if;
  perform cb.ensure_project(t);
  if exists (select 1 from cb.projects p where p.slug = a) then
    perform set_config('cb.quiet', 'on', true);
    update cb.tasks x set project = t, labels = x.labels || array(select g from unnest(tg) g where g <> all(x.labels))
     where x.project = a;
    get diagnostics n = row_count;
    update cb.questions q set project = t where q.project = a;
    update cb.events e set project = t where e.project = a;
    -- pages follow (cb.pages.project is a foreign key): an area the target already has a page for keeps the old one under a new name
    update cb.pages g set project = t,
           area = case when exists (select 1 from cb.pages x where x.project = t and x.area = g.area) then g.area || '-' || a else g.area end
     where g.project = a;
    update cb.epics e set project = t where e.project = a; -- epics follow their steps
    update cb.goals g set project = t where g.project = a;
    update cb.memories m set project = t where m.project = a; -- no unique key on a memory's project: nothing collides
    update cb.jobs j set project = t where j.project = a; -- runner jobs (#3600): a foreign key that does not cascade a delete
    -- the runners' recipes follow, so moved queued jobs are claimed (no foreign key); a recipe the runner already offers
    -- the target for the same repo keeps the target's row. runner.json must follow the merge too: a runner restart
    -- publishes its projects again
    delete from cb.runner_recipes rr where rr.project = a
      and exists (select 1 from cb.runner_recipes x where x.runner = rr.runner and x.project = t and x.repo = rr.repo and x.recipe = rr.recipe);
    update cb.runner_recipes rr set project = t where rr.project = a;
    -- asks and bound sessions follow: their foreign keys set null on the delete below
    update cb.asks k set project = t where k.project = a;
    update cb.sessions s set project = t where s.project = a;
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
    coalesce((select string_agg(p.slug, ', ' order by p.slug) from cb.projects p where p.state = 'enabled'), 'none yet (cb add creates one)');
end $$;

-- #4559: does this project get work? Only an enabled one does. A slug with no row yet is enabled: first use makes it so.
create function cb._live(project text) returns boolean language sql stable as $$
  select coalesce((select p.state = 'enabled' from cb.projects p where p.slug = $1), true)
$$;

-- The one sentence every refusal, notice and banner uses for a project that gets no work; null while it is enabled.
create function cb._state_words(project text) returns text language sql stable as $$
  select case p.state
    when 'disabled' then format('%s is disabled by Ahmed%s: no work is handed out there',
                                p.name, coalesce(' since ' || to_char(p.state_at at time zone 'UTC', 'DD Mon HH24:MI') || ' UTC', ''))
    when 'archived' then format('%s is archived: nothing new goes there', p.name)
  end from cb.projects p where p.slug = $1
$$;
-- What a seat of such a project does meanwhile (cb next, cb start, the notice, refused work).
create function cb._wait_words(project text) returns text language sql stable as $$
  select cb._state_words($1) || case when cb._live($1) then '' when (select p.state from cb.projects p where p.slug = $1) = 'archived'
    then '. File new work elsewhere, or ask Ahmed to unarchive it'
    else '. Write where you stopped (cb log <card> "...") and wait: you will be told when it is enabled' end
$$;

-- #4621: where a card goes when its question stops holding it: its holder takes it up again, or it waits in Next. A
-- project that gets no work starts nothing: the holder keeps the card and finds it in Next.
create function cb._freed_status(assignee text, project text) returns text language sql stable as $$
  select case when $1 is null or not cb._live($2) then 'next' else 'in_progress' end
$$;

create function cb.ensure_project(project text) returns text language plpgsql as $$
#variable_conflict use_variable
declare slug text := cb.resolve(project);
begin
  if slug = '' then raise exception 'project is required'; end if;
  if slug ~ '^#?[0-9]+$' then
    raise exception '"%" looks like a task number, not a project: use cb log <project> "..." -t %', project, ltrim(project, '#');
  end if;
  insert into cb.projects (slug, name)
  values (slug, case when slug = 'claude-board' then 'Agents Board' else initcap(replace(slug, '-', ' ')) end) -- #4531
  on conflict do nothing;
  return slug;
end $$;

-- Before-row trigger: rank on entering a status, done_at, blocked_on, epic (same project, joins at the end), updated_at.
create function cb.tasks_before() returns trigger language plpgsql as $$
declare ep text;
declare ac text; r text;
begin
  -- #4593: a for:<agent> label names an agent a seat can run (a typo would keep the card from everyone). Only labels
  -- added now: one saved before this rule does not block other changes to its card
  if tg_op = 'INSERT' or new.labels is distinct from old.labels then
    select l into r from unnest(new.labels) l
     where lower(l) like 'for:%' and substr(lower(l), 5) <> all(cb._agents_main()) and (tg_op = 'INSERT' or l <> all(old.labels)) limit 1;
    if r is not null then
      raise exception 'label % names no agent: for: takes one of %', lower(r), array_to_string(cb._agents_main(), ', ');
    end if;
  end if;
  -- squad pipeline guard (#3598): a staged card leaves its flow only through Ahmed's dashboard, or the lead with a note
  if tg_op = 'UPDATE' and old.stage is not null and cb._pipeline(old.project) and current_setting('cb.stage_ok', true) is distinct from 'on' then
    if new.status in ('done', 'cancelled') and new.status is distinct from old.status then
      ac := current_setting('cb.actor', true);
      if not (cb._is_dashboard() or (cb._role(ac) = 'lead' and nullif(trim(coalesce(current_setting('cb.note', true), '')), '') is not null)) then
        raise exception '#% is at %: % (only Ahmed, or the lead with a note, closes it outside the pipeline)', old.id, old.stage,
          case when old.stage = 'approval' then cb._finish_line(old) else 'finish it with ' || cb._finish_line(old, ac) end;
      end if;
    end if;
    -- review is the status of a card waiting at approval; any other staged card parked there would fall out of every list
    if new.status = 'review' and new.status is distinct from old.status and new.stage is distinct from 'approval' then
      raise exception '#% is at %: finish it with %', old.id, cb._stage_words(old.stage), cb._finish_line(old, current_setting('cb.actor', true));
    end if;
    if new.project is distinct from old.project and not cb._is_dashboard() then
      raise exception '#% is at %: a staged card stays in its project (Ahmed can move it from the board)', old.id, old.stage;
    end if;
  end if;
  -- a closed card is out of the pipeline whatever the pipeline switch says; one waiting at approval takes its question with it,
  -- and one of several repos its parts (#3703: they would count as held work forever)
  if tg_op = 'UPDATE' and old.stage is not null and new.status in ('done', 'cancelled') and new.status is distinct from old.status then
    new.stage := null; new.stage_since := null;
    if old.stage = 'approval' then
      update cb.questions q set status = 'withdrawn' where q.approval_for = old.id and q.status in ('open', 'sent_back', 'dormant');
    end if;
    -- who built and reviewed each part stays on the card (build:<repo>, review:<repo>: keys no rule reads)
    new.crew := new.crew || coalesce((select jsonb_object_agg(c.key || ':' || p.repo, c.value)
                                        from cb.task_parts p cross join lateral jsonb_each(p.crew) c where p.task_id = old.id), '{}');
    -- a part's holder is told: the card was never theirs, so its close reaches them no other way
    insert into cb.events (actor, project, task_id, kind, summary, data)
    select 'board', new.project, old.id, 'message', format('#%s is %s: your part %s is closed', old.id, new.status, p.repo),
           jsonb_build_object('to', p.assignee, 'repo', p.repo)
      from cb.task_parts p where p.task_id = old.id and nullif(trim(p.assignee), '') is not null and p.stage <> 'merged'
     order by p.repo;
    delete from cb.task_parts p where p.task_id = old.id;
  end if;
  -- a task page follows its task to another project (an area page is moved by cb.project_alias)
  if tg_op = 'UPDATE' and new.project is distinct from old.project then
    update cb.pages g set project = new.project where g.task_id = old.id;
  end if;
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

-- A session's binding (cb iam: its actor and project) is kept by its relay, which hands it to every cb call so the
-- call is one round trip, not two (#3256). The relay must hear every change, whatever made it: cb iam through the
-- relay or directly, the dashboard, a project renamed or deleted (by cascade). One notice per changed row, on its
-- own channel: the heartbeats (last_seen, broadcast_seen) say nothing.
create function cb.sessions_bind_notify() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform pg_notify('cb_bind', old.machine || ':' || old.pane);
  else perform pg_notify('cb_bind', new.machine || ':' || new.pane); end if;
  return null;
end $$;
create or replace trigger sessions_bind_notify after insert or delete on cb.sessions
  for each row execute function cb.sessions_bind_notify();
create or replace trigger sessions_bind_changed after update on cb.sessions
  for each row when (old.actor is distinct from new.actor or old.project is distinct from new.project
                     or old.machine is distinct from new.machine or old.pane is distinct from new.pane
                     or old.agent is distinct from new.agent)  -- #4002: the relay delivers by the session's agent
  execute function cb.sessions_bind_notify();

-- The open blockers a task waits on (not done or cancelled), lowest id first: "waits on #12".
create function cb._waits_on(tid bigint) returns bigint[] language sql stable as $$
  select array(select b.blocker from cb.task_blockers b join cb.tasks x on x.id = b.blocker
                where b.task = $1 and x.status not in ('done', 'cancelled') order by b.blocker)
$$;

create function cb.task_add(project text, title text, body text default '', status text default null,
                            priority text default 'P2', labels jsonb default '[]', links jsonb default '{}',
                            assignee text default null, actor text default null, type text default null, epic text default null,
                            stage text default null, why text default null, repos jsonb default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.ensure_project(project); new_id bigint;
  l text[] := array(select distinct cb.norm_tag(x) from jsonb_array_elements_text(coalesce(labels, '[]')) x where cb.norm_tag(x) <> '');
  piped boolean := cb._pipeline(p); ty text := cb.norm_type(type); sg text := lower(trim(stage));
  -- pipeline projects: a new card starts at design (PR tracking cards and investigations stay unstaged) and waits in Next
  staged boolean := piped and a <> 'github' and ty <> 'research';
  -- a staged card waits in Next (or Backlog if asked): any other status would be a self-claim past the role-aware claim
  st text := case when staged then (case when cb.norm_status(coalesce(status, 'next')) = 'backlog' then 'backlog' else 'next' end)
                  else cb.norm_status(coalesce(status, 'backlog')) end;
begin
  if coalesce(trim(title), '') = '' then raise exception 'title is required'; end if;
  -- #4559 (Q3020): an archived project takes nothing new, from anyone. A disabled one takes the card but parks it in its
  -- Backlog with no holder and no stage jump, so a filer in another project (cb bug, cb triage) is never broken; Ahmed's
  -- dashboard files as he chooses. The CLI tells the filer (cb._state_words).
  if not cb._live(p) then
    if (select pr.state from cb.projects pr where pr.slug = p) = 'archived' then
      raise exception '%. File it elsewhere, or ask Ahmed to unarchive it', cb._state_words(p);
    end if;
    if not cb._is_dashboard() then st := 'backlog'; assignee := null; sg := null; end if;
  end if;
  if sg is not null and not piped then raise exception 'stage is only for projects with the pipeline on'; end if;
  if sg is not null and sg <> 'build' then raise exception 'a new card starts at design; the lead can send small work to build: stage => build'; end if;
  -- said here, not by stage_set: its hint would name a card id that the refusal rolls back
  if sg = 'build' and cardinality(coalesce(cb._repo_list(repos), '{}')) = 0 and cb._multi_repo(p) then
    raise exception 'give the repos: --stage build --repo <repo> --why "<why>"';
  end if;
  -- work added through an alias ("tamarind") keeps that stream's tags
  l := l || array(select g from cb.project_aliases pa, unnest(pa.tags) g where pa.alias = cb.slug(project) and g <> all(l));
  insert into cb.tasks (project, title, body, status, priority, labels, links, assignee, created_by, type, epic_id, stage, stage_since, repos)
  values (p, trim(title), coalesce(body, ''), st, cb.norm_priority(priority),
          l, coalesce(links, '{}'),
          coalesce(cb._norm_assignee(assignee), case when st = 'in_progress' then a end), a, ty, cb.norm_epic(epic),
          case when staged then 'design' end, case when staged then now() end, cb._check_repos(p, cb._repo_list(repos)))
  returning cb.tasks.id into new_id;
  -- stage => build is the lead's restage, with the same checks (and the note) as cb.stage_set; it reads the repos just stored
  if sg = 'build' then perform cb.stage_set(new_id::text, 'build', why, a); end if;
  return new_id;
end $$;

create function cb.task_move(id text, status text, note text default null, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare tid bigint := cb.norm_id(id); s text := cb.norm_status(status); cur cb.tasks;
begin
  perform cb.set_actor(actor);
  -- #4559: starting work never passes cb._claimable here, so it has its own rule: in a project that gets no work, a
  -- session may wrap up (log, done, block, review, back to Next or Backlog) but not move a card into In progress
  if s = 'in_progress' and not cb._is_dashboard() then
    select * into cur from cb.tasks t where t.id = tid;
    if found and cur.status <> 'in_progress' and not cb._live(cur.project) then
      raise exception '%', cb._wait_words(cur.project);
    end if;
  end if;
  perform set_config('cb.note', coalesce(note, ''), true);
  -- #4454: the status asked for rides on the event, so a move to the status a card already has (its history writes a
  -- note, not a moved event) still reads as a move there: cb move <id> blocked "<new why>" restates a blocked card's reason
  perform set_config('cb.data', jsonb_build_object('to', s)::text, true);
  update cb.tasks t set status = s where t.id = tid;
  if not found then raise exception 'task #% not found', tid; end if;
  perform set_config('cb.note', '', true);
  perform set_config('cb.data', '', true);
end $$;

create function cb.task_update(id text, fields jsonb, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare tid bigint := cb.norm_id(id); bad text; cur cb.tasks; ep bigint; rs text[]; opn boolean := false;
begin
  perform cb.set_actor(actor);
  select string_agg(k, ', ') into bad from jsonb_object_keys(coalesce(fields, '{}')) k
   where k not in ('title','body','priority','assignee','labels','links','project','rank','type','epic','epic_rank','repos');
  if bad is not null then
    raise exception 'unknown field(s) %; allowed: title, body, priority, assignee, labels, links, project, rank, type, epic, epic_rank, repos', bad;
  end if;
  -- a cleared holder is null, never a string (#3762): cb edit --assignee none or '' (the dashboard sends a JSON null)
  if fields ? 'assignee' then
    fields := jsonb_set(fields, '{assignee}', coalesce(to_jsonb(cb._norm_assignee(fields ->> 'assignee')), 'null'::jsonb));
  end if;
  -- the row lock first: a concurrent cb fail --to design or a second --repo edit cannot slip between these checks and
  -- the update (#3703: repos and parts change together)
  select * into cur from cb.tasks t where t.id = tid for update;
  if not found then raise exception 'task #% not found', tid; end if;
  -- #4559: giving a card a holder starts work outside a claim, so a project that gets no work refuses it from a session
  -- (clearing a holder is fine; Ahmed's dashboard may do both). A card moved into a disabled project lands and waits;
  -- into an archived one it is refused
  if fields ? 'project' and cb.resolve(fields ->> 'project') <> cur.project
     and (select pr.state from cb.projects pr where pr.slug = cb.resolve(fields ->> 'project')) = 'archived' then
    raise exception '%. Move it elsewhere, or ask Ahmed to unarchive it', cb._state_words(cb.resolve(fields ->> 'project'));
  end if;
  if not cb._is_dashboard() and nullif(trim(fields ->> 'assignee'), '') is not null and (fields ->> 'assignee') is distinct from cur.assignee
     and not cb._live(case when fields ? 'project' then cb.resolve(fields ->> 'project') else cur.project end) then
    raise exception '%', cb._wait_words(case when fields ? 'project' then cb.resolve(fields ->> 'project') else cur.project end);
  end if;
  rs := cur.repos;
  if fields ? 'repos' then
    -- repos lock from approval on: Ahmed approved a design for these repos, and builders may already work in them.
    -- Except once (#3703, digest group 13): a card at build or review that names no repo and has no parts (staged before
    -- its project had several repos) takes them; several only at build and unheld, which opens its parts.
    if cur.stage in ('approval', 'build', 'review', 'merge', 'qa') and cb._pipeline(cur.project) then
      if cur.stage not in ('build', 'review') or cardinality(coalesce(cur.repos, '{}')) > 0
         or exists (select 1 from cb.task_parts p where p.task_id = tid) then
        raise exception '#% is at %: repos lock once the design is passed; send it back with cb fail % --to design', tid, cb._stage_words(cur.stage), tid;
      end if;
      opn := cardinality(coalesce(cb._check_repos(case when fields ? 'project' then cb.resolve(fields ->> 'project') else cur.project end,
                                                  cb._repo_list(fields -> 'repos')), '{}')) > 1;
      if opn and cur.stage = 'review' then
        raise exception '#% is in review: give one repo, or send it back with cb fail % --to design', tid, tid;
      end if;
      -- the holder after this edit: one named in the same call counts
      if opn and nullif(trim(case when fields ? 'assignee' then fields ->> 'assignee' else cur.assignee end), '') is not null then
        raise exception '#% is held by %: give one repo, or free it first', tid,
          case when fields ? 'assignee' then fields ->> 'assignee' else cur.assignee end;
      end if;
    end if;
    rs := cb._check_repos(case when fields ? 'project' then cb.resolve(fields ->> 'project') else cur.project end, cb._repo_list(fields -> 'repos'));
  elsif fields ? 'project' and cb.resolve(fields ->> 'project') <> cur.project then
    rs := cb._check_repos(cb.resolve(fields ->> 'project'), cur.repos);  -- its repos must exist in the project it moves to
  end if;
  -- a parts card (#3703) is held by its parts at build and review, never as a card (clearing a holder is fine)
  if nullif(trim(fields ->> 'assignee'), '') is not null and cur.stage in ('build', 'review') and cb._pipeline(cur.project)
     and exists (select 1 from cb.task_parts p where p.task_id = tid) then
    raise exception '#% is built one part per repo: parts are claimed by each repo''s sessions', tid;
  end if;
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
    rank     = case when fields ? 'rank' then (fields ->> 'rank')::double precision else t.rank end,
    repos    = rs
  where t.id = tid;
  perform set_config('cb.note', '', true);
  if opn then
    perform cb._parts_open(tid);
    -- the card stays at build, so no stage change pushes the new parts: a note per part, by repo (cb.inbox next_work)
    insert into cb.events (actor, project, task_id, kind, summary, data)
    select coalesce(nullif(current_setting('cb.actor', true), ''), 'unknown'), t.project, tid, 'note',
           format('part %s opened at build', p.repo), jsonb_build_object('repo', p.repo)
      from cb.task_parts p join cb.tasks t on t.id = p.task_id where p.task_id = tid order by p.repo;
  end if;
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
  summary := cb.guest_text(a, summary);
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
declare a text := cb.set_actor(actor); p text := cb.read_project(project); tid bigint; st text; tproj text; rp text;
begin
  -- the order and the claim rules are cb.task_queue's (cb start previews it); the outer filters are re-checked on a row
  -- another claim changed while we waited, so they stay here
  select t.id, t.stage, t.project into tid, st, tproj from cb.task_queue(p, a, null) with ordinality as q join cb.tasks t on t.id = q.id
   where t.status = 'next' and (t.assignee is null or t.assignee = a)  -- never take a task queued for someone else
     and cb._claimable(t, a)  -- re-checked on the locked row: a restage meanwhile must not hand it to the wrong role
   order by q.ordinality limit 1
   for update of t skip locked;
  if tid is null then return; end if;
  -- a card with parts (#3703): claim the actor's repo part, never the card (it stays in Next: the parts carry the
  -- status). The where is the real guard: a part a claim took while this one waited is not taken again (nothing this
  -- once). Pipeline off: the card is claimed as a card.
  if st in ('build', 'review') and cb._pipeline(tproj) and exists (select 1 from cb.task_parts tp where tp.task_id = tid) then
    update cb.task_parts tp set status = 'in_progress', assignee = a, since = now(), nudged_at = null
     where tp.task_id = tid and tp.repo = cb._repo(a) and tp.stage = st and tp.status = 'next' and (tp.assignee is null or tp.assignee = a)
    returning tp.repo into rp;
    if rp is null then return; end if;
    perform cb._parts_sync(tid, format('claimed by %s (part %s)', a, rp), jsonb_build_object('repo', rp));
    return query select t.* from cb.tasks t where t.id = tid;
    return;
  end if;
  perform set_config('cb.note', 'claimed by ' || a, true);
  return query update cb.tasks t set status = 'in_progress', assignee = a where t.id = tid returning t.*;
  perform set_config('cb.note', '', true);
end $$;

-- My open tasks, plus anything of mine that changed in the last 24h, so a
-- cancelled or reassigned task is seen at least once. Open ones come first (#4452): by status alone, text order put
-- [cancelled] and [done] ahead of [in_progress], and a session read closed work as its own.
create function cb.mine(actor text default null)
returns setof cb.tasks language plpgsql as $$
#variable_conflict use_variable
declare a text := coalesce(nullif(trim(actor), ''), nullif(current_setting('cb.actor', true), ''), 'unknown');
begin
  -- a card whose part a holds (#3703) shows as a's, at the part's stage and status (as cb.resume shows it)
  return query select (w.v).* from (
    select case when h.repo is null then t
                else jsonb_populate_record(t, jsonb_build_object('status', h.status, 'stage', h.stage, 'assignee', a)) end as v
      from cb.tasks t
      left join lateral (select x.repo, x.stage, x.status from cb._held_parts() x where x.task_id = t.id and x.assignee = a
                          order by x.repo limit 1) h on true
     where (t.assignee = a
            and (t.status not in ('done', 'cancelled') or t.updated_at > now() - interval '24 hours'))
        or (t.assignee is distinct from a and exists (
              select 1 from cb.events e where e.task_id = t.id and e.data -> 'assignee' ->> 'from' = a
                 and e.at > now() - interval '24 hours'))
        or h.repo is not null) w
   order by ((w.v).assignee is distinct from a or (w.v).status in ('done', 'cancelled')), (w.v).status, (w.v).priority, (w.v).rank;
end $$;

-- ---------------------------------------------------------------- questions

drop function if exists cb.questions_history cascade;
alter table cb.questions add column if not exists assigned_to text references cb.users(name) on update cascade on delete set null;
alter table cb.questions add column if not exists answered_by text;
-- Pictures on a question: "it looks like this now", "this is how it looks after the change". Kept in the board's own
-- database (it already holds client work, so no new place), read only through the server's signed-in route.
create table if not exists cb.question_images (
  id          bigint generated always as identity primary key,
  question_id bigint not null references cb.questions(id) on delete cascade,
  ord         int not null,
  caption     text,
  mime        text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  data        bytea not null,
  created_at  timestamptz not null default now()
);
create index if not exists question_images_q on cb.question_images (question_id, ord);
drop function if exists cb.ask cascade;
drop function if exists cb._image_mime cascade;
drop function if exists cb.question_image_add cascade;
drop function if exists cb.user_add cascade;
drop function if exists cb.user_rotate cascade;
drop function if exists cb.user_remove cascade;
drop function if exists cb._user_hand_back cascade;
drop function if exists cb._handed_back cascade;
drop function if exists cb.user_project_add cascade;
drop function if exists cb.user_project_remove cascade;
drop function if exists cb.user_password cascade;
drop function if exists cb.user_set_role cascade;
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
drop function if exists cb._skipped cascade;
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
              jsonb_build_object('blocking', new.blocking, 'options', new.options)
              -- who opened it: not the asker, so cb._board_active does not read it as the asker's own write (#4341)
              || case when tg_op = 'INSERT' then '{}'::jsonb else jsonb_build_object('opened_by', a) end);
    end if;
  elsif new.status = 'answered' and (old.status <> 'answered' or new.answer is distinct from old.answer) then
    insert into cb.events (actor, project, task_id, question_id, kind, summary, data)
    values (a, new.project, new.task_id, new.id, 'answered', left(new.answer, 120),
            jsonb_build_object('edited', old.status = 'answered')
              || case when new.answer_history is null then '{}'::jsonb
                      else jsonb_build_object('changed', true, 'was', new.answer_history -> -1 ->> 'answer') end);
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
  -- #4559: nothing new is asked in a project that gets no work. The design-approval question cb.stage_pass asks for a
  -- design passed while wrapping up is the one exemption (it sets cb.ask_internal around its call)
  if not cb._live(p) and current_setting('cb.ask_internal', true) is distinct from 'on' then
    raise exception '%: nothing is asked there until Ahmed enables it. Write where you stopped with cb log <card> "..."', cb._state_words(p);
  end if;
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

-- A picture's type, from its first bytes (never from a file name or a caller's say-so): the server serves it with
-- this type, so a file that only claims to be a PNG can't reach the page as HTML or script. null: not a picture we take.
create function cb._image_mime(data bytea) returns text language sql immutable as $$
  select case
    when substring(data from 1 for 8) = '\x89504e470d0a1a0a'::bytea then 'image/png'
    when substring(data from 1 for 3) = '\xffd8ff'::bytea then 'image/jpeg'
    when substring(data from 1 for 4) = '\x47494638'::bytea then 'image/gif'
    when substring(data from 1 for 4) = '\x52494646'::bytea and substring(data from 9 for 4) = '\x57454250'::bytea then 'image/webp'
  end
$$;

-- One picture on a question its asker is still shaping (open, dormant or sent back), in the order given; caption is
-- what it shows ("Now", "After"). replace_all clears the question's pictures first: new pictures on a reask replace
-- the old ones, as new -o replace the options. At most 6 a question, 5 MB each.
create function cb.question_image_add(id text, data bytea, caption text default null, replace_all boolean default false,
                                      actor text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(regexp_replace(trim(coalesce(id, '')), '^[qQ]', '')); a text := cb.set_actor(actor);
        q cb.questions; m text := cb._image_mime(data); n int; iid bigint;
begin
  select * into q from cb.questions x where x.id = qid for update;
  if q.id is null then raise exception 'question Q% not found', qid; end if;
  if a <> q.asked_by then raise exception 'Q% was asked by %: only its asker adds pictures to it', qid, q.asked_by; end if;
  if q.status not in ('open', 'dormant', 'sent_back') then
    raise exception 'Q% is already %: pictures go on a question still waiting for its answer, so ask a new one', qid, q.status;
  end if;
  if coalesce(octet_length(data), 0) = 0 then raise exception 'the picture is empty'; end if;
  if octet_length(data) > 5 * 1024 * 1024 then
    raise exception 'the picture is % MB, 5 MB at most: crop it to what matters, or save it as JPEG', round(octet_length(data) / 1048576.0, 1);
  end if;
  if m is null then raise exception 'not a PNG, JPEG, WebP or GIF picture: save it as one of those'; end if;
  if coalesce(replace_all, false) then delete from cb.question_images i where i.question_id = qid; end if;
  select count(*) into n from cb.question_images i where i.question_id = qid;
  if n >= 6 then raise exception 'Q% already has 6 pictures, the most one question carries', qid; end if;
  insert into cb.question_images (question_id, ord, caption, mime, data)
  values (qid, n + 1, nullif(trim(caption), ''), m, data) returning cb.question_images.id into iid;
  perform pg_notify('cb', 'questions'); -- open pages re-read the question and show the picture
  return iid;
end $$;

-- Options as stored: jsonb array of strings or {label, description} -> [{label, description}].
create function cb._options(options jsonb) returns jsonb language sql immutable as $$
  select jsonb_agg(case when jsonb_typeof(o) = 'string' then jsonb_build_object('label', o #>> '{}', 'description', null)
                        else jsonb_build_object('label', o ->> 'label', 'description', o ->> 'description') end order by i)
    from jsonb_array_elements(options) with ordinality as e(o, i)
$$;

-- Editable until delivered; after that a change is a correction (#1346), from the dashboard only (the server sends a
-- guest's there once it has checked the question is theirs): the told answer moves to answer_history and the question
-- is answered again, delivered as a change. The same answer again changes nothing. ruled_by (M12): "Already ruled" (#553): the answer is that live memory entry, so the asking
-- session gets the rule itself; questions.ruled_by keeps the link for the weekly metric. A typed answer clears it.
create function cb.answer(id text, answer text default null, actor text default 'ahmed', ruled_by text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
-- no cb.memories row type: it is created further down
declare qid bigint := cb.norm_id(id); cur text; a text; par bigint; qp text; rid bigint; rst text; rp text; stale boolean; asker text; prev text; appr bigint;
begin
  a := cb.set_actor(actor);
  select q.status, q.parent_id, q.project, q.asked_by, q.answered_by, q.approval_for into cur, par, qp, asker, prev, appr from cb.questions q where q.id = qid for update;
  if cur is null then raise exception 'question Q% not found', qid; end if;
  -- a design approval is Ahmed's, from the dashboard (squad pipeline, #3598)
  if appr is not null and not (cb.ahmed_like(a) and current_setting('application_name') = 'cb-web') then
    raise exception 'only Ahmed approves designs, from the board';
  end if;
  if nullif(trim(ruled_by), '') is not null then
    perform cb.dashboard_only('Today');  -- the metric counts Ahmed's "Already ruled", and the answer carries his authority
    select x.id, x.status, x.project, coalesce(x.review_after < current_date, false),
           'Already ruled: M' || x.id || ' ' || x.title || coalesce(' — ' || nullif(left(x.body, 500), ''), '')
      into rid, rst, rp, stale, answer from cb.memories x where x.id = cb.norm_mem(ruled_by);
    if rst <> 'active' then raise exception 'M% is %: only a live entry answers a question', rid, rst; end if;
    if stale then raise exception 'M% is past its review date: renew it on the Memory page first', rid; end if;
    if rp is not null and rp <> qp then raise exception 'M% is in %, not %: only a global entry or one in Q%''s project', rid, rp, qp, qid; end if;
  end if;
  answer := cb.guest_text(a, answer);
  if coalesce(trim(answer), '') = '' then raise exception 'answer is required'; end if;
  if cur = 'withdrawn' then raise exception 'question Q% is already withdrawn', qid; end if;
  if cur = 'delivered' then
    if current_setting('application_name') <> 'cb-web' then
      raise exception 'question Q% is already delivered: only Ahmed (or the person it is for) can change it, on the dashboard', qid;
    end if;
    -- a guest corrects their own answer, never Ahmed's (or another's) on a question handed to them
    if not cb.ahmed_like(a) and a is distinct from prev then
      raise exception 'Q% was answered by %: only they or Ahmed can change it', qid, coalesce(prev, 'someone else');
    end if;
    if exists (select 1 from cb.questions q where q.id = qid and q.answer = trim(answer)) then return; end if;
    update cb.questions q set status = 'answered',
           answer_history = coalesce(q.answer_history, '[]') || jsonb_build_array(jsonb_build_object('answer', q.answer,
             'answered_by', q.answered_by, 'answered_at', q.answered_at, 'delivered_at', q.delivered_at,
             'delivered_to', q.delivered_to, 'changed_at', now(), 'changed_by', a)),
           answer = trim(answer), answered_at = now(), answered_by = a, ruled_by = rid, delivered_at = null, delivered_to = null
     where q.id = qid;
    perform cb._followups_route(qid);
    perform cb._approval_answered(qid);
    return;
  end if;
  if cur = 'dormant' then raise exception 'Q% waits on Q%: it opens when that one is answered', qid, par; end if;
  if cur = 'sent_back' then raise exception 'Q% was sent back to %: it comes back when they rewrite it', qid, asker; end if;
  -- Ahmed's answer is his until delivered too: a guest (or session) answering after him would overwrite it
  if cur = 'answered' and cb.ahmed_like(prev) and not cb.ahmed_like(a) then
    raise exception 'Q% was answered by Ahmed: only he can change it', qid;
  end if;
  update cb.questions q set status = 'answered', answer = trim(answer), answered_at = now(), answered_by = a, ruled_by = rid where q.id = qid;
  perform cb._followups_route(qid);  -- first answer or a change: the follow-ups follow it
  perform cb._approval_answered(qid);
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

-- Did Q pid's delivery skip follow-up Q qid (or one above it)? Its last withdrawal says so (cb._dormant_withdraw's note).
create function cb._skipped(qid bigint, pid bigint) returns boolean language sql stable as $$
  select coalesce((select e.summary from cb.events e where e.question_id = qid and e.kind = 'withdrawn' order by e.id desc limit 1)
                  like 'skipped: Q' || pid || ' answered %', false)
$$;

-- Q pid's answer is new or changed (not delivered yet): its follow-ups follow it.
--  - open, unanswered follow-ups it no longer picks go back to dormant, and give back the task they held;
--  - dormant follow-ups it picks (or with no if_answer) open, asked now so they sort fresh; blocking ones hold the task;
--  - a follow-up it no longer picks that is already answered refuses the change (withdraw it first).
-- The rest stay dormant until the answer is delivered (cb.answer_delivered skips them).
-- A correction (#1346: the session was told an earlier answer, answer_history): what the told answer opened stays as it
-- is (the session withdraws what is moot); a branch it skipped at delivery that the new answer picks comes back, with
-- its skipped follow-ups dormant under it. One withdrawn otherwise (by its session) stays withdrawn.
create function cb._followups_route(pid bigint) returns void language plpgsql as $$
#variable_conflict use_variable
declare par cb.questions; picked text[]; c record; t cb.tasks; h jsonb; live bigint; lv bigint[]; opened bigint[] := '{}';
begin
  select * into par from cb.questions q where q.id = pid;
  picked := cb._picked(par.options, par.answer, par.multi);
  if par.answer_history is not null then
    -- what this correction opened so far (answer_history's last entry, the told answer, keeps it): edited again, the
    -- ones it no longer picks wait again below, as an undelivered answer's do
    opened := array(select x::bigint from jsonb_array_elements_text(coalesce(par.answer_history -> -1 -> 'opened', '[]')) x);
    lv := array(select x.id from cb.questions x where x.parent_id = pid and x.status = 'withdrawn' and x.if_answer = any(picked)
                  and cb._skipped(x.id, pid));
    while cardinality(lv) > 0 loop
      update cb.questions x set status = 'dormant' where x.id = any(lv);
      lv := array(select x.id from cb.questions x where x.parent_id = any(lv) and x.status = 'withdrawn' and cb._skipped(x.id, pid));
    end loop;
  end if;
  select q.id, q.if_answer, q.status into c from cb.questions q
   where q.parent_id = pid and q.status in ('answered', 'delivered') and q.if_answer is not null and q.if_answer <> all(picked)
     and par.answer_history is null
   order by q.id limit 1;
  if found then
    raise exception 'Q% (the "%" follow-up) is already %; %', c.id, c.if_answer, c.status,
      case when c.status = 'answered' then 'withdraw it first (cb withdraw Q' || c.id || ') to change the answer to Q' || pid
           else 'the answer to Q' || pid || ' can no longer change' end;
  end if;

  perform set_config('cb.note', 'waiting again: Q' || pid || ' now answered ' || left(par.answer, 100), true);
  for c in update cb.questions q set status = 'dormant', sent_back = null
            where q.parent_id = pid and q.status in ('open', 'sent_back') and q.if_answer is not null and q.if_answer <> all(picked)
              and (par.answer_history is null or q.id = any(opened))
            returning q.id, q.hold_before loop
    h := c.hold_before;
    continue when h is null;
    -- put the task back as it was before this follow-up took it; a question that held it then and has since been
    -- delivered or withdrawn no longer holds it (released as its delivery would have)
    -- a correction (#1346) is answered again, but its task was released at its first delivery: it holds nothing
    live := (select x.id from cb.questions x where x.id = (h ->> 'blocked_on')::bigint and x.status in ('open', 'answered', 'sent_back')
               and x.answer_history is null);
    perform set_config('cb.note', 'Q' || c.id || ' waits again: back as before it asked', true);
    update cb.tasks x set blocked_on = live,
           status = case when live is not null then 'blocked'
                         when h ->> 'blocked_on' is null then
                           case when h ->> 'status' = 'in_progress' and not cb._live(x.project) then 'next' else h ->> 'status' end
                         when cardinality(cb._waits_on(x.id)) > 0 then 'blocked'
                         else cb._freed_status(x.assignee, x.project) end
     where x.id = (h ->> 'task')::bigint and x.blocked_on = c.id and x.status = 'blocked';
  end loop;
  perform set_config('cb.note', '', true);

  for c in update cb.questions q set status = 'open', created_at = now(), hold_before = null, sent_back = null
            where q.parent_id = pid and q.status = 'dormant' and (q.if_answer is null or q.if_answer = any(picked))
            returning q.id, q.blocking, q.task_id loop
    opened := opened || c.id;
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
  if par.answer_history is not null then
    update cb.questions q set answer_history = jsonb_set(q.answer_history, '{-1,opened}',
             to_jsonb(array(select x.id from cb.questions x where x.id = any(opened) and x.status in ('open', 'sent_back') order by x.id)))
     where q.id = pid;
  end if;
end $$;

create function cb.withdraw(id text, actor text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(id);
begin
  perform cb.set_actor(actor);
  perform cb._approval_guard(qid);
  if not cb._is_dashboard() and exists (select 1 from cb.questions q where q.id = qid and q.status = 'answered' and q.answer_history is not null) then
    raise exception 'Q% has a changed answer on its way to you: take it (cb pending) instead of withdrawing it', qid;
  end if;
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
  update cb.tasks t set status = cb._freed_status(t.assignee, t.project)
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
        n text := nullif(trim(regexp_replace(coalesce(cb.guest_text(a, note), ''), '[\s\u0085\u2028\u2029]+', ' ', 'g')), ''); cur text; hit text;
begin
  perform cb.dashboard_only('Today');
  perform cb._approval_guard(qid);
  if length(n) > 500 then raise exception 'the note is at most 500 characters (this one is %)', length(n); end if;
  hit := cb._sensitive(n);
  if hit is not null then
    raise exception 'that looks like %; the note goes to a session: say where the value lives, not the value', hit;
  end if;
  -- visual: "show me": the asker asks again with pictures of what it looks like now and after (cb reask --image)
  if r not in ('details', 'clarify', 'simplify', 'reask', 'visual') then
    raise exception '"%" is not a reason: details, clarify, simplify, reask or visual', trim(coalesce(reason, ''));
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
        -- new pictures: added in this same transaction, just before (cb reask -i). now() is the transaction's start,
        -- so a picture's created_at equals it only if it was added in this transaction: read from the rows, never a flag.
        pictures boolean := exists (select 1 from cb.question_images i where i.question_id = qid and i.created_at = now());
begin
  select * into q from cb.questions x where x.id = qid for update;
  if q.id is null then raise exception 'question Q% not found', qid; end if;
  if not cb._is_dashboard() and a <> q.asked_by then
    raise exception 'only Q%''s asker (%) or Ahmed can rewrite it', qid, q.asked_by;
  end if;
  if q.status not in ('open', 'sent_back') then
    raise exception 'Q% is %: only an open or sent-back question can be rewritten', qid, q.status;
  end if;
  -- #4621: as cb.ask: nothing is asked in a project that gets no work, and a rewrite asks again
  if not cb._live(q.project) then
    raise exception '%: nothing is asked there until Ahmed enables it. Write where you stopped with cb log <card> "..."', cb._state_words(q.project);
  end if;
  if q.sent_back ->> 'reason' = 'visual' and not pictures and not cb._is_dashboard() then
    raise exception 'Q% was sent back with "Show me": rewrite it with pictures (cb reask Q% -i "Now=<screenshot>" -i "After=<mockup>"). No way to make one? cb withdraw Q% and ask again saying why', qid, qid, qid;
  end if;
  if b is null and options is null and not fr and multi is null and context is null and not pictures then
    raise exception 'nothing to rewrite: give the new question, -o options, --free, --multi, -c context or -i pictures';
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
                                   when 'simplify' then 'simplified' when 'reask' then 'new options'
                                   when 'visual' then 'with pictures' end || ')', '')
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
-- again) since is left as it is, quietly. answered_at (#1346), likewise: the answer it pushed; one changed since is
-- left answered, and the next push carries it. Without it (cb delivered), the answer as it is now.
create function cb.answer_delivered(id text, delivered_to text default null, actor text default null, sent_back_at text default null,
                                    answered_at text default null)
returns void language plpgsql as $$
#variable_conflict use_variable
declare qid bigint := cb.norm_id(id); cur text; ans text; at_ timestamptz;
begin
  perform cb.set_actor(actor);
  select q.status, q.answer, q.answered_at into cur, ans, at_ from cb.questions q where q.id = qid for update;
  if cur is null then raise exception 'question Q% not found', qid; end if;
  if cur = 'delivered' then return; end if;
  if cur = 'sent_back' then  -- the asker was told (#616); the question waits for its rewrite and keeps holding its task
    update cb.questions q set sent_back = q.sent_back || jsonb_build_object('delivered_at', now(), 'delivered_to', delivered_to)
     where q.id = qid and q.sent_back ->> 'delivered_at' is null and (sent_back_at is null or q.sent_back ->> 'at' = sent_back_at);
    return;
  end if;
  if sent_back_at is not null then return; end if;
  if cur <> 'answered' then raise exception 'question Q% is %, not answered', qid, cur; end if;
  if answered_at is not null and at_ is distinct from answered_at::timestamptz then return; end if;
  update cb.questions q set status = 'delivered', delivered_at = now(), delivered_to = delivered_to where q.id = qid;
  -- the answer is final now: follow-ups it did not pick are skipped, down the chain
  perform cb._dormant_withdraw(array(select q.id from cb.questions q where q.parent_id = qid and q.status = 'dormant'),
                               'skipped: Q' || qid || ' answered ' || left(ans, 100));
  -- a correction (#1346): its task was released when the first answer was delivered; what holds it now is not this
  if exists (select 1 from cb.questions q where q.id = qid and q.answer_history is not null) then return; end if;
  -- the blockers lock (see cb.tasks_unblock) before deciding: a blocker finishing at the same moment either has
  -- committed (the statements below see it) or waits for this transaction and then sees blocked_on cleared
  perform pg_advisory_xact_lock(hashtext('cb.blockers:' || x.project))
     from (select distinct t.project from cb.tasks t where t.blocked_on = qid order by 1) x;
  -- still waiting on a task (see cb.task_blockers): the question no longer holds it, the blocker does
  perform set_config('cb.note', 'Q' || qid || ' answered; still waits on its blocking tasks', true);
  update cb.tasks t set blocked_on = null where t.blocked_on = qid and t.status = 'blocked' and cardinality(cb._waits_on(t.id)) > 0;
  perform set_config('cb.note', 'unblocked: Q' || qid || ' answered', true);
  update cb.tasks t set status = cb._freed_status(t.assignee, t.project)
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
  -- #4559: a project that gets no work says so first (disabled: its words; absent while enabled). With no project
  -- given, such projects are left out (cb._brief_tasks too)
  return case when p is not null and not cb._live(p) then jsonb_build_object('disabled', cb._wait_words(p)) else '{}'::jsonb end
   || jsonb_build_object(
    'in_progress', cb._brief_tasks(p, tg, 'in_progress', 50, ty),
    'next', cb._brief_tasks(p, tg, 'next', 10, ty),
    'blocked', cb._brief_tasks(p, tg, 'blocked', 50, ty),
    'review', cb._brief_tasks(p, tg, 'review', 50, ty),
    'open_questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'project', q.project, 'body', q.body,
        'blocking', q.blocking, 'asked_by', q.asked_by, 'task_id', q.task_id, 'options', q.options, 'assigned_to', q.assigned_to) order by q.blocking desc, q.id)
      from cb.questions q where q.status = 'open' and (q.project = p or (p is null and cb._live(q.project)))), '[]'),
    'answered_pending', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'project', q.project, 'body', q.body,
        'answer', q.answer, 'asked_by', q.asked_by, 'reply_to', q.reply_to, 'task_id', q.task_id,
        'was', q.answer_history -> -1 ->> 'answer') order by q.id)
      from cb.questions q where q.status = 'answered' and (q.project = p or (p is null and cb._live(q.project)))), '[]'),
    'broadcasts', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'project', e.project, 'summary', e.summary, 'at', e.at)
                                               order by e.id desc)
      from cb.events e where e.kind = 'broadcast' and e.at > now() - interval '24 hours'
                         and (p is null or e.project is null or e.project = p)), '[]'),
    'goals', cb.goals_list(p),  -- active goals for this project and every-project ones, in order
    'memory', cb.mem_pack(p));  -- no project: the global entries only
end $$;

drop function if exists cb._brief_tasks cascade;
-- stage (#4340): a card's pipeline stage, as cb.tick's prs list gives it (null when unstaged or the pipeline is off), so a
-- reader of Next tells build work from a card already merged (merge) or on dev (qa). plpgsql: the stage column and
-- cb._pipeline are created further down this file, and a sql function's body is checked when it is created.
create function cb._brief_tasks(p text, tg text, s text, lim int, ty text default null) returns jsonb language plpgsql stable as $$
begin
  return (select coalesce(jsonb_agg(to_jsonb(x) - 'o' order by x.o), '[]') from (
    select t.id, t.project, t.title, t.priority, t.assignee, t.updated_at, t.blocked_on, t.rank, t.labels, t.type,
           t.epic_id, cb._waits_on(t.id) as waits_on,
           case when cb._pipeline(t.project) then t.stage end as stage,
           case when cb._pipeline(t.project) and t.stage is not null then cb._stage_words(t.stage) end as stage_words,
           -- #4454: why a Blocked card waits when no question or card holds it. block_note = the note given with
           -- cb move <id> blocked "<why>" on its newest move there, a restatement on a card already blocked included
           -- (a note event task_move marks with to; cb.tick's blocked list reads the same); null when that move had no
           -- note (the summary is then "<from> → blocked"). last_note = its newest note, shown in its place as a note
           case when t.status = 'blocked' then (select nullif(e.summary, (e.data ->> 'from') || ' → blocked') from cb.events e
                 where e.task_id = t.id and e.kind in ('moved', 'note') and e.data ->> 'to' = 'blocked' order by e.id desc limit 1) end as block_note,
           case when t.status = 'blocked' then (select e.summary from cb.events e
                 where e.task_id = t.id and e.kind = 'note' order by e.id desc limit 1) end as last_note,
           row_number() over (order by t.priority <> 'P0', case when t.priority <> 'P0' then cb._goal_rank(t.id) end nulls last,
                                       t.priority, t.rank, t.id) as o
      from cb.tasks t where t.status = s and (t.project = p or (p is null and cb._live(t.project))) and (tg is null or tg = any(t.labels))
                        and (ty is null or t.type = ty)
     order by o limit lim) x);
end $$;

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

-- The name a pane's row has before any cb iam: <pane>@<machine>. A pane or machine named like ahmed must not make a
-- session named like him. Positional: m is the machine already lower-cased and trimmed.
create function cb._seat_name(m text, pane text) returns text language sql stable as $$
  select case when cb.ahmed_like($2 || '@' || $1) then 'session-' || left(md5($2 || '@' || $1), 8) else $2 || '@' || $1 end
$$;

-- Bind a session (machine + herdr pane) to an actor. Machine names compare case-insensitively.
create function cb.iam(machine text, pane text, actor text, project text default null, role text default null, area text default null, model text default null, repo text default null, agent text default null) returns text language plpgsql as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);  -- unknown project raises; null keeps the session's current one
        ar text := nullif(cb.norm_tag(area), '');
        mo text := nullif(trim(model), '');
        rp text := nullif(trim(repo), '');
        ag text := nullif(trim(agent), '');  -- the CLI the session runs (#4002); null: claude, or what it said before
        pp text; held record; eff text;
begin
  if ag is not null and ag not in ('claude', 'codex', 'opencode', 'agy') then
    raise exception 'agent must be one of claude, codex, opencode, agy (got %)', ag;
  end if;
  -- the repo is one of the project's (a one-repo project: main)
  if rp is not null then
    pp := coalesce(p, (select s.project from cb.sessions s where s.machine = lower(trim(machine)) and s.pane = trim(pane)));
    if pp is null then raise exception 'a repo needs a project: cb iam <name> <project> --repo %', rp; end if;
    perform cb._check_repos(pp, array[rp]);
  end if;
  if role is not null and role not in ('lead','architect','owner','builder','reviewer','qa','investigator') then
    raise exception 'role must be one of lead, architect, owner, builder, reviewer, qa, investigator (got %)', role;
  end if;
  if coalesce(trim(actor), '') = '' or coalesce(trim(pane), '') = '' then raise exception 'pane and actor are required'; end if;
  perform cb.not_ahmed(actor);
  -- #4559: no new seat binds to a project that gets no work; the same name on a pane already bound to it keeps its
  -- binding (a re-bind after a compaction included), and a call that names no project keeps the pane's. Another name
  -- there is a new seat (#4621)
  select s.project, s.actor into held from cb.sessions s where s.machine = lower(trim(machine)) and s.pane = trim(pane);
  eff := coalesce(p, held.project);
  if not cb._live(eff) and (held.project is distinct from eff or held.actor is distinct from trim(actor)) then
    raise exception '%: no new seat binds to it until Ahmed enables it', cb._state_words(eff);
  end if;
  -- a new session starts from now: it never gets broadcasts or messages sent before it existed
  insert into cb.sessions (machine, pane, actor, project, broadcast_seen, role, area, model, repo, agent)
  values (lower(trim(machine)), trim(pane), trim(actor), p, coalesce((select max(e.id) from cb.events e), 0), role, ar, mo, rp, coalesce(ag, 'claude'))
  on conflict on constraint sessions_pkey do update
    set actor = excluded.actor, project = coalesce(excluded.project, cb.sessions.project), started_at = now(), last_seen = now(),
        -- the same name re-binding keeps what it said before; a pane taken over by another actor starts clean
        role = case when excluded.actor = cb.sessions.actor then coalesce(excluded.role, cb.sessions.role) else excluded.role end,
        area = case when excluded.actor = cb.sessions.actor then coalesce(excluded.area, cb.sessions.area) else excluded.area end,
        model = case when excluded.actor = cb.sessions.actor then coalesce(excluded.model, cb.sessions.model) else excluded.model end,
        -- ag, not excluded.agent: the insert filled claude in, so excluded cannot say "not given"
        agent = case when excluded.actor = cb.sessions.actor then coalesce(ag, cb.sessions.agent) else coalesce(ag, 'claude') end,
        -- a repo belongs to its project: moving to another project drops it
        repo = case when excluded.actor = cb.sessions.actor and coalesce(excluded.project, cb.sessions.project) is not distinct from cb.sessions.project
                    then coalesce(excluded.repo, cb.sessions.repo) else excluded.repo end,
        -- a pane taken over by another name starts from now, as a new row does (#4379); the first bind after the
        -- relay's own row (still its pane@machine name) keeps that row's mark, set when the relay started
        broadcast_seen = case when excluded.actor = cb.sessions.actor or cb.sessions.actor = cb._seat_name(lower(trim(machine)), trim(pane))
                              then cb.sessions.broadcast_seen else excluded.broadcast_seen end,
        -- #3221: a held window belongs to the mark above: it starts clean with it
        hold_from = case when excluded.actor = cb.sessions.actor or cb.sessions.actor = cb._seat_name(lower(trim(machine)), trim(pane))
                         then cb.sessions.hold_from end,
        hold_at = case when excluded.actor = cb.sessions.actor or cb.sessions.actor = cb._seat_name(lower(trim(machine)), trim(pane))
                       then cb.sessions.hold_at end,
        -- the relay's next check takes its session id as it is (#4379): the session that bound may be one its relay
        -- has not seen yet, and must not be reset to the relay's own name a moment after it bound
        session_id = null,
        running_model = null; -- #4786: what ran before this bind says nothing about now; the relay reads it again
  -- a name binding again is a new session: a closing mark the supervisor left on its old rows no longer applies (#3601)
  update cb.sessions s set closing_at = null where s.actor = trim(actor) and s.closing_at is not null;
  return trim(actor);
end $$;

-- A person, not a session: the owner, or a signed-in user acting under their own name.
create function cb._person(a text) returns boolean language sql stable as $$
  select a = 'ahmed' or exists (select 1 from cb.users u where u.name = a)
$$;

-- What the relay pushes into a session: answers addressed to its pane, and changes other people
-- made to its actor's tasks (moves, edits, done, notes) after event `after_event`.
-- session: the agent session the relay serves (#4379; Claude: its session id), or null when its agent names none.
create function cb.inbox(machine text, pane text, after_event bigint default 0, session text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare m text := lower(trim(machine)); sid text := nullif(trim(session), ''); me text; proj text; seen bigint; myrepo text; am_lead boolean; ag text;
        hf bigint; ha timestamptz;
begin
  -- a new session (relay before cb iam) starts from now; until it joins a project it hears no broadcasts.
  -- #4379: so does another session in a reused pane id. A session id other than the row's is not the row's session:
  -- the row starts again as the relay's own (its name, no project or role, broadcasts from now). The same id (the PC
  -- woke up, the relay restarted), no id, or a row with none yet (from before #4379, or a cb iam since) keep it.
  -- `sid <> ...` is null, so keeps, when either side is null.
  insert into cb.sessions (machine, pane, actor, broadcast_seen, session_id)
  values (m, pane, cb._seat_name(m, pane), coalesce((select max(e.id) from cb.events e), 0), sid)
  on conflict on constraint sessions_pkey do update
    set last_seen = now(), session_id = coalesce(sid, cb.sessions.session_id),
        actor = case when sid <> cb.sessions.session_id then excluded.actor else cb.sessions.actor end,
        project = case when sid <> cb.sessions.session_id then null else cb.sessions.project end,
        role = case when sid <> cb.sessions.session_id then null else cb.sessions.role end,
        area = case when sid <> cb.sessions.session_id then null else cb.sessions.area end,
        model = case when sid <> cb.sessions.session_id then null else cb.sessions.model end,
        running_model = case when sid <> cb.sessions.session_id then null else cb.sessions.running_model end,
        repo = case when sid <> cb.sessions.session_id then null else cb.sessions.repo end,
        broadcast_seen = case when sid <> cb.sessions.session_id then excluded.broadcast_seen else cb.sessions.broadcast_seen end,
        hold_from = case when sid <> cb.sessions.session_id then null else cb.sessions.hold_from end,
        hold_at = case when sid <> cb.sessions.session_id then null else cb.sessions.hold_at end,
        started_at = case when sid <> cb.sessions.session_id then now() else cb.sessions.started_at end,
        closing_at = case when sid <> cb.sessions.session_id then null else cb.sessions.closing_at end
  returning cb.sessions.actor, cb.sessions.project, cb.sessions.broadcast_seen, cb.sessions.agent, cb.sessions.hold_from, cb.sessions.hold_at
       into me, proj, seen, ag, hf, ha;
  myrepo := cb._repo(me);  -- once, not per event row (next_work)
  am_lead := cb._is_lead(me, proj);  -- once too (answer_copies)
  return jsonb_build_object(
    'actor', me,
    'project', proj, -- with actor: the binding the relay hands to cb (#3256)
    'agent', ag, -- the session's agent (#4002)
    -- #3221: the relay's held window (cb.relay_hold), its age on the board's clock; null: nothing held. The key's
    -- presence says the board keeps holds: a relay that does not see it delivers everything at once
    -- from: the cursor to read again from, no further back than 24 h (review M5: as messages; a seat down a day with a
    -- hold open does not replay older memory changes)
    'hold', case when hf is null then null
                 else jsonb_build_object('from', greatest(hf, coalesce((select e.id from cb.events e where e.at <= now() - interval '24 hours'
                                                                         order by e.at desc limit 1), 0)),
                                         'age_ms', floor(extract(epoch from now() - coalesce(ha, now())) * 1000)) end,
    'broadcasts', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'project', e.project, 'summary', e.summary,
                                                             'urgent', cb._person(e.actor)) order by e.id)
                              from cb.events e
                             where e.kind = 'broadcast' and e.id > seen and proj is not null and (e.project is null or e.project = proj)
                               -- 24 h, as messages and huddles: a reused pane id keeps the old row's broadcast_seen (#4343)
                               and e.at > now() - interval '24 hours'
                               and e.actor is distinct from me), '[]'),
    -- raw: Ahmed typing from the dashboard (cb.type_to); the relay hands it over as a plain prompt, no board wrapper
    -- notice (#3221): a routine board message the relay may hold (a digest, a stall or ping nudge); null for every
    -- other message, and for a digest that carries a new P0 or a supervisor problem (data.urgent)
    -- urgent (#3221): never held: marked so (a part freed off me, GitHub lines by Ahmed's login), or about a P0 card (a
    -- nudge's card, a job's card in data.task), its priority as it is now; (Q3128: a session's line may now wait the
    -- relay's settle window) a person's line (cb._person), or a direct question: a session's message with a ? that ends
    -- a sentence (a ? inside a URL is followed by text and does not count)
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'actor', e.actor, 'summary', e.summary,
                                                              'raw', e.actor = 'ahmed' and e.data ->> 'raw' = 'true',
                                                              'notice', case when e.data ->> 'urgent' = 'true' then null
                                                                             when e.data ? 'digest' then 'digest'
                                                                             when e.data ? 'nudge' then 'nudge' end,
                                                              'urgent', coalesce(e.data ->> 'urgent' = 'true', false)
                                                                        or cb._person(e.actor)
                                                                        or (e.actor not in ('board', 'github', 'runner', 'supervisor')
                                                                            and e.summary ~ '[?]($|[[:space:]]|[)"''])')
                                                                        or exists (select 1 from cb.tasks t where t.priority = 'P0'
                                                                                      and t.id = coalesce(e.task_id, case when e.data ->> 'task' ~ '^[0-9]{1,18}$'
                                                                                                                         then (e.data ->> 'task')::bigint end))) order by e.id)
                            from cb.events e
                           where e.kind = 'message' and e.data ->> 'to' = me and e.id > seen
                             and e.at > now() - interval '24 hours'), '[]'),
    -- the project's lead (cb._is_lead, as huddle admin) gets a copy of Ahmed's answers to its workers
    'answer_copies', coalesce((select jsonb_agg(jsonb_build_object('event_id', e.id, 'id', q.id, 'task_id', q.task_id, 'asked_by', q.asked_by, 'answered_by', q.answered_by,
                                                                   'body', q.body, 'answer', q.answer, 'was', e.data ->> 'was') order by e.id)
                                 from cb.events e join cb.questions q on q.id = e.question_id
                                where e.kind = 'answered' and am_lead and e.project = proj and not cb._pipeline(proj)  -- a pipeline lead gets cb.digest instead
                                  and q.asked_by <> me and e.id > seen and e.at > now() - interval '24 hours'), '[]'),
    -- new unassigned bugs filed in my project, if I triage it (cb.triagers: its lead, else everyone bound)
    'bugs', coalesce((select jsonb_agg(jsonb_build_object('event_id', e.id, 'id', t.id, 'project', t.project, 'title', t.title,
                                                          'body', t.body, 'priority', t.priority, 'actor', e.actor,
                                                          'urgent', cb._person(e.actor)) order by e.id)
                        from cb.events e join cb.tasks t on t.id = e.task_id
                       where e.kind = 'task_created' and t.type = 'bug' and t.assignee is null and t.status not in ('done', 'cancelled')
                         and t.project = proj and e.actor <> me and e.id > seen and e.at > now() - interval '24 hours'
                         and me = any(cb.triagers(proj))
                         and cb._live(proj)), '[]'),  -- #4559: no triage offers in a project that gets no work
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
                                                             'parent_answered_by', pq.answered_by,
                                                             'was', q.answer_history -> -1 ->> 'answer', 'answered_at', q.answered_at) order by q.id)
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
    -- urgent (Q3128): never held for the settle window: a P0 card, a person's line, or my card cancelled, blocked or
    -- taken off me (#3221 review M1: stop what you are doing)
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'task_id', e.task_id, 'kind', e.kind, 'summary', e.summary,
                                                            'actor', e.actor, 'title', t.title, 'status', t.status,
                                                            'urgent', coalesce(t.priority = 'P0' or cb._person(e.actor)
                                                                               or e.data ->> 'to' in ('cancelled', 'blocked')
                                                                               or e.data -> 'assignee' ->> 'from' = me, false)) order by e.id)
                          from cb.events e join cb.tasks t on t.id = e.task_id
                         where me is not null and e.id > after_event and e.actor <> me
                           and e.kind in ('task_created', 'moved', 'updated', 'done', 'note')
                           and (t.assignee = me or e.data -> 'assignee' ->> 'from' = me)), '[]'),
    -- New work in my project's Next (unassigned or mine), only while I have nothing in progress.
    -- A new unassigned bug goes to triage ('bugs') instead: one decision, not every idle worker racing for it.
    'next_work', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'priority', t.priority)
                                            order by t.priority <> 'P0', case when t.priority <> 'P0' then cb._goal_rank(t.id) end nulls last, t.priority, t.rank, t.id)
                             from cb.tasks t
                            where me is not null and proj is not null and t.project = proj and cb._offerable(t, me)
                              and not (select cb._busy(me))  -- once per call, not per card
                              and exists (select 1 from cb.events e where e.task_id = t.id and e.id > after_event and e.actor <> me
                                            and ((e.kind = 'task_created' and e.data ->> 'status' = 'next')
                                                 or (e.kind = 'moved' and e.data ->> 'to' = 'next')
                                                 -- a parts card (#3703) stays in Next while its parts move: its stage
                                                 -- changes, and changes to a part of my repo (sent back, freed), count
                                                 or (e.kind in ('updated', 'note') and exists (select 1 from cb.task_parts p where p.task_id = t.id)
                                                     and (e.data ? 'stage' or e.data ->> 'repo' = myrepo))))), '[]'),
    -- Shared memory changes (#553), same audience as broadcasts: bound sessions on the entry's project, every bound
    -- session for a global one, only that machine's for a machine-scoped one. Live on add, Ahmed's confirm, a
    -- supersede (one line naming the replacement: its add is skipped), a retire with its why. Never a proposal, a
    -- reject or a renew (none of those changed what sessions are told), and never back to the session that made it.
    'memory', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'action', e.data ->> 'action', 'actor', e.actor, 'memory', x.id,
                                                            'kind', x.kind, 'title', x.title,
                                                            'why', case when e.data ? 'why_flagged' then null else e.data ->> 'why' end,
                                                            'why_hidden', e.data ? 'why_flagged', 'urgent', cb._person(e.actor),
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
                                                                       and not coalesce((e.data ->> 'terminal')::boolean, false) -- #951: the session's own note
                                                                       and e.id > case when i.delivered then coalesce(i.last_reply, 0) else a.delivered_upto end))
                                        order by a.id)
                        from cb.asks a cross join lateral cb._ask_info(a.id) i
                       where me is not null and a.status = 'open' and a.to_actor = me
                         and (not i.delivered or (i.late and a.repushed_at is null))), '[]'),
    'last_event', (select coalesce(max(e.id), 0) from cb.events e));
end $$;

-- A message to one project's sessions, or (everyone, project null) to every session. Relays push it; cb brief lists
-- 24h. #4740 (Ahmed): the sender says which on purpose, so a forgotten project never reaches every session.
create function cb.broadcast(message text, project text default null, actor text default null, everyone boolean default false)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.read_project(project); new_id bigint;
begin
  if coalesce(trim(message), '') = '' then raise exception 'message is required'; end if;
  if (p is null) is distinct from coalesce(everyone, false) then
    raise exception 'say one scope: cb broadcast "<message>" --project <p> (that project''s sessions) or --all (every session)';
  end if;
  insert into cb.events (actor, project, kind, summary) values (a, p, 'broadcast', trim(message))
  returning cb.events.id into new_id;
  return new_id;
end $$;

create function cb.broadcast_seen(machine text, pane text, upto bigint) returns void language sql as $$
  -- positional: in a SQL function a bare "pane" would mean the column
  update cb.sessions s set broadcast_seen = greatest(s.broadcast_seen, $3)
   where s.machine = lower(trim($1)) and s.pane = $2
$$;

-- #3221: the relay starts a hold (from_event: the card-event cursor its held read used) or ends one (null, after the
-- flush). A hold already running keeps its cursor and its clock: the window counts from the first held notice.
create function cb.relay_hold(machine text, pane text, from_event bigint) returns void language sql as $$
  update cb.sessions s
     set hold_from = case when $3 is null then null else coalesce(s.hold_from, $3) end,
         hold_at = case when $3 is null then null else coalesce(s.hold_at, now()) end
   where s.machine = lower(trim($1)) and s.pane = $2
$$;

-- Add and remove tags in one call (the orchestrator tags work streams: ocr, tamarind, ...). Returns the new tags.
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

-- #4786: the relay's reading of the model on its agent's screen. The screen is the agent's own output: only a model id
-- is taken, anything else is ignored, and the reading is only ever shown
create function cb.seat_model(machine text, pane text, model text) returns void language plpgsql as $$
#variable_conflict use_variable
declare mo text := trim(coalesce(model, ''));
begin
  if mo !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then return; end if;
  update cb.sessions s set running_model = mo
   where s.machine = lower(trim(machine)) and s.pane = trim(pane) and s.running_model is distinct from mo;
end $$;

-- The model a seat really runs, where the board can tell: the relay's screen reading, else what the usage hook reported
-- for the pane's own session (Claude: the last finished turn's model). plpgsql: cb.session_usage is created further down
create function cb._running_model(m text, pn text) returns text language plpgsql stable as $$
begin
  return (select coalesce(s.running_model,
                          (select nullif(u.model, 'unknown') from cb.session_usage u where u.session_id = s.session_id and u.machine = s.machine))
            from cb.sessions s where s.machine = m and s.pane = pn);
end $$;

-- Another model than the one it was started with? The running id may say more (a date, an effort) than the launch one,
-- which may be an alias (sonnet) or carry a context mark ([1m]) the running id lacks. Either side unknown: not judged
create function cb._model_differs(launched text, running text) returns boolean language sql immutable as $$
  select coalesce(position(lower(regexp_replace(launched, '\[[^]]*\]$', '')) in lower(running)) = 0, false)
$$;

-- One row per session/worker: bound sessions (cb iam), plus anyone who acted or holds open work in
-- the last week. live = its relay checked in within 90s (relays poll every 30s).
-- jit off: the many per-actor subplans push the estimate past jit_above_cost, and LLVM compiling the plan took 2.2 of
-- every call's 2.3 s (2026-11-26; ~100 ms without). On tables this small JIT never pays back.
create function cb.sessions_overview(project text default null) returns jsonb language plpgsql stable set jit = off as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  return coalesce((select jsonb_agg(x.r order by (x.r ->> 'live') desc, x.r ->> 'actor') from (
    select jsonb_build_object(
      'actor', a.actor, 'project', s.project, 'machine', s.machine, 'pane', s.pane, 'last_seen', s.last_seen,
      'live', coalesce(s.last_seen > now() - interval '90 seconds', false),
      'role', case when cb._pipeline(s.project) then cb._role(a.actor) else s.role end, 'area', s.area, 'model', s.model,
      'running_model', cb._running_model(s.machine, s.pane),  -- #4786
      'model_differs', cb._model_differs(s.model, cb._running_model(s.machine, s.pane)),
      'agent', s.agent,  -- #4002; null for a worker with no session row
      'lead', cb._is_lead(a.actor, s.project),  -- #3771: the dashboard's lead is the board's (by role, #3746), not an orch@ name
      'doing', coalesce((select jsonb_agg(d.j order by d.at desc) from (
                           select jsonb_build_object('id', t.id, 'title', t.title, 'priority', t.priority, 'status', t.status) as j, t.updated_at as at
                             from cb.tasks t where t.assignee = a.actor and t.status in ('in_progress', 'blocked', 'review') and (p is null or t.project = p)
                           union all  -- a part in work (#3703), named by its repo
                           select jsonb_build_object('id', t.id, 'title', t.title, 'priority', t.priority, 'status', h.status, 'part', h.repo), t.updated_at
                             from cb._held_parts() h join cb.tasks t on t.id = h.task_id
                            where h.assignee = a.actor and h.status = 'in_progress' and t.assignee is distinct from a.actor and (p is null or t.project = p)) d), '[]'),
      'queued', (select count(*) from cb.tasks t where t.assignee = a.actor and t.status = 'next' and (p is null or t.project = p))
                + (select count(*) from cb._held_parts() h join cb.tasks t on t.id = h.task_id
                    where h.assignee = a.actor and h.status = 'next' and t.assignee is distinct from a.actor and (p is null or t.project = p)),
      'done_24h', (select count(*) from cb.tasks t where t.assignee = a.actor and t.status = 'done' and t.done_at > now() - interval '24 hours' and (p is null or t.project = p)),
      'open_questions', (select count(*) from cb.questions q where q.asked_by = a.actor and q.status = 'open' and (p is null or q.project = p)),
      'last', (select jsonb_build_object('at', e.at, 'kind', e.kind, 'summary', e.summary, 'task_id', e.task_id)
                 from cb.events e where e.actor = a.actor and (p is null or e.project = p) order by e.id desc limit 1)) as r
    from (
      select s2.actor from cb.sessions s2 where p is null or s2.project = p
      union select e.actor from cb.events e where e.at > now() - interval '7 days' and (p is null or e.project = p)
      union select t.assignee from cb.tasks t where t.assignee is not null and t.status not in ('done', 'cancelled') and (p is null or t.project = p)
      union select h.assignee from cb._held_parts() h join cb.tasks t on t.id = h.task_id where p is null or t.project = p
    ) a
    left join lateral (select * from cb.sessions s3 where s3.actor = a.actor order by s3.last_seen desc limit 1) s on true
    where a.actor is not null and a.actor not in ('ahmed', 'relay', 'unknown', 'board', 'supervisor', 'runner') and a.actor not in (select u.name from cb.users u)
    offset 0  -- #4353: a fence. Without it the planner copies r, every subquery above with it, into both sort keys
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

-- Ahmed typing into a session from the dashboard: arrives as an ordinary prompt, exactly his text, as if typed in its
-- terminal. Dashboard only (cb.dashboard_only), and the event is always his: no session can produce a raw line.
create function cb.type_to(to_actor text, message text, actor text default null) returns bigint language plpgsql as $$
#variable_conflict use_variable
declare new_id bigint; p text;
begin
  perform cb.dashboard_only('Sessions');
  perform cb.set_actor('ahmed');
  if coalesce(trim(message), '') = '' then raise exception 'message is required'; end if;
  select s.project into p from cb.sessions s where s.actor = to_actor order by s.last_seen desc limit 1;
  if not found then raise exception 'unknown session %: it appears once its relay has started', to_actor; end if;
  insert into cb.events (actor, project, kind, summary, data)
  values ('ahmed', p, 'message', message, jsonb_build_object('to', to_actor, 'raw', 'true'))
  returning cb.events.id into new_id;
  return new_id;
end $$;

-- "Why is this card not moving?" (Ahmed's opt-in, per card or in bulk, from the dashboard). While a pinged card is open (any
-- status but done or cancelled) and nothing has happened on it for an hour (its fields or any event but the board's own pings: a cb log note counts),
-- the board asks its assignee and its orchestrator every 30 minutes, until something happens. The server runs
-- cb.pings_due() every minute. The asks are ordinary messages from `board`; the relay delivers them like cb tell.
create table if not exists cb.task_pings (
  task_id bigint primary key references cb.tasks(id) on delete cascade,
  since timestamptz not null default now(),
  last_ping_at timestamptz
);

create function cb.task_ping_set(id text, enabled boolean, actor text default null) returns boolean language plpgsql as $$
#variable_conflict use_variable
declare tid bigint := cb.norm_id(id);
begin
  perform cb.dashboard_only('the card panel');
  perform cb.set_actor(actor);
  if not exists (select 1 from cb.tasks t where t.id = tid) then raise exception 'no task #%', tid; end if;
  if enabled then
    insert into cb.task_pings (task_id) values (tid) on conflict do nothing;
  else
    delete from cb.task_pings p where p.task_id = tid;
  end if;
  return enabled;
end $$;

-- The same, for many cards: the ids given (jsonb array), or every open card of a project. Done and cancelled cards are
-- skipped. Returns how many cards changed.
create function cb.task_ping_bulk(ids jsonb default null, project text default null, enabled boolean default true, actor text default null)
returns int language plpgsql as $$
#variable_conflict use_variable
declare n int;
begin
  perform cb.dashboard_only('the board');
  perform cb.set_actor(actor);
  if ids is null and coalesce(trim(project), '') = '' then raise exception 'say which cards: ids or a project'; end if;
  if enabled then
    with c as (
      insert into cb.task_pings (task_id)
      select t.id from cb.tasks t
       where t.status not in ('done', 'cancelled')
         and ((ids is not null and t.id in (select v::bigint from jsonb_array_elements_text(ids) v)) or (ids is null and t.project = project))
      on conflict do nothing returning 1)
    select count(*) into n from c;
  else
    with c as (
      delete from cb.task_pings p using cb.tasks t
       where t.id = p.task_id
         and ((ids is not null and t.id in (select v::bigint from jsonb_array_elements_text(ids) v)) or (ids is null and t.project = project))
      returning 1)
    select count(*) into n from c;
  end if;
  return n;
end $$;

-- Sends what is due, returns how many messages. A worker whose session has not checked in for 10 minutes is not pinged
-- (its messages would pile up and arrive in a heap): its orchestrator is, and told so.
create function cb.pings_due() returns int language plpgsql as $$
declare r record; o text; n int := 0; mins int; idle text; live boolean;
begin
  for r in
    select t.id, t.project, left(t.title, 80) as title, nullif(trim(t.assignee), '') as assignee, t.status,  -- unassigned cards hold '' as well as null; a title is cut: GitHub cards carry strangers' text
           -- #4559: quiet time counts from the project's last enable (state_at; greatest skips a null), so an enable is no burst
           t.stage, greatest(t.updated_at, coalesce((select max(e.at) from cb.events e where e.task_id = t.id and not (e.data ? 'nudge')), t.updated_at),
                             (select pr.state_at from cb.projects pr where pr.slug = t.project)) as last_at,
           p.last_ping_at
      from cb.task_pings p join cb.tasks t on t.id = p.task_id
     where t.status not in ('done', 'cancelled')
       -- #4665: parked cards are not silence: review waits on Ahmed by definition, an unassigned backlog card on purpose
       and t.status <> 'review' and not (t.status = 'backlog' and nullif(trim(t.assignee), '') is null)
       and cb._live(t.project)  -- #4559: a project that gets no work is not asked about; its reminder rows are kept
       and (p.last_ping_at is null or p.last_ping_at < now() - interval '30 minutes')
       and not exists (select 1 from cb.questions q where q.task_id = t.id and q.status = 'open')  -- waiting on a person is not silence (Q2357)
  loop
    continue when r.last_at > now() - interval '1 hour';
    -- #4665: an in_progress card nobody holds is asked about once per quiet stretch (the fix is to move it back), not
    -- every 30 minutes; an update starts a new stretch. #4679: and again each day, so it is not forgotten
    continue when r.status = 'in_progress' and r.assignee is null
              and r.last_ping_at >= r.last_at and r.last_ping_at > now() - interval '24 hours';
    mins := floor(extract(epoch from now() - r.last_at) / 60);
    idle := (mins / 60) || 'h ' || (mins % 60) || 'm';
    live := r.assignee is not null and exists (select 1 from cb.sessions s where s.actor = r.assignee and s.last_seen > now() - interval '10 minutes');
    if live then
      insert into cb.events (actor, project, task_id, kind, summary, data)
      values ('board', r.project, r.id, 'message',
              format('Card #%s "%s" (%s) has had no update for %s. Why is it not moving? Say where it stands with: cb log %s "<where it stands>" (any update stops these asks), or move or block it.', r.id, r.title, r.status, idle, r.id),
              jsonb_build_object('to', r.assignee, 'nudge', true));
      n := n + 1;
    end if;
    for o in select x from unnest(cb.triagers(r.project)) x where cb._is_lead(x, r.project) and x is distinct from r.assignee
                 -- a staged card's lead copy is the digest's, which never names an unowned in_progress one (#4679)
                 and (not (r.stage is not null and cb._pipeline(r.project))
                      or (r.status = 'in_progress' and r.assignee is null
                          and not exists (select 1 from cb.task_parts tp where tp.task_id = r.id and tp.assignee is not null))) loop
      insert into cb.events (actor, project, task_id, kind, summary, data)
      values ('board', r.project, r.id, 'message',
              case when r.status = 'in_progress' and r.assignee is null
                then format('Card #%s "%s" (unassigned, in_progress) has had no update for %s, and nobody holds it: move it back (cb move %s next) or assign it. Asked again in a day if nothing changes.', r.id, r.title, idle, r.id)
                else format('Card #%s "%s" (%s, %s) has had no update for %s%s. Ask why it is not moving, or reassign it.', r.id, r.title,
                     case when r.assignee is null then 'unassigned' else 'assigned to ' || r.assignee end, r.status, idle,
                     case when r.assignee is null or live then '' else ' and its session has not checked in for 10 minutes' end) end,
              jsonb_build_object('to', o, 'nudge', true));
      n := n + 1;
    end loop;
    update cb.task_pings p set last_ping_at = now() where p.task_id = r.id;
  end loop;
  return n;
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

-- admin = Ahmed or the huddle project's lead (cb._is_lead: the lead role, whatever the name; #3746).
create function cb._huddle_post(h cb.huddles, action text, message text, a text) returns bigint language plpgsql as $$
declare new_id bigint;
begin
  if h.status = 'closed' then raise exception 'huddle #% is closed', h.id; end if;
  if not (a = 'ahmed' or cb._is_lead(a, h.project)
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
  -- #4559: open huddles stay open; no new one starts in a project that gets no work
  if not cb._live(p) then raise exception '%: no new huddle starts there until Ahmed enables it', cb._state_words(p); end if;
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

-- People who answer through a guest link (Cai, Ana). The link carries the token.
create function cb.user_add(name text, display text default null, actor text default null, role text default 'member') returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); n text := lower(trim(name)); r text := lower(trim(coalesce(role, 'member'))); t text; was text; now_d text; now_r text;
begin
  if n !~ '^[a-z][a-z0-9_-]*$' then raise exception 'user name: lowercase letters, digits, - or _ (e.g. cai)'; end if;
  if r not in ('admin', 'member') then raise exception 'role: admin or member'; end if;
  if n = 'ahmed' and r <> 'admin' then raise exception 'ahmed is the board owner: add him as admin (role => admin)'; end if;
  -- an "ahmed-m" would read as Ahmed in every answer and history line
  if n <> 'ahmed' and n ~ 'ahmed' then raise exception 'names with ahmed in them are reserved for the owner: pick another name'; end if;
  if r = 'admin' then perform cb.dashboard_only('Users'); end if;
  select u.display into was from cb.users u where u.name = n;
  insert into cb.users (name, display, role) values (n, coalesce(nullif(trim(display), ''), initcap(n)), r)
  on conflict on constraint users_pkey do update set display = coalesce(nullif(trim(user_add.display), ''), cb.users.display),
    role = case when r = 'admin' then 'admin' else cb.users.role end, -- adding again never demotes
    token = case when r = 'admin' and cb.users.role <> 'admin' then gen_random_uuid()::text else cb.users.token end
  returning cb.users.token, cb.users.display, cb.users.role into t, now_d, now_r;
  if was is null or was <> now_d then
    insert into cb.events (actor, kind, summary, data)
    values (a, 'user', case when was is null then 'added ' || now_d || ' (' || n || ')' || case when r = 'admin' then ' as admin' else '' end
                            else 'renamed ' || was || ' to ' || now_d || ' (' || n || ')' end,
            jsonb_build_object('user', n, 'action', case when was is null then 'add' else 'rename' end)
              || case when now_r = 'admin' then '{"role": "admin"}'::jsonb else '{}' end);
  end if;
  -- The token is a member's whole login: only Ahmed's dashboard gets it back. A session adds people, Ahmed sends the link.
  -- An admin's token is never handed out: admins sign in by password, and the token is their cookie.
  return case when current_setting('application_name') = 'cb-web' and now_r = 'member' then t end;
end $$;

-- Make a user an admin (the whole board, signing in by password) or a member (their own questions and tasks).
create function cb.user_set_role(name text, role text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text; n text := lower(trim(name)); r text := lower(trim(coalesce(role, ''))); d text; was text;
begin
  perform cb.dashboard_only('Users');
  a := cb.set_actor(actor);
  if r not in ('admin', 'member') then raise exception 'role: admin or member'; end if;
  if n = 'ahmed' and r <> 'admin' then raise exception 'ahmed is the owner: always an admin'; end if;
  select u.display, u.role into d, was from cb.users u where u.name = n for update;
  if d is null then raise exception 'unknown user %: see cb users', name; end if;
  if was = r then return; end if;
  if was = 'admin' and not exists (select 1 from cb.users u where u.role = 'admin' and u.name <> n) then
    raise exception '% is the last admin: make someone else admin first', n;
  end if;
  -- a new token: a member's old link (sent over chat) must not become an admin's credential, nor an admin's cookie a member's
  update cb.users u set role = r, token = gen_random_uuid()::text where u.name = n;
  insert into cb.events (actor, kind, summary, data)
  values (a, 'user', d || ' (' || n || ') is now ' || r, jsonb_build_object('user', n, 'action', 'role', 'role', r));
end $$;

-- A new link for a user. The old one stops working at once, in signed-in browsers too (the cookie holds the token).
create function cb.user_rotate(name text, actor text default null) returns text language plpgsql as $$
#variable_conflict use_variable
declare a text; n text := lower(trim(name)); t text; d text; r text;
begin
  perform cb.dashboard_only();
  a := cb.set_actor(actor);
  update cb.users u set token = gen_random_uuid()::text where u.name = n returning u.token, u.display, u.role into t, d, r;
  if t is null then raise exception 'unknown user %: see cb users', name; end if;
  insert into cb.events (actor, kind, summary, data)
  values (a, 'user', case when r = 'admin' then d || ' (' || n || ') signed out everywhere'
                          else 'new link for ' || d || ' (' || n || '): the old one no longer works' end,
          jsonb_build_object('user', n, 'action', 'rotate'));
  -- an admin's token is their cookie, never handed out: for them this is "sign out everywhere"
  return case when r = 'member' then t end;
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
  if n = 'ahmed' then raise exception 'ahmed is the owner: can''t be removed'; end if;
  select u.display into d from cb.users u where u.name = n for update;
  if d is null then raise exception 'unknown user %: see cb users', name; end if;
  if (select u.role from cb.users u where u.name = n) = 'admin'
     and not exists (select 1 from cb.users u where u.role = 'admin' and u.name <> n) then
    raise exception '% is the last admin: make someone else admin first', n;
  end if;
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
  if who is null or who = 'ahmed' -- the owner: on no project, and work can always be left with him
     or (tg_op = 'UPDATE' and who is not distinct from to_jsonb(old) ->> tg_argv[0])
     or not exists (select 1 from cb.users u where u.name = who)
     or exists (select 1 from cb.user_projects up where up.user_name = who and up.project = new.project) then
    return new;
  end if;
  raise exception '% is not on project %: Ahmed adds people to projects on the Users page', who, new.project;
end $$;

create or replace trigger tasks_assignee_project before insert or update of assignee on cb.tasks
  for each row execute function cb.assignee_on_project('assignee');
create or replace trigger questions_assignee_project before insert or update of assigned_to on cb.questions
  for each row execute function cb.assignee_on_project('assigned_to');

-- The Users page refreshes when someone runs cb user add from a session.
create or replace trigger users_notify after insert or update or delete on cb.users
  for each statement execute function cb.notify();
create or replace trigger user_projects_notify after insert or update or delete on cb.user_projects
  for each statement execute function cb.notify();

-- Hand an open question to a user (null hands it back to Ahmed).
create function cb.question_assign(id text, to_user text, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); qid bigint := cb.norm_id(id);
begin
  perform cb._approval_guard(qid);
  if to_user = 'ahmed' then to_user := null; end if; -- the owner's own queue (he is a user too, to sign in)
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
        -- #4559: a project that gets no work: one line (disabled), plus the answers and my questions (answers already
        -- given still matter). With no project given, such projects' cards, seats and huddles are left out
        off boolean := p is not null and not cb._live(p);
begin
  return case when off then jsonb_build_object('disabled', cb._wait_words(p)) else '{}'::jsonb end || jsonb_build_object(
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
     where t.status = 'in_progress' and (p is null or t.project = p) and not off and cb._live(t.project) and t.assignee is not null and t.assignee <> 'ahmed'
       -- #4559: quiet since the project was enabled, not since the wrap-up before it was disabled
       and t.assignee not in (select u.name from cb.users u)
       and coalesce(greatest(l.at, (select pr.state_at from cb.projects pr where pr.slug = t.project)), '-infinity') < now() - interval '30 minutes'), '[]'),
    'blocked', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'assignee', t.assignee, 'since', coalesce(b.at, t.updated_at),
        'note', r.summary, 'question', q.id, 'question_body', q.body, 'question_status', q.status, 'question_for', coalesce(q.assigned_to, 'ahmed'))
        order by coalesce(b.at, t.updated_at))
      from cb.tasks t
      left join cb.questions q on q.id = t.blocked_on
      left join lateral (select e.at, e.summary from cb.events e where e.task_id = t.id and e.kind = 'moved' and e.data ->> 'to' = 'blocked'
                          order by e.id desc limit 1) b on true
      -- the reason as cb brief picks it (#4454): a reason restated on a card already blocked is newest; since stays the move
      left join lateral (select e.summary from cb.events e where e.task_id = t.id and e.kind in ('moved', 'note') and e.data ->> 'to' = 'blocked'
                          order by e.id desc limit 1) r on true
     where t.status = 'blocked' and (p is null or t.project = p) and not off and cb._live(t.project)
       and greatest(coalesce(b.at, t.updated_at), (select pr.state_at from cb.projects pr where pr.slug = t.project)) < now() - interval '1 hour'
       -- waiting on an open task blocker is by design, not stuck (a question it also holds on still shows)
       and (t.blocked_on is not null or cardinality(cb._waits_on(t.id)) = 0)), '[]'),
    'unreviewed', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'assignee', t.assignee, 'pr', t.links ->> 'pr') order by t.id)
      from cb.tasks t where t.status = 'review' and (p is null or t.project = p) and not off and cb._live(t.project)
       -- a staged card in review is an approval card: the pipeline reviews it, not a "Review #N" card
       and not (t.stage is not null and cb._pipeline(t.project))
       and not cb._is_review(t.labels, t.title) and not cb._has_reviewer(t)
       -- held by Ahmed, a user or a lead, "review" means waiting on a person, not on a code review. Any lead (cb._role, as
       -- misheld below, #3746 C10): a lead holds cards of the projects it led before it was bound to another one. "is
       -- distinct from": cb._role is null for a worker with no role, and that row must stay
       and coalesce(t.assignee, '') <> 'ahmed' and cb._role(t.assignee) is distinct from 'lead'
       and coalesce(t.assignee, '') not in (select u.name from cb.users u)), '[]'),
    -- in progress, but the last one to move it or write on it is another worker (not Ahmed, the relay or a lead: any
    -- session whose role is lead, whichever project it leads, #3746)
    'misheld', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'assignee', t.assignee, 'by', l.actor) order by t.id)
      from cb.tasks t cross join lateral (select e.actor from cb.events e where e.task_id = t.id and e.kind in ('moved', 'note', 'done')
                                           order by e.id desc limit 1) l
     where t.status = 'in_progress' and (p is null or t.project = p) and not off and cb._live(t.project) and t.assignee is not null and l.actor <> t.assignee
       and l.actor not in ('ahmed', 'relay', 'unknown') and cb._role(l.actor) is distinct from 'lead'
       and l.actor not in (select u.name from cb.users u)), '[]'),
    -- live sessions (relay within 90s) holding nothing in progress; tags = what they worked on this week
    'idle', coalesce((select jsonb_agg(jsonb_build_object('actor', s.actor, 'tags',
          (select coalesce(jsonb_agg(distinct g), '[]') from cb.tasks t, unnest(t.labels) g where t.assignee = s.actor and t.updated_at > now() - interval '7 days'),
          -- the Next cards this session's role may claim: never told to take one it cannot
          'can', (select coalesce(jsonb_agg(t.id order by t.id), '[]') from cb.tasks t
                   where t.status = 'next' and t.assignee is null and (p is null or t.project = p) and cb._claimable(t, s.actor)))
        order by s.actor)
      -- one row per actor (its latest live session), with the project it is bound to
      from (select distinct on (s2.actor) s2.actor, s2.project from cb.sessions s2
             where (p is null or s2.project = p) and s2.last_seen > now() - interval '90 seconds' order by s2.actor, s2.last_seen desc) s
     -- a lead of its own project is never offered work (#3746); nor a seat of a project that gets no work (#4559)
     where s.actor <> me and not cb._is_lead(s.actor, s.project) and not off and cb._live(s.project)
       and not exists (select 1 from cb.tasks t where t.assignee = s.actor and t.status = 'in_progress')
       -- a part in work (#3703) is work in progress too
       and not exists (select 1 from cb._held_parts() h where h.assignee = s.actor and h.status = 'in_progress')), '[]'),
    'next', case when off then '[]'::jsonb else cb._brief_tasks(p, null, 'next', 50) end,
    'huddles', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'topic', h.topic, 'last_at', l.at) order by l.at)
      from cb.huddles h cross join lateral (select coalesce(max(e.at), h.opened_at) as at from cb.events e
                                             where e.kind = 'huddle' and (e.data ->> 'huddle')::bigint = h.id) l
     where h.status = 'open' and (p is null or h.project = p) and not off and cb._live(h.project)
       and greatest(l.at, (select pr.state_at from cb.projects pr where pr.slug = h.project)) < now() - interval '20 minutes'), '[]'),
    'locks', cb.lock_queue(null),
    -- Ahmed's asks to me (#936) still without a reply 15 minutes after delivery
    'late_asks', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'delivered_at', a.delivered_at, 'from_terminal', a.from_terminal) order by a.id)
      from cb.asks a cross join lateral cb._ask_info(a.id) i where a.to_actor = me and i.late), '[]'),
    -- tasks with a PR, open or touched this week: the CLI asks GitHub about these
    'prs', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'assignee', t.assignee, 'labels', t.labels,
        'pr', t.links ->> 'pr', 'commit', t.links ->> 'commit', 'done_at', t.done_at,
        'stage', case when cb._pipeline(t.project) then t.stage end, 'finish', case when cb._pipeline(t.project) and t.stage is not null then cb._finish_line(t) end,
        'review', cb._is_review(t.labels, t.title), 'reviewed', cb._has_reviewer(t),
        'go', v.summary ~ '\mGO\M' and v.summary !~ 'NO[- ]?GO', 'verdict', v.summary)
        order by t.id)
      from cb.tasks t
      left join lateral (select e.summary from cb.events e where e.task_id = t.id and e.kind in ('done', 'note') and e.summary ~ '\mGO\M'
                          order by e.id desc limit 1) v on true
     where (p is null or t.project = p) and not off and cb._live(t.project) and cb._pr_no(t.links) is not null
       and (t.status not in ('done', 'cancelled') or t.updated_at > now() - interval '7 days')), '[]'));
end $$;

-- ---------------------------------------------------------------- epics and blockers (#341)

-- "E3", "e3", "#3" or "3" → 3; null, '' or "none" → null (out of its epic). An unknown epic is an error.
-- a card's holder as stored: '', blanks and 'none' (any case) mean nobody, i.e. null; a name is trimmed (#3762). The rest
-- of the board tests "assignee is null" for unassigned (cb next, claims, cb stage)
create function cb._norm_assignee(x text) returns text language sql immutable as $$
  select case when lower(coalesce(trim(x), '')) in ('', 'none') then null else trim(x) end
$$;

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
-- is a message to the project's leads (sessions bound to it with the lead role, as cb.triagers; seen in the last day).
-- Named after tasks_history on purpose:
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
           where coalesce(s2.role, case when s2.actor = 'orch' or s2.actor like 'orch@%' then 'lead' end) = 'lead'
             and s2.last_seen > now() - interval '1 day') s on s.project = f.project
   where f.assignee is null and not cb._pipeline(f.project);  -- a pipeline lead hears of it in the digest
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
  perform cb.broadcast('Goal G' || g.id || ' is active: ' || g.title || ' (' || n || case when n = 1 then ' card' else ' cards' end || '). Its cards come right after P0; cb goals lists it.', g.project, a, g.project is null);
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
    perform cb.broadcast('Goal G' || g.id || ' is active: ' || g.title || ' (' || n || case when n = 1 then ' open card' else ' open cards' end || '). Its cards come right after P0; cb goals lists it.', g.project, a, g.project is null);
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
-- #951: what Ahmed asked in a session's terminal, recorded by that session as an ask to itself (never pushed to it)
alter table cb.asks add column if not exists from_terminal boolean not null default false;
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
drop function if exists cb.ask_record cascade;
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
-- #951: Ahmed asked this session in its terminal; the session records it so its replies land on Today. Always
-- addressed to the caller, marked from_terminal, and counted as delivered with its reminder spent: the relay never
-- hands the session its own note back as an "[Ahmed asks]" line. cb tick and cb start still show it late.
create function cb.ask_record(body text, task text default null, project text default null, actor text default null)
returns bigint language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); tid bigint; r cb.asks; ev bigint;
begin
  if cb._is_dashboard() or cb.ahmed_like(a) then
    raise exception 'a session records what Ahmed asked in its terminal; the dashboard uses Ask a session on Today';
  end if;
  if coalesce(trim(body), '') = '' then raise exception 'what Ahmed asked is required: cb asks add "<his ask>"'; end if;
  if nullif(trim(coalesce(task, '')), '') is not null then
    tid := cb.norm_id(task);
    if not exists (select 1 from cb.tasks t where t.id = tid) then raise exception 'task #% not found', tid; end if;
  end if;
  insert into cb.asks (project, task_id, to_actor, body, from_terminal, delivered_at, delivered_to, repushed_at)
  values (coalesce((select s.project from cb.sessions s where s.actor = a order by s.last_seen desc limit 1), cb.read_project(project)),
          tid, a, trim(body), true, now(), a, now()) returning * into r;
  ev := cb._ask_event(r, 'open', r.body, a, '{"terminal": true}');
  update cb.asks x set delivered_upto = ev where x.id = r.id;
  return r.id;
end $$;

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
  if r.from_terminal then  -- #951: its text is the session's note, not Ahmed's words; it must not reach another session as his
    raise exception 'A% was asked in a terminal and recorded by %: ask the other session with Ask a session', r.id, r.to_actor;
  end if;
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
      'from_terminal', a.from_terminal,
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
-- ---------------------------------------------------------------- telegram (#683)
-- The board server's bot (server/telegram.ts) sends Ahmed's open questions to his paired chat and answers them
-- from it. The paired chat lives in cb.settings ('telegram_chat': {chat_id, paired_at}); this table maps each
-- question to the message that shows it, so a restart neither re-sends nor loses the buttons.
-- asked_at: the question's created_at when sent (a rewrite or a reopened follow-up is asked anew: a new message).
-- state: 'open' while the buttons work, else the outcome the message shows ('answered:<answer>', 'withdrawn', ...).
-- picked: multi-select toggles so far (raw labels). awaiting 'clarify': the next reply is the send-back note;
-- prompt_id: the "reply with your question" message that reply may quote.
create table if not exists cb.telegram_messages (
  question_id bigint primary key references cb.questions(id) on delete cascade,
  chat_id     bigint not null,
  message_id  bigint not null,
  asked_at    timestamptz not null,
  state       text not null default 'open',
  picked      jsonb not null default '[]',
  awaiting    text,
  prompt_id   bigint
);
-- ---------------------------------------------------------------- Squad pipeline (#3598)
-- Cards move through stages (design, approval, build, review, merge, qa) and sessions have roles. Everything here is
-- gated on cb._pipeline(project): a project with pipeline = false behaves exactly as before.
drop function if exists cb._pipeline cascade;
drop function if exists cb._role cascade;
drop function if exists cb._is_lead cascade;
drop function if exists cb._area cascade;
drop function if exists cb.project_pipeline cascade;
drop function if exists cb.page_set cascade;
drop function if exists cb.page_get cascade;
drop function if exists cb.stage_set cascade;
drop function if exists cb._stage_move cascade;
drop function if exists cb.stage_pass cascade;
drop function if exists cb.stage_fail cascade;
drop function if exists cb._approval_answered cascade;
drop function if exists cb._approval_guard cascade;
drop function if exists cb._claimable cascade;
drop function if exists cb._agent cascade;
drop function if exists cb._squad_lacks cascade;
drop function if exists cb._for_agents cascade;
drop function if exists cb._for_skipped cascade;
drop function if exists cb._review_words cascade;
drop function if exists cb._agents_words cascade;
drop function if exists cb._kept cascade;
drop function if exists cb._for_fits cascade;
drop function if exists cb._claimable_any cascade;
drop function if exists cb.work_still_open cascade;
drop function if exists cb._offerable cascade;
drop function if exists cb._busy cascade;
drop function if exists cb._repo_fits cascade;
drop function if exists cb._closing cascade;
drop function if exists cb.stage_stalls_due cascade;
drop function if exists cb._role_model cascade;
drop function if exists cb._expected_model cascade;
drop function if exists cb.digest cascade;
drop function if exists cb._board_active cascade;
drop function if exists cb.digests_due cascade;
drop function if exists cb._stage_words cascade;
drop function if exists cb._held_parts cascade;
drop function if exists cb._parts_words cascade;
drop function if exists cb._finish_line cascade;
drop function if exists cb._takes_it cascade;
drop function if exists cb.next_step cascade;
drop function if exists cb._page_for cascade;
drop function if exists cb.resume cascade;
drop function if exists cb.task_queue cascade;

alter table cb.projects add column if not exists pipeline boolean not null default false;
-- the squad file (its section below adds it too): cb._expected_model, created above it, reads it (#4002)
alter table cb.projects add column if not exists squad jsonb;

alter table cb.tasks add column if not exists stage text;
select cb._ensure_check('cb.tasks', 'tasks_stage_check', $c$stage is null or stage in ('design','approval','build','review','merge','qa')$c$);
-- crew: who designs, builds and reviews this card (keys design, build, review: actor names)
alter table cb.tasks add column if not exists crew jsonb not null default '{}';
alter table cb.tasks add column if not exists stage_since timestamptz;
alter table cb.tasks add column if not exists approved_version int;

alter table cb.sessions add column if not exists role text;
select cb._ensure_check('cb.sessions', 'sessions_role_check', $c$role is null or role in ('lead','architect','owner','builder','reviewer','qa','investigator')$c$);
alter table cb.sessions add column if not exists area text;
alter table cb.sessions add column if not exists model text;
-- the supervisor marks a session it is about to close: no card may land on it for 5 minutes (#3601)
alter table cb.sessions add column if not exists closing_at timestamptz;
-- several repos in one project (#3703): the repo a session works in (null: the project's home repo), and the repos a
-- card touches (null: not named yet; one-repo projects leave it null)
alter table cb.sessions add column if not exists repo text;
alter table cb.tasks add column if not exists repos text[];

alter table cb.questions add column if not exists approval_for bigint references cb.tasks(id) on delete set null;
alter table cb.questions add column if not exists page_version int;

-- A card's page (task_id) or an area's page (area): one current body, older ones in page_versions.
create table if not exists cb.pages (
  id         bigint generated always as identity primary key,
  project    text not null references cb.projects(slug) on update cascade,
  task_id    bigint unique references cb.tasks(id) on delete cascade,
  area       text,
  body       text not null,
  version    int not null,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  unique (project, area),
  check ((task_id is null) <> (area is null))
);
create table if not exists cb.page_versions (
  page_id    bigint references cb.pages(id) on delete cascade,
  version    int,
  body       text,
  updated_by text,
  updated_at timestamptz,
  primary key (page_id, version)
);
-- the last stall nudge sent for a card in a stage
create table if not exists cb.stage_nudges (
  task_id   bigint primary key references cb.tasks(id) on delete cascade,
  nudged_at timestamptz not null
);
-- a card of several repos: one part per repo through build, review and merge (#3703; rules at cb._parts_sync)
create table if not exists cb.task_parts (
  task_id   bigint references cb.tasks(id) on delete cascade,
  repo      text not null,
  stage     text not null check (stage in ('build', 'review', 'merge', 'merged')),
  status    text not null default 'next' check (status in ('next', 'in_progress')),
  assignee  text,
  crew      jsonb not null default '{}',  -- build, review: who built and reviewed this part
  pr        text,
  commit    text,
  since     timestamptz not null default now(),
  nudged_at timestamptz,
  primary key (task_id, repo)
);

create function cb._pipeline(p text) returns boolean language sql stable as $$
  select coalesce((select pr.pipeline from cb.projects pr where pr.slug = p), false)
$$;

-- The role of the actor's most recently seen session; the orchestrator is the lead until it says otherwise.
create function cb._role(a text) returns text language sql stable as $$
  select coalesce((select s.role from cb.sessions s where s.actor = a order by s.last_seen desc limit 1),
                  case when a = 'orch' or a like 'orch@%' then 'lead' end)
$$;

-- #4744: without pipeline stages nothing hands a reviewer a review card (the board keeps no record of who built it), and
-- cb pass and cb fail have no stage to move. What a reviewer there does instead (cb next, cb start, cb pass, cb fail); null
-- for any other role, and for a project with stages or one that gets no work (cb._wait_words says that).
create function cb._review_words(project text, a text) returns text language sql stable as $$
  select case when cb._role(a) = 'reviewer' and cb._live($1) and not cb._pipeline($1)
    then format('%s has no pipeline stages, so the board hands out no review there: the lead hands you pull requests (cb tell). '
                || 'Put your GO or findings in cb log <card> "..." and in a PR comment, and tell the builder. Never cb done a card you reviewed', $1)
  end
$$;

-- Is the actor the lead of this project (#3746): its latest session (the one cb._role reads) is bound to the project and
-- has the lead role, or no role and an orch name (cb._role's default). A lead-role session bound to another project leads
-- that one, not this; an actor with no session leads nothing. Never null: callers negate it.
create function cb._is_lead(a text, proj text) returns boolean language sql stable as $$
  select exists (select 1 from (select s.project, s.role from cb.sessions s where s.actor = a order by s.last_seen desc limit 1) s
                  where s.project = proj and coalesce(s.role, case when a = 'orch' or a like 'orch@%' then 'lead' end) = 'lead')
$$;

create function cb._area(a text) returns text language sql stable as $$
  select s.area from cb.sessions s where s.actor = a order by s.last_seen desc limit 1
$$;

-- Ahmed turns the squad pipeline on or off for a project, from the dashboard (its Project settings page since #4332).
create function cb.project_pipeline(project text, enabled boolean, actor text default null) returns boolean language plpgsql as $$
#variable_conflict use_variable
declare a text; p text := cb.read_project(project);
begin
  perform cb.dashboard_only('Project settings');
  a := cb.set_actor(coalesce(actor, 'ahmed'));
  update cb.projects pr set pipeline = coalesce(enabled, false) where pr.slug = p;
  insert into cb.events (actor, project, kind, summary)
  values (a, p, 'note', format('pipeline %s for %s', case when coalesce(enabled, false) then 'on' else 'off' end, p));
  return coalesce(enabled, false);
end $$;

-- Save a card's design page or an area page: one current body, every real save copied to page_versions.
create function cb.page_set(body text, task text default null, area text default null, project text default null, actor text default null, base_version int default null)
returns int language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); hit text; pg cb.pages%rowtype; tid bigint; p text; st text;
begin
  if (task is null) = (area is null) then raise exception 'give exactly one of task or area'; end if;
  if coalesce(trim(body), '') = '' then raise exception 'the page is empty; write the design'; end if;
  hit := cb._sensitive(body);
  if hit is not null then
    raise exception 'that looks like %; pages are on the board, so describe the code and where the value lives, never the value', hit;
  end if;
  if task is not null then
    tid := cb.norm_id(task);
    select t.project, t.stage into p, st from cb.tasks t where t.id = tid;
    if p is null then raise exception 'no task #%', tid; end if;
    select * into pg from cb.pages g where g.task_id = tid for update;
    if st = 'approval' then
      raise exception '#% waits for Ahmed''s approval of v%: to change the page, take it back with cb fail % "<why>"', tid, pg.version, tid;
    end if;
  else
    if project is null then raise exception 'an area page needs a project'; end if;
    p := cb.read_project(project);
    select * into pg from cb.pages g where g.project = p and g.area = page_set.area for update;
  end if;
  -- the dashboard passes the version it loaded: a session's newer version is never silently replaced
  if base_version is not null and pg.id is not null and pg.version <> base_version then
    raise exception 'the page changed to v% while you edited: reload it and edit again', pg.version;
  end if;
  if pg.id is not null and pg.body = body then return pg.version; end if;
  if pg.id is null then
    insert into cb.pages (project, task_id, area, body, version, updated_by) values (p, tid, area, body, 1, a) returning * into pg;
  else
    update cb.pages g set body = page_set.body, version = g.version + 1, updated_by = a, updated_at = now()
     where g.id = pg.id returning * into pg;
  end if;
  insert into cb.page_versions (page_id, version, body, updated_by, updated_at) values (pg.id, pg.version, pg.body, a, pg.updated_at);
  if tid is not null then
    insert into cb.events (actor, project, task_id, kind, summary) values (a, p, tid, 'note', format('design page v%s', pg.version));
  end if;
  return pg.version;
end $$;

-- A page as jsonb (null: none). version picks an older one; approved_* is the version Ahmed approved (task pages).
create function cb.page_get(task text default null, area text default null, project text default null, version int default null)
returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare pg cb.pages%rowtype; v cb.page_versions%rowtype; av int; ab text; aby text; aat timestamptz;
begin
  if (task is null) = (area is null) then raise exception 'give exactly one of task or area'; end if;
  if task is not null then
    select * into pg from cb.pages g where g.task_id = cb.norm_id(task);
  else
    select * into pg from cb.pages g where g.project = cb.read_project(project) and g.area = page_get.area;
  end if;
  if pg.id is null then return null; end if;
  select * into v from cb.page_versions pv where pv.page_id = pg.id and pv.version = coalesce(page_get.version, pg.version);
  if v.page_id is null then return null; end if;
  if pg.task_id is not null then
    select t.approved_version into av from cb.tasks t where t.id = pg.task_id;
    select pv.body, pv.updated_by, pv.updated_at into ab, aby, aat from cb.page_versions pv where pv.page_id = pg.id and pv.version = av;
  end if;
  return jsonb_build_object('project', pg.project, 'task_id', pg.task_id, 'area', pg.area, 'version', v.version, 'body', v.body,
    'updated_by', v.updated_by, 'updated_at', v.updated_at, 'approved_version', av, 'approved_body', ab, 'approved_by', aby, 'approved_at', aat);
end $$;

-- The lead restages an unclaimed card. build: small found work (a bug or chore) skips design (Q2315); none: work with
-- no code (ops, a data check) leaves the pipeline and is worked the old way (Q2323).
create function cb.stage_set(id text, stage text, why text, actor text default null, repos jsonb default null) returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); t cb.tasks%rowtype; tid bigint := cb.norm_id(id); s text := lower(trim(coalesce(stage, '')));
        rs text[];
begin
  select * into t from cb.tasks x where x.id = tid for update;
  if not found then raise exception 'task #% not found', tid; end if;
  if not cb._pipeline(t.project) then raise exception '% has no pipeline', t.project; end if;
  if cb._role(a) is distinct from 'lead' then raise exception 'only the lead restages a card'; end if;
  if s not in ('build', 'none') then raise exception 'stage is build or none'; end if;
  if s = 'none' and t.stage is null then raise exception '#% is not in the pipeline', tid; end if;
  if coalesce(trim(why), '') = '' then raise exception 'why is required: say in one line why this card skips the pipeline'; end if;
  -- a design waiting for Ahmed is his: the lead neither restages it nor frees it (#3800 review)
  if t.stage = 'approval' then
    raise exception '#% waits for Ahmed''s approval: he answers, or the designer takes it back with cb fail % "<why>"', tid, tid;
  end if;
  if t.assignee is not null or t.status not in ('next', 'backlog') then
    raise exception '%', format('#%s is not unclaimed (assignee or status): restage cards nobody holds. Free it first: %s', tid,
      concat_ws(', then ', case when t.assignee is not null then format('cb edit %s --assignee none', tid) end,
                           case when t.status not in ('next', 'backlog') then format('cb move %s next', tid) end));
  end if;
  -- a card of several repos is held by its parts (#3703)
  if s = 'none' and exists (select 1 from cb.task_parts p where p.task_id = tid and p.assignee is not null) then
    raise exception '#% has parts in work: %; free them first: cb fail % --to design "<why>", then cb edit % --assignee none', tid,
      (select string_agg(p.repo || ' (' || p.assignee || ')', ', ' order by array_position(t.repos, p.repo), p.repo)
         from cb.task_parts p where p.task_id = tid and p.assignee is not null), tid, tid;
  end if;
  if s = 'build' then
    if t.stage is distinct from 'design' then raise exception '#% is not at design: only a card at design can skip to build', tid; end if;
    if t.type not in ('bug', 'chore') then raise exception '#% is a %: only a bug or chore can skip design', tid, t.type; end if;
    -- a card never defaults to a repo (#3703): in a project of several, the lead names them
    rs := coalesce(cb._check_repos(t.project, cb._repo_list(repos)), t.repos);
    if rs is null and cb._multi_repo(t.project) then raise exception 'give the repos: cb stage % build --repo <repo> --why "<why>"', tid; end if;
  elsif cardinality(coalesce(cb._repo_list(repos), '{}')) > 0 then
    raise exception 'repos go with build: cb stage % build --repo <repo> --why "<why>"', tid;
  end if;
  perform set_config('cb.stage_ok', 'on', true);
  update cb.tasks x set stage = case when s = 'build' then 'build' end, stage_since = case when s = 'build' then now() end,
         repos = case when s = 'build' then rs else x.repos end where x.id = tid;
  perform set_config('cb.stage_ok', '', true);
  insert into cb.events (actor, project, task_id, kind, summary, data)
  values (a, t.project, tid, 'note',
          case when s = 'build' then 'small work, skipped design: ' || trim(why) else 'taken out of the pipeline: ' || trim(why) end,
          case when s = 'build' then '{"small": true}'::jsonb else '{"unstaged": true}'::jsonb end);
  if s = 'build' then perform cb._parts_open(tid); else delete from cb.task_parts p where p.task_id = tid; end if;
  return case when s = 'build' then 'build' end;
end $$;

-- Move a card to a stage in one update: who holds it next, its status, the history note. data may carry links and crew
-- to merge into the card; the history event keeps all of it plus the stage change.
create function cb._stage_move(tid bigint, to_stage text, hold text, note text, data jsonb default '{}') returns void language plpgsql as $$
#variable_conflict use_variable
declare fromst text; kept text[];
begin
  select t.stage, cb._for_agents(t.labels) into fromst, kept from cb.tasks t where t.id = tid for update;
  -- #4593 review 100 F2 (lead's ruling): a for: label binds the next claim only: a card that passes its stage loses it,
  -- and the history says so in plain words. Entering its first stage (from none) keeps it. #4679: so does a move into or
  -- out of approval, which no seat claims: a label set at design holds through to the build
  -- Nor does cb fail take it off (cb.keep_for, set by cb.stage_fail): the card goes back to the same kind of agent
  if fromst is null or to_stage = fromst or 'approval' in (fromst, to_stage)
     or current_setting('cb.keep_for', true) = 'on' then kept := '{}'; end if;
  if cardinality(kept) > 0 then
    note := concat_ws('; ', nullif(note, ''), format('it was kept for %s for one stage only, so any seat may take it now', cb._agents_words(kept)));
  end if;
  perform set_config('cb.stage_ok', 'on', true);
  perform set_config('cb.note', coalesce(note, ''), true);
  perform set_config('cb.data', (coalesce(data, '{}') || jsonb_build_object('stage', jsonb_build_object('from', fromst, 'to', to_stage)))::text, true);
  update cb.tasks t set stage = case when to_stage = 'done' then null else to_stage end,
         stage_since = case when to_stage = 'done' then null else now() end,
         assignee = hold,
         status = case to_stage when 'approval' then 'review' when 'done' then 'done' else 'next' end,
         links = t.links || coalesce(data -> 'links', '{}'),
         crew = t.crew || coalesce(data -> 'crew', '{}'),
         labels = case when cardinality(kept) > 0 then array(select l from unnest(t.labels) with ordinality u(l, o) where lower(l) not like 'for:%' order by o) else t.labels end
   where t.id = tid;
  perform set_config('cb.stage_ok', '', true);
  perform set_config('cb.note', '', true);
  perform set_config('cb.data', '', true);
  delete from cb.stage_nudges n where n.task_id = tid;
end $$;

-- The holder hands a card to the next stage. approval is never passed by a session: Ahmed's answer moves it.
-- A card with parts (#3703) passes one part: build and review the part the actor holds, merge the part repo names.
create function cb.stage_pass(id text, summary text, links jsonb default '{}', actor text default null, repo text default null)
returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); t cb.tasks%rowtype; tid bigint := cb.norm_id(id); r text := cb._role(a);
        lk jsonb := coalesce(links, '{}'); nxt text; hold text; extra jsonb := '{}'; v int; qid bigint; pgbody text; rs text[];
        pt cb.task_parts%rowtype; rp text := nullif(trim(repo), '');
begin
  select * into t from cb.tasks x where x.id = tid for update;
  if not found then raise exception 'task #% not found', tid; end if;
  if not cb._pipeline(t.project) then
    raise exception '%', coalesce(cb._review_words(t.project, a), format('pipeline is off for %s: finish it with cb done %s', t.project, tid));
  end if;
  if t.stage is null then raise exception '#% is not in the pipeline', tid; end if;
  if t.stage = 'approval' then
    select q.id into qid from cb.questions q where q.approval_for = tid and q.status in ('open', 'answered') order by q.id desc limit 1;
    raise exception 'waiting for Ahmed''s answer on Q%', qid;
  end if;
  if rp is not null and not exists (select 1 from cb.task_parts p where p.task_id = tid) then
    raise exception '#% has no parts: drop --repo', tid;
  end if;
  if t.stage in ('build', 'review', 'merge') and exists (select 1 from cb.task_parts p where p.task_id = tid) then
    if t.stage <> 'merge' and r = 'lead' then raise exception '#% is at %, not merging yet', tid, cb._stage_words(t.stage); end if;
    if t.stage = 'merge' then
      if r is distinct from 'lead' then raise exception 'merging is the lead''s'; end if;
      if rp is null then
        raise exception 'give the repo: --repo <repo> (parts: %)',
          (select string_agg(p.repo, ', ' order by array_position(t.repos, p.repo), p.repo) from cb.task_parts p where p.task_id = tid);
      end if;
      select * into pt from cb.task_parts p where p.task_id = tid and p.repo = rp and p.stage = 'merge';
      if not found then raise exception 'part % of #% is not waiting to merge', rp, tid; end if;
    else
      -- the part's own stage, not the card's: a NO-GO on another part may have pulled the card back to build
      select * into pt from cb.task_parts p
       where p.task_id = tid and p.assignee = a and p.stage in ('build', 'review') and (rp is null or p.repo = rp) order by p.repo limit 1;
      if not found then raise exception 'you hold no part of #%: claim it first (cb next)', tid; end if;
      if pt.stage = 'build' and r is distinct from 'builder' then raise exception 'build is passed by a builder session'; end if;
      if pt.stage = 'review' and r is distinct from 'reviewer' then raise exception 'review is passed by a reviewer session'; end if;
    end if;
    if coalesce(trim(summary), '') = '' then raise exception 'summary is required: say in one line what you did'; end if;
    if pt.stage = 'build' then
      if nullif(lk ->> 'pr', '') is null and pt.pr is null then raise exception 'give the pull request: --pr <url>'; end if;
      -- a GitHub or an Azure DevOps PR (#3746); a null link (the part already has its PR) falls through
      if nullif(lk ->> 'pr', '') !~ '^https://github\.com/[^/]+/[^/]+/pull/[0-9]+/?$'
         and nullif(lk ->> 'pr', '') !~ '^https://dev\.azure\.com/[^/]+/[^/]+/_git/[^/]+/pullrequest/[0-9]+/?$' then
        raise exception 'give the full pull request URL: https://github.com/<owner>/<repo>/pull/<n> or https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<n>';
      end if;
    elsif pt.stage = 'review' then
      if a = pt.crew ->> 'build' then raise exception 'you built it: another reviewer passes review'; end if;
      if a = t.crew ->> 'design' then raise exception 'you designed it: another reviewer passes review'; end if;
    elsif nullif(lk ->> 'commit', '') is null and pt.commit is null then
      raise exception 'give the merge commit: --commit <sha>';
    end if;
    update cb.task_parts p set stage = case pt.stage when 'build' then 'review' when 'review' then 'merge' else 'merged' end,
           status = 'next', assignee = null, since = now(), nudged_at = null,
           pr = coalesce(nullif(lk ->> 'pr', ''), p.pr), commit = coalesce(nullif(lk ->> 'commit', ''), p.commit),
           crew = p.crew || case pt.stage when 'build' then jsonb_build_object('build', a) when 'review' then jsonb_build_object('review', a)
                                          else '{}'::jsonb end
     where p.task_id = tid and p.repo = pt.repo;
    -- each part's PR and commit under its repo; the bare pr and commit are the first repo's (the design's merge order)
    lk := (lk - 'pr' - 'commit') || jsonb_strip_nulls(jsonb_build_object(
            'pr:' || pt.repo, nullif(lk ->> 'pr', ''), 'commit:' || pt.repo, nullif(lk ->> 'commit', ''),
            'pr', case when pt.repo = t.repos[1] then nullif(lk ->> 'pr', '') end,
            'commit', case when pt.repo = t.repos[1] then nullif(lk ->> 'commit', '') end));
    perform cb._parts_sync(tid, pt.repo || ': ' || trim(summary), jsonb_build_object('links', lk, 'repo', pt.repo));
    select x.stage into nxt from cb.tasks x where x.id = tid;
    return nxt;
  end if;
  if t.stage = 'design' and (r is null or r not in ('owner', 'architect')) then raise exception 'design is passed by an owner or architect session'; end if;
  if t.stage = 'build' and r is distinct from 'builder' then raise exception 'build is passed by a builder session'; end if;
  if t.stage = 'review' and r is distinct from 'reviewer' then raise exception 'review is passed by a reviewer session'; end if;
  if t.stage = 'merge' and r is distinct from 'lead' then raise exception 'merging is the lead''s'; end if;
  if t.stage = 'qa' and r is distinct from 'qa' then raise exception 'checking on dev is a qa session''s'; end if;
  -- merging is the lead's stage: the lead passes it without claiming it first
  if t.stage <> 'merge' and t.assignee is distinct from a then raise exception '#% is not held by you: claim it first', tid; end if;
  if coalesce(trim(summary), '') = '' then raise exception 'summary is required: say in one line what you did'; end if;
  if t.stage = 'design' then
    select g.version, g.body into v, pgbody from cb.pages g where g.task_id = tid;
    if v is null then raise exception 'write the design page first: cb page set % -f <file>', tid; end if;
    -- several repos (#3703): the card names its repos before approval; unnamed, they come from its area tags, in squad order
    if t.repos is null then
      select array_agg(z.rname order by z.ix) into rs
        from (select e.el ->> 'repo' as rname, min(e.ix) as ix
                from cb.projects pr, jsonb_array_elements(pr.squad -> 'areas') with ordinality e(el, ix)
               where pr.slug = t.project and jsonb_typeof(e.el) = 'object' and e.el ->> 'name' = any(t.labels)
               group by 1) z;
      if rs is null and cb._multi_repo(t.project) then raise exception 'name the repos first: cb edit % --repo <repo,repo>', tid; end if;
      if rs is not null then update cb.tasks x set repos = rs where x.id = tid; end if;
    end if;
    extra := jsonb_build_object('crew', jsonb_build_object('design', a));
  elsif t.stage = 'build' then
    if nullif(lk ->> 'pr', '') is null and nullif(t.links ->> 'pr', '') is null then raise exception 'give the pull request: --pr <url>'; end if;
    extra := jsonb_build_object('crew', jsonb_build_object('build', a));
  elsif t.stage = 'review' then
    if a = t.crew ->> 'build' then raise exception 'you built it: another reviewer passes review'; end if;
    if a = t.crew ->> 'design' then raise exception 'you designed it: another reviewer passes review'; end if;
    extra := jsonb_build_object('crew', jsonb_build_object('review', a));
  elsif t.stage = 'merge' then
    if nullif(lk ->> 'commit', '') is null and nullif(t.links ->> 'commit', '') is null then raise exception 'give the merge commit: --commit <sha>'; end if;
  elsif t.stage = 'qa' then
    if a = t.crew ->> 'build' or exists (select 1 from cb.task_parts p where p.task_id = tid and p.crew ->> 'build' = a) then
      raise exception 'you built it: another qa session checks it';
    end if;
  end if;
  nxt := case t.stage when 'design' then 'approval' when 'build' then 'review' when 'review' then 'merge' when 'merge' then 'qa' else 'done' end;
  hold := case when nxt = 'done' then a end;
  perform cb._stage_move(tid, nxt, hold, trim(summary), extra || jsonb_build_object('links', lk));
  if nxt = 'approval' then
    -- #4559: exempt from the disabled-project ask rule, and only this call (the setting is cleared right after)
    perform set_config('cb.ask_internal', 'on', true);
    qid := cb.ask(t.project, format('Approve the design for #%s "%s"?', tid, t.title),
                  jsonb_build_array(jsonb_build_object('label', 'Approve', 'description', 'it goes to build'),
                                    jsonb_build_object('label', 'Changes needed', 'description', 'back to ' || a || ' with your note')),
                  task_id => tid::text, context => pgbody || E'\n\nv' || v || ', written by ' || a, actor => 'board');
    perform set_config('cb.ask_internal', '', true);
    perform cb.set_actor(a);
    update cb.questions q set approval_for = tid, page_version = v where q.id = qid;
  end if;
  return nxt;
end $$;

-- A reviewer or qa session sends the card back (to its builder, or to design); the designer takes a card back from approval.
-- A card with parts (#3703): a reviewer's NO-GO sends back only its part; qa names the repo that fails; --to design
-- sends the whole card back and its parts wait, unheld, for re-approval.
-- The project's lead sends any card past approval back to design with --to design (#3800): a design that turns out to
-- need no code, or one Ahmed wants redone. Nothing else freed a part held at build.
create function cb.stage_fail(id text, why text, to_stage text default null, actor text default null, repo text default null)
returns text language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); t cb.tasks%rowtype; tid bigint := cb.norm_id(id); s text := lower(nullif(trim(to_stage), '')); nxt text; qid bigint;
        pt cb.task_parts%rowtype; rp text := nullif(trim(repo), ''); parts text; lh text;
begin
  select * into t from cb.tasks x where x.id = tid for update;
  if not found then raise exception 'task #% not found', tid; end if;
  if not cb._pipeline(t.project) then
    raise exception '%', coalesce(cb._review_words(t.project, a), format('pipeline is off for %s: finish it with cb done %s', t.project, tid));
  end if;
  if coalesce(trim(why), '') = '' then raise exception 'why is required: say in one line what is wrong'; end if;
  if s is not null and s not in ('design', 'build') then raise exception 'to is design (default: build)'; end if;
  select string_agg(p.repo, ', ' order by array_position(t.repos, p.repo), p.repo) into parts from cb.task_parts p where p.task_id = tid;
  if rp is not null and parts is null then raise exception '#% has no parts: drop --repo', tid; end if;
  -- what the lead is told when its cb fail has no other path: at merge, a stale GO wants a fresh one, not a redesign
  lh := case when t.stage = 'merge'
             then format('nothing goes back from merge: for a GO on an older head, ask the reviewer for a fresh GO; to change the design, cb fail %s --to design "<why>"', tid)
             else format('the lead sends #%s back to design: cb fail %s --to design "<why>"', tid, tid) end;
  if s = 'design' and t.stage in ('build', 'review', 'merge', 'qa') and cb._is_lead(a, t.project) then
    nxt := 'design';  -- the lead's send back (#3800): parts freed and holders told below
  elsif parts is not null and t.stage in ('build', 'review', 'merge') then
    -- the reviewer's part, at its own stage (the card may be back at build already)
    select * into pt from cb.task_parts p
     where p.task_id = tid and p.assignee = a and p.stage = 'review' and (rp is null or p.repo = rp) order by p.repo limit 1;
    if not found then
      if cb._is_lead(a, t.project) then raise exception '%', lh; end if;
      if exists (select 1 from cb.task_parts p where p.task_id = tid and p.assignee = a and p.stage = 'build') then
        raise exception 'your part of #% is at build: cb fail sends back a part in review. If it cannot be built as approved, ask the lead to send the card back: cb fail % --to design "<why>"', tid, tid;
      end if;
      raise exception 'you hold no part of #%: claim it first (cb next)', tid;
    end if;
    nxt := coalesce(s, 'build');
  elsif t.stage in ('review', 'qa') then
    if t.assignee is distinct from a then raise exception '#% is not held by you: claim it first', tid; end if;
    nxt := coalesce(s, 'build');
    if parts is not null and nxt = 'build' then
      if rp is null then raise exception 'name the repo that fails: cb fail % --repo <repo> "<why>" (parts: %)', tid, parts; end if;
      select * into pt from cb.task_parts p where p.task_id = tid and p.repo = rp;
      if not found then raise exception '% is not a part of #%: %', rp, tid, parts; end if;
    end if;
  elsif t.stage = 'approval' and a = t.crew ->> 'design' then
    nxt := 'design';
    select q.id into qid from cb.questions q where q.approval_for = tid and q.status in ('open', 'answered') order by q.id desc limit 1;
    perform set_config('cb.stage_ok', 'on', true);  -- lets cb._approval_guard pass the designer's own withdraw
    if qid is not null then perform cb.withdraw(qid::text, a); end if;
    perform set_config('cb.stage_ok', '', true);
  else
    if t.stage in ('build', 'merge') and cb._is_lead(a, t.project) then raise exception '%', lh; end if;
    if t.stage = 'build' and t.assignee = a then
      raise exception 'you hold #% at build: cb fail sends back a card in review or qa. If it cannot be built as approved, ask the lead to send it back: cb fail % --to design "<why>"', tid, tid;
    end if;
    raise exception 'cb fail is for the holder of a card in review or qa, the designer taking a card back from approval, or the project''s lead sending a card back to design';
  end if;
  if pt.repo is not null and nxt = 'build' then
    -- back to its builder; a merged part reopened by qa needs a new merge commit
    update cb.task_parts p set stage = 'build', status = 'next', assignee = p.crew ->> 'build', commit = null, since = now(), nudged_at = null
     where p.task_id = tid and p.repo = pt.repo;
    perform set_config('cb.keep_for', 'on', true);
    perform cb._parts_sync(tid, pt.repo || ': ' || trim(why), jsonb_build_object('repo', pt.repo));
    perform set_config('cb.keep_for', '', true);
    -- the card stays in Next and unheld: its builder hears of it only by message (busy or not)
    insert into cb.events (actor, project, task_id, kind, summary, data)
    select 'board', t.project, tid, 'message', format('#%s part %s is back with you at build: %s', tid, pt.repo, trim(why)),
           jsonb_build_object('to', pt.crew ->> 'build', 'repo', pt.repo)
     where nullif(trim(pt.crew ->> 'build'), '') is not null;
    return 'build';
  end if;
  perform set_config('cb.keep_for', 'on', true);
  perform cb._stage_move(tid, nxt, case nxt when 'design' then t.crew ->> 'design' else t.crew ->> 'build' end, trim(why));
  perform set_config('cb.keep_for', '', true);
  -- the parts wait for re-approval, held by nobody: cb._parts_open gives each back to its builder. Their holders (but
  -- the one sending it back) are told: nothing else reaches them.
  if nxt = 'design' then
    insert into cb.events (actor, project, task_id, kind, summary, data)
    select 'board', t.project, tid, 'message',
           format('#%s went back to design: %s. Your part %s waits for re-approval', tid, trim(why), p.repo),
           jsonb_build_object('to', p.assignee, 'repo', p.repo)
      from cb.task_parts p where p.task_id = tid and nullif(trim(p.assignee), '') is not null and p.assignee <> a
     order by p.repo;
    update cb.task_parts p set assignee = null, status = 'next' where p.task_id = tid;
    -- a card held whole (its builder, when the lead sends it back) hears of it through the move's own event (cb.inbox)
  end if;
  return nxt;
end $$;

-- An approval question is never withdrawn, sent back or reassigned on its own: the card would wait with no live question.
-- Only cb.stage_fail (the designer taking the card back) gets through, with cb.stage_ok on.
create function cb._approval_guard(qid bigint) returns void language plpgsql as $$
#variable_conflict use_variable
declare tid bigint;
begin
  select q.approval_for into tid from cb.questions q join cb.tasks t on t.id = q.approval_for
   where q.id = qid and q.status in ('open', 'answered', 'dormant', 'sent_back')
     and t.stage = 'approval' and t.status not in ('done', 'cancelled') and cb._pipeline(t.project);
  if tid is not null and current_setting('cb.stage_ok', true) is distinct from 'on' then
    raise exception 'Q% is the approval for #%: the designer takes it back with cb fail % "<why>"', qid, tid, tid;
  end if;
end $$;

-- Ahmed answered an approval question (first answer or a change). Still at approval: Approve sends the card to build,
-- Changes needed back to its designer. Moved on already: a note for the digest, the card is left alone.
create function cb._approval_answered(qid bigint) returns void language plpgsql as $$
#variable_conflict use_variable
declare q cb.questions%rowtype; t cb.tasks%rowtype; picked text[]; latest bigint;
begin
  select * into q from cb.questions x where x.id = qid;
  if q.approval_for is null then return; end if;
  select * into t from cb.tasks x where x.id = q.approval_for for update;
  if not found then return; end if;
  -- only the card's current approval question moves it: an older one, corrected later, is history
  select max(x.id) into latest from cb.questions x where x.approval_for = t.id and x.status <> 'withdrawn';
  if t.stage = 'approval' and t.status not in ('done', 'cancelled') and cb._pipeline(t.project) and qid = latest then
    picked := cb._picked(q.options, q.answer, false);
    if 'Approve' = any (picked) then
      -- a first approval leaves the card unassigned; one after a send back to design returns it to its builder. A card of
      -- several repos (or one that has parts) is held by its parts instead: unassigned, each part back with its builder.
      perform cb._stage_move(t.id, 'build',
        case when cardinality(coalesce(t.repos, '{}')) > 1 or exists (select 1 from cb.task_parts p where p.task_id = t.id) then null
             else t.crew ->> 'build' end, 'design approved');
      update cb.tasks x set approved_version = q.page_version where x.id = t.id;
      perform cb._parts_open(t.id);
    else  -- Changes needed, or any typed answer: never approve on an ambiguous one, never leave the card waiting
      perform cb._stage_move(t.id, 'design', t.crew ->> 'design', q.answer);
    end if;
  elsif t.status not in ('done', 'cancelled') and cb._pipeline(t.project) then
    insert into cb.events (actor, project, task_id, kind, summary, data)
    values (coalesce(nullif(current_setting('cb.actor', true), ''), 'unknown'), t.project, t.id, 'note',
            format('approval answer changed to "%s" after the card moved on', q.answer), '{"digest": true}');
  end if;
  update cb.questions x set status = 'delivered', delivered_at = now(), delivered_to = 'board' where x.id = qid;
end $$;

-- May session a take this card? Outside a pipeline project: always. Unstaged: research goes to investigators, the rest to
-- roleless sessions and the lead. Staged: the role must match the stage; a hold (assignee = a, as stage_fail sets it)
-- only skips the area and 15-minute checks of design, never the role.
create function cb._closing(a text) returns boolean language sql stable as $$
  select exists (select 1 from cb.sessions s where s.actor = a and s.closing_at > now() - interval '5 minutes')
$$;

-- The repo half of a build or review claim (#3703). A card with parts: a free part of a's repo at the card's stage (at
-- review, not one a built or the card a designed). No parts in a project of several repos: the card's first repo is a's
-- (no repos named: nobody's). One repo: any. plpgsql: cb._repo and cb.task_parts are created further down.
create function cb._repo_fits(t cb.tasks, a text) returns boolean language plpgsql stable as $$
begin
  if exists (select 1 from cb.task_parts p where p.task_id = t.id) then
    return exists (select 1 from cb.task_parts p
                    where p.task_id = t.id and p.stage = t.stage and p.status = 'next' and (p.assignee is null or p.assignee = a)
                      and p.repo = cb._repo(a)
                      and (t.stage <> 'review' or (a is distinct from p.crew ->> 'build' and a is distinct from t.crew ->> 'design')));
  end if;
  return not cb._multi_repo(t.project) or coalesce(t.repos[1] = cb._repo(a), false);
end $$;

-- #4593: the agent an actor runs, read as cb._role reads its role (its latest session); claude when it has none.
create function cb._agent(a text) returns text language sql stable as $$
  select coalesce((select s.agent from cb.sessions s where s.actor = a order by s.last_seen desc limit 1), 'claude')
$$;

-- #4593: the agents a card is kept for, from its for:<agent> labels, in name order (empty: any agent). Only agents a seat
-- can run (review 100 F4): a label saved before the rule (for:ahmed) keeps the card from nobody. The names are spelled
-- out: cb._agents_main is made further down, and a sql function is checked when it is made.
create function cb._for_agents(labels text[]) returns text[] language sql immutable as $$
  select coalesce(array(select distinct substr(lower(l), 5) from unnest(labels) l
                         where lower(l) like 'for:%' and substr(lower(l), 5) = any(array['claude', 'codex', 'opencode', 'agy']) order by 1), '{}')
$$;

-- #4593 review 100 F3: the seat a kept card waits for, in plain words: "a Codex seat", "an agy or Codex seat".
create function cb._agents_words(ag text[]) returns text language sql immutable as $$
  select case when left(w, 1) in ('a', 'e', 'i', 'o', 'u') then 'an ' else 'a ' end || w || ' seat'
    from (select string_agg(case x when 'claude' then 'Claude' when 'codex' then 'Codex' when 'opencode' then 'OpenCode' else x end, ' or ' order by n) w
            from unnest(ag) with ordinality u(x, n)) z
$$;

-- #4679: the project has a squad and none of its roles or seats runs one of these agents (no squad: nothing to say)
create function cb._squad_lacks(p text, ag text[]) returns boolean language sql stable as $$
  select coalesce((select pr.squad is not null and not exists (
      select 1 from jsonb_each(pr.squad -> 'roles') r
       cross join lateral (select coalesce(r.value ->> 'agent', 'claude') as agent
                           union all
                           select se.value ->> 'agent' from jsonb_each(coalesce(r.value -> 'seats', '{}')) se) s
       where s.agent = any(ag))
    from cb.projects pr where pr.slug = p), false)
$$;

-- #4593 review 100 F1: the waiting cards kept for an agent, counted by the agents they are kept for ("codex", "agy,codex"),
-- from a JSON array of label arrays. {} when none.
create function cb._kept(ls jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, n), '{}') from (
    select array_to_string(cb._for_agents(array(select jsonb_array_elements_text(x))), ',') k, count(*) n
      from jsonb_array_elements(coalesce(ls, '[]')) x group by 1) z where k <> ''
$$;

-- #4593: may a take this card, as far as its for: labels go: none, its assignee, or a seat of one of the agents named.
-- The like is a cheap first look (review 100 F5): nearly every card has no for: label.
create function cb._for_fits(t cb.tasks, a text) returns boolean language sql stable as $$
  select t.assignee is not distinct from a or array_to_string(t.labels, ' ') not ilike '%for:%'
      or cardinality(cb._for_agents(t.labels)) = 0 or cb._agent(a) = any(cb._for_agents(t.labels))
$$;

-- Everything but the for: labels (#4593 split it out: cb._for_skipped names what only a label kept from a).
create function cb._claimable_any(t cb.tasks, a text) returns boolean language sql stable as $$
  select case
    when cb._closing(a) then false
    -- #4559: the one place "no new work" lives: cb next, the cb start preview, the relay's offers and cb tick's "can take"
    when not cb._live(t.project) then false
    when not cb._pipeline(t.project) then true
    when t.stage is null then
      case when t.type = 'research' then cb._role(a) = 'investigator' or t.assignee = a
           else cb._role(a) is null or cb._role(a) = 'lead' or t.assignee = a end
    else coalesce(case t.stage
      when 'design' then
        (cb._role(a) = 'owner' and cb._area(a) = any(t.labels))
        or (cb._role(a) in ('architect', 'owner') and (t.assignee = a
              or (cb._area(a) is null and (t.stage_since < now() - interval '15 minutes'
                  or not exists (select 1 from cb.sessions s where s.role = 'owner' and s.project = t.project and s.area = any(t.labels)
                                    and s.last_seen > now() - interval '10 minutes')))))
      when 'build' then cb._role(a) = 'builder' and cb._repo_fits(t, a)
      when 'review' then cb._role(a) = 'reviewer' and a is distinct from t.crew ->> 'build' and a is distinct from t.crew ->> 'design'
                         and cb._repo_fits(t, a)
      when 'merge' then cb._role(a) = 'lead'
      when 'qa' then cb._role(a) = 'qa' and a is distinct from t.crew ->> 'build'
                     -- a parts card keeps its builders on the parts (#3703)
                     and not exists (select 1 from cb.task_parts p where p.task_id = t.id and p.crew ->> 'build' = a)
      else false end, false)
    end
$$;

create function cb._claimable(t cb.tasks, a text) returns boolean language sql stable as $$
  -- #4593: a card kept for:<agent> goes only to a seat of that agent, or to its assignee
  select cb._for_fits(t, a) and cb._claimable_any(t, a)
$$;

-- #4593: why cb next found nothing for a: the Next cards of the project a could take but for their for: labels (review 100
-- F7: never a card its role could not take anyway), as "#660: waiting for a Codex seat" (at most 5), or null.
create function cb._for_skipped(project text, a text) returns text language sql stable as $$
  select string_agg(format('#%s: waiting for %s', t.id, cb._agents_words(cb._for_agents(t.labels))), ', ' order by t.id)
    from (select t.* from cb.tasks t where t.status = 'next' and t.project = $1 and t.assignee is null
            and not cb._for_fits(t, $2) and cb._claimable_any(t, $2)
          order by t.id limit 5) t
$$;


-- Quiet staged cards (never approval, never unstaged ones such as investigations): a live holder is nudged after 30 minutes
-- and loses the card after 90 if the nudge went unanswered; a hold (status next) whose live holder has gone 90 minutes
-- quiet is freed. A holder whose session is down keeps everything (Q2324: Ahmed restores the session). Quiet = no card
-- event (the board's own nudges excluded) and no event by the holder anywhere. Returns messages sent plus cards freed.
-- #4335: a builder holding a card (or part) at build with a PR linked is working on that PR (a send-back to build owes
-- a new one), and keeps it through a quiet spell of up to 24 h: nudged once, without "it goes back to the queue". At
-- 24 h it gets the usual nudge, and is freed an hour after that if it is still quiet. Any other holder, or stage: the
-- usual rules. (Not the PR's state: the poller lists only PRs that have its card, which a squad's own PRs mostly lack;
-- #17's second review. A merged or closed PR is held at most the 24 h.)
create function cb.stage_stalls_due() returns int language plpgsql as $$
declare r record; n int := 0; mins int; idle text; why text; moved int; grace interval;
begin
  -- the close path leaves a card's nudge row behind: drop rows of cards that have no stage any more
  delete from cb.stage_nudges d where not exists (select 1 from cb.tasks t where t.id = d.task_id and t.stage is not null);
  for r in
    select t.id, t.project, left(t.title, 80) as title, t.assignee, t.status, t.stage, q.quiet_since, nd.nudged_at,
           (t.stage = 'build' and cb._role(t.assignee) = 'builder' and cb._pr_no(t.links) is not null) as has_pr,
           cb._pr_no(t.links) as pr_no
      from cb.tasks t
      cross join lateral (select greatest(t.updated_at,
                                          coalesce((select max(e.at) from cb.events e where e.task_id = t.id and not (e.data ? 'nudge')), t.updated_at),
                                          coalesce((select max(e.at) from cb.events e where e.actor = t.assignee), t.updated_at),
                                          -- a restored session starts afresh (cb.iam writes no event): Q2324
                                          coalesce((select max(s.started_at) from cb.sessions s where s.actor = t.assignee), t.updated_at),
                                          -- #4559: quiet time counts from the project's last enable (null: never changed)
                                          (select pr.state_at from cb.projects pr where pr.slug = t.project)) as quiet_since) q
      left join cb.stage_nudges nd on nd.task_id = t.id
     where t.stage is not null and t.stage <> 'approval' and nullif(trim(t.assignee), '') is not null
       and t.status in ('in_progress', 'next') and cb._pipeline(t.project)
       and cb._live(t.project)  -- #4559 (Q3017): a disabled project's held cards keep their holders: no nudge, no freeing
       and q.quiet_since <= now() - interval '30 minutes'
       and exists (select 1 from cb.sessions s where s.actor = t.assignee and s.last_seen > now() - interval '10 minutes')
       and not exists (select 1 from cb.questions qq where qq.task_id = t.id and qq.status = 'open')  -- waiting on a person (Q2357)
  loop
    mins := floor(extract(epoch from now() - r.quiet_since) / 60);
    idle := (mins / 60) || 'h ' || (mins % 60) || 'm';
    -- a PR hold's own nudge is no warning (review M1): past 24 h only a nudge sent after the exemption ended counts
    grace := case when r.has_pr then interval '24 hours' else interval '0' end;
    if not (r.has_pr and mins < 24 * 60) and mins >= 90 and (r.status = 'next' or (r.nudged_at > r.quiet_since + grace and r.nudged_at <= now() - interval '60 minutes')) then
      why := case when r.status = 'next' then format('held for %s with no activity', idle)
                  else format('no update for %s and the nudge went unanswered', idle) end;
      perform set_config('cb.actor', 'board', true);
      perform set_config('cb.note', format('freed from %s: %s', r.assignee, why), true);
      perform set_config('cb.data', '{"stall": true}', true);
      update cb.tasks t set assignee = null, status = 'next',
             rank = (select coalesce(min(x.rank) - 1024, 0) from cb.tasks x where x.project = t.project and x.status = 'next' and x.id <> t.id)
       where t.id = r.id and t.assignee = r.assignee and t.status = r.status;  -- claimed or moved since the select: leave it
      get diagnostics moved = row_count;
      perform set_config('cb.note', '', true);
      perform set_config('cb.data', '', true);
      continue when moved = 0;
      delete from cb.stage_nudges d where d.task_id = r.id;
      insert into cb.events (actor, project, task_id, kind, summary, data)
      -- urgent (#3221 review M2): a card taken off a seat is never held by its relay; nudge stays (no card activity)
      values ('board', r.project, r.id, 'message', format('#%s went back to the queue: %s', r.id, why),
              jsonb_build_object('to', r.assignee, 'nudge', true, 'stall', true, 'urgent', true));
      n := n + 2;
    elsif r.status = 'in_progress' and mins >= 30 and (r.nudged_at is null or r.nudged_at <= r.quiet_since + case when mins >= 24 * 60 then grace else interval '0' end) then
      insert into cb.events (actor, project, task_id, kind, summary, data)
      values ('board', r.project, r.id, 'message',
              case when r.has_pr and mins < 24 * 60
                then format('#%s "%s" has PR #%s linked, with no update for %s at %s. Say where it stands (cb log %s "...").',
                            r.id, r.title, r.pr_no, idle, cb._stage_words(r.stage), r.id)
                else format('#%s "%s" has had no update for %s at %s. Say where it stands (cb log %s "...") or it goes back to the queue in an hour.',
                            r.id, r.title, idle, cb._stage_words(r.stage), r.id) end,
              jsonb_build_object('to', r.assignee, 'nudge', true, 'stall', true));
      insert into cb.stage_nudges (task_id, nudged_at) values (r.id, now())
      on conflict (task_id) do update set nudged_at = excluded.nudged_at;
      n := n + 1;
    end if;
  end loop;
  -- held parts (#3703): the same rules per part, its nudge time on the part. Quiet = no part change, no card event (nudges
  -- excluded), no event by the holder anywhere, no fresh bind of its session.
  for r in
    select h.task_id as id, h.repo, h.assignee, h.status, h.stage, h.nudged_at, t.project, left(t.title, 80) as title, q.quiet_since,
           (h.stage = 'build' and cb._role(h.assignee) = 'builder' and substring(h.pr from '([0-9]+)/?$') is not null) as has_pr,
           substring(h.pr from '([0-9]+)/?$') as pr_no
      from cb._held_parts() h join cb.tasks t on t.id = h.task_id
      cross join lateral (select greatest(h.since,
                                          -- a sibling part's free note (stall) is not this part's activity
                                          (select max(e.at) from cb.events e where e.task_id = t.id and not (e.data ? 'nudge' or e.data ? 'stall')),
                                          (select max(e.at) from cb.events e where e.actor = h.assignee),
                                          (select max(s.started_at) from cb.sessions s where s.actor = h.assignee),
                                          (select pr.state_at from cb.projects pr where pr.slug = t.project)) as quiet_since) q  -- #4559
     where t.status in ('in_progress', 'next') and cb._pipeline(t.project) and cb._live(t.project) and q.quiet_since <= now() - interval '30 minutes'
       and exists (select 1 from cb.sessions s where s.actor = h.assignee and s.last_seen > now() - interval '10 minutes')
       and not exists (select 1 from cb.questions qq where qq.task_id = t.id and qq.status = 'open')
  loop
    mins := floor(extract(epoch from now() - r.quiet_since) / 60);
    idle := (mins / 60) || 'h ' || (mins % 60) || 'm';
    perform 1 from cb.tasks t where t.id = r.id for update;  -- part rows change only under the card's row lock
    -- a PR hold's own nudge is no warning (review M1): past 24 h only a nudge sent after the exemption ended counts
    grace := case when r.has_pr then interval '24 hours' else interval '0' end;
    if not (r.has_pr and mins < 24 * 60) and mins >= 90 and (r.status = 'next' or (r.nudged_at > r.quiet_since + grace and r.nudged_at <= now() - interval '60 minutes')) then
      why := case when r.status = 'next' then format('held for %s with no activity', idle)
                  else format('no update for %s and the nudge went unanswered', idle) end;
      update cb.task_parts p set assignee = null, status = 'next', nudged_at = null
       where p.task_id = r.id and p.repo = r.repo and p.assignee = r.assignee and p.status = r.status;  -- claimed or passed since: leave it
      get diagnostics moved = row_count;
      continue when moved = 0;
      insert into cb.events (actor, project, task_id, kind, summary, data)
      values ('board', r.project, r.id, 'note', format('freed from %s: %s (part %s)', r.assignee, why, r.repo),
              jsonb_build_object('stall', true, 'repo', r.repo));
      insert into cb.events (actor, project, task_id, kind, summary, data)
      values ('board', r.project, r.id, 'message', format('#%s part %s went back to the queue: %s', r.id, r.repo, why),
              jsonb_build_object('to', r.assignee, 'nudge', true, 'stall', true, 'repo', r.repo, 'urgent', true));  -- as above (M2)
      n := n + 2;
    elsif r.status = 'in_progress' and mins >= 30 and (r.nudged_at is null or r.nudged_at <= r.quiet_since + case when mins >= 24 * 60 then grace else interval '0' end) then
      insert into cb.events (actor, project, task_id, kind, summary, data)
      values ('board', r.project, r.id, 'message',
              case when r.has_pr and mins < 24 * 60
                then format('#%s "%s" (part %s) has PR #%s linked, with no update for %s at %s. Say where it stands (cb log %s "...").',
                            r.id, r.title, r.repo, r.pr_no, idle, cb._stage_words(r.stage), r.id)
                else format('#%s "%s" (part %s) has had no update for %s at %s. Say where it stands (cb log %s "...") or it goes back to the queue in an hour.',
                            r.id, r.title, r.repo, idle, cb._stage_words(r.stage), r.id) end,
              jsonb_build_object('to', r.assignee, 'nudge', true, 'stall', true, 'repo', r.repo));
      update cb.task_parts p set nudged_at = now() where p.task_id = r.id and p.repo = r.repo;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- The lead's digest (Task 9)
-- One message to the lead every 15 minutes (at once on a new P0) replaces the per-event copies in pipeline projects.
-- ponytail: fixed defaults until the per-project model map lands (piece 2). Claude's only (#4002): another agent has
-- no default model (its squad seat names one), so null. A null agent is claude.
create function cb._role_model(role text, agent text default 'claude') returns text language sql immutable as $$
  select case when coalesce(agent, 'claude') <> 'claude' then null when role in ('builder', 'qa') then 'sonnet' else 'opus' end
$$;

-- The model a session should run (#4002): its squad seat's, else its squad role's, else the role default. The seat key is
-- the one wantList (cli/squad-up.ts) names the session by: the lead 1, an owner its area, else the number in its name
-- (demo-B2@m: 2), with repos <repo>:2 for builders and reviewers (no repo named: the home repo). The home repo is read
-- from the squad here, not cb._home_repo, which is created further down. A session running another agent than its seat's
-- (bound with --agent codex in a claude seat, say) runs that agent's model: null, not judged.
create function cb._expected_model(project text, actor text, role text, area text, repo text, agent text) returns text language plpgsql stable as $$
#variable_conflict use_variable
declare sq jsonb := (select pr.squad from cb.projects pr where pr.slug = project); k text;
begin
  if role = 'lead' then k := '1';
  elsif role = 'owner' then k := area;
  else
    k := (regexp_match(actor, '[ABRQI]([0-9]+)@'))[1];
    if sq->'repos' is not null and role in ('builder', 'reviewer') then
      k := coalesce(nullif(repo, ''), (select h.key from jsonb_each(sq->'repos') h where h.value->>'home' = 'true' limit 1)) || ':' || k;
    end if;
  end if;
  if coalesce(agent, 'claude') <> coalesce(sq->'roles'->role->'seats'->k->>'agent', sq->'roles'->role->>'agent', 'claude') then
    return null;
  end if;
  return coalesce(sq->'roles'->role->'seats'->k->>'model', sq->'roles'->role->>'model', cb._role_model(role, agent));
end $$;

-- Minutes since a session last wrote to the board itself, when that was in the last 30 minutes (the "silent" window of
-- cb tick), else null. Its relay not live plus a number here = the relay is down but the session still acts (#4341):
-- the digest and cb tell say so instead of "down". A lead acting with --as writes as the session too, so callers say
-- "last wrote to the board", never that the session is alive. A follow-up question opening is written as its asker by
-- whoever answered the parent (questions_history, data.opened_by): not the session's write.
create function cb._board_active(who text) returns int language sql stable as $$
  select floor(extract(epoch from now() - max(e.at)) / 60)::int from cb.events e
   where e.actor = who and e.at > now() - interval '30 minutes' and not (e.kind = 'asked' and e.data ? 'opened_by')
$$;

-- What needs the lead in a pipeline project: plain lines, the stage count first, P0 cards next, at most 20. Reads only:
-- it frees nothing and writes nothing on any card.
create function cb.digest(project text, since timestamptz default now() - interval '15 minutes', cap boolean default true) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); head text; rest jsonb;
begin
  select format('Stages: design %s · waiting for Ahmed %s · build %s · review %s · merge %s · QA on dev %s',
                count(*) filter (where t.stage = 'design'), count(*) filter (where t.stage = 'approval'),
                count(*) filter (where t.stage = 'build'), count(*) filter (where t.stage = 'review'),
                count(*) filter (where t.stage = 'merge'), count(*) filter (where t.stage = 'qa'))
    into head from cb.tasks t where t.project = p and t.status not in ('done', 'cancelled');
  with items(grp, p0, id, line) as (
    -- 1: a P0 card created since the last digest, or raised to P0 since (#3221 review), named so the "at once" digest
    -- says what it is about
    select 1, true, t.id, format('#%s is P0: "%s": cb show %s', t.id, left(t.title, 80), t.id)
      from cb.tasks t where t.project = p and t.priority = 'P0' and t.status not in ('done', 'cancelled')
       and (t.created_at > since or exists (select 1 from cb.events e where e.task_id = t.id and e.at > since and e.data -> 'fields' ? 'priority'))
    union all
    -- 2: freed since the last digest
    select 2, t.priority = 'P0', t.id, format('#%s freed from %s (%s): cb session %s', t.id, m[1], m[2], m[1])
      from cb.events e join cb.tasks t on t.id = e.task_id
     cross join lateral regexp_match(e.summary, '^freed from ([^:]+): (.*)$') m
     where e.project = p and e.at > since and e.data ? 'stall' and e.kind <> 'message' and m is not null
    union all
    -- 3: designs waiting for Ahmed
    select 3, bool_or(t.priority = 'P0'), null::bigint,
           format('%s designs wait for Ahmed''s approval, oldest %sh (#%s)', count(*),
                  floor(extract(epoch from now() - min(coalesce(t.stage_since, t.updated_at))) / 3600),
                  (array_agg(t.id order by coalesce(t.stage_since, t.updated_at)))[1])
      from cb.tasks t where t.project = p and t.stage = 'approval' and t.status not in ('done', 'cancelled') having count(*) > 0
    union all
    -- 4: reviewed, waiting for the lead to merge
    select 4, t.priority = 'P0', t.id, format('#%s reviewed: merge it, then cb pass %s "<what merged>" --commit <sha>', t.id, t.id)
      from cb.tasks t where t.project = p and t.stage = 'merge' and t.status not in ('done', 'cancelled')
       and not exists (select 1 from cb.task_parts tp where tp.task_id = t.id)
    union all
    -- 4, a parts card (#3703): a line per part still to merge
    select 4, t.priority = 'P0', t.id,
           format('#%s reviewed: merge %s%s, then cb pass %s "<what merged>" --repo %s --commit <sha>', t.id, tp.repo,
                  coalesce(' (PR #' || substring(tp.pr from '/pull/([0-9]+)') || ')', ''), t.id, tp.repo)
      from cb.tasks t join cb.task_parts tp on tp.task_id = t.id and tp.stage = 'merge'
     where t.project = p and t.stage = 'merge' and t.status not in ('done', 'cancelled')
    union all
    -- 5: answers nobody collected: the lead asked, or the asker's relay has been gone for 10 minutes
    select 5, false, q.id, format('Q%s answered for %s (%s): cb pending', q.id, q.asked_by,
                                  case when cb._role(q.asked_by) = 'lead' then 'asked by the lead' else 'its relay has been down 10 minutes' end)
      from cb.questions q
     where q.project = p and q.status = 'answered' and q.approval_for is null and q.asked_by not in ('ahmed', 'board')
       and q.answered_at > now() - interval '24 hours'  -- as the old copies: older answers are history
       and (cb._role(q.asked_by) = 'lead'
            or not exists (select 1 from cb.sessions s where s.actor = q.asked_by and s.last_seen > now() - interval '10 minutes'))
    union all
    -- 6: design cards no live owner of their area will take
    select 6, t.priority = 'P0', t.id,
           format('#%s has no area owner (tags: %s): an architect takes it after 15 min, or cb tag %s <area>', t.id, array_to_string(t.labels, ', '), t.id)
      from cb.tasks t
     where t.project = p and t.stage = 'design' and t.status = 'next' and nullif(trim(t.assignee), '') is null and cardinality(t.labels) > 0
       and not exists (select 1 from cb.sessions s where s.role = 'owner' and s.project = p and s.area = any(t.labels)
                          and s.last_seen > now() - interval '10 minutes')
    union all
    -- 7: notes the lead should see (small work, taken out of the pipeline, other digest notes)
    select 7, t.priority = 'P0', t.id, format('#%s %s: cb show %s', t.id, e.summary, t.id)
      from cb.events e join cb.tasks t on t.id = e.task_id
     where e.project = p and e.at > since and (e.data ? 'small' or e.data ? 'unstaged' or e.data ? 'digest')
    union all
    -- 8: cards waiting in Next outside the pipeline with nobody to take them (research has its own line below)
    select 8, t.priority = 'P0', t.id,
           -- #4593 review 100 F3: a card kept for an agent says which seat it waits for, in plain words
           case when cardinality(cb._for_agents(t.labels)) > 0
                then format('#%s is waiting for %s%s, or cb edit %s --assignee <session>', t.id, cb._agents_words(cb._for_agents(t.labels)),
                            case when cb._squad_lacks(p, cb._for_agents(t.labels)) then ', and the squad has none: add one to the squad' else ': start one' end, t.id)
                else format('#%s is not staged: cb edit %s --assignee <session>', t.id, t.id) end
      from cb.tasks t
     where t.project = p and t.stage is null and t.status = 'next' and nullif(trim(t.assignee), '') is null and t.type <> 'research'
    union all
    -- 9: a holder whose relay has been gone 10 minutes keeps its cards and parts (Q2324); a name with no session row is a
    -- re-bound pane. With a session row and still writing to the board (cb._board_active): only its relay is down, so
    -- restart that (#4341); a re-bound name's recent writes do not count, nothing runs as it now. Else it is down: cb edit
    -- hands over a card, not a part, so a holder of parts only is restored
    select 9, bool_or(x.p0), min(x.id),
           case when a.mins is not null
                then format('%s''s relay is down, but the session last wrote to the board %sm ago; it holds %s: have it run cb relay --restart (a cb tell to it waits for its relay)',
                            x.holder, a.mins, string_agg(x.what, ', ' order by x.id, x.what))
                else format('%s is down and holds %s: restore it', x.holder, string_agg(x.what, ', ' order by x.id, x.what))
                     || coalesce(', or cb edit ' || min(x.id) filter (where x.repo is null) || ' --assignee <session>', '') end
      from (select t.id, t.priority = 'P0' as p0, t.assignee as holder, null::text as repo, '#' || t.id as what
              from cb.tasks t
             where t.project = p and t.status in ('in_progress', 'next', 'blocked') and nullif(trim(t.assignee), '') is not null
            union all
            select t.id, t.priority = 'P0', h.assignee, h.repo, format('#%s (part %s)', t.id, h.repo)
              from cb._held_parts() h join cb.tasks t on t.id = h.task_id where t.project = p) x
     cross join lateral (select case when exists (select 1 from cb.sessions s where s.actor = x.holder) then cb._board_active(x.holder) end as mins) a
     where not exists (select 1 from cb.sessions s where s.actor = x.holder and s.last_seen > now() - interval '10 minutes')
       and (x.holder like '%@%' or exists (select 1 from cb.sessions s where s.actor = x.holder))
     group by x.holder, a.mins
    union all
    -- 10: a live session on the wrong model for its seat (#4002: the squad's seat or role model, else the role's
    -- default); a session with no model to expect (an agent without a default) is not judged
    select 10, false, null::bigint, format('%s is a %s on %s; the role runs %s: restart it with --model %s',
                                           s.actor, s.role, s.model, w.want, w.want)
      from (select distinct on (s2.actor) s2.actor, s2.role, s2.model, s2.area, s2.repo, s2.agent from cb.sessions s2
             where s2.project = p and s2.role is not null and s2.model is not null and s2.last_seen > now() - interval '10 minutes'
             order by s2.actor, s2.last_seen desc) s
      cross join lateral (select cb._expected_model(p, s.actor, s.role, s.area, s.repo, s.agent) as want) w
     where w.want is not null and s.model not ilike '%' || w.want || '%'
    union all
    -- 11: cards no session can ever take, named instead of left silent
    select 11, bool_or(n.p0), min(n.id), 'nobody can take: ' || string_agg(n.what, ', ' order by n.id)
      from (
        -- a hold by a live session whose role no longer fits the stage
        select t.id, t.priority = 'P0' as p0,
               format('#%s (held by %s, %s, at %s)', t.id, t.assignee,
                      case when cb._role(t.assignee) is null then 'with no role' else 'a ' || cb._role(t.assignee) end, cb._stage_words(t.stage)) as what
          from cb.tasks t
         where t.project = p and t.stage is not null and t.stage <> 'approval' and t.status = 'next' and nullif(trim(t.assignee), '') is not null
           and exists (select 1 from cb.sessions s where s.actor = t.assignee and s.last_seen > now() - interval '10 minutes')
           and not cb._claimable(t, t.assignee)
        union all
        -- an unheld staged card no live session of the project could take, the design wait aside (aged stage_since copy)
        select t.id, t.priority = 'P0', format('#%s (%s, %s)', t.id, cb._stage_words(t.stage),
               case when cardinality(cb._for_agents(t.labels)) > 0 then 'waiting for ' || cb._agents_words(cb._for_agents(t.labels))
                         || case when cb._squad_lacks(p, cb._for_agents(t.labels)) then ': the squad has none' else ': none live can take it' end
                    else 'no live session can take it' end)
          from cb.tasks t
         where t.project = p and t.stage is not null and t.stage <> 'approval' and t.status = 'next' and nullif(trim(t.assignee), '') is null
           -- a parts card (#3703) whose parts at its stage are all held is in work, not waiting
           and not (exists (select 1 from cb.task_parts tp where tp.task_id = t.id and tp.stage = t.stage)
                    and not exists (select 1 from cb.task_parts tp where tp.task_id = t.id and tp.stage = t.stage and tp.assignee is null))
           and not exists (select 1 from cb.sessions s
                            where s.project = p and s.last_seen > now() - interval '10 minutes'
                              and cb._claimable(jsonb_populate_record(null::cb.tasks, to_jsonb(t) || jsonb_build_object('stage_since', now() - interval '1 day')), s.actor))
        union all
        select t.id, t.priority = 'P0', format('#%s (research, no investigator)', t.id)
          from cb.tasks t
         where t.project = p and t.type = 'research' and t.status = 'next' and nullif(trim(t.assignee), '') is null
           and not exists (select 1 from cb.sessions s where s.project = p and s.role = 'investigator' and s.last_seen > now() - interval '10 minutes')
      ) n having count(*) > 0
    union all
    -- 12: what the supervisor did since the last digest, and the sessions it could not keep up (#3601)
    select 12, false, 0::bigint,
           format('supervisor: started %s, closed %s, restored %s (cb sessions %s)',
                  count(*) filter (where e.data ->> 'what' = 'start'), count(*) filter (where e.data ->> 'what' = 'close'),
                  count(*) filter (where e.data ->> 'what' = 'restore'), p)
      from cb.events e where e.project = p and e.kind = 'supervisor' and e.at > since having count(*) > 0
    union all
    select 12, false, e.id, (e.data ->> 'session') || case e.data ->> 'what' when 'down_again' then ' down again' when 'failed' then ' failed to start'
                                                        when 'quota' then ' stopped by its quota' else ' blocked' end
                            || coalesce(': ' || (e.data ->> 'note'), '')
      from cb.events e where e.project = p and e.kind = 'supervisor' and e.at > since and e.data ->> 'what' in ('down_again', 'blocked', 'failed', 'quota')
    union all
    -- 13: a staged card no builder or reviewer takes because it names no repo, in a project of several (#3703)
    -- (several repos open parts only at build: at review the lead names one)
    select 13, t.priority = 'P0', t.id,
           format('#%s has no repo: cb edit %s --repo %s', t.id, t.id, case when t.stage = 'review' then '<repo>' else '<repo,repo>' end)
      from cb.tasks t
     where t.project = p and t.stage in ('build', 'review') and t.status not in ('done', 'cancelled')
       and cardinality(coalesce(t.repos, '{}')) = 0 and cb._multi_repo(p)
       and not exists (select 1 from cb.task_parts tp where tp.task_id = t.id)
    union all
    -- 14: a parts card at build or review, its parts in plain words (#3703)
    select 14, t.priority = 'P0', t.id, format('#%s %s', t.id, cb._parts_words(t.id))
      from cb.tasks t
     where t.project = p and t.stage in ('build', 'review') and t.status not in ('done', 'cancelled')
       and exists (select 1 from cb.task_parts tp where tp.task_id = t.id))
  -- at most 5 lines per group (the last says +N more), then 19 lines in all with a closing "+N more" line: no group buries another
  , capped as (
    select x.grp, x.p0, x.id,
           case when cap and x.rn = 5 and x.cnt > 5 then x.line || format(' +%s more (cb digest %s --all)', x.cnt - 5, p) else x.line end as line,
           case when cap and x.rn = 5 and x.cnt > 5 then x.cnt - 5 else 0 end as hid
      from (select i.*, row_number() over (partition by i.grp order by i.p0 desc, i.id, i.line) rn, count(*) over (partition by i.grp) cnt from items i) x
     where not cap or x.rn <= 5),
  ranked as (select c.*, row_number() over (order by c.p0 desc, c.grp, c.id, c.line) o, count(*) over () total from capped c)
  select coalesce(jsonb_agg(r.line order by r.o) filter (where not cap or r.total <= 19 or r.o <= 18), '[]')
         || case when cap and max(r.total) > 19
                 then jsonb_build_array(format('+%s more: cb digest %s --all', max(r.total) - 18 + coalesce(sum(r.hid) filter (where r.o > 18), 0), p))
                 else '[]'::jsonb end
    into rest from ranked r;
  return jsonb_build_array(head) || rest;
end $$;

-- The 60 s tick. A pipeline project with a lead seen in the last day gets a digest when 15 minutes have passed since the
-- last one, or a P0 card was created since. Only the stage line = nothing to say: no message, but the time is recorded.
-- The digest is one message to each lead and writes nothing on any card, so it never counts as card activity.
create function cb.digests_due() returns int language plpgsql as $$
declare r record; leads text[]; last_at timestamptz; last_hash text; lines jsonb; txt text; h text; newp0 boolean; l text; n int := 0;
        urgent boolean;
begin
  -- #4559: only enabled projects; after an enable the digest covers the time since then, never the time disabled
  for r in select pr.slug, pr.state_at from cb.projects pr where pr.pipeline and pr.state = 'enabled' loop
    select array_agg(distinct s.actor) into leads from cb.sessions s
     where s.project = r.slug and cb._role(s.actor) = 'lead' and s.last_seen > now() - interval '1 day';
    continue when leads is null;
    select (st.value ->> 'at')::timestamptz, st.value ->> 'hash' into last_at, last_hash from cb.settings st where st.key = 'digest:' || r.slug;
    last_at := greatest(last_at, r.state_at);  -- greatest skips a null: no digest yet, or a state never changed
    -- a card raised to P0 since counts as new too (#3221 review), as cb.digest's first group names it
    newp0 := last_at is not null and exists (select 1 from cb.tasks t where t.project = r.slug and t.priority = 'P0'
                                               and (t.created_at > last_at or exists (select 1 from cb.events e where e.task_id = t.id and e.at > last_at
                                                                                         and e.data -> 'fields' ? 'priority')));
    continue when last_at is not null and last_at > now() - interval '15 minutes' and not newp0;
    lines := cb.digest(r.slug, coalesce(last_at, now() - interval '15 minutes'));
    -- #3221: a digest with a new P0 or a session the supervisor could not keep up is never held by the lead's relay
    urgent := newp0 or exists (select 1 from cb.events e where e.project = r.slug and e.kind = 'supervisor'
                                  and e.at > coalesce(last_at, now() - interval '15 minutes')
                                  and e.data ->> 'what' in ('down_again', 'blocked', 'failed', 'quota'));
    -- the body without its stage line: a byte-identical one is not sent again (a new P0 always is)
    select string_agg(x.v, E'\n' order by x.n) into txt from jsonb_array_elements_text(lines) with ordinality x(v, n) where x.n > 1;
    h := md5(coalesce(txt, ''));
    if jsonb_array_length(lines) > 1 and (h is distinct from last_hash or newp0) then
      txt := (lines ->> 0) || E'\n' || txt;
      foreach l in array leads loop
        insert into cb.events (actor, project, kind, summary, data)
        values ('board', r.slug, 'message', 'Digest for ' || r.slug || E':\n' || txt,
                jsonb_build_object('to', l, 'digest', true) || case when urgent then '{"urgent": true}'::jsonb else '{}' end);
        n := n + 1;
      end loop;
    end if;
    insert into cb.settings (key, value) values ('digest:' || r.slug, jsonb_build_object('at', now(), 'hash', h))
    on conflict (key) do update set value = excluded.value;
  end loop;
  return n;
end $$;

-- ---- agent-native output (#3598): what to run next, in plain words. Agents act on whatever the board prints.
-- The six stage words, as the UI chip shows them (web/src/components/Chips.tsx keeps its own copy).
create function cb._stage_words(stage text) returns text language sql immutable as $$
  select case when $1 is null then 'Not staged' else case $1 when 'design' then 'Design' when 'approval' then 'Waiting for your approval'
    when 'build' then 'Building' when 'review' then 'In review' when 'merge' then 'Merging to dev'
    when 'qa' then 'Checking on dev against the design' else $1 end end
$$;

-- A part hold (#3703) counts exactly like a card's: the part has a holder and is not merged, its card is open and staged.
create function cb._held_parts() returns setof cb.task_parts language sql stable as $$
  select p.* from cb.task_parts p join cb.tasks t on t.id = p.task_id
   where nullif(trim(p.assignee), '') is not null and p.stage <> 'merged' and t.status not in ('done', 'cancelled') and t.stage is not null
$$;

-- #4336: may this card be offered to me as new Next work? Shared by the inbox's next_work and the relay's re-check
-- (cb.work_still_open) so the two cannot drift (review I1): in Next, unassigned or mine, mine to claim, and not an
-- unassigned bug outside a pipeline stage (triage gets those). Whether I am busy is cb._busy, kept apart on purpose:
-- it does not depend on the card, and callers evaluate it once (an uncorrelated subquery), not once per card.
create function cb._offerable(t cb.tasks, me text) returns boolean language sql stable as $$
  select t.status = 'next' and (t.assignee is null or t.assignee = me) and cb._claimable(t, me)
     and not (t.type = 'bug' and t.assignee is null and not (cb._pipeline(t.project) and t.stage is not null))
$$;

-- I have something in progress: a card, or a part (#3703). New Next work is offered only while I have neither.
create function cb._busy(me text) returns boolean language sql stable as $$
  select exists (select 1 from cb.tasks w where w.assignee = me and w.status = 'in_progress')
      or exists (select 1 from cb._held_parts() h where h.assignee = me and h.status = 'in_progress')
$$;

-- #4336: the relay holds a "new work in Next" offer a few seconds (the lead creates a card in Next, then assigns it),
-- then pushes only the cards this returns: those still offerable to me.
create function cb.work_still_open(ids bigint[], actor text) returns bigint[] language sql stable as $$
  select coalesce(array_agg(t.id order by t.id), '{}') from cb.tasks t
   where t.id = any(ids) and cb._offerable(t, actor) and not (select cb._busy(actor))
$$;

-- A parts card in plain words (#3703): its stage, then each part in the design's repo order, e.g.
-- "build: api done (PR #12), dashboard building (zed-dashboard-B1@mac)". null: no parts, or the card is not past approval
-- (parts sent back to design wait for re-approval).
create function cb._parts_words(tid bigint) returns text language sql stable as $$
  select t.stage || ': ' || string_agg(p.repo || ' ' || case
      when p.stage = 'merged' then 'merged'
      when array_position('{build,review,merge}'::text[], p.stage) > array_position('{build,review,merge,qa}'::text[], t.stage)
        then 'done' || coalesce(' (PR #' || substring(p.pr from '/pull/([0-9]+)') || ')', '')
      else case p.stage when 'build' then case when h.held then 'building' else 'waits for a builder' end
                        when 'review' then case when h.held then 'in review' else 'waits for a reviewer' end
                        else 'waits for the lead to merge' end
           || case when h.held then ' (' || p.assignee || ')' else '' end
    end, ', ' order by array_position(t.repos, p.repo), p.repo)
    from cb.tasks t join cb.task_parts p on p.task_id = t.id
   cross join lateral (select nullif(trim(p.assignee), '') is not null as held) h
   where t.id = tid and t.stage in ('build', 'review', 'merge', 'qa')
   group by t.id, t.stage
$$;

-- The command that finishes this card's stage for whoever holds it. a holding a part (#3703): its part's stage, not the
-- card's (a NO-GO on another part may have pulled the card back to build), with --repo.
-- plpgsql, not sql: a sql body is checked at create time, and cb._multi_repo is created further down this file.
create function cb._finish_line(t cb.tasks, a text default null) returns text language plpgsql stable as $$
begin
  return (select coalesce((select case h.stage
      when 'build' then format('cb pass %s "<summary>" --pr <url> --repo %s', t.id, h.repo)
      when 'review' then format('cb pass %s "<verdict>" --repo %s or cb fail %s "<what is wrong>" --repo %s', t.id, h.repo, t.id, h.repo) end
    from cb._held_parts() h where h.task_id = t.id and h.assignee = a and cb._pipeline(t.project) order by h.repo limit 1),
  case when not cb._pipeline(t.project) then format('cb done %s "<summary>"', t.id) else case t.stage
    when 'design' then format('cb page set %s -f page.md, %sthen cb pass %s "<summary>"', t.id,
      case when t.repos is null and cb._multi_repo(t.project) then format('cb edit %s --repo <repo,repo>, ', t.id) else '' end, t.id)
    when 'build' then format('cb pass %s "<summary>" --pr <url>', t.id)
    when 'review' then format('cb pass %s "<verdict>" or cb fail %s "<what is wrong>"', t.id, t.id)
    when 'merge' then case when exists (select 1 from cb.task_parts p where p.task_id = t.id)
      then format('merge each repo''s PR in the design''s order, then cb pass %s "<what merged>" --repo <repo> --commit <sha>', t.id)
      else format('merge it, then cb pass %s "<what merged>" --commit <sha>', t.id) end
    when 'qa' then format('cb pass %s "<checked on dev>" or cb fail %s "<what fails>"', t.id, t.id)
    when 'approval' then format('waiting for Ahmed (Q%s)',
      (select max(q.id) from cb.questions q where q.approval_for = t.id and q.status in ('open', 'answered')))
    else format('cb done %s "<summary>"', t.id) end end));
end
$$;

-- Who takes the card now: its holder by name, a parts card's parts in words (#3703), else the role the stage needs.
create function cb._takes_it(t cb.tasks) returns text language sql stable as $$
  select coalesce(nullif(trim(t.assignee), ''),
    case when cb._pipeline(t.project) and t.stage in ('build', 'review', 'merge') then cb._parts_words(t.id) end, case (case when cb._pipeline(t.project) then t.stage end) when 'design' then 'an owner or architect' when 'approval' then 'Ahmed'
    when 'build' then 'a builder' when 'review' then 'a reviewer' when 'merge' then 'the lead' when 'qa' then 'QA'
    else 'the lead or a session without a role' end)
$$;

-- What cb pass, fail and stage print: where the card went and who takes it (a pipeline that is off leaves cards unstaged).
create function cb.next_step(id text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare t cb.tasks%rowtype; st text; fin boolean;
begin
  select * into t from cb.tasks x where x.id = cb.norm_id(id);
  if not found then raise exception 'task % not found', id; end if;
  fin := t.status = 'done';
  st := case when cb._pipeline(t.project) then t.stage end;
  return jsonb_build_object('id', t.id, 'stage', st, 'stage_words', case when fin then 'Done' else cb._stage_words(st) end,
                            'takes_it', case when not fin then cb._takes_it(t) end);
end $$;

-- The design page as this actor should read it: builders, reviewers and qa get the approved version when there is one.
create function cb._page_for(t cb.tasks, a text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare pg jsonb;
begin
  pg := cb.page_get(task => t.id::text);
  if pg is null then return null; end if;
  if cb._role(a) in ('builder', 'reviewer', 'qa') and pg ->> 'approved_version' is not null then
    return jsonb_build_object('version', pg -> 'approved_version', 'body', pg -> 'approved_body', 'approved', true);
  end if;
  return jsonb_build_object('version', pg -> 'version', 'body', pg -> 'body', 'approved', false);
end $$;

-- After a compaction or restart: everything an agent needs to carry on, in one read.
create function cb.resume(actor text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare a text := coalesce(nullif(trim(actor), ''), nullif(current_setting('cb.actor', true), ''), 'unknown'); s cb.sessions%rowtype;
begin
  select * into s from cb.sessions x where x.actor = a order by x.last_seen desc limit 1;
  -- disabled (#4559): the bound project gets no work, in the words cb start and the SessionStart hook print; absent while enabled
  return case when s.project is not null and not cb._live(s.project) then jsonb_build_object('disabled', cb._wait_words(s.project)) else '{}'::jsonb end
   || jsonb_build_object('actor', a, 'role', cb._role(a), 'area', s.area, 'model', s.model, 'agent', s.agent, 'project', s.project,
    'cards', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'title', t.title, 'stage', case when cb._pipeline(t.project) then (w.v).stage end,
        'stage_words', cb._stage_words(case when cb._pipeline(t.project) then (w.v).stage end), 'status', (w.v).status,
        'finish', cb._finish_line(w.v, a), 'page', cb._page_for(t, a),
        -- a parts card (#3703): the part this actor holds, and every part in words
        'part', case when hp.repo is not null then jsonb_build_object('repo', hp.repo, 'stage', hp.stage, 'pr', hp.pr) end,
        'parts', cb._parts_words(t.id),
        'notes', coalesce((select jsonb_agg(jsonb_build_object('at', n.at, 'actor', n.actor, 'summary', n.summary) order by n.id desc)
                             from (select e.id, e.at, e.actor, e.summary from cb.events e
                                    where e.task_id = t.id and (e.kind in ('note', 'done') or e.data ? 'stage') and e.summary <> ''
                                    order by e.id desc limit 5) n), '[]'),
        'questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'body', q.body, 'status', q.status) order by q.id)
                                 from cb.questions q where q.task_id = t.id and q.status in ('open', 'answered')), '[]'))
      order by t.updated_at desc)
      from cb.tasks t
      left join lateral (select h.repo, h.stage, h.status, h.pr from cb._held_parts() h where h.task_id = t.id and h.assignee = a order by h.repo limit 1) hp on true
      -- the card at the stage and status of the part this actor holds: a reviewer's part may be ahead of the card (a NO-GO
      -- pulled it back), and the card itself stays in Next
      cross join lateral (select jsonb_populate_record(t, jsonb_build_object('stage', coalesce(hp.stage, t.stage), 'status', coalesce(hp.status, t.status))) as v) w
     where (t.assignee = a or hp.repo is not null) and t.status not in ('done', 'cancelled')), '[]'));
end $$;

-- The queue this actor can claim, in claim order: cb.task_claim takes its first row, cb start previews the first few (lim null = all).
create function cb.task_queue(project text, actor text, lim int default 3) returns setof cb.tasks language plpgsql stable as $$
#variable_conflict use_variable
begin
  return query select t.* from cb.tasks t
   where t.status = 'next' and (project is null or t.project = cb.read_project(project)) and (t.assignee is null or t.assignee = actor) and cb._claimable(t, actor)
   order by t.priority <> 'P0', coalesce(cb._pipeline(t.project) and cb._area(actor) = any(t.labels), false) desc,
            case when t.priority <> 'P0' then cb._goal_rank(t.id) end nulls last, t.priority, t.rank, t.id limit lim;
end $$;

-- ---------------------------------------------------------------- Squad kit (#3599)
drop function if exists cb.role_text cascade;
drop function if exists cb.role_text_set cascade;
drop function if exists cb.role_text_page cascade;
drop function if exists cb.role_text_import cascade;
drop function if exists cb._role_project_block cascade;
drop function if exists cb.project_role_set cascade;
drop function if exists cb.project_role_page cascade;

-- Role texts, board-wide. The database owns them (#4332, Q2969): Ahmed edits them on the project settings page
-- (cb.role_text_set). db/roles.ts seeds a role that has no row from prompts/roles/*.md at setup and never overwrites or
-- deletes one. Tests reseed them from the files in freshDb.
create table if not exists cb.role_texts (
  role text primary key,
  body text not null,
  updated_at timestamptz not null default now()
);
alter table cb.role_texts add column if not exists updated_by text;
-- The settings page re-reads the role texts when one changes (another tab, a Load), not on every board event.
create or replace trigger role_texts_notify after insert or update or delete on cb.role_texts
  for each statement execute function cb.notify();
-- Every edit of a role text, with the text before and after (#4332). Seeding a missing role is not an edit.
create table if not exists cb.role_text_edits (
  id     bigint generated always as identity primary key,
  role   text not null,
  before text,
  after  text not null,
  actor  text not null,
  at     timestamptz not null default now()
);
create index if not exists role_text_edits_role on cb.role_text_edits (role, id desc);
-- 'import' for an edit cb.role_text_import made (#4525 review M1); null for one made on the page, so the page can tell
-- a text changed by hand after the last load from one the load itself wrote.
alter table cb.role_text_edits add column if not exists via text;
-- One project's own rules for its seats (Q2992) and who its stuck seats ask first (Q2994), #4525. The board-wide texts
-- above never carry either. No row = no addition and the lead first (how squads ran before the setting). Ahmed sets
-- both on the project settings page (cb.project_role_set); each change is an event with the text before and after.
create table if not exists cb.project_role_settings (
  project    text primary key references cb.projects(slug) on update cascade on delete cascade,
  addition   text not null default '',
  ask_first  text not null default 'lead',
  updated_at timestamptz not null default now(),
  updated_by text
);

-- What a project adds after the board-wide text: a heading, its addition (if any), then who to ask first as the last
-- line (the shared text points there). '' for no project: cb role outside a project prints the board-wide text alone;
-- an unknown one is refused (cb.read_project). The one asked first (the lead, or the named session reading it as actor)
-- is told seats ask it, not to ask itself.
create function cb._role_project_block(role text, project text, actor text default null) returns text language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); s cb.project_role_settings; who text; line text;
begin
  if p is null then return ''; end if;
  select * into s from cb.project_role_settings x where x.project = p;
  who := coalesce(s.ask_first, 'lead');
  line := 'Ask first when stuck or a decision is needed: ' || case
    when (who = 'lead' and role = 'lead') or (who not in ('lead', 'ahmed') and lower(who) = lower(coalesce(actor, '')))
      then 'seats in this project ask you. Decide from Ahmed''s rulings (`cb mem find`); ask him on the board only what you cannot decide.'
    when who = 'lead' then 'the lead (`cb tell <name>`; `cb sessions` names it). The lead decides from Ahmed''s rulings or asks him on the board.'
    when who = 'ahmed' then 'Ahmed, on the board (`cb ask`).'
    else format('%s (`cb tell %s`). It decides or asks Ahmed on the board.', who, who) end;
  return E'\n\n# This project: ' || p || E'\n\n' || case when coalesce(s.addition, '') <> '' then s.addition || E'\n\n' else '' end || line;
end $$;

-- What cb role prints: the rules every role follows, a blank line, the role's own text, then (given a project) that
-- project's addition and who its seats ask first (actor: who reads it, so the one asked first is not told to ask
-- itself). The start hook and cb role both read it, so they print the same.
create function cb.role_text(role text, project text default null, actor text default null) returns text language plpgsql stable as $$
#variable_conflict use_variable
declare t text;
begin
  select r.body into t from cb.role_texts r where r.role = role and r.role <> '_common';
  if t is null then
    raise exception 'unknown role %: one of lead, architect, owner, builder, reviewer, qa, investigator', role;
  end if;
  return coalesce((select c.body || E'\n\n' from cb.role_texts c where c.role = '_common'), '') || t
    || coalesce(cb._role_project_block(role, project, actor), '');
end $$;

-- Ahmed replaces one role's text, or _common (the rules every role follows), for every project (#4332, Q2969). Dashboard
-- only. Kept as given apart from blank lines and spaces at either end. A text the same as the saved one writes nothing.
-- Every change keeps the old and new text (cb.role_text_edits) and writes an event naming that row (role, edit_id and the
-- two lengths: the texts stay in role_text_edits, not doubled into cb.events). Seats read the new text at their next
-- cb role. The cap keeps what every seat reads at start short: the longest file is about 4,000 characters.
create function cb.role_text_set(role text, body text, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text; b text := btrim(coalesce(body, ''), E' \t\r\n'); old text; r cb.role_texts; eid bigint;
begin
  perform cb.dashboard_only('Project settings');
  a := cb.set_actor(actor);
  if role is null or role not in ('_common', 'lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator') then
    raise exception 'unknown role %: one of lead, architect, owner, builder, reviewer, qa, investigator, or _common for the rules every role follows', coalesce(role, 'null');
  end if;
  if b = '' then raise exception 'the text for % is empty: write what this role does', role; end if;
  if length(b) > 8000 then
    raise exception 'the text for % is % characters; the most is 8000 (every seat reads it when it starts: keep it short)', role, length(b);
  end if;
  select x.body into old from cb.role_texts x where x.role = role for update;
  if old is not distinct from b then
    select * into r from cb.role_texts x where x.role = role;
    return jsonb_build_object('role', role, 'body', r.body, 'updated_at', r.updated_at, 'updated_by', r.updated_by, 'changed', false);
  end if;
  insert into cb.role_texts as x (role, body, updated_at, updated_by) values (role, b, now(), a)
    on conflict on constraint role_texts_pkey do update set body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    returning * into r;
  insert into cb.role_text_edits (role, before, after, actor) values (role, old, b, a) returning id into eid;
  insert into cb.events (actor, project, kind, summary, data)
    values (a, null, 'updated', 'role text updated',
            jsonb_build_object('role', role, 'edit_id', eid, 'before_length', length(old), 'after_length', length(b)));
  return jsonb_build_object('role', role, 'body', r.body, 'updated_at', r.updated_at, 'updated_by', r.updated_by, 'changed', true);
end $$;

-- The role texts as stored, for the settings page's editor (cb.role_text joins _common to a role's text, so it can't be
-- edited from): every role's raw text with when and by whom it last changed (updated_by null = seeded from the files),
-- whether its last change was made by hand on the page (edited: not seeded, not a Load the new texts), and the last 20
-- edits with the text before and after.
create function cb.role_text_page() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'roles', coalesce((select jsonb_agg(jsonb_build_object('role', r.role, 'body', r.body, 'updated_at', r.updated_at, 'updated_by', r.updated_by,
                                'edited', coalesce((select e.via is null from cb.role_text_edits e where e.role = r.role order by e.id desc limit 1), false))
                                order by r.role <> '_common', array_position(array['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'], r.role))
                         from cb.role_texts r), '[]'),
    'edits', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'role', e.role, 'actor', e.actor, 'at', e.at, 'before', e.before, 'after', e.after) order by e.id desc)
                         from (select * from cb.role_text_edits x order by x.id desc limit 20) e), '[]'))
$$;

-- Ahmed loads a set of role texts at once (#4525): the "Load the new texts" action on the settings page sends the texts
-- this release ships (prompts/roles), since setup never replaces a stored text (Q2969). One transaction: every text
-- changes or none does, never a new _common beside an old role. Each goes through cb.role_text_set, so each change keeps
-- its text before and after; a text already the same writes nothing. Dashboard only, as role_text_set.
create function cb.role_text_import(texts jsonb, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare k text; changed text[] := '{}'; same int := 0;
begin
  perform cb.dashboard_only('Project settings');
  if jsonb_typeof(texts) is distinct from 'object' or texts = '{}'::jsonb then
    raise exception 'no texts to load: give each role''s text by its name, e.g. {"builder": "..."}';
  end if;
  for k in select x from jsonb_object_keys(texts) x order by x <> '_common', array_position(array['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'], x), x loop
    if jsonb_typeof(texts -> k) is distinct from 'string' then raise exception 'the text for % is not text', k; end if;
    if (cb.role_text_set(k, texts ->> k, actor) ->> 'changed')::boolean then
      changed := changed || k;
      update cb.role_text_edits e set via = 'import' where e.id = (select max(x.id) from cb.role_text_edits x where x.role = k);
    else same := same + 1; end if;
  end loop;
  return jsonb_build_object('changed', to_jsonb(changed), 'unchanged', same);
end $$;

-- Ahmed sets one project's addition and who its stuck seats ask first (#4525, Q2992, Q2994). Dashboard only, as the role
-- texts. null leaves that part as it is; an empty addition removes it. ask_first is lead, ahmed or a session name. The
-- addition has its own cap: with the longest board-wide text it must still fit what the start hook re-injects after a
-- compaction (CAP and RESUME_KEEP in hooks/session-start.mjs; test/role-text-size.test.ts adds them up). A change
-- writes an event with both texts.
create function cb.project_role_set(project text, addition text default null, ask_first text default null, actor text default null)
returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text; p text; s cb.project_role_settings; ad text; who text;
begin
  perform cb.dashboard_only('Project settings');
  a := cb.set_actor(actor);
  p := cb.read_project(project);
  if p is null then raise exception 'say which project'; end if;
  select * into s from cb.project_role_settings x where x.project = p for update;
  ad := coalesce(btrim(addition, E' \t\r\n'), s.addition, '');
  if length(ad) > 1000 then
    raise exception 'the addition for % is % characters; the most is 1000 (every seat of the project reads it when it starts: keep it short)', p, length(ad);
  end if;
  who := coalesce(nullif(btrim(ask_first), ''), s.ask_first, 'lead');
  if lower(who) in ('lead', 'ahmed') then who := lower(who);
  elsif who !~ '^[A-Za-z0-9@._-]{1,64}$' then
    raise exception 'ask first must be lead, ahmed or a session name (letters, digits, @ . _ -, at most 64)';
  end if;
  if ad = coalesce(s.addition, '') and who = coalesce(s.ask_first, 'lead') then
    return jsonb_build_object('project', p, 'addition', ad, 'ask_first', who, 'updated_at', s.updated_at, 'updated_by', s.updated_by, 'changed', false);
  end if;
  insert into cb.project_role_settings as x (project, addition, ask_first, updated_at, updated_by) values (p, ad, who, now(), a)
    on conflict on constraint project_role_settings_pkey do update set addition = excluded.addition, ask_first = excluded.ask_first, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  insert into cb.events (actor, project, kind, summary, data)
    values (a, p, 'updated', 'project role text updated',
            jsonb_build_object('addition_before', coalesce(s.addition, ''), 'addition', ad, 'ask_first_before', coalesce(s.ask_first, 'lead'), 'ask_first', who));
  return jsonb_build_object('project', p, 'addition', ad, 'ask_first', who, 'updated_at', now(), 'updated_by', a, 'changed', true);
end $$;

-- The settings page's read of the two: the stored values (no row = no addition, the lead first), the cap, and the
-- project's recent session names to pick from.
create function cb.project_role_page(project text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); s cb.project_role_settings;
begin
  select * into s from cb.project_role_settings x where x.project = p;
  return jsonb_build_object('project', p, 'addition', coalesce(s.addition, ''), 'ask_first', coalesce(s.ask_first, 'lead'),
    'updated_at', s.updated_at, 'updated_by', s.updated_by, 'cap', 1000,
    'sessions', coalesce((select jsonb_agg(n order by n) from (select distinct x.actor as n from cb.sessions x
                            where x.project = p and x.last_seen > now() - interval '14 days') q), '[]'));
end $$;

-- The squad file: who runs a project's squad, on which machines. null = no squad. Task 4's cb squad up reads it.
drop function if exists cb.squad_set cascade;
drop function if exists cb.squad_get cascade;
drop function if exists cb._repos_of cascade;
drop function if exists cb._home_repo cascade;
drop function if exists cb._multi_repo cascade;
drop function if exists cb._repo cascade;
drop function if exists cb._check_repos cascade;
drop function if exists cb._repo_list cascade;
drop function if exists cb._check_model cascade;
drop function if exists cb._efforts cascade;
drop function if exists cb._check_effort cascade;
drop function if exists cb.machine_models_set cascade;
drop function if exists cb._models_used cascade;
drop function if exists cb._check_seat cascade;
drop function if exists cb._agents_main cascade;
alter table cb.projects add column if not exists squad jsonb;
-- #4332: raised by one on every save that changes the squad; cb.squad_set's base refuses a save made from an older copy
alter table cb.projects add column if not exists squad_version int not null default 0;
-- the History list on the project settings page and the supervisor's last-20-snapshots read (#4332): events has no
-- project index
create index if not exists events_squad_history on cb.events (project, id desc) where kind = 'updated' and summary = 'squad updated';

-- with_version (#4332): the squad with its "version" key (cb squad show --json, edited and given back to cb squad set)
create function cb.squad_get(project text, with_version boolean default false) returns jsonb language sql stable as $$
  select case when with_version and p.squad is not null then p.squad || jsonb_build_object('version', p.squad_version) else p.squad end
    from cb.projects p where p.slug = cb.read_project(project)
$$;

-- A project's repos (#3703), home first, then by name. A squad without repos (or no squad) is one repo: main.
create function cb._repos_of(p text) returns text[] language sql stable as $$
  select coalesce((select array_agg(r.key order by r.value -> 'home' = 'true' desc nulls last, r.key)
                     from cb.projects pr, jsonb_each(pr.squad -> 'repos') r where pr.slug = p), '{main}')
$$;
create function cb._home_repo(p text) returns text language sql stable as $$ select (cb._repos_of(p))[1] $$;
create function cb._multi_repo(p text) returns boolean language sql stable as $$ select cardinality(cb._repos_of(p)) > 1 $$;

-- The repo an actor works in (in project p when given): its latest session's, else that session's project's home repo;
-- no session: p's home repo (main). A stored main the project no longer has (it gained repos after the bind) counts
-- as the home repo; any other stale repo stays as it is: it claims nothing, and the supervisor shows it under that repo.
create function cb._repo(a text, p text default null) returns text language sql stable as $$
  select coalesce((select case when s.repo = any(cb._repos_of(s.project)) or coalesce(s.repo, 'main') <> 'main' then s.repo
                               else cb._home_repo(s.project) end
                     from cb.sessions s where s.actor = a and (p is null or s.project = p) order by s.last_seen desc limit 1),
                  cb._home_repo(p))
$$;

-- Repo names checked against the project's repos; duplicates dropped, given order kept. null or empty: null (not named).
create function cb._check_repos(p text, r text[]) returns text[] language plpgsql stable as $$
declare known text[] := cb._repos_of(p); x text; res text[] := '{}';
begin
  foreach x in array coalesce(r, '{}') loop
    x := trim(x);
    if not coalesce(x = any(known), false) then raise exception 'repo % is not a repo of %: %', x, p, array_to_string(known, ', '); end if;
    if x <> all(res) then res := res || x; end if;
  end loop;
  return nullif(res, '{}');
end $$;

-- A JSON list of repo names (cb add/edit --repo) as text[]; JSON null or absent: null.
create function cb._repo_list(j jsonb) returns text[] language plpgsql immutable as $$
begin
  if j is null or jsonb_typeof(j) = 'null' then return null; end if;
  if jsonb_typeof(j) <> 'array' then raise exception 'repos is a list of repo names, e.g. ["api","dashboard"]'; end if;
  return array(select jsonb_array_elements_text(j));
end $$;

-- The model names already used for each agent, across every saved squad: the settings page's suggestions, and what
-- makes a name that is two of them joined detectable on save (#4717). Per agent: {"claude": ["opus", ...], ...}.
create function cb._models_used() returns jsonb language sql stable as $$
  with sq as (select pr.squad from cb.projects pr where pr.squad is not null),
  r as (select rl.value as v from sq cross join lateral jsonb_each(case when jsonb_typeof(sq.squad->'roles') = 'object' then sq.squad->'roles' else '{}' end) rl),
  specs as (
    select coalesce(r.v->>'agent', 'claude') as agent, r.v->>'model' as model, r.v as v from r
    union all
    select coalesce(se.value->>'agent', r.v->>'agent', 'claude'), se.value->>'model', se.value
      from r cross join lateral jsonb_each(case when jsonb_typeof(r.v->'seats') = 'object' then r.v->'seats' else '{}' end) se
  ),
  pairs as (
    select s.agent, s.model from specs s where s.model is not null
    union
    select f->>'agent', f->>'model' from specs s
      cross join lateral jsonb_array_elements(case when jsonb_typeof(s.v->'fallback') = 'array' then s.v->'fallback' else '[]' end) f
     where f->>'agent' is not null and f->>'model' is not null
  )
  select coalesce((select jsonb_object_agg(z.agent, z.models) from
                   (select p.agent, jsonb_agg(distinct p.model order by p.model) as models from pairs p group by p.agent) z), '{}')
$$;

-- A model for an agent (#4002), refused naming the field (label) and the shape to give. Claude takes its four names;
-- codex and agy a model name, never a Claude one (the slip when only the agent was changed); opencode provider/model.
-- A null model is refused like a wrong one (it would pass not in and !~ silently); a null agent is claude.
-- A value that is two known names joined with no separator (the settings picker's slip, #4717) is refused too: it still
-- fits the shape, but it is not one model. stable: it reads the names already used.
create function cb._check_model(agent text, model text, label text) returns void language plpgsql stable as $$
#variable_conflict use_variable
declare
  known text[]; a text; b text;
begin
  if model is not null then
    known := array(select jsonb_array_elements_text(coalesce(cb._models_used()->coalesce(agent, 'claude'), '[]'::jsonb)));
    foreach a in array known loop
      if a <> model and length(model) > length(a) and left(model, length(a)) = a then
        b := substring(model from length(a) + 1);
        if b = any(known) then
          raise exception '% model "%" is two model names joined (% and %): pick one', label, model, a, b;
        end if;
      end if;
    end loop;
  end if;
  case coalesce(agent, 'claude')
    when 'claude' then
      if model is null or model not in ('opus', 'sonnet', 'haiku', 'fable') then
        raise exception '% model must be opus, sonnet, haiku or fable', label;
      end if;
    when 'codex' then
      if model is null or model !~ '^[a-z0-9][a-z0-9._-]{0,63}$' or model in ('opus', 'sonnet', 'haiku', 'fable') then
        raise exception '% model for codex must be a Codex model name like gpt-6.1-sol: lower-case letters, digits, . _ -, at most 64 characters, not opus, sonnet, haiku or fable', label;
      end if;
    when 'opencode' then
      if model is null or model !~ '^[a-z0-9][a-z0-9._-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$' then
        raise exception '% model for opencode must be provider/model, like anthropic/claude-opus-5-5', label;
      end if;
    when 'agy' then
      if model is null or model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' or model in ('opus', 'sonnet', 'haiku', 'fable') then
        raise exception '% model for agy must be an Antigravity model name like gemini-4-neon-xhigh: letters, digits, . _ -, at most 64 characters, not opus, sonnet, haiku or fable', label;
      end if;
    else
      raise exception '% agent must be one of claude, codex, opencode, agy (got %)', label, to_jsonb(agent);
  end case;
end $$;

-- The agents a seat may run as its main agent (#4332): the save gate's one list (_check_seat), read by the settings page
-- (cb.squad_options). The launch gate is INSTALLED in cli/agents/index.ts; test/settings.test.ts fails when the two differ.
-- All four in every project since #4585 (Q3024).
create function cb._agents_main() returns text[] language sql immutable as $$ select array['claude', 'codex', 'opencode', 'agy']::text[] $$;

-- #4763: the effort levels each agent takes when a seat starts (cli/agents/effort.ts is the same list); none: no effort.
create function cb._efforts() returns jsonb language sql immutable as $$
  select '{"claude": ["low", "medium", "high", "xhigh", "max"], "codex": ["low", "medium", "high", "xhigh", "max", "ultra"],
           "opencode": [], "agy": ["low", "medium", "high", "xhigh", "max"]}'::jsonb
$$;

-- One effort of a role, seat or backup, for the agent it runs. effort is the value as given: a JSON null is refused too.
create function cb._check_effort(agent text, effort jsonb, label text) returns void language plpgsql immutable as $$
declare levels jsonb := cb._efforts()->agent;
begin
  if jsonb_array_length(levels) = 0 then raise exception '% effort: % takes no effort when a seat starts: leave it out', label, agent; end if;
  if jsonb_typeof(effort) is distinct from 'string' or not levels ? (effort #>> '{}') then
    raise exception '% effort for % must be one of % (got %): leave it out for the agent''s own default', label, agent,
      (select string_agg(u.x, ', ' order by u.n) from jsonb_array_elements_text(levels) with ordinality u(x, n)), effort;
  end if;
end $$;

-- One seat's agent, model, effort and fallback (#4002, #4763): a role's own, or a seat's override of its role. ag and mo are what it
-- inherits (for a role: claude and the role's default model). Returns what is saved: the agent only when it differs from
-- the inherited one (so claude, the default, is never written), the model and the effort only when given, the fallback
-- only when it lists some, as {agent, model} entries, each with its effort when it has one.
create function cb._check_seat(spec jsonb, ag text, mo text, label text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare a text := ag; m text := mo; fb jsonb := '[]'; cnt int; x record; k text; pair text; pairs text[] := '{}';
begin
  if spec ? 'agent' then
    if jsonb_typeof(spec->'agent') is distinct from 'string' or spec->>'agent' not in ('claude', 'codex', 'opencode', 'agy') then
      raise exception '% agent must be one of claude, codex, opencode, agy (got %)', label, spec->'agent';
    end if;
    a := spec->>'agent';
    -- only an agent cb can start: a seat saved for another would be refused by squad up and retried by the supervisor
    -- every 10 minutes. A fallback may name any agent: nothing switches to it yet.
    if a <> all(cb._agents_main()) then
      raise exception '% agent "%" cannot be assigned as a primary seat yet (the board starts % only; other agents are allowed in fallback)', label, a, array_to_string(cb._agents_main(), ', ');
    end if;
  end if;
  if spec ? 'model' then
    m := case when jsonb_typeof(spec->'model') = 'string' then spec->>'model' end;
    perform cb._check_model(a, m, label);
  end if;
  if spec ? 'effort' then perform cb._check_effort(a, spec->'effort', label); end if;
  if spec ? 'fallback' then
    -- an if, not OR: jsonb_array_length errors on a non-array, and SQL does not promise OR's order
    if jsonb_typeof(spec->'fallback') is distinct from 'array' then cnt := 6; else cnt := jsonb_array_length(spec->'fallback'); end if;
    if cnt > 5 then
      raise exception '% fallback must be a list of at most 5 {"agent", "model"} entries, like [{"agent": "codex", "model": "gpt-6.1-sol"}]', label;
    end if;
    for x in select e.v, e.n from jsonb_array_elements(spec->'fallback') with ordinality e(v, n) loop
      k := label || ' fallback ' || x.n;
      if jsonb_typeof(x.v) is distinct from 'object' then raise exception '% must be {"agent": "<agent>", "model": "<model>"}', k; end if;
      if exists (select 1 from jsonb_object_keys(x.v) j where j not in ('agent', 'model', 'effort')) then
        raise exception '% has an unknown key: only agent, model and effort', k;
      end if;
      if jsonb_typeof(x.v->'agent') is distinct from 'string' or x.v->>'agent' not in ('claude', 'codex', 'opencode', 'agy') then
        raise exception '% agent must be one of claude, codex, opencode, agy (got %)', k, coalesce(x.v->'agent', 'null');
      end if;
      perform cb._check_model(x.v->>'agent', case when jsonb_typeof(x.v->'model') = 'string' then x.v->>'model' end, k);
      if x.v ? 'effort' then perform cb._check_effort(x.v->>'agent', x.v->'effort', k); end if;
      pair := (x.v->>'agent') || ' ' || (x.v->>'model'); -- another effort makes no other backup: it is the same model
      if x.v->>'agent' = a and x.v->>'model' = m then
        raise exception '% (%) is the same as its own agent and model: a fallback must be another', k, pair;
      end if;
      if pair = any(pairs) then raise exception '% (%) is listed twice', k, pair; end if;
      pairs := pairs || pair;
      fb := fb || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('agent', x.v->>'agent', 'model', x.v->>'model', 'effort', x.v->'effort')));
    end loop;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('agent', nullif(a, ag), 'model', case when spec ? 'model' then m end,
                                              'effort', spec->'effort', 'fallback', nullif(fb, '[]')));
end $$;

-- One machine's model lists (#4763): {"codex"|"opencode"|"agy": [{"id", "efforts"?}]}, as its CLIs printed them. That is
-- outside text: only a name of the agent's own shape is kept, once, in the CLI's order, with the efforts the agent takes.
-- A list with no name kept leaves the one saved before. Returns how many were kept per agent.
create function cb.machine_models_set(machine text, lists jsonb, actor text) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare m text := lower(trim(coalesce(machine, ''))); r record; kept jsonb; shape text; res jsonb := '{}';
begin
  if coalesce(trim(actor), '') = '' then raise exception 'actor is required'; end if;
  perform cb.not_ahmed(actor);
  if m !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    raise exception 'machine must be a machine name (letters, digits, . _ -, at most 64): give it with --machine';
  end if;
  if jsonb_typeof(lists) is distinct from 'object' or lists = '{}' then raise exception 'no model list given'; end if;
  for r in select * from jsonb_each(lists) loop
    shape := case r.key when 'codex' then '^[a-z0-9][a-z0-9._-]{0,63}$'
                        when 'opencode' then '^[a-z0-9][a-z0-9._-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$'
                        when 'agy' then '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' end;
    if shape is null then raise exception 'a model list is for codex, opencode or agy (got %)', r.key; end if;
    -- an if, not OR: jsonb_array_length errors on a non-array
    if jsonb_typeof(r.value) is distinct from 'array' then raise exception '% models must be a list of at most 500', r.key; end if;
    if jsonb_array_length(r.value) > 500 then raise exception '% models must be a list of at most 500', r.key; end if;
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', d.v->>'id', 'efforts',
             (select jsonb_agg(l.x order by l.n) from jsonb_array_elements_text(cb._efforts()->r.key) with ordinality l(x, n)
               where jsonb_typeof(d.v->'efforts') = 'array' and (d.v->'efforts') ? l.x))) order by d.n), '[]')
      into kept
      from (select distinct on (e.v->>'id') e.v, e.n from jsonb_array_elements(r.value) with ordinality e(v, n)
             where jsonb_typeof(e.v->'id') = 'string' and e.v->>'id' ~ shape and e.v->>'id' not in ('opus', 'sonnet', 'haiku', 'fable')
             order by e.v->>'id', e.n) d;
    res := res || jsonb_build_object(r.key, jsonb_array_length(kept));
    if kept <> '[]' then
      insert into cb.machine_models as mm (machine, agent, models, reported_by) values (m, r.key, kept, actor)
        on conflict on constraint machine_models_pkey do update set models = excluded.models, reported_at = now(), reported_by = excluded.reported_by;
    end if;
  end loop;
  return res;
end $$;

-- Validate, complete (areas always there, every model filled) and save. Ahmed (dashboard) or the lead only.
-- Every refusal names the field. base (#4332): the version the caller's copy was taken at (cb.squad_get with_version,
-- cb.squad_page); another version is refused, so a page or a file can't silently undo a save made since. null skips the
-- check (a CLI from before it). A save that changes nothing writes nothing and keeps the version. Returns the saved squad;
-- with_version adds "version" (as saved now) and "changed" (false for a no-op), from the same locked read, for cb squad set
-- and the page. base and with_version are after actor: callers pass actor third by position.
create function cb.squad_set(project text, squad jsonb, actor text default null, base int default null,
                             with_version boolean default false) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare
  a text := cb.set_actor(actor); p text := cb.read_project(project);
  r record; m record; ar jsonb; seen text[] := '{}'; c int; mac int := 0; n_areas int;
  areas jsonb; roles jsonb := '{}'; ns jsonb;
  -- repos (#3703): rp as given, rs as saved (home on every repo), hm the home repo, area_repos the areas' repos
  rp jsonb := squad->'repos'; rs jsonb := '{}'; x record; hm text; nm text; keys text; need text[]; area_repos text[] := '{}';
  busy text;  -- the open cards that hold a repo the new squad drops
  -- #4002: rv a role's agent, model and fallback as saved; st its seats as saved, sk the seat keys it has; se, sv a seat
  rv jsonb; st jsonb; sk text[]; se record; sv jsonb;
  cur jsonb; ver int;  -- #4332: the squad and version saved now
begin
  if not cb._is_dashboard() and cb._role(a) is distinct from 'lead' then raise exception 'only Ahmed or the lead sets the squad'; end if;
  if p is null then raise exception 'project is required'; end if;
  if jsonb_typeof(squad) is distinct from 'object' or jsonb_typeof(squad->'machines') is distinct from 'object'
     or jsonb_typeof(squad->'roles') is distinct from 'object' then
    raise exception 'squad needs machines and roles objects';
  end if;
  if exists (select 1 from jsonb_object_keys(squad) k where k not in ('machines','roles','areas','supervise','repos','protected')) then
    raise exception 'squad has an unknown key: only machines, roles, areas and supervise (and repos, for a project of several repos; protected, the branches no session may push to)';
  end if;
  -- protected (#3746): branch names or * globs the push hook fences (CB_PROTECTED_BRANCHES, comma-joined: no commas)
  if squad ? 'protected' then
    -- a non-array gets the same refusal (c 31). An if, not OR: jsonb_array_length errors on a non-array, and SQL
    -- does not promise OR's order
    if jsonb_typeof(squad->'protected') is distinct from 'array' then c := 31; else c := jsonb_array_length(squad->'protected'); end if;
    if c > 30 then raise exception 'protected: give a list of at most 30 branch names or globs, like ["development", "releases/*"]'; end if;
    for ar in select jsonb_array_elements(squad->'protected') loop
      if jsonb_typeof(ar) is distinct from 'string' or length(ar #>> '{}') > 100 or (ar #>> '{}') !~ '^[A-Za-z0-9._/*][A-Za-z0-9._/*-]*$' then
        raise exception 'protected: % is not a branch name or glob: give names like "development" or "releases/*" (letters, digits, . _ / * -, at most 100 characters, not starting with -)', ar;
      end if;
      -- the push hook compares branch names (it strips refs/heads/ and heads/ from what is pushed): an entry with a ref
      -- or remote prefix, or a trailing /, could never match, and the fence would silently hold nothing (C11)
      if (ar #>> '{}') ~ '^(refs|heads|origin)/' or (ar #>> '{}') ~ '/$' then
        raise exception 'protected: give the branch name as git shows it, like "development" or "releases/*", not %', ar;
      end if;
    end loop;
  end if;
  -- "repos": null is a mistake, not "no repos": refused here, before a machine's repo is judged against it
  if squad ? 'repos' and jsonb_typeof(squad->'repos') is distinct from 'object' then
    raise exception 'repos must be an object of repos: {"<name>": {"home": true, "paths": {"<machine>": "<absolute path>"}}}';
  end if;
  if squad ? 'supervise' and jsonb_typeof(squad->'supervise') is distinct from 'boolean' then
    raise exception 'supervise must be true or false';
  end if;
  areas := coalesce(squad->'areas', '[]'::jsonb);
  if jsonb_typeof(areas) is distinct from 'array' then raise exception 'areas must be a list'; end if;
  for m in select * from jsonb_each(squad->'machines') loop
    if jsonb_typeof(m.value) is distinct from 'object' then raise exception 'machine % must be an object', m.key; end if;
    if rp is not null and m.value ? 'repo' then raise exception 'machine % repo: with repos, each repo lists its own paths', m.key; end if;
    if exists (select 1 from jsonb_object_keys(m.value) k where k not in ('herdr','repo','board','workspace')) then
      raise exception 'machine % has an unknown key: only herdr, repo, board and workspace', m.key;
    end if;
    -- workspace (#3719): the herdr workspace label new sessions open in; passed as one argument, never through a shell
    if m.value ? 'workspace' and (jsonb_typeof(m.value->'workspace') is distinct from 'string'
       or length(m.value->>'workspace') not between 1 and 64 or m.value->>'workspace' ~ '[[:cntrl:]]'
       or btrim(m.value->>'workspace') <> m.value->>'workspace' or m.value->>'workspace' like '-%') then
      raise exception 'machine % workspace must be a herdr workspace label: 1 to 64 characters, no control characters, no space at either end, not starting with -', m.key;
    end if;
    if m.key !~ '^[a-z][a-z0-9-]{0,31}$' then raise exception 'machine % must be a slug: lower-case letters, digits, dashes', m.key; end if;
    if not (m.value ? 'herdr') then raise exception 'machine % needs a herdr key: the herdr machine name, or null for this PC', m.key; end if;
    if jsonb_typeof(m.value->'herdr') not in ('string', 'null') then raise exception 'machine % herdr must be a text or null', m.key; end if;
    if rp is null and (jsonb_typeof(m.value->'repo') is distinct from 'string' or m.value->>'repo' = '') then raise exception 'machine % needs a repo', m.key; end if;
    if jsonb_typeof(m.value->'board') is distinct from 'string' or m.value->>'board' = '' then raise exception 'machine % needs a board', m.key; end if;
    -- absolute, no spaces or shell characters: these go into a herdr command line (a ~ would not expand there)
    if rp is null and (m.value->>'repo' !~ '^(/|[A-Za-z]:[/\\])' or m.value->>'repo' ~ '[[:space:];&|$`<>()''"*?~]') then
      raise exception 'machine % repo must be an absolute path with no spaces, ~ or shell characters', m.key;
    end if;
    if m.value->>'board' !~ '^(/|[A-Za-z]:[/\\])' or m.value->>'board' ~ '[[:space:];&|$`<>()''"*?~]' then
      raise exception 'machine % board must be an absolute path with no spaces, ~ or shell characters', m.key;
    end if;
  end loop;
  -- repos: each a slug with a path per machine (the machine repo rule), exactly one home (a lone repo is home by default)
  if rp is not null then
    if jsonb_typeof(rp) is distinct from 'object' or rp = '{}' then
      raise exception 'repos must be an object of repos: {"<name>": {"home": true, "paths": {"<machine>": "<absolute path>"}}}';
    end if;
    for m in select * from jsonb_each(rp) loop
      if m.key !~ '^[a-z][a-z0-9-]{0,31}$' then raise exception 'repo % must be a slug: lower-case letters, digits, dashes', m.key; end if;
      if jsonb_typeof(m.value) is distinct from 'object' then raise exception 'repo % must be an object', m.key; end if;
      if exists (select 1 from jsonb_object_keys(m.value) k where k not in ('home','paths')) then
        raise exception 'repo % has an unknown key: only home and paths', m.key;
      end if;
      if m.value ? 'home' and jsonb_typeof(m.value->'home') is distinct from 'boolean' then raise exception 'repo % home must be true or false', m.key; end if;
      if jsonb_typeof(m.value->'paths') is distinct from 'object' then raise exception 'repo % needs paths: {"<machine>": "<absolute path>"}', m.key; end if;
      for x in select * from jsonb_each(m.value->'paths') loop
        if not (squad->'machines' ? x.key) then raise exception 'repo % path on %: % is not in machines', m.key, x.key, x.key; end if;
        if jsonb_typeof(x.value) is distinct from 'string' or (x.value #>> '{}') !~ '^(/|[A-Za-z]:[/\\])' or (x.value #>> '{}') ~ '[[:space:];&|$`<>()''"*?~]' then
          raise exception 'repo % path on % must be an absolute path with no spaces, ~ or shell characters', m.key, x.key;
        end if;
      end loop;
      rs := rs || jsonb_build_object(m.key, jsonb_build_object('home', coalesce((m.value->>'home')::boolean, (select count(*) from jsonb_object_keys(rp)) = 1), 'paths', m.value->'paths'));
    end loop;
    need := array(select k from jsonb_object_keys(rs) k where rs->k->>'home' = 'true');
    if cardinality(need) <> 1 then raise exception 'exactly one repo is home: mark it "home": true (lead, architect, qa and investigator start there)'; end if;
    hm := need[1];
  end if;
  n_areas := jsonb_array_length(areas);
  for ar in select jsonb_array_elements(areas) loop
    if rp is null then
      if jsonb_typeof(ar) is distinct from 'string' or (ar #>> '{}') !~ '^[a-z][a-z0-9-]*$' then
        raise exception 'area % must be a slug: lower-case letters, digits, dashes', ar;
      end if;
      nm := ar #>> '{}';
    else
      if jsonb_typeof(ar) is distinct from 'object' or exists (select 1 from jsonb_object_keys(ar) k where k not in ('name','repo')) then
        raise exception 'area %: with repos, each area is {"name", "repo"}', ar;
      end if;
      nm := ar->>'name';
      if jsonb_typeof(ar->'name') is distinct from 'string' or nm !~ '^[a-z][a-z0-9-]*$' then
        raise exception 'area % must be a slug: lower-case letters, digits, dashes', ar->'name';
      end if;
      if jsonb_typeof(ar->'repo') is distinct from 'string' or not (rp ? (ar->>'repo')) then
        raise exception 'area % names repo %, which is not in repos', nm, coalesce(ar->>'repo', 'null');
      end if;
      if (ar->>'repo') <> all(area_repos) then area_repos := area_repos || (ar->>'repo'); end if;
    end if;
    if nm = any(seen) then raise exception 'area % is listed twice', nm; end if;
    seen := seen || nm;
  end loop;
  for r in select * from jsonb_each(squad->'roles') loop
    if r.key not in ('lead','architect','owner','builder','reviewer','qa','investigator') then
      raise exception 'unknown role %: one of lead, architect, owner, builder, reviewer, qa, investigator', r.key;
    end if;
    if jsonb_typeof(r.value) is distinct from 'object' then raise exception 'role % must be an object', r.key; end if;
    if exists (select 1 from jsonb_object_keys(r.value) k where k not in ('count','model','machine','agent','effort','fallback','seats')) then
      raise exception 'role % has an unknown key: only count, model, machine, agent, effort, fallback and seats', r.key;
    end if;
    -- the role's agent, model, effort and fallback (#4002); its seats once its count is known
    rv := cb._check_seat(r.value, 'claude', cb._role_model(r.key), r.key);
    if jsonb_typeof(r.value->'machine') is distinct from 'string' or not (squad->'machines' ? (r.value->>'machine')) then
      raise exception '% machine is not in machines', r.key;
    end if;
    if r.key = 'owner' then
      if r.value ? 'count' then raise exception 'owner takes no count: one owner per area'; end if;
      c := n_areas;
      need := area_repos;  -- an owner starts in its area's repo
    elsif rp is not null and r.key in ('builder', 'reviewer') then
      -- repo-bound: a count per repo
      if jsonb_typeof(r.value->'count') is distinct from 'object' or r.value->'count' = '{}' then
        raise exception '% count must be a count per repo: {"<repo>": 1-8}', r.key;
      end if;
      c := 0;
      for x in select * from jsonb_each(r.value->'count') loop
        if not (rp ? x.key) then raise exception '% count names repo %, which is not in repos', r.key, x.key; end if;
        if jsonb_typeof(x.value) is distinct from 'number' or (x.value #>> '{}') !~ '^[1-8]$' then
          raise exception '% count for % must be a whole number from 1 to 8', r.key, x.key;
        end if;
        c := c + (x.value #>> '{}')::int;
      end loop;
      need := array(select jsonb_object_keys(r.value->'count'));
    else
      if jsonb_typeof(r.value->'count') is distinct from 'number' or (r.value->>'count') !~ '^[1-8]$' then
        raise exception '% count must be a whole number from 1 to 8', r.key;
      end if;
      c := (r.value->>'count')::int;
      if r.key = 'lead' and c <> 1 then raise exception 'lead count must be 1'; end if;
      need := array[hm];  -- project-wide: starts in the home repo
    end if;
    -- every session starts inside its repo: the role's machine needs a path in each repo it works in
    if rp is not null then
      foreach nm in array need loop
        if not (rp->nm->'paths' ? (r.value->>'machine')) then raise exception 'repo % has no path on %', nm, r.value->>'machine'; end if;
      end loop;
    end if;
    -- seats (#4002), each overriding the role's agent, model, effort or fallback, keyed as wantList (cli/squad-up.ts) names its
    -- sessions: the lead 1, an owner its area, a builder or reviewer with repos <repo>:<n> (the home repo's too), any
    -- other 1..count. A seat left with nothing of its own is not saved, nor is an empty seats map.
    st := '{}';
    if r.value ? 'seats' then
      if jsonb_typeof(r.value->'seats') is distinct from 'object' then
        raise exception '% seats must be an object of seats: {"<seat>": {"agent", "model", "effort", "fallback"}}, a seat named 1, 2 ... (with repos <repo>:1, for an owner its area)', r.key;
      end if;
      if r.key = 'owner' then sk := seen;
      elsif rp is not null and r.key in ('builder', 'reviewer') then
        sk := array(select cn.key || ':' || g from jsonb_each(r.value->'count') cn cross join generate_series(1, (cn.value #>> '{}')::int) g order by cn.key, g);
      else sk := array(select g::text from generate_series(1, c) g); end if;
      for se in select * from jsonb_each(r.value->'seats') loop
        if se.key <> all(sk) then raise exception '% seat % is not one of its seats: %', r.key, se.key, array_to_string(sk, ', '); end if;
        if jsonb_typeof(se.value) is distinct from 'object' then raise exception '% seat % must be an object: {"agent", "model", "effort", "fallback"}', r.key, se.key; end if;
        if se.value = '{}' then raise exception '% seat % is empty: give agent, model, effort or fallback', r.key, se.key; end if;
        if exists (select 1 from jsonb_object_keys(se.value) k where k not in ('agent', 'model', 'effort', 'fallback')) then
          raise exception '% seat % has an unknown key: only agent, model, effort and fallback', r.key, se.key;
        end if;
        sv := cb._check_seat(se.value, coalesce(rv->>'agent', 'claude'), coalesce(r.value->>'model', cb._role_model(r.key)), r.key || ' seat ' || se.key);
        if sv <> '{}' then st := st || jsonb_build_object(se.key, sv); end if;
      end loop;
    end if;
    if squad->'machines'->(r.value->>'machine')->>'herdr' = 'macbook' then mac := mac + c; end if; -- the Mac cap counts by herdr label, whatever the key
    roles := roles || jsonb_build_object(r.key,
      jsonb_strip_nulls(jsonb_build_object('count', r.value->'count', 'model', coalesce(r.value->>'model', cb._role_model(r.key)), 'machine', r.value->>'machine'))
      || rv || case when st <> '{}' then jsonb_build_object('seats', st) else '{}'::jsonb end);
  end loop;
  if (roles ? 'owner') and n_areas = 0 then raise exception 'owner needs areas: list the areas the owners hold'; end if;
  if n_areas > 0 and not (roles ? 'owner') then raise exception 'areas need an owner role: one owner per area'; end if;
  -- a part with nobody to review it would sit in review forever
  if rp is not null then
    select min(k) into nm from jsonb_object_keys(coalesce(roles->'builder'->'count', '{}')) k where not coalesce(roles->'reviewer'->'count' ? k, false);
    if nm is not null then raise exception 'repo % has builders but no reviewers: add a reviewer count for %', nm, nm; end if;
  end if;
  if mac > 8 then raise exception 'macbook would run % sessions; the cap is 8', mac; end if;
  -- herdr names are at most 32 characters (cli/squad-up.ts herdrName maps one character to one): each role's longest
  -- session name must fit. Home repo <p>-B2@m, another repo <p>-<repo>-B2@m (builders and reviewers only: project-wide
  -- roles are always <p>-Q1@m), owners <p>-O-<area>@m, the lead orch@m, or <p>-orch@m when orch@m leads another
  -- project (#3746).
  -- #3779: with each name, the keys that make it up, so the error names the fix for that name
  select sn, ks into nm, keys from (
      select 'orch@' || (roles->'lead'->>'machine') as sn, 'machine' as ks where roles ? 'lead'
      union all
      select p || '-orch@' || (roles->'lead'->>'machine'), 'project or machine' where roles ? 'lead'
      union all
      select p || '-O-' || coalesce(ae ->> 'name', ae #>> '{}') || '@' || (roles->'owner'->>'machine'), 'project, area or machine'
        from jsonb_array_elements(areas) ae where roles ? 'owner'
      union all
      select p || '-' || case when rp is null or cn.key = hm or rl.role not in ('builder', 'reviewer') then '' else cn.key || '-' end || rl.letter || cn.value || '@' || (roles->rl.role->>'machine'),
             case when rp is null or cn.key = hm or rl.role not in ('builder', 'reviewer') then 'project or machine' else 'project, repo or machine' end
        from (values ('architect', 'A'), ('builder', 'B'), ('reviewer', 'R'), ('qa', 'Q'), ('investigator', 'I')) rl(role, letter)
        cross join lateral jsonb_each_text(case when jsonb_typeof(roles->rl.role->'count') = 'object' then roles->rl.role->'count'
                                                else jsonb_build_object('main', roles->rl.role->'count') end) cn
       where roles ? rl.role) z
   where length(sn) > 32 limit 1;
  if nm is not null then raise exception 'session name % is over herdr''s 32 characters: use a shorter % key', nm, keys; end if;
  -- a repo open work names stays (dropped or renamed, its cards and parts could never be claimed); flat is the one repo
  -- main. Adding repos is free.
  need := case when rp is null then '{main}' else array(select jsonb_object_keys(rs)) end;
  select z.r, string_agg('#' || z.id, ', ' order by z.id) filter (where z.n <= 5) into nm, busy
    from (select w.r, w.id, row_number() over (partition by w.r order by w.id) as n
            from (select u.r, t.id from cb.tasks t cross join lateral unnest(t.repos) u(r)
                   where t.project = p and t.status not in ('done', 'cancelled')
                  union
                  select tp.repo, t.id from cb.task_parts tp join cb.tasks t on t.id = tp.task_id
                   where t.project = p and t.status not in ('done', 'cancelled')) w
           where w.r <> all(need)) z
   group by z.r order by z.r limit 1;
  if nm is not null then raise exception 'repo % still has open work (%): finish or move those cards first', nm, busy; end if;
  ns :=jsonb_build_object('machines', squad->'machines', 'roles', roles, 'areas', areas)
        || case when rp is not null then jsonb_build_object('repos', rs) else '{}'::jsonb end
        || case when squad ? 'supervise' then jsonb_build_object('supervise', squad->'supervise') else '{}'::jsonb end
        || case when squad ? 'protected' then jsonb_build_object('protected', squad->'protected') else '{}'::jsonb end;
  -- the row lock makes the version check and the save one step: two saves from the same version can't both pass
  select pr.squad, pr.squad_version into cur, ver from cb.projects pr where pr.slug = p for update;
  if base is not null and base <> ver then
    raise exception 'Someone changed this squad since your copy was taken (it is now version %, your copy is version %). Load it again (reopen the page, or cb squad show % --json), make your change there and save.', ver, base, p;
  end if;
  -- nothing changed: no event (the supervisor's 20-snapshot window keeps real versions only) and the same version
  if cur is not distinct from ns then
    return ns || case when with_version then jsonb_build_object('version', ver, 'changed', false) else '{}'::jsonb end;
  end if;
  update cb.projects pr set squad = ns, squad_version = ver + 1 where pr.slug = p;
  -- 'edited' is not an allowed event kind (events_kind_check); 'updated' is. via: the dashboard (page) or a session (cli)
  insert into cb.events (actor, project, kind, summary, data) values (a, p, 'updated', 'squad updated',
    jsonb_build_object('squad', ns, 'version', ver + 1, 'via', case when cb._is_dashboard() then 'page' else 'cli' end));
  return ns || case when with_version then jsonb_build_object('version', ver + 1, 'changed', true) else '{}'::jsonb end;
end $$;

-- ---------------------------------------------------------------- Project settings page (#4332)
-- The page reads cb.squad_options and cb.squad_page and saves the squad through cb.squad_set (with base), role texts
-- through cb.role_text_set, the pipeline through cb.project_pipeline, reminders through cb.task_ping_bulk and GitHub
-- watches through the cb.github_* functions below (shared with cb github, #4523).
drop function if exists cb._seat_want cascade;
drop function if exists cb.squad_options cascade;
drop function if exists cb.squad_page cascade;
drop function if exists cb._github_guard cascade;
drop function if exists cb.github_watch_add cascade;
drop function if exists cb.github_watch_remove cascade;
drop function if exists cb.github_mute cascade;
drop function if exists cb.github_watches cascade;

-- What a session's seat should run: its seat key (as cb._expected_model reads it), the seat's agent (else the role's, else
-- claude) and the seat's model (else the role's, else the role default for that agent). Unlike cb._expected_model it
-- answers for any agent, so the page can say "should be Codex" when a seat runs Claude.
create function cb._seat_want(project text, actor text, role text, area text, repo text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare sq jsonb := (select pr.squad from cb.projects pr where pr.slug = project); k text; ag text;
begin
  if role is null then return null; end if;
  if role = 'lead' then k := '1';
  elsif role = 'owner' then k := area;
  else
    k := (regexp_match(actor, '[ABRQI]([0-9]+)@'))[1];
    if sq->'repos' is not null and role in ('builder', 'reviewer') then
      k := coalesce(nullif(repo, ''), (select h.key from jsonb_each(sq->'repos') h where h.value->>'home' = 'true' limit 1)) || ':' || k;
    end if;
  end if;
  ag := coalesce(sq->'roles'->role->'seats'->k->>'agent', sq->'roles'->role->>'agent', 'claude');
  return jsonb_build_object('seat', k, 'agent', ag,
    'model', coalesce(sq->'roles'->role->'seats'->k->>'model', sq->'roles'->role->>'model', cb._role_model(role, ag)));
end $$;

-- What the page's form offers, with the same limits as cb.squad_set: the roles, the agents (main = may run a seat now;
-- any may be a backup), Claude's models, each role's default model, the limits, the patterns machine keys, repo names and
-- paths must match, the model names already used in any squad (per agent, for suggestions) and the machines already
-- used in any squad (to add one to another project).
create function cb.squad_options() returns jsonb language sql stable as $$
  with sq as (select pr.squad from cb.projects pr where pr.squad is not null)
  select jsonb_build_object(
    'roles', to_jsonb(array['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator']),
    'repo_bound_roles', to_jsonb(array['builder', 'reviewer']),
    'agents', (select jsonb_agg(jsonb_build_object('agent', g, 'main', g = any(cb._agents_main())) order by n)
                 from unnest(array['claude', 'codex', 'opencode', 'agy']) with ordinality u(g, n)),
    'claude_models', to_jsonb(array['opus', 'sonnet', 'haiku', 'fable']),
    'efforts', cb._efforts(),
    'machine_models', coalesce((select jsonb_object_agg(z.machine, z.agents) from
                        (select mm.machine, jsonb_object_agg(mm.agent, jsonb_build_object('models', mm.models, 'at', mm.reported_at)) as agents
                           from cb.machine_models mm group by mm.machine) z), '{}'),
    'default_models', (select jsonb_object_agg(x, cb._role_model(x)) from unnest(array['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator']) x),
    'limits', jsonb_build_object('count_min', 1, 'count_max', 8, 'lead_count', 1, 'macbook_seats', 8, 'fallbacks', 5,
                                 'session_name', 32, 'protected', 30, 'protected_length', 100, 'workspace_length', 64),
    'patterns', jsonb_build_object('slug', '^[a-z][a-z0-9-]{0,31}$', 'area', '^[a-z][a-z0-9-]*$',
                                   'path', '^(/|[A-Za-z]:[/\\])', 'path_forbidden', '[[:space:];&|$`<>()''"*?~]',
                                   'codex_model', '^[a-z0-9][a-z0-9._-]{0,63}$',
                                   'opencode_model', '^[a-z0-9][a-z0-9._-]{0,31}/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$',
                                   'agy_model', '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
    'models_used', cb._models_used(),
    'machines_used', coalesce((select jsonb_agg(distinct jsonb_build_object('key', m.key) || m.value)
                                 from sq cross join lateral jsonb_each(case when jsonb_typeof(sq.squad->'machines') = 'object' then sq.squad->'machines' else '{}' end) m), '[]'))
$$;

-- Everything the page shows for one project: the squad and its version (give it back as cb.squad_set's base), the
-- pipeline and supervisor switches, the live seats (seen in the last 90 s) with what each runs and should run, the last
-- 20 saved squads (newest first; version and via are null on saves from before #4332) and the reminder counts.
create function cb.squad_page(project text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); sq jsonb; v int;
begin
  if p is null then raise exception 'project is required'; end if;
  select pr.squad, pr.squad_version into sq, v from cb.projects pr where pr.slug = p;
  return jsonb_build_object(
    'project', p, 'squad', sq, 'version', v,
    'pipeline', cb._pipeline(p),
    'supervise', coalesce(sq->>'supervise' = 'true', false),
    -- #4806: one supervisor serves every project, so starting it acts on all of these
    'acts_on', coalesce((select jsonb_agg(jsonb_build_object('project', pr.slug, 'winding_down', not cb._live(pr.slug)) order by pr.slug)
      from cb.projects pr where pr.squad ->> 'supervise' = 'true'), '[]'),
    'seats', coalesce((select jsonb_agg(jsonb_build_object(
        'actor', s.actor, 'machine', s.machine, 'role', s.role, 'area', s.area, 'repo', s.repo,
        'agent', s.agent, 'model', s.model,
        'running_model', cb._running_model(s.machine, s.pane),  -- #4786
        'model_differs', cb._model_differs(s.model, cb._running_model(s.machine, s.pane)),
        'in_squad', coalesce(sq->'roles' ? s.role, false),
        'want_agent', w.want->>'agent', 'want_model', w.want->>'model',
        -- a seat bound without --model is not judged on its model
        'same', case when w.want is null then null
                     else s.agent = w.want->>'agent' and (s.model is null or s.model = w.want->>'model') end,
        'holds', (select count(*) from cb.tasks t where t.assignee = s.actor and t.status not in ('done', 'cancelled')),
        'last_seen', s.last_seen) order by s.role nulls last, s.actor)
      from cb.sessions s
      cross join lateral (select cb._seat_want(p, s.actor, s.role, s.area, s.repo) as want) w
      where s.project = p and s.last_seen > now() - interval '90 seconds'), '[]'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'actor', e.actor,
        'version', e.data->'version', 'via', e.data->'via', 'squad', e.data->'squad') order by e.id desc)
      from (select * from cb.events x where x.project = p and x.kind = 'updated' and x.summary = 'squad updated'
             order by x.id desc limit 20) e), '[]'),
    'reminders', (select jsonb_build_object('open', count(*), 'on', count(tp.task_id))
                    from cb.tasks t left join cb.task_pings tp on tp.task_id = t.id
                   where t.project = p and t.status not in ('done', 'cancelled')));
end $$;

-- GitHub watches (#1207, moved here from cli/cb.ts by #4523/#4332): one cb.settings row per repo, 'github:<owner/repo>',
-- and the muted logins in 'github-muted'; the board server polls them (server/github.ts). What the board watches and whom
-- it tells is Ahmed's call: the same guard as his People and Epics pages (a session pointing it at another repo his gh
-- reads would pour that text onto a board guests see). The refusal never names the way past it: a session (or a comment
-- steering one) would learn it here.
create function cb._github_guard(refusal text) returns void language plpgsql as $$
begin
  perform cb.dashboard_only('GitHub');
exception when raise_exception then
  raise exception '%', refusal;
end $$;

-- Watch a repo, or change a watched one. project: the project its PR cards go in (a new repo needs one: project, else
-- default_project, the project of the pane cb github ran in); tell: the session told (default: the project's one lead);
-- cards_in: more projects whose cards a PR may name (null leaves them, [] clears them). Adding a watched repo again
-- changes only what is given and keeps its checkpoint. A new repo starts now (no backfill). Returns the stored watch.
create function cb.github_watch_add(repo text, project text default null, tell text default null, cards_in jsonb default null,
                                    default_project text default null, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare k text := 'github:' || coalesce(repo, ''); had boolean; proj text; p text; t text := nullif(trim(tell), '');
        leads text[]; also jsonb; patch jsonb; v jsonb; known text;
begin
  -- no part starting with a dot: ../.., .github/x and owner/.. never reach gh as a path
  if repo is null or repo !~ '^[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*$' then
    raise exception '"%" is not owner/repo, e.g. cb github add acme/widgets', coalesce(repo, '');
  end if;
  perform cb._github_guard('only Ahmed adds or removes watched repos: ask him to (cb ask), saying which repo and why');
  perform cb.set_actor(actor);
  perform 1 from cb.settings s where s.key = k for update;
  had := found;
  proj := coalesce(nullif(trim(project), ''), case when not had then nullif(trim(default_project), '') end);
  if not had and proj is null then
    select string_agg(x.slug, ', ' order by x.slug) into known from cb.projects x;
    raise exception 'name the project its PR cards go in: cb github add % --project <project> (known: %)', repo, coalesce(known, 'none yet');
  end if;
  p := case when proj is not null then cb.read_project(proj) end;
  if not had and t is null then
    leads := array(select distinct s.actor from cb.sessions s where s.project = p and cb._is_lead(s.actor, p) order by s.actor);
    if cardinality(leads) > 1 then
      raise exception '% has several leads (%): say which one is told: cb github add % --project % --to <session>', p, array_to_string(leads, ', '), repo, p;
    end if;
    if cardinality(leads) = 0 then
      raise exception '% has no lead session to tell: cb github add % --project % --to <session> (cb sessions lists them)', p, repo, p;
    end if;
    t := leads[1];
  end if;
  if cards_in is not null then
    if jsonb_typeof(cards_in) is distinct from 'array' then raise exception 'cards_in is a list of projects, like ["demo"]'; end if;
    select coalesce(jsonb_agg(cb.read_project(trim(x.v)) order by x.n), '[]') into also
      from jsonb_array_elements_text(cards_in) with ordinality x(v, n) where trim(x.v) <> '';
  end if;
  patch := case when nullif(trim(tell), '') is not null then jsonb_build_object('to', t) else '{}' end
        || case when nullif(trim(project), '') is not null then jsonb_build_object('project', p) else '{}' end
        || case when also is not null then jsonb_build_object('card_projects', also) else '{}' end;
  insert into cb.settings as st (key, value)
    values (k, jsonb_build_object('since', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'to', t, 'project', p)
               || case when also is not null then jsonb_build_object('card_projects', also) else '{}' end
               || jsonb_build_object('last_ok', null, 'last_error', null, 'prs', '{}'::jsonb))
    on conflict on constraint settings_pkey do update set value = st.value || patch
    returning st.value into v;
  return v;
end $$;

-- Stop watching a repo; its cards stay on the board.
create function cb.github_watch_remove(repo text, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
begin
  if repo is null or repo !~ '^[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_-][A-Za-z0-9_.-]*$' then
    raise exception '"%" is not owner/repo, e.g. cb github add acme/widgets', coalesce(repo, '');
  end if;
  perform cb._github_guard('only Ahmed adds or removes watched repos: ask him to (cb ask), saying which repo and why');
  perform cb.set_actor(actor);
  delete from cb.settings s where s.key = 'github:' || repo;
  if not found then raise exception '% is not watched: cb github lists the repos', repo; end if;
  return jsonb_build_object('repo', repo, 'watched', false);
end $$;

-- Mute (mute true) or unmute a GitHub login: its PRs, comments, reviews and commits no longer reach the watch (failed CI
-- runs still do). Ahmed's own workers post as one. Logins are kept lower case, once, sorted. Returns the muted list.
create function cb.github_mute(login text, mute boolean default true, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare l text := lower(coalesce(login, '')); cur jsonb; nxt jsonb;
begin
  if l !~ '^[a-z0-9][a-z0-9-]{0,38}$' then raise exception '"%" is not a GitHub login', coalesce(login, ''); end if;
  perform cb._github_guard('only Ahmed mutes or unmutes GitHub logins: ask him to (cb ask), saying which login and why');
  perform cb.set_actor(actor);
  select coalesce(s.value, '[]') into cur from cb.settings s where s.key = 'github-muted' for update;
  cur := coalesce(cur, '[]');
  if not mute and not (cur ? l) then raise exception '% is not muted: cb github lists the muted logins', l; end if;
  select coalesce(jsonb_agg(x order by x collate "C"), '[]') into nxt
    from (select jsonb_array_elements_text(cur) as x union select l where mute) y where mute or y.x <> l;
  insert into cb.settings as st (key, value) values ('github-muted', nxt)
    on conflict on constraint settings_pkey do update set value = excluded.value;
  return nxt;
end $$;

-- The watches (the repo plus its stored state: to, project, card_projects, since, last_ok, last_error, prs) and the muted
-- logins. project: only the watches whose cards go in it or that log on its cards (cards_in); null: all. Anyone reads.
create function cb.github_watches(project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := case when nullif(trim(project), '') is not null then cb.read_project(project) end;
begin
  return jsonb_build_object(
    'watches', coalesce((select jsonb_agg(jsonb_build_object('repo', substr(s.key, 8)) || s.value order by s.key)
                           from cb.settings s
                          where s.key like 'github:%' and s.key not like 'github:outbox:%'
                            and (p is null or s.value->>'project' = p or coalesce(s.value->'card_projects', '[]') ? p)), '[]'),
    'muted', coalesce((select s.value from cb.settings s where s.key = 'github-muted'), '[]'));
end $$;

-- Build parts (#3703): a card of several repos is built, reviewed and merged one part per repo. The card's stage is its
-- least advanced part's; while it is at build or review the parts are held, never the card. Merge passes per part (the
-- lead, by --repo); qa stays card-level. A card has parts once it entered build with more than one repo, and keeps
-- them through a send back to design (re-approval reopens them). Part rows change only under the card's row lock.
-- (cb.task_parts is created in the pipeline section: stage_pass and stage_fail declare its rowtype)
drop function if exists cb._parts_open cascade;
drop function if exists cb._parts_sync cascade;

-- The card's stage := its least advanced part's (all merged: qa, unassigned). A stage change goes through _stage_move
-- (unheld, Next). The card's status never follows its parts: they carry their own, and a flip would re-rank the card.
-- note and data (links merged into the card) go on the card's history either way, so a part's pass is recorded even
-- when the card stays.
create function cb._parts_sync(tid bigint, note text default null, data jsonb default '{}') returns void language plpgsql as $$
#variable_conflict use_variable
declare cur text; lo int; nxt text;
begin
  select t.stage into cur from cb.tasks t where t.id = tid for update;
  select min(array_position('{build,review,merge,merged}'::text[], p.stage)) into lo from cb.task_parts p where p.task_id = tid;
  if lo is null then return; end if;
  nxt := ('{build,review,merge,qa}'::text[])[lo];
  if nxt is distinct from cur then
    perform cb._stage_move(tid, nxt, null, note, data);
    return;
  end if;
  if note is null then return; end if;
  perform set_config('cb.stage_ok', 'on', true);
  perform set_config('cb.note', note, true);
  perform set_config('cb.data', coalesce(data, '{}')::text, true);
  update cb.tasks t set links = t.links || coalesce(data -> 'links', '{}') where t.id = tid;
  perform set_config('cb.stage_ok', '', true);
  perform set_config('cb.note', '', true);
  perform set_config('cb.data', '', true);
end $$;

-- On entering build: one part per repo at build. A part kept from before goes back to its builder (status next) with its
-- PR, not its commit (its merge needs a new one); a part whose repo left the list is dropped with a note for the lead
-- to close its PR. One repo and no parts: nothing.
create function cb._parts_open(tid bigint) returns void language plpgsql as $$
#variable_conflict use_variable
declare t cb.tasks%rowtype; r record;
begin
  select * into t from cb.tasks x where x.id = tid for update;
  if cardinality(coalesce(t.repos, '{}')) <= 1 and not exists (select 1 from cb.task_parts p where p.task_id = tid) then return; end if;
  -- a holder losing its part is told (never the session acting): its card was never its own, so nothing else reaches it.
  -- No session path leaves a holder here today (--to design frees every part); a dashboard edit could.
  for r in delete from cb.task_parts p where p.task_id = tid and not (p.repo = any(coalesce(t.repos, '{}'))) returning p.repo, p.pr, p.assignee loop
    insert into cb.events (actor, project, task_id, kind, summary, data)
    values (coalesce(nullif(current_setting('cb.actor', true), ''), 'board'), t.project, tid, 'note',
            'part ' || r.repo || ' dropped' || coalesce(': close its PR ' || r.pr, ''), '{"digest": true}');
    if nullif(trim(r.assignee), '') is not null and r.assignee is distinct from current_setting('cb.actor', true) then
      insert into cb.events (actor, project, task_id, kind, summary, data)
      values ('board', t.project, tid, 'message', format('#%s part %s was dropped: you no longer hold it', tid, r.repo),
              jsonb_build_object('to', r.assignee, 'repo', r.repo));
    end if;
  end loop;
  insert into cb.events (actor, project, task_id, kind, summary, data)
  select 'board', t.project, tid, 'message', format('#%s part %s went back to build: you no longer hold it', tid, p.repo),
         jsonb_build_object('to', p.assignee, 'repo', p.repo)
    from cb.task_parts p
   where p.task_id = tid and nullif(trim(p.assignee), '') is not null and p.assignee is distinct from p.crew ->> 'build'
     and p.assignee is distinct from current_setting('cb.actor', true)
   order by p.repo;
  -- a kept part's builder is told (the card stays in Next and unheld: nothing else reaches it); a new part has no holder
  for r in insert into cb.task_parts as p (task_id, repo, stage) select tid, x, 'build' from unnest(t.repos) x
           on conflict (task_id, repo) do update set stage = 'build', status = 'next', assignee = p.crew ->> 'build', commit = null,
                                                     since = now(), nudged_at = null
           returning p.repo, p.assignee loop
    if nullif(trim(r.assignee), '') is not null then
      insert into cb.events (actor, project, task_id, kind, summary, data)
      values ('board', t.project, tid, 'message', format('#%s part %s is back with you at build', tid, r.repo),
              jsonb_build_object('to', r.assignee, 'repo', r.repo));
    end if;
  end loop;
  perform cb._parts_sync(tid);
end $$;



-- PC job runner (#3600): jobs queued on the board, run by a daemon on Ahmed's PC. The daemon connects as application
-- name 'cb-runner/<version>'; runner-only functions refuse any other name (a deterrent like cb-web, not auth).
create table if not exists cb.runners (
  name text primary key, log_url text, started_at timestamptz, last_seen timestamptz
);
-- params: {"<name>": {"min": int, "max": int}} = how many values the recipe takes
create table if not exists cb.runner_recipes (
  runner text references cb.runners(name) on delete cascade, project text, recipe text,
  params jsonb not null default '{}', db boolean not null default false,
  primary key (runner, project, recipe)
);
create table if not exists cb.jobs (
  id bigserial primary key,
  project text not null references cb.projects(slug) on update cascade,
  recipe text not null,
  params jsonb not null default '{}',  -- {"<name>": ["v", ...]}
  sha text not null,
  requester text not null,
  task_id bigint references cb.tasks(id) on delete set null,
  state text not null default 'queued' check (state in ('queued','running','passed','failed','error','cancelled')),
  exit_code int, summary text, runner text,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz
);
create index if not exists jobs_open_idx on cb.jobs (state, id) where state in ('queued','running');
-- several repos in one project (#3703): recipes and jobs belong to a repo; a one-repo project's is main
alter table cb.runner_recipes add column if not exists repo text not null default 'main';
alter table cb.jobs add column if not exists repo text not null default 'main';
-- the key takes the repo (api and dashboard may both offer test). Existing rows are all main, so they stay unique.
do $$ begin
  if not exists (select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                 where c.conrelid = 'cb.runner_recipes'::regclass and c.contype = 'p' and a.attname = 'repo') then
    alter table cb.runner_recipes drop constraint runner_recipes_pkey, add primary key (runner, project, repo, recipe);
  end if;
end $$;
-- The runner queue page (#4527). pos: a job's place once someone moved it (null = its id). A move only hands out keys
-- the moved jobs already held (cb.job_move), so every key is the id of a job that already exists: a job queued later
-- always goes after. retry_of: "Run again" makes a new job and never revives the old one.
alter table cb.jobs add column if not exists pos bigint;
alter table cb.jobs add column if not exists retry_of bigint references cb.jobs(id) on delete set null;
create index if not exists jobs_finished_idx on cb.jobs (finished_at desc) where finished_at is not null;
-- mode: on, paused (stays until resumed) or draining (a pause before a restart: runner_hello ends it). slots/db_lanes:
-- what the runner reported at start (null: a runner from before #4527). slots_set/lanes_set: Ahmed's board setting, the
-- one source the runner reads at start (null: its runner.json); cb.job_claim applies a lower one at once.
alter table cb.runners add column if not exists mode text not null default 'on';
alter table cb.runners add column if not exists mode_by text;
alter table cb.runners add column if not exists mode_at timestamptz;
alter table cb.runners add column if not exists slots int;
alter table cb.runners add column if not exists db_lanes int;
alter table cb.runners add column if not exists slots_set int;
alter table cb.runners add column if not exists lanes_set int;
alter table cb.runners add column if not exists set_by text;
alter table cb.runners add column if not exists set_at timestamptz;
select cb._ensure_check('cb.runners', 'runners_mode_check', $c$mode in ('on', 'paused', 'draining')$c$);
-- the setting's range on the row itself, whatever writes it (the runner builds a slot list of this size; a lane is one
-- digit in its stack's ports). setting_refused: why the runner could not run the board's setting at its last start
-- (null = it ran it, or there is none); the page says so in words.
select cb._ensure_check('cb.runners', 'runners_slots_set_check', $c$slots_set between 1 and 64$c$);
select cb._ensure_check('cb.runners', 'runners_lanes_set_check', $c$lanes_set between 1 and 9$c$);
alter table cb.runners add column if not exists setting_refused text;
-- #4710: seconds between two of the runner's DB test stack starts (null: the runner's default, 30), read at its start:
-- Postgres containers that initialise together miss their health deadline
alter table cb.runners add column if not exists stack_gap_set int;
select cb._ensure_check('cb.runners', 'runners_stack_gap_set_check', $c$stack_gap_set between 0 and 300$c$);
-- A project's lead (or Ahmed) holds that project's waiting jobs; the shared runner keeps serving every other project.
create table if not exists cb.job_holds (
  project text primary key references cb.projects(slug) on update cascade on delete cascade,
  held_by text not null, held_at timestamptz not null default now()
);

drop function if exists cb._is_runner cascade;
drop function if exists cb._runner_only cascade;
drop function if exists cb._job_tell cascade;
drop function if exists cb.job_add cascade;
drop function if exists cb.job_get cascade;
drop function if exists cb.jobs_list cascade;
drop function if exists cb.jobs_ended cascade;
drop function if exists cb.job_cancel cascade;
drop function if exists cb.runner_hello cascade;
drop function if exists cb.runner_reconcile cascade;
drop function if exists cb.runner_beat cascade;
drop function if exists cb.job_claim cascade;
drop function if exists cb.job_finish cascade;
drop function if exists cb._job_check cascade;
drop function if exists cb._job_reply cascade;
drop function if exists cb._lead_by_role cascade;
drop function if exists cb._is_owner cascade;
drop function if exists cb._queue_manager cascade;
drop function if exists cb._supervisor_up cascade;
drop function if exists cb.runner_queue cascade;
drop function if exists cb.job_retry cascade;
drop function if exists cb.job_move cascade;
drop function if exists cb.job_hold cascade;
drop function if exists cb.runner_set cascade;
drop function if exists cb.runner_limits_set cascade;
drop function if exists cb.queue_notify cascade;

create function cb._is_runner() returns boolean language sql stable as $$ select current_setting('application_name') like 'cb-runner%' $$;
create function cb._runner_only() returns void language plpgsql stable as $$
begin
  if not cb._is_runner() then raise exception 'only the runner can do this'; end if;
end $$;

-- "job #N recipe at sha7: state (exit n). summary" + log hint (once it started: no log before), to the requester.
-- A repo other than main is named after the recipe: "job #N test (dashboard) at ..." (#3703).
-- untrusted: the summary is the job's output (code from any origin branch), marked like GitHub lines; the head is not.
-- Best effort: an unknown requester (session gone, no events) must not stop the job from ending.
-- data.task (#3221 review M3): the job's card, so the relay never holds a P0 card's result (data, not task_id: a job
-- result is no activity on the card for the stall and ping clocks).
create function cb._job_tell(j cb.jobs, untrusted boolean default false) returns void language plpgsql as $$
declare new_id bigint;
begin
  new_id := cb.tell(j.requester,
    format('job #%s %s%s at %s: %s%s. %s%s', j.id, j.recipe, case when j.repo <> 'main' then format(' (%s)', j.repo) else '' end, left(j.sha, 7), j.state,
           case when j.exit_code is not null then format(' (exit %s)', j.exit_code) else '' end,
           case when untrusted and coalesce(j.summary, '') <> '' then '[job output · untrusted] ' else '' end, coalesce(j.summary, ''))
    || case when j.started_at is not null then E'\nLog: cb job log ' || j.id else '' end, 'runner');
  begin  -- its own block: a failure here must not take the result back
    if j.task_id is not null then
      update cb.events e set data = e.data || jsonb_build_object('task', j.task_id) where e.id = new_id;
    end if;
  exception when others then null;
  end;
exception when others then null;
end $$;

-- The recipe and parameter checks a new job passes (job_add, and job_retry against the recipe as it is now).
-- A repo no runner offers for the project is refused, naming the ones they have: no fallback to another repo (#3703).
create function cb._job_check(p text, r text, recipe text, params jsonb) returns void language plpgsql stable as $$
#variable_conflict use_variable
declare rp jsonb; k text; spec jsonb; vals jsonb; ev jsonb; lo int; hi int; has text[];
begin
  if jsonb_typeof(params) is distinct from 'object' then raise exception 'params must be an object of lists'; end if;
  has := array(select distinct rr.repo from cb.runner_recipes rr where rr.project = p order by rr.repo);
  if cardinality(has) > 0 and r <> all(has) then raise exception 'the runner has no repo % for %: it has %', r, p, array_to_string(has, ', '); end if;
  select rr.params into rp from cb.runner_recipes rr where rr.project = p and rr.repo = r and rr.recipe = recipe order by rr.runner limit 1;
  if not found then
    raise exception 'no recipe % for % on any runner: see cb jobs', recipe, p || case when r <> 'main' then format(' (%s)', r) else '' end;
  end if;
  for k in select jsonb_object_keys(params) loop
    if not (rp ? k) then raise exception 'unknown parameter % for recipe %', k, recipe; end if;
  end loop;
  for k, spec in select * from jsonb_each(rp) loop
    lo := coalesce((spec->>'min')::int, 0); hi := least(coalesce((spec->>'max')::int, 20), 20);
    vals := coalesce(params->k, '[]'::jsonb);
    if jsonb_typeof(vals) is distinct from 'array' then raise exception 'parameter % must be a list', k; end if;
    if jsonb_array_length(vals) < lo then raise exception '% needs at least % value(s)', k, lo; end if;
    if jsonb_array_length(vals) > hi then raise exception '% takes at most % values', k, hi; end if;
    for ev in select jsonb_array_elements(vals) loop
      if jsonb_typeof(ev) is distinct from 'string' or (ev #>> '{}') !~ '^[A-Za-z0-9@._/-]{1,200}$'
         or (ev #>> '{}') ~ '^[-/]' or (ev #>> '{}') ~ '(^|/)\.\.(/|$)' then
        raise exception 'bad value for %: % (text of letters, digits and @ . _ / - only, no leading - or /, no .. segment)', k, left(ev::text, 60);
      end if;
    end loop;
  end loop;
end $$;

-- What a new job is told about the queue (#4527): how many wait ahead of it in claim order (cb.job_claim: the lowest
-- coalesce(pos, id), then id), and whether nothing will start it for now: every runner that offers it is paused or
-- draining, or its project's jobs are held.
create function cb._job_reply(j cb.jobs) returns jsonb language sql stable as $$
  select jsonb_build_object('id', j.id,
    'ahead', (select count(*)::int from cb.jobs x where x.state = 'queued' and (coalesce(x.pos, x.id), x.id) < (coalesce(j.pos, j.id), j.id)),
    'runner_paused', exists (select 1 from cb.runner_recipes rr where rr.project = j.project and rr.repo = j.repo and rr.recipe = j.recipe)
                     and not exists (select 1 from cb.runner_recipes rr join cb.runners r on r.name = rr.runner
                                     where rr.project = j.project and rr.repo = j.repo and rr.recipe = j.recipe and r.mode = 'on'),
    'held', exists (select 1 from cb.job_holds h where h.project = j.project))
$$;

-- repo null: cb._repo of the actor in this project (its latest session there, else the project's home repo).
create function cb.job_add(project text, recipe text, sha text, params jsonb default '{}', task_id bigint default null, actor text default null,
                           repo text default null)
returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.read_project(project); r text; j cb.jobs;
begin
  if p is null then raise exception 'project is required'; end if;
  -- #4559: refused with words, so cb run --wait never sits silent on a job no runner will take
  if not cb._live(p) then raise exception '%: its runner jobs wait, and no new one is queued until Ahmed enables it', cb._state_words(p); end if;
  if not cb._is_dashboard() and not exists (select 1 from cb.sessions s where s.actor = a and s.project = p and s.last_seen > now() - interval '1 day') then
    raise exception '% has no bound session on % in the last day: only a session of the project, or Ahmed, can queue a job', a, p;
  end if;
  sha := lower(trim(coalesce(sha, '')));
  if sha !~ '^[0-9a-f]{7,40}$' then raise exception 'sha must be 7 to 40 hex characters'; end if;
  params := coalesce(params, '{}'::jsonb);
  r := coalesce(nullif(trim(repo), ''), cb._repo(a, p));
  perform cb._job_check(p, r, recipe, params);
  insert into cb.jobs (project, repo, recipe, params, sha, requester, task_id) values (p, r, recipe, params, sha, a, task_id)
  returning * into j;
  perform pg_notify('cb_jobs', j.id::text);
  return cb._job_reply(j);
end $$;

create function cb.job_get(id bigint) returns jsonb language sql stable as $$
  select to_jsonb(j) from cb.jobs j where j.id = job_get.id
$$;

create function cb.jobs_list(project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project);
begin
  return jsonb_build_object(
    'jobs', coalesce((select jsonb_agg(to_jsonb(j) order by coalesce(j.pos, j.id), j.id) from cb.jobs j -- claim order (#4527)
                      where j.state in ('queued','running') and (p is null or j.project = p)), '[]'::jsonb),
    'runners', coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'last_seen', r.last_seen, 'recipes',
                  coalesce((select jsonb_agg(jsonb_build_object('project', rr.project, 'repo', rr.repo, 'recipe', rr.recipe, 'params', rr.params, 'db', rr.db)
                            order by rr.project, rr.repo, rr.recipe) from cb.runner_recipes rr where rr.runner = r.name), '[]'::jsonb))
                  order by r.name) from cb.runners r), '[]'::jsonb));
end $$;

-- #4732: the newest 20 ended jobs, so a lost job id is looked up, not scanned for. more: older ones were left out
-- (the 21st is read only to know that). summary is the job's output: whoever shows it marks it.
create function cb.jobs_ended(project text default null, requester text default null, task_id bigint default null)
returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); found jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(t) order by t.finished_at desc, t.id desc), '[]'::jsonb) into found from (
    select * from cb.jobs j
     where j.finished_at is not null and (p is null or j.project = p)
       and (requester is null or j.requester = requester) and (task_id is null or j.task_id = task_id)
     order by j.finished_at desc, j.id desc limit 21) t;
  return jsonb_build_object('jobs', found - 20, 'more', jsonb_array_length(found) > 20);
end $$;

create function cb.job_cancel(id bigint, actor text default null) returns void language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); j cb.jobs;
begin
  select * into j from cb.jobs x where x.id = id for update;
  if not found then raise exception 'no job #%: cb jobs lists queued and running jobs, cb jobs --ended the ended ones', id; end if;
  -- #4527: from the dashboard only Ahmed (the Runners page is for every admin, and the web may call this function)
  if not (cb._is_dashboard() and a = 'ahmed') and j.requester <> a
     and not cb._is_lead(a, j.project) then  -- the lead of the job's project
    raise exception 'only the requester, the project''s lead or Ahmed can cancel job #%', id;
  end if;
  if j.state not in ('queued','running') then raise exception 'job #% already ended', id; end if;
  update cb.jobs x set state = 'cancelled', summary = 'cancelled by ' || a, finished_at = now() where x.id = id returning x.* into j;
  perform pg_notify('cb_jobs', id::text);
  -- a lead or Ahmed cancelled it: the requester may be waiting on its end. Last: cb.tell sets the actor to runner.
  if j.requester is distinct from a then perform cb._job_tell(j); end if;
end $$;

-- slots, db_lanes (#4527): what this runner runs at once, as it started (the board setting, else runner.json); a runner
-- from before passes neither and the page says "not reported yet". setting_refused: why it could not run the board's
-- setting (null: it ran it). A restart ends a drain; a pause stays (Q2983).
create function cb.runner_hello(runner text, log_url text, recipes jsonb, slots int default null, db_lanes int default null,
                                setting_refused text default null)
returns int language plpgsql as $$
#variable_conflict use_variable
declare j cb.jobs; n int := 0; r jsonb;
begin
  perform cb._runner_only();
  if jsonb_typeof(coalesce(recipes, '[]'::jsonb)) is distinct from 'array' then raise exception 'recipes must be a list'; end if;
  insert into cb.runners (name, log_url, started_at, last_seen, slots, db_lanes, setting_refused)
  values (runner, log_url, now(), now(), slots, db_lanes, left(setting_refused, 300))
  on conflict (name) do update set log_url = excluded.log_url, started_at = now(), last_seen = now(),
    slots = excluded.slots, db_lanes = excluded.db_lanes, setting_refused = excluded.setting_refused,
    mode = case when cb.runners.mode = 'draining' then 'on' else cb.runners.mode end,
    mode_by = case when cb.runners.mode = 'draining' then null else cb.runners.mode_by end,
    mode_at = case when cb.runners.mode = 'draining' then now() else cb.runners.mode_at end;
  delete from cb.runner_recipes rr where rr.runner = runner_hello.runner;
  for r in select jsonb_array_elements(coalesce(recipes, '[]'::jsonb)) loop
    insert into cb.runner_recipes (runner, project, repo, recipe, params, db)
    values (runner, r->>'project', coalesce(r->>'repo', 'main'), r->>'recipe', coalesce(r->'params', '{}'::jsonb), coalesce((r->>'db')::boolean, false));
  end loop;
  for j in update cb.jobs x set state = 'error', summary = 'error: runner restarted', finished_at = now()
           where x.runner = runner_hello.runner and x.state = 'running' returning x.* loop
    n := n + 1;
    perform cb._job_tell(j);
  end loop;
  return n;
end $$;

-- #3902 review I1: a claim whose reply was lost (the connection died after job_claim committed) leaves a job running
-- that no slot of this runner holds. A restart used to end it (runner_hello); a runner that survives the drop calls this
-- with the jobs its slots hold, from inside its one claim loop (so no claim is in flight), and the rest end.
create function cb.runner_reconcile(runner text, running bigint[]) returns int language plpgsql as $$
#variable_conflict use_variable
declare j cb.jobs; n int := 0;
begin
  perform cb._runner_only();
  for j in update cb.jobs x set state = 'error', summary = 'error: the runner lost the board connection while claiming it', finished_at = now()
           where x.runner = runner_reconcile.runner and x.state = 'running' and not (x.id = any(coalesce(running, '{}'))) returning x.* loop
    n := n + 1;
    perform cb._job_tell(j);
  end loop;
  return n;
end $$;

create function cb.runner_beat(runner text) returns void language plpgsql as $$
begin
  perform cb._runner_only();
  update cb.runners r set last_seen = now() where r.name = runner_beat.runner;
end $$;

-- #4527: nothing while the runner is paused or draining; nothing past Ahmed's slot setting, and no DB job past his lane
-- setting, counted from this runner's running jobs (a lower setting applies here at once; a higher one needs the runner
-- to restart, as it read its slots at start); never a held project's job; the lowest key first (a moved job's pos).
-- A DB job at the front is still passed over while no lane is free, and the plain jobs behind it start.
create function cb.job_claim(runner text, allow_db boolean) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare j cb.jobs; jid bigint; d boolean; rn cb.runners; busy int; busy_db int;
begin
  perform cb._runner_only();
  select * into rn from cb.runners r where r.name = job_claim.runner;
  if found and rn.mode <> 'on' then return null; end if;
  if rn.slots_set is not null or rn.lanes_set is not null then
    select count(*)::int, count(*) filter (where rr.db)::int into busy, busy_db from cb.jobs x
    left join cb.runner_recipes rr on rr.runner = x.runner and rr.project = x.project and rr.repo = x.repo and rr.recipe = x.recipe
    where x.runner = job_claim.runner and x.state = 'running';
    if busy >= coalesce(rn.slots_set, busy + 1) then return null; end if;
    if busy_db >= coalesce(rn.lanes_set, busy_db + 1) then allow_db := false; end if;
  end if;
  select x.id, rr.db into jid, d from cb.jobs x
  join cb.runner_recipes rr on rr.runner = job_claim.runner and rr.project = x.project and rr.repo = x.repo and rr.recipe = x.recipe
  where x.state = 'queued' and (allow_db or not rr.db) and not exists (select 1 from cb.job_holds h where h.project = x.project)
    -- #4559: a project that gets no work keeps its jobs waiting. Its own condition, not a job_holds row a lead could release
    and not exists (select 1 from cb.projects pr where pr.slug = x.project and pr.state <> 'enabled')
  order by coalesce(x.pos, x.id), x.id limit 1 for update of x skip locked;
  if not found then return null; end if;
  update cb.jobs x set state = 'running', runner = job_claim.runner, started_at = now() where x.id = jid returning x.* into j;
  return to_jsonb(j) || jsonb_build_object('db', d);
end $$;

create function cb.job_finish(id bigint, runner text, state text, exit_code int, summary text) returns boolean language plpgsql as $$
#variable_conflict use_variable
declare j cb.jobs; hit text;
begin
  perform cb._runner_only();
  if state not in ('passed','failed','error') then raise exception 'state must be passed, failed or error'; end if;
  if length(coalesce(summary, '')) > 1000 then raise exception 'summary is over 1000 characters'; end if;
  hit := cb._sensitive(summary);
  if hit is not null then raise exception 'the summary looks like %; the board keeps no such text', hit; end if;
  update cb.jobs x set state = job_finish.state, exit_code = job_finish.exit_code, summary = job_finish.summary, finished_at = now()
  where x.id = job_finish.id and x.state = 'running' and x.runner = job_finish.runner returning x.* into j;
  if not found then return false; end if;
  perform cb._job_tell(j, true);
  return true;
end $$;

-- The runner queue page (#4527). Who manages the queue (Q2982): Ahmed, from his dashboard, and each project's lead for
-- that project's jobs only, by the board's one rule for a lead (cb._is_lead: the lead role, or a role-less orch session
-- bound to the project, as job_cancel always had it). Runner-wide state (pause, drain, slots) is Ahmed's alone: the
-- runner serves every project. Deterrents like the rest.
-- exactly ahmed from the dashboard: not cb.ahmed_like, which takes any name holding the word
create function cb._is_owner(a text) returns boolean language sql stable as $$ select cb._is_dashboard() and a = 'ahmed' $$;
create function cb._queue_manager(a text, proj text) returns boolean language sql stable as $$
  select cb._is_owner(a) or cb._is_lead(a, proj)
$$;
-- The supervisor holds the session advisory lock hashtext('cb-supervisor') while it runs (cli/supervise.ts); pg_locks
-- shows it to every role. A bigint key is split into classid (high 32 bits) and objid (low 32 bits), objsubid 1.
create function cb._supervisor_up() returns boolean language sql stable as $$
  select exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.granted and l.objsubid = 1
    and l.database = (select d.oid from pg_database d where d.datname = current_database())
    and l.classid::bigint = ((hashtext('cb-supervisor')::bigint >> 32) & 4294967295)
    and l.objid::bigint = (hashtext('cb-supervisor')::bigint & 4294967295))
$$;

-- Everything the Runners page shows, in one read. project narrows the job lists only: the runners, the counts of the
-- whole queue and every place number stay the machine's, so a wait still makes sense. why: the first reason that stops
-- the job: its project gets no work (#4559: no hold release or runner state would start it), else, over the runners
-- that offer it, the least stopped one counted: held, no runner, not answering (3 minutes
-- without a beat, the supervisor's threshold), paused or draining, no DB lane free, no slot free; else it starts next.
-- A slot or lane count is the lower of what the runner reported and Ahmed's setting (either may be unknown).
create function cb.runner_queue(project text default null, hours int default 24) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); h int := least(greatest(coalesce(hours, 24), 1), 168);
begin
  return (
    with run as (
      select x.runner, count(*)::int as busy, count(*) filter (where rr.db)::int as busy_db from cb.jobs x
      left join cb.runner_recipes rr on rr.runner = x.runner and rr.project = x.project and rr.repo = x.repo and rr.recipe = x.recipe
      where x.state = 'running' group by x.runner
    ), rs as (
      select r.name, r.last_seen, r.started_at, r.mode, r.mode_by, r.mode_at, r.slots, r.db_lanes, r.slots_set, r.lanes_set, r.set_by, r.set_at,
        coalesce(r.setting_refused is not null and r.started_at >= r.set_at, false) as setting_refused,
        r.last_seen > now() - interval '3 minutes' as alive, coalesce(run.busy, 0) as busy, coalesce(run.busy_db, 0) as busy_db,
        least(r.slots, r.slots_set) as cap, least(r.db_lanes, r.lanes_set) as lanes
      from cb.runners r left join run on run.runner = r.name
    ), q as (
      select x.*, row_number() over (order by coalesce(x.pos, x.id), x.id)::int as place,
        exists (select 1 from cb.runner_recipes rr where rr.project = x.project and rr.repo = x.repo and rr.recipe = x.recipe and rr.db) as db
      from cb.jobs x where x.state = 'queued'
    ), w as (
      select q.*, coalesce(
        (select jsonb_build_object('reason', 'project', 'state', pr.state, 'words', cb._state_words(pr.slug))
           from cb.projects pr where pr.slug = q.project and pr.state <> 'enabled'),
        (select jsonb_build_object('reason', 'held', 'by', hd.held_by, 'at', hd.held_at) from cb.job_holds hd where hd.project = q.project),
        (select why from (
           select case when not rs.alive then 5 when rs.mode <> 'on' then 4 when q.db and rs.busy_db >= rs.lanes then 3
                       when rs.busy >= rs.cap then 2 else 1 end as rank,
                  case when not rs.alive then jsonb_build_object('reason', 'down', 'runner', rs.name, 'since', rs.last_seen)
                       when rs.mode <> 'on' then jsonb_build_object('reason', rs.mode, 'runner', rs.name, 'by', rs.mode_by, 'at', rs.mode_at)
                       when q.db and rs.busy_db >= rs.lanes then jsonb_build_object('reason', 'lane', 'busy', rs.busy_db, 'of', rs.lanes)
                       when rs.busy >= rs.cap then jsonb_build_object('reason', 'slot', 'busy', rs.busy, 'of', rs.cap)
                       else jsonb_build_object('reason', 'next') end as why
           from rs join cb.runner_recipes rr on rr.runner = rs.name and rr.project = q.project and rr.repo = q.repo and rr.recipe = q.recipe
           order by 1 limit 1) best),
        jsonb_build_object('reason', 'no_runner')) as why
      from q
    )
    select jsonb_build_object(
      'now', now(), 'project', p, 'hours', h, 'supervisor', cb._supervisor_up(),
      'runners', coalesce((select jsonb_agg(to_jsonb(rs) order by rs.name) from rs), '[]'::jsonb),
      'holds', coalesce((select jsonb_agg(to_jsonb(hd) order by hd.project) from cb.job_holds hd), '[]'::jsonb),
      'counts', jsonb_build_object(
        'waiting', (select count(*)::int from q), 'running', (select coalesce(sum(busy), 0)::int from run),
        'waiting_here', (select count(*)::int from q where p is null or q.project = p),
        'running_here', (select count(*)::int from cb.jobs x where x.state = 'running' and (p is null or x.project = p)),
        'passed_hour', (select count(*)::int from cb.jobs x where x.state = 'passed' and x.finished_at > now() - interval '1 hour' and (p is null or x.project = p)),
        'failed_hour', (select count(*)::int from cb.jobs x where x.state in ('failed', 'error') and x.finished_at > now() - interval '1 hour' and (p is null or x.project = p))),
      'running', coalesce((select jsonb_agg(to_jsonb(x) - 'exit_code' - 'pos' || jsonb_build_object('db', coalesce(rr.db, false)) order by x.started_at, x.id)
                 from cb.jobs x left join cb.runner_recipes rr on rr.runner = x.runner and rr.project = x.project and rr.repo = x.repo and rr.recipe = x.recipe
                 where x.state = 'running' and (p is null or x.project = p)), '[]'::jsonb),
      'waiting', coalesce((select jsonb_agg(to_jsonb(w) - 'exit_code' - 'pos' order by w.place) from w where p is null or w.project = p), '[]'::jsonb),
      'finished', coalesce((select jsonb_agg(t.f order by t.finished_at desc, t.id desc) from (
                   select x.finished_at, x.id, to_jsonb(x) - 'exit_code' - 'pos' as f from cb.jobs x
                   where x.finished_at > now() - make_interval(hours => h) and (p is null or x.project = p)
                   order by x.finished_at desc, x.id desc limit 200) t), '[]'::jsonb)));
end $$;

-- "Run again" (#4527): a new job with the old one's project, repo, recipe, sha, parameters, card and requester (its
-- result reaches the session that waited), linked by retry_of. The recipe is checked as it is now. One of the same
-- check already waiting or running is refused, so a double tap queues one.
create function cb.job_retry(id bigint, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); j cb.jobs; n cb.jobs; dup bigint;
begin
  select * into j from cb.jobs x where x.id = id;
  if not found then raise exception 'no job #%: cb jobs lists queued and running jobs, cb jobs --ended the ended ones', id; end if;
  if j.requester <> a and not cb._queue_manager(a, j.project) then
    raise exception 'only the requester, the lead of % or Ahmed can run job #% again', j.project, id;
  end if;
  if j.state in ('queued', 'running') then raise exception 'job #% has not ended: stop it first, or wait for it', id; end if;
  if not cb._live(j.project) then raise exception '%: no new job is queued until Ahmed enables it', cb._state_words(j.project); end if;  -- #4559, as job_add
  perform pg_advisory_xact_lock(hashtext('cb-job-queue'));
  select x.id into dup from cb.jobs x where x.state in ('queued', 'running') and x.project = j.project and x.repo = j.repo
    and x.recipe = j.recipe and x.sha = j.sha and x.params = j.params order by x.id limit 1;
  if found then raise exception 'the same check is already waiting or running as job #%', dup; end if;
  perform cb._job_check(j.project, j.repo, j.recipe, j.params);
  insert into cb.jobs (project, repo, recipe, params, sha, requester, task_id, retry_of)
  values (j.project, j.repo, j.recipe, j.params, j.sha, j.requester, j.task_id, j.id) returning * into n;
  perform pg_notify('cb_jobs', n.id::text);
  return cb._job_reply(n);
end $$;

-- Move a waiting job (#4527): next, up, down or back. The moved jobs swap the keys they already hold, so no other job's
-- place changes and a job queued later still goes after them. Ahmed moves over the whole queue; a project's lead only
-- among its own project's waiting jobs (Q2982: a lead's move never puts its jobs ahead of another project's). Which
-- lane a DB job gets is still decided at claim time: a moved DB job starts when a lane frees.
create function cb.job_move(id bigint, place text, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); j cb.jobs; own boolean; ids bigint[]; ks bigint[]; i int; k int; n int;
begin
  if place is null or place not in ('next', 'up', 'down', 'back') then raise exception 'place must be next, up, down or back'; end if;
  perform pg_advisory_xact_lock(hashtext('cb-job-queue'));
  select * into j from cb.jobs x where x.id = id;
  if not found then raise exception 'no job #%: cb jobs lists queued and running jobs, cb jobs --ended the ended ones', id; end if;
  own := cb._is_owner(a);
  if not own and not cb._is_lead(a, j.project) then
    raise exception 'only Ahmed or the lead of % can move its jobs in the queue', j.project;
  end if;
  if j.state <> 'queued' then raise exception 'job #% is not waiting any more: it started or ended', id; end if;
  select array_agg(x.id order by coalesce(x.pos, x.id), x.id), array_agg(coalesce(x.pos, x.id) order by coalesce(x.pos, x.id), x.id)
    into ids, ks from cb.jobs x where x.state = 'queued' and (own or x.project = j.project);
  n := cardinality(ids); i := array_position(ids, j.id);
  k := case place when 'next' then 1 when 'back' then n when 'up' then greatest(i - 1, 1) else least(i + 1, n) end;
  if k <> i then
    ids := array_remove(ids, j.id);
    ids := ids[1:k - 1] || j.id || ids[k:];
    for t in 1..n loop
      update cb.jobs x set pos = ks[t] where x.id = ids[t] and coalesce(x.pos, x.id) <> ks[t];
    end loop;
  end if;
  return jsonb_build_object('id', j.id, 'moved', k <> i);
end $$;

-- Hold or release a project's waiting jobs (#4527): Ahmed or the project's lead. Running jobs carry on; the runner keeps
-- serving every other project. A hold stays until someone releases it.
create function cb.job_hold(project text, held boolean, actor text default null) returns boolean language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); p text := cb.read_project(project);
begin
  if p is null then raise exception 'project is required'; end if;
  if not cb._queue_manager(a, p) then raise exception 'only Ahmed or the lead of % can hold its jobs', p; end if;
  if held then
    insert into cb.job_holds (project, held_by) values (p, a) on conflict on constraint job_holds_pkey do nothing;
  else
    delete from cb.job_holds hd where hd.project = p;
    perform pg_notify('cb_jobs', '0'); -- the runner fills its slots now, not at its next 30 s tick
  end if;
  return held;
end $$;

-- Pause, drain or resume a runner (#4527, Q2983): Ahmed's alone. A pause stays until resumed (a restart keeps it); a
-- drain is a pause before a restart and ends when the runner comes back (runner_hello). Running jobs carry on.
create function cb.runner_set(runner text, mode text, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); r cb.runners;
begin
  if not cb._is_owner(a) then raise exception 'only Ahmed can pause, drain or resume a runner: it serves every project'; end if;
  if mode is null or mode not in ('on', 'paused', 'draining') then raise exception 'mode must be on, paused or draining'; end if;
  update cb.runners x set mode = runner_set.mode, mode_by = a, mode_at = now() where x.name = runner returning x.* into r;
  if not found then raise exception 'no runner %: see cb jobs', runner; end if;
  if mode = 'on' then perform pg_notify('cb_jobs', '0'); end if;
  return jsonb_build_object('name', r.name, 'mode', r.mode);
end $$;

-- How many jobs a runner runs at once, and how many of them may be DB jobs (#4527, Q2984): Ahmed's alone, any number up
-- or down, beyond the old code cap of 10 (1-64). The runner reads it at start (cli/runner.ts): a lower number applies at
-- the next claim (cb.job_claim), a higher one when the runner restarts and reports it. A lane is one digit in its test
-- stack's ports (docs/ops/maintain.md), so 1-9 lanes, never more than the slots. A value left out (null) keeps what is
-- set; clear_slots / clear_lanes go back to the runner's runner.json.
create function cb.runner_limits_set(runner text, slots int default null, db_lanes int default null, actor text default null,
                                     clear_slots boolean default false, clear_lanes boolean default false)
returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text := cb.set_actor(actor); r cb.runners;
begin
  if not cb._is_owner(a) then raise exception 'only Ahmed can change how many jobs a runner runs at once'; end if;
  if slots is not null and (slots < 1 or slots > 64) then raise exception 'slots must be 1 to 64'; end if;
  if db_lanes is not null and (db_lanes < 1 or db_lanes > 9) then raise exception 'database lanes must be 1 to 9'; end if;
  select * into r from cb.runners x where x.name = runner for update;
  if not found then raise exception 'no runner %: see cb jobs', runner; end if;
  slots := case when clear_slots then null else coalesce(slots, r.slots_set) end;
  db_lanes := case when clear_lanes then null else coalesce(db_lanes, r.lanes_set) end;
  if db_lanes is not null and db_lanes > coalesce(slots, r.slots, db_lanes) then
    raise exception 'database lanes (%) cannot be more than slots (%)', db_lanes, coalesce(slots, r.slots);
  end if;
  update cb.runners x set slots_set = slots, lanes_set = db_lanes, set_by = a, set_at = now() where x.name = runner returning x.* into r;
  perform pg_notify('cb_jobs', '0');
  return jsonb_build_object('name', r.name, 'slots_set', r.slots_set, 'lanes_set', r.lanes_set);
end $$;

-- The page's live refresh (#4527): its own channel, so a job's start or end neither wakes every open page (channel cb)
-- nor the runner (cb_jobs). Never on the 30 s beat (last_seen).
create function cb.queue_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('cb_queue', tg_table_name);
  return null;
end $$;
create or replace trigger jobs_queue_notify after insert or update or delete on cb.jobs
  for each statement execute function cb.queue_notify();
create or replace trigger runners_queue_notify after insert or delete or update of mode, slots, db_lanes, slots_set, lanes_set, setting_refused on cb.runners
  for each statement execute function cb.queue_notify();
create or replace trigger job_holds_queue_notify after insert or update or delete on cb.job_holds
  for each statement execute function cb.queue_notify();


-- The supervisor (#3601): a PC daemon (application name 'cb-supervisor/<version>') that starts and closes squad sessions
-- from these facts. Its functions refuse any other name (a deterrent like cb-runner, not auth).
drop function if exists cb._is_supervisor cascade;
drop function if exists cb._supervisor_only cascade;
drop function if exists cb.supervise_state cascade;
drop function if exists cb.supervise_mark cascade;
drop function if exists cb.supervise_log cascade;

create function cb._is_supervisor() returns boolean language sql stable as $$ select current_setting('application_name') like 'cb-supervisor%' $$;
create function cb._supervisor_only() returns void language plpgsql stable as $$
begin
  if not cb._is_supervisor() then raise exception 'only the supervisor can do this'; end if;
end $$;

-- Everything the supervisor plans from, for one project. Waiting = cards nobody holds (design: the owner of the card's
-- area first, the architect once no owner covers it or it has waited 15 minutes); builders and reviewers per repo.
create function cb.supervise_state(project text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); rs text[] := cb._repos_of(p); sq jsonb; owners boolean; areas text[]; res jsonb;
begin
  select pr.squad into sq from cb.projects pr where pr.slug = p;
  owners := coalesce(sq -> 'roles' ? 'owner', false);
  -- an area is a name, or {name, repo} in a squad with repos
  areas := coalesce(array(select coalesce(e ->> 'name', e #>> '{}') from jsonb_array_elements(sq -> 'areas') e), '{}');
  with free as (
    select t.* from cb.tasks t
     where t.project = p and t.status = 'next' and nullif(trim(t.assignee), '') is null
       and cb._pipeline(p) -- #4806: waiting work is counted by stage; with no stages no seat is started for a card
  ), design as (
    select f.*, owners and f.labels && areas as covered from free f where f.stage = 'design'
  ), repo_work as (
    -- build and review work per repo (#3703): a part counts under its repo when unheld at its card's stage; a card
    -- without parts under its first repo (one repo: the home repo); no repos named in a project of several: nobody's
    select pt.repo, f.stage, f.labels from free f join cb.task_parts pt on pt.task_id = f.id
     where f.stage in ('build', 'review') and pt.stage = f.stage and pt.status = 'next' and nullif(trim(pt.assignee), '') is null
    union all
    select case when cardinality(rs) > 1 then f.repos[1] else rs[1] end, f.stage, f.labels from free f
     where f.stage in ('build', 'review') and not exists (select 1 from cb.task_parts pt where pt.task_id = f.id)
  )
  select jsonb_build_object(
    -- #4559: a project that gets no work is not supervised: nothing is started or restored for it; state says why. A
    -- squad the supervisor runs winds down instead (Q3018): its idle seats are closed, counted from state_at at the earliest
    'project', p, 'squad', sq, 'pipeline', cb._pipeline(p), 'supervised', coalesce(cb._pipeline(p) and sq ->> 'supervise' = 'true' and cb._live(p), false),
    -- #4806: under its own key: a supervisor not yet restarted plans from 'supervised', and with nothing counted as waiting
    -- it would close every idle seat of a no-stage squad
    'supervised_unstaged', coalesce(not cb._pipeline(p) and sq ->> 'supervise' = 'true' and cb._live(p), false),
    'winding_down', coalesce(sq ->> 'supervise' = 'true' and not cb._live(p), false),
    'state', (select pr.state from cb.projects pr where pr.slug = p),
    'state_at', (select pr.state_at from cb.projects pr where pr.slug = p),
    'waiting', jsonb_build_object(
      'builder', (select jsonb_object_agg(r, (select count(*) from repo_work w where w.stage = 'build' and w.repo = r)) from unnest(rs) r),
      'reviewer', (select jsonb_object_agg(r, (select count(*) from repo_work w where w.stage = 'review' and w.repo = r)) from unnest(rs) r),
      'qa', (select count(*) from free f where f.stage = 'qa'),
      'investigator', (select count(*) from free f where f.type = 'research'),
      'architect', (select count(*) from design d where not d.covered or coalesce(d.stage_since, d.updated_at) < now() - interval '15 minutes'),
      'owner', coalesce((select jsonb_object_agg(ar, (select count(*) from design d where ar = any(d.labels) and coalesce(d.stage_since, d.updated_at) >= now() - interval '15 minutes')) from unnest(areas) ar), '{}')),
    -- #4593 review 100 F1: of those, the cards kept for an agent (for: labels), by the agents named: only a seat of one of
    -- them can take such a card, so the planner starts or keeps one of those
    'kept', jsonb_build_object(
      'builder', (select coalesce(jsonb_object_agg(r, cb._kept((select jsonb_agg(to_jsonb(w.labels)) from repo_work w where w.stage = 'build' and w.repo = r))), '{}') from unnest(rs) r),
      'reviewer', (select coalesce(jsonb_object_agg(r, cb._kept((select jsonb_agg(to_jsonb(w.labels)) from repo_work w where w.stage = 'review' and w.repo = r))), '{}') from unnest(rs) r),
      'qa', cb._kept((select jsonb_agg(to_jsonb(f.labels)) from free f where f.stage = 'qa')),
      'investigator', cb._kept((select jsonb_agg(to_jsonb(f.labels)) from free f where f.type = 'research')),
      'architect', cb._kept((select jsonb_agg(to_jsonb(d.labels)) from design d where not d.covered or coalesce(d.stage_since, d.updated_at) < now() - interval '15 minutes')),
      'owner', coalesce((select jsonb_object_agg(ar, cb._kept((select jsonb_agg(to_jsonb(d.labels)) from design d where ar = any(d.labels) and coalesce(d.stage_since, d.updated_at) >= now() - interval '15 minutes'))) from unnest(areas) ar), '{}')),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object(
        'actor', a.actor, 'role', cb._role(a.actor), 'area', s.area, 'repo', cb._repo(a.actor), 'machine', s.machine, 'pane', s.pane,
        -- the session's agent (#4002) and the model it bound with (#4332); null for a holder with no session row
        'agent', s.agent, 'model', s.model,
        'bound', s.project, -- #4559: the project that latest session is bound to
        'live', coalesce(s.last_seen > now() - interval '90 seconds', false),
        'holds', (select count(*) from cb.tasks t where t.assignee = a.actor and t.status not in ('done', 'cancelled'))
                 + (select count(*) from cb._held_parts() h where h.assignee = a.actor),
        'questions', (select count(*) from cb.questions q where q.asked_by = a.actor and q.status = 'open'),
        'jobs', (select count(*) from cb.jobs j where j.requester = a.actor and j.state in ('queued', 'running')),
        'jobs_running', (select count(*) from cb.jobs j where j.requester = a.actor and j.state = 'running'),
        'asks', (select count(*) from cb.asks k where k.to_actor = a.actor and k.status = 'open'),
        -- greatest: a squad name is reused, so its old events must not make a fresh bind look idle
        'last_event', greatest((select max(e.at) from cb.events e where e.actor = a.actor), s.started_at),
        'closing', cb._closing(a.actor),
        'last_restore', r.at,
        -- the latest restore did not start (its note is 'start failed'): retried, never read as down again
        'last_restore_failed', coalesce(r.failed, false),
        'down_again_logged', exists (select 1 from cb.events e where e.actor = 'supervisor' and e.data ->> 'what' = 'down_again'
                                        and e.data ->> 'session' = a.actor and e.at > coalesce(r.at, '-infinity')),
        -- #4787: its quota stop is on the board, and it has neither bound anew nor done anything there since: said once
        'quota_told', exists (select 1 from cb.events e where e.actor = 'supervisor' and e.data ->> 'what' = 'quota' and e.data ->> 'session' = a.actor
                                and e.at > greatest(coalesce(s.started_at, '-infinity'),
                                                    coalesce((select max(x.at) from cb.events x where x.actor = a.actor), '-infinity'))),
        -- a down_again since the name last bound: no automatic restore until it binds again (no crash loop)
        'down_again_since_bind', exists (select 1 from cb.events e where e.actor = 'supervisor' and e.data ->> 'what' = 'down_again'
                                            and e.data ->> 'session' = a.actor and e.at > coalesce(s.started_at, '-infinity'))
      ) order by a.actor)
      from (select s2.actor from cb.sessions s2 where s2.project = p
            union select t.assignee from cb.tasks t where t.project = p and t.assignee is not null and t.status not in ('done', 'cancelled')
            union select h.assignee from cb._held_parts() h join cb.tasks t on t.id = h.task_id where t.project = p) a
      left join lateral (select * from cb.sessions s3 where s3.actor = a.actor order by s3.last_seen desc limit 1) s on true
      left join lateral (select e.at, e.data ->> 'note' = 'start failed' as failed from cb.events e
                          where e.actor = 'supervisor' and e.data ->> 'what' = 'restore' and e.data ->> 'session' = a.actor
                            -- #4559: not one from before the project's last state change: it was wound down since
                            and e.at > coalesce((select pr.state_at from cb.projects pr where pr.slug = p), '-infinity')
                          order by e.at desc, e.id desc limit 1) r on true
      where a.actor is not null and a.actor <> ''), '[]'))
  into res;
  return res;
end $$;

-- Mark a session closing (or clear it). A mark loses to a card the session holds: a claim that won the race
-- clears the mark and the close is skipped. True when the mark stands. #4559 (Q3017): a seat of a project that gets no
-- work is closed with its cards, which stay its own; a card of a live project, or a seat bound to one, keeps the rule.
create function cb.supervise_mark(actor text, closing boolean) returns boolean language plpgsql as $$
#variable_conflict use_variable
begin
  perform cb._supervisor_only();
  update cb.sessions s set closing_at = case when closing then now() end where s.actor = actor;
  if not found then return false; end if;
  if closing and exists (
       select 1 from (select t.project from cb.tasks t where t.assignee = actor and t.status not in ('done', 'cancelled')
                      union all
                      select t.project from cb._held_parts() h join cb.tasks t on t.id = h.task_id where h.assignee = actor) w
        where cb._live(w.project)
           or cb._live((select s.project from cb.sessions s where s.actor = actor order by s.last_seen desc limit 1))) then
    update cb.sessions s set closing_at = null where s.actor = actor;
    return false;
  end if;
  return closing;
end $$;

-- One board event per start, close, restore and the like (project null for runner events). Names sessions and counts only.
create function cb.supervise_log(project text, what text, session text, note text default null) returns bigint language plpgsql as $$
#variable_conflict use_variable
declare id bigint; hit text;
begin
  perform cb._supervisor_only();
  if nullif(trim(session), '') is null then raise exception 'session is required'; end if;
  if session !~ '^[A-Za-z0-9@._-]{1,64}$' then raise exception 'session must be a session name: letters, digits, @ . _ - (at most 64)'; end if;
  note := nullif(left(trim(note), 200), '');
  hit := cb._sensitive(note);
  if hit is not null then raise exception 'the note looks like %; the board keeps no such text', hit; end if;
  if what is null or what not in ('start', 'close', 'restore', 'blocked', 'failed', 'runner', 'down_again', 'restart', 'quota') then
    raise exception 'what must be one of start, close, restore, blocked, failed, runner, down_again, restart, quota';
  end if;
  insert into cb.events (actor, project, kind, summary, data)
  values ('supervisor', case when project is null then null else cb.read_project(project) end, 'supervisor',
          what || ' ' || session || coalesce(' (' || note || ')', ''), jsonb_build_object('what', what, 'session', session) || case when note is null then '{}'::jsonb else jsonb_build_object('note', note) end)
  returning events.id into id;
  return id;
end $$;

-- ---------------------------------------------------------------- Card search (#4339)

drop function if exists cb.task_find cascade;

-- Find cards by their words, to check for a duplicate before filing one: titles and bodies (full text, plus a plain
-- substring match for words full text drops, as cb.mem_find), and with notes the card's notes (cb log, cb done) too.
-- Open cards first, then cancelled and done; newest first within each. No project = every project. Every status counts:
-- a cancelled card is often the duplicate. total counts past the cap (lim; null = no cap).
create function cb.task_find(q text, project text default null, notes boolean default false, lim int default 20) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare s text := trim(coalesce(q, '')); p text := cb.read_project(project); tq tsquery; pat text;
begin
  if s = '' then raise exception 'what to look for is required: cb search <project> "<words>"'; end if;
  tq := websearch_to_tsquery('english', s);
  pat := '%' || replace(replace(replace(s, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return (with hit as (
    select t.id, t.project, t.status, t.stage, t.priority, t.type, t.assignee, t.title,
           row_number() over (order by t.status in ('done', 'cancelled'), t.id desc) as n
      from cb.tasks t
     where (p is null or t.project = p)
       and (to_tsvector('english', t.title || ' ' || t.body) @@ tq or t.title ilike pat or t.body ilike pat
            or (coalesce(notes, false) and exists (select 1 from cb.events e where e.task_id = t.id and e.kind in ('note', 'done')
                                                     and (e.summary ilike pat or to_tsvector('english', e.summary) @@ tq)))))
  select jsonb_build_object('total', (select count(*) from hit),
    'cards', coalesce((select jsonb_agg(to_jsonb(h) - 'n' order by h.n) from hit h where lim is null or h.n <= lim), '[]')));
end $$;

-- ---------------------------------------------------------------- Session usage ledger (#4349)

-- One row per agent session: its CUMULATIVE token counts (and the cost its status line reported, when one was fresh),
-- as the session's Stop hook (hooks/usage-stop.mjs) last summed them from its transcript. Numbers only: no transcript
-- text ever reaches the board. Never read inside sessions_overview (#4344): cb.usage_summary is the read.
create table if not exists cb.session_usage (
  session_id         text primary key,
  machine            text not null,
  pane               text not null default '',
  actor              text,
  project            text references cb.projects(slug) on update cascade on delete set null,
  model              text,
  input_tokens       bigint not null default 0,
  output_tokens      bigint not null default 0,
  cache_read_tokens  bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  cost_usd           numeric(12,4),
  first_seen         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists session_usage_updated on cb.session_usage (updated_at desc);

drop function if exists cb.usage_report cascade;
drop function if exists cb.usage_summary cascade;

-- The hook's write. Idempotent and monotonic: each counter keeps the larger of the stored and the sent value (a hook
-- that lost its state and is still catching up never lowers a row), cost keeps the last one given, and a report that
-- changes nothing leaves the row untouched (updated_at too). The pane's board binding names the actor and project.
-- The first report places the row: its machine and pane stay, and actor and project are only filled in while empty, so
-- a later caller can never move a session's row to another seat; a report from another machine is refused.
-- An all-zero report is ignored: a ledger of zero rows reads as "free" (the zero-fill trap the card names).
-- Returns 'new', 'updated', 'same' or 'ignored'.
create function cb.usage_report(machine text, pane text, session_id text, model text, input_tokens bigint, output_tokens bigint,
                                cache_read_tokens bigint, cache_write_tokens bigint, cost_usd numeric default null)
returns text language plpgsql as $$
#variable_conflict use_variable
declare
  m text := lower(trim(coalesce(machine, ''))); p text := trim(coalesce(pane, '')); sid text := trim(coalesce(session_id, ''));
  mo text := nullif(trim(coalesce(model, '')), ''); ba text; bp text; n int; existed boolean;
begin
  if m = '' or sid !~ '^[A-Za-z0-9_-]{1,100}$' then raise exception 'usage_report needs a machine and a session id (letters, digits, - and _)'; end if;
  if length(m) > 100 or length(p) > 100 then raise exception 'usage_report: machine and pane are names of at most 100 characters'; end if;
  -- a model id only: anything else (text from a broken transcript) is stored as unknown, never as given
  if mo is not null and mo !~ '^[A-Za-z0-9._:@/\[\]-]{1,100}$' then mo := 'unknown'; end if;
  if least(input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) < 0 or cost_usd < 0 then
    raise exception 'usage_report: counts and cost cannot be negative';
  end if;
  if coalesce(input_tokens, 0) + coalesce(output_tokens, 0) + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0) = 0
     and coalesce(cost_usd, 0) = 0 then
    return 'ignored';
  end if;
  if p <> '' then select s.actor, s.project into ba, bp from cb.sessions s where s.machine = m and s.pane = p; end if;
  existed := exists (select 1 from cb.session_usage u where u.session_id = sid);
  if exists (select 1 from cb.session_usage u where u.session_id = sid and u.machine <> m) then
    raise exception 'usage_report: session % is recorded from another machine', sid;
  end if;
  insert into cb.session_usage as u (session_id, machine, pane, actor, project, model, input_tokens, output_tokens,
                                     cache_read_tokens, cache_write_tokens, cost_usd)
  values (sid, m, p, ba, bp, mo, coalesce(input_tokens, 0), coalesce(output_tokens, 0),
          coalesce(cache_read_tokens, 0), coalesce(cache_write_tokens, 0), cost_usd)
  on conflict on constraint session_usage_pkey do update
    set actor = coalesce(u.actor, excluded.actor), project = coalesce(u.project, excluded.project),
        model = coalesce(excluded.model, u.model),
        input_tokens = greatest(u.input_tokens, excluded.input_tokens),
        output_tokens = greatest(u.output_tokens, excluded.output_tokens),
        cache_read_tokens = greatest(u.cache_read_tokens, excluded.cache_read_tokens),
        cache_write_tokens = greatest(u.cache_write_tokens, excluded.cache_write_tokens),
        cost_usd = coalesce(excluded.cost_usd, u.cost_usd),
        updated_at = now()
    where (u.actor, u.project, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens,
           u.cache_write_tokens, u.cost_usd)
          is distinct from
          (coalesce(u.actor, excluded.actor), coalesce(u.project, excluded.project),
           coalesce(excluded.model, u.model), greatest(u.input_tokens, excluded.input_tokens),
           greatest(u.output_tokens, excluded.output_tokens), greatest(u.cache_read_tokens, excluded.cache_read_tokens),
           greatest(u.cache_write_tokens, excluded.cache_write_tokens), coalesce(excluded.cost_usd, u.cost_usd));
  get diagnostics n = row_count;
  return case when not existed then 'new' when n = 0 then 'same' else 'updated' end;
end $$;

-- The read: sessions whose ledger row changed within `since`, with their LIFETIME totals (rows are cumulative, so this
-- is "what the sessions active in the window have used so far", not spend inside the window). No project = every
-- project, rows with no bound project included. cost_usd sums only the sessions that reported one: costed says how many.
create function cb.usage_summary(project text default null, since interval default '24 hours') returns jsonb
language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); w interval := coalesce(since, interval '24 hours');
begin
  return (with r as (
    select u.* from cb.session_usage u where u.updated_at >= now() - w and (p is null or u.project = p))
  select jsonb_build_object(
    'project', p, 'since', w::text,
    'note', 'model is the main session''s last model; the counts include its subagents, which may run other models',
    'totals', (select jsonb_build_object('sessions', count(*), 'input_tokens', coalesce(sum(r.input_tokens), 0),
                 'output_tokens', coalesce(sum(r.output_tokens), 0), 'cache_read_tokens', coalesce(sum(r.cache_read_tokens), 0),
                 'cache_write_tokens', coalesce(sum(r.cache_write_tokens), 0), 'cost_usd', sum(r.cost_usd),
                 'costed', count(r.cost_usd)) from r),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('session_id', r.session_id, 'machine', r.machine, 'pane', r.pane,
                 'actor', r.actor, 'project', r.project, 'model', r.model, 'input_tokens', r.input_tokens,
                 'output_tokens', r.output_tokens, 'cache_read_tokens', r.cache_read_tokens,
                 'cache_write_tokens', r.cache_write_tokens, 'cost_usd', r.cost_usd, 'first_seen', r.first_seen,
                 'updated_at', r.updated_at)
                 order by r.cost_usd desc nulls last, r.output_tokens desc) from r), '[]'::jsonb)));
end $$;

-- ---------------------------------------------------------------- Project states (#4559)
-- Enabled, disabled or archived, set by Ahmed alone from his dashboard (exactly ahmed: cb._is_owner, not cb.ahmed_like;
-- the server also keeps it from other admins, OWNER_ONLY). Enabled <-> disabled, disabled <-> archived: archive only a
-- disabled project, and unarchive goes back to disabled, so waking an old one is always two steps. Nothing is deleted
-- or moved: held cards keep their holders, jobs and questions wait (the rules that skip them read cb._live). Disable
-- and enable tell each seat bound to the project in the last day and each holder of its open cards or parts, once.
-- state_at is where every quiet clock starts again after an enable (cb.pings_due, cb.stage_stalls_due, cb.digests_due).
create function cb.project_state(project text, state text, actor text default null) returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare a text; p text; s text := lower(trim(coalesce(state, ''))); cur cb.projects; verb text; msg text; who text; n int := 0;
  jb cb.jobs; stopped int := 0;
begin
  perform cb.dashboard_only('Projects');
  a := cb.set_actor(actor);
  if not cb._is_owner(a) then raise exception 'only Ahmed changes a project''s state, on the Projects page'; end if;
  p := cb.read_project(project);
  if p is null then raise exception 'project is required'; end if;
  if s not in ('enabled', 'disabled', 'archived') then raise exception 'state must be enabled, disabled or archived (got %)', state; end if;
  select * into cur from cb.projects pr where pr.slug = p for update;
  if cur.state = s then
    return jsonb_build_object('project', p, 'state', cur.state, 'state_by', cur.state_by, 'state_at', cur.state_at, 'told', 0, 'changed', false);
  end if;
  if s = 'archived' and cur.state = 'enabled' then raise exception '% is enabled: disable it first, then archive it', cur.name; end if;
  if s = 'enabled' and cur.state = 'archived' then raise exception '% is archived: unarchive it first (it goes back to disabled), then enable it', cur.name; end if;
  verb := case when s = 'disabled' and cur.state = 'archived' then 'unarchived' else s end;  -- before the update: from where
  update cb.projects pr set state = s, state_by = a, state_at = now(), archived = (s = 'archived') where pr.slug = p returning pr.* into cur;
  insert into cb.events (actor, project, kind, summary, data)
  values (a, p, 'note', format('Ahmed %s %s', verb, cur.name), jsonb_build_object('state', s));
  -- the seats are told only on disable and enable: archive and unarchive happen to a project already quiet
  msg := case verb
    when 'disabled' then format('Ahmed disabled %s. Stop at a safe point: push your work, write where it stands (cb log <card> "..."), and release any lock you hold. Take no new card. Your cards stay yours, and you will be told when %s is enabled again.', cur.name, cur.name)
    when 'enabled' then format('Ahmed enabled %s again. Carry on: cb resume, then cb next.', cur.name) end;
  if msg is not null then
    for who in
      select distinct x.who from (
        select s2.actor as who from cb.sessions s2 where s2.project = p and s2.last_seen > now() - interval '1 day'
        union select t.assignee from cb.tasks t where t.project = p and t.status not in ('done', 'cancelled')
        union select h.assignee from cb._held_parts() h join cb.tasks t on t.id = h.task_id where t.project = p) x
       where nullif(trim(x.who), '') is not null and not cb.ahmed_like(x.who)
         and x.who not in (select u.name from cb.users u)  -- people see their own page, not session messages
       order by x.who
    loop
      insert into cb.events (actor, project, kind, summary, data)
      values ('board', p, 'message', msg, jsonb_build_object('to', who, 'state', s));
      n := n + 1;
    end loop;
  end if;
  if s = 'enabled' then perform pg_notify('cb_jobs', '0'); end if;  -- the runner takes the waiting jobs now
  -- its open questions leave (or come back to) Today, the lamp and Telegram: the readers of the questions channel re-read
  perform pg_notify('cb', 'questions');
  -- #4559 slice 4: an archive cancels the project's waiting jobs, as cb.job_cancel does, and tells who asked for each;
  -- running ones finish (disable already stopped new claims). Last: cb.tell sets the actor to runner
  if s = 'archived' then
    for jb in update cb.jobs x set state = 'cancelled', summary = 'cancelled: the project was archived', finished_at = now()
              where x.project = p and x.state = 'queued' returning x.* loop
      stopped := stopped + 1;
      perform pg_notify('cb_jobs', jb.id::text);
      perform cb._job_tell(jb);
    end loop;
  end if;
  return jsonb_build_object('project', p, 'state', cur.state, 'state_by', cur.state_by, 'state_at', cur.state_at, 'told', n, 'changed', true,
    'jobs_cancelled', stopped);
end $$;

-- What disabling (or archiving) this project would touch, in one read: the confirm dialog's counts. Reads only.
create function cb.project_state_preview(project text) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := cb.read_project(project); pr cb.projects;
begin
  if p is null then raise exception 'project is required'; end if;
  select * into pr from cb.projects x where x.slug = p;
  return jsonb_build_object('project', p, 'name', pr.name, 'state', pr.state, 'state_by', pr.state_by, 'state_at', pr.state_at,
    'words', cb._state_words(p),
    'seats_live', (select count(distinct s.actor) from cb.sessions s where s.project = p and s.last_seen > now() - interval '90 seconds'),
    'open', (select count(*) from cb.tasks t where t.project = p and t.status not in ('done', 'cancelled')),
    'in_progress', (select count(*) from cb.tasks t where t.project = p and t.status = 'in_progress' and nullif(trim(t.assignee), '') is not null),
    'held', (select count(*) from cb.tasks t where t.project = p and t.status not in ('done', 'cancelled') and nullif(trim(t.assignee), '') is not null)
            + (select count(*) from cb._held_parts() h join cb.tasks t on t.id = h.task_id where t.project = p),
    'jobs_waiting', (select count(*) from cb.jobs j where j.project = p and j.state = 'queued'),
    'jobs_running', (select count(*) from cb.jobs j where j.project = p and j.state = 'running'),
    'questions', (select count(*) from cb.questions q where q.project = p and q.status = 'open' and q.assigned_to is null),
    'github_watches', (select count(*) from cb.settings st where st.key like 'github:%' and st.key not like 'github:outbox:%' and st.value ->> 'project' = p));
end $$;

-- Releases (#4352). cb update installs on a worker the release the board serves; these say what the board's database
-- runs and which code each seat runs.
--
-- The schema this database runs: db/setup.ts writes cb.schema_applied() after every apply, as
-- {"current": <sha256 of the db/schema.sql applied last>, "seen": [each sha256 ever applied, in the order first applied]}.
-- A function, not a row: it lives with the schema, and tests truncate every table. A release needs the schema its own
-- db/schema.sql hashes to (its manifest has that hash). The database has it when the hash is the current one, or was
-- first applied before the current one: the schema is applied forward only, so a later schema keeps what an earlier one
-- made (an old cb against new columns works). Never applied, or first applied after the current one (the board was
-- rolled back since): the database is older than the release needs.
drop function if exists cb.schema_covers cascade;
drop function if exists cb.seat_code cascade;
drop function if exists cb.seats_code cascade;
-- plpgsql: its body is checked when called, so it may name cb.schema_applied, which setup.ts creates after this file
create function cb.schema_covers(need text) returns boolean language plpgsql stable as $$
declare a jsonb := cb.schema_applied(); cur bigint; nd bigint;
begin
  select x.i into cur from jsonb_array_elements_text(a -> 'seen') with ordinality x(h, i) where x.h = a ->> 'current';
  select x.i into nd from jsonb_array_elements_text(a -> 'seen') with ordinality x(h, i) where x.h = need;
  return coalesce(nd <= cur, false);
end $$;

-- The commit a seat's relay runs (cli/release.ts codeSha: a checkout's HEAD, or an installed version's folder name);
-- null: not known (a relay from before this, or a copy that is neither). The relay sends it after its first inbox read
-- and every few minutes; true when the seat has a row. Not a binding change: no cb_bind notice.
alter table cb.sessions add column if not exists code_sha text;
create function cb.seat_code(machine text, pane text, code_sha text) returns boolean language plpgsql as $$
#variable_conflict use_variable
declare c text := case when code_sha ~ '^[0-9a-f]{40}$' then code_sha end;
begin
  update cb.sessions s set code_sha = c
   where s.machine = lower(trim(machine)) and s.pane = trim(pane) and s.code_sha is distinct from c;
  return exists (select 1 from cb.sessions s where s.machine = lower(trim(machine)) and s.pane = trim(pane));
end $$;

-- The live seats (relay heard in the last 90 s, as cb.sessions_overview counts them) whose code is not the board's
-- commit `board`, by machine; an unknown code counts (a relay too old to say it runs older code). Today shows one line.
create function cb.seats_code(board text, project text default null) returns jsonb language plpgsql stable as $$
#variable_conflict use_variable
declare p text := nullif(cb.resolve(project), '');  -- not read_project: an unknown project shows no seats, never fails Today
begin
  return jsonb_build_object('board', board,
    'live', (select count(*) from cb.sessions s where s.last_seen > now() - interval '90 seconds' and (p is null or s.project = p)),
    'off', coalesce((select jsonb_agg(jsonb_build_object('machine', x.machine, 'seats', x.n) order by x.n desc, x.machine) from (
              select s.machine, count(*) as n from cb.sessions s
               where s.last_seen > now() - interval '90 seconds' and (p is null or s.project = p)
                 and s.code_sha is distinct from board
               group by s.machine) x), '[]'::jsonb));
end $$;
