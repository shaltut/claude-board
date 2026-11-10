# Goals (#663)

## Why

Ahmed wants to steer ~20 sessions by saying what matters ("we need to improve our OCR/vision"), not by
re-ranking cards one at a time. A goal is that sentence turned into a living filter: every card that fits
it is worked first, including cards filed after the goal was set.

## How it differs from an epic

An epic is a fixed, ordered group Ahmed builds by hand. A goal is a description plus match rules; it keeps
pulling in new matching cards. A card can be in an epic and a goal at once.

## Decided by Ahmed

- **Q206:** a new card that matches an active goal joins it at once and is handed out first. The goal page
  marks it *new* so Ahmed can untick it.
- **Q207:** several goals can be active at once; Ahmed orders them. Each goal's cards come right after P0,
  in goal order, before ordinary P1/P2/P3 work.
- **From the card:** Ahmed sets goals from the dashboard; he confirms the first list; the Today page shows
  progress (N of M closed); orchestrators are told; a goal closes when its cards are done, or by Ahmed.

## Shape

**Data**
- `cb.goals`: id, title, description, project (null = every project), rules jsonb
  `{labels: [], words: [], epics: []}`, status `active | paused | done`, rank, created_at, closed_at.
- `cb.goal_tasks`: goal_id, task_id, `state in | out` (out = Ahmed unticked it; never re-added by matching),
  `via match | ahmed`, `new` boolean (cleared when Ahmed opens the goal), added_at.

**Matching** (plain SQL, no LLM)
- A card matches when it carries one of the goal's labels, OR its title/body hits one of the goal's words
  (the same `websearch_to_tsquery` + ilike as `mem_find`), OR it sits in one of the goal's epics; and it is
  in the goal's project (if set) and not done/cancelled.
- On creating a goal, the server proposes rules from the description: existing labels whose name appears in
  it, plus its non-stopwords. Ahmed edits the rules and sees the matching cards live before saving; the
  saved list is the confirmed first list.
- A trigger on task insert and on title/body/labels/epic change adds new matches to every active goal as
  `in, via match, new`. A card Ahmed unticked stays out.

**Ordering**
- `cb.task_claim` (cb next) and `cb tick` order by: P0 first, then the lowest rank of an active goal the card
  is `in`, then priority, rank, id. Cards in no goal keep today's order behind them.

**Closing**
- When every `in` card of a goal is done or cancelled, the goal moves to done and the board broadcasts it
  to its project. Ahmed can also close, pause or reopen a goal.

**Surfaces**
- Web: a Goals page (next free nav key) to create a goal, edit its rules, see matched cards (new ones
  marked, untick to drop), drag goals into order, pause/close. The Today page shows each active goal with
  N of M closed.
- CLI (read-only for sessions): `cb goals [project]` lists active goals in order with progress; `cb brief`
  and `cb iam` show the active goals for the session's project; `cb show` notes a card's goal.
- Orchestrators: activating a goal broadcasts it to its project (`--project`), naming the goal and how many
  cards it pulled in.
- Only Ahmed (dashboard) creates, edits, orders or closes goals: the same `cb.dashboard_only` guard as epics.

## My calls (Ahmed did not decide these)

1. A goal can span every project (project null). The OCR goal touches ihop and ocr-arena.
2. Matching is labels + words + epics in SQL, not an LLM reading the description. Predictable, free, and
   Ahmed sees the result before saving.
3. An unticked card never rejoins by matching; Ahmed can tick it back on the goal page.
4. A card in two goals ranks by the higher (lower-numbered) goal.
5. A paused goal keeps its list but stops affecting order and stops matching.
6. Auto-close only fires when the goal has at least one card; an empty goal stays open.

## Not in this round

- An LLM turning a free description into rules.
- Goal deadlines or targets beyond "all matched cards closed".
- Sessions creating or proposing goals.

## Rollout

Schema first (Ahmed runs `db/setup.ts` on live), then server + CLI + web, behind the usual review and
independent run. The ordering change touches `cb next` for every session, so it ships with a test that
P0 still beats every goal and that cards in no goal keep their current order.
