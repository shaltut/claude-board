# Guardrails

Every rule the board enforces and where. A change that touches one updates its row in the same commit.
"Under multi-user" and "Phase" refer to [the multi-user design](superpowers/specs/2026-11-12-multi-user-sessions-design.md).

| # | Guardrail today | Source | Under this design | Phase | State |
|---|---|---|---|---|---|
| 1 | Database password only on Ahmed's machines; Postgres only on the Tailscale address | ops README | **Unchanged**, and now a hard line: teammates never get it | all | planned |
| 2 | Only the dashboard acts as `ahmed` (`cb.not_ahmed`) | schema | **Tightened** for teammates: the session API never sets `cb-web`, and the server sets the actor. Still a deterrent on Ahmed's machines | 4 | planned |
| 3 | Dashboard-only actions (`cb.dashboard_only`: users, links, epics, roles) | schema | **Unchanged**; none are on the session allow-list | 4 | planned |
| 4 | Names with `ahmed` reserved | `cb.user_add`, `cb.ahmed_like` | **Unchanged**; also applied to device labels and session roles | 2 | in place for device names (phase 2): `cb.device_add` refuses them |
| 5 | Every write has an actor | `cb.set_actor` | **Tightened**: for teammates the actor is composed and checked by the server; `owner` recorded on events | 2, 4 | partly in place (phase 2): `cb.events.owner` is stamped by the `events_owner` trigger; the server-side actor check is phase 4 |
| 6 | `--as` / `$CB_ACTOR` name any actor | CLI | **Restricted** for teammates to their own devices' names | 4 | planned |
| 7 | `orch` rights by name | `_huddle_post`, `tick` | **Replaced** for teammates by an explicit grant | 5 | planned |
| 8 | A bound session works only its own project | CLI + functions | **Tightened**: enforced by the server from `cb.user_projects`, not by the session's own binding | 4 | planned |
| 9 | Work reaches a person only on their projects | `assignee_on_project` trigger | **Generalised**: also covers that person's sessions | 5 | planned |
| 10 | Members: only answer / send back / note their own items | `server/main.ts` | **Unchanged** for the browser. Sessions get the wider allow-list of 4.3, only with the switch on | 4, 6 | planned |
| 11 | Ahmed's answer can't be overwritten | `cb.answer` | **Unchanged**; extended to a principal's answers | 5 | planned |
| 12 | "(not Ahmed)" on others' answers | relay | **Generalised** to principal / board owner / colleague | 5 | planned |
| 13 | Another session's message is never Ahmed's approval | `prompts/session.md` 16 | **Split**: sibling session vs another person's session, the second marked as untrusted | 5, 7 | planned |
| 14 | GitHub text is untrusted and marked | relay, prompts | **Unchanged**; the same marking reused for cross-person text | 5 | planned |
| 15 | Memory: no secrets or personal data (`cb._sensitive`); flagged entries wait for Ahmed | schema | **Unchanged**; applies to teammates' entries | 4 | planned |
| 16 | Memory authority `ahmed` only from the dashboard | schema | **Unchanged**; author's person recorded | 5 | planned |
| 17 | Epics and goals are Ahmed's | schema, prompts | **Unchanged** | 4 | planned |
| 18 | Members' links and admins' tokens never shown to sessions | `user_add`, `/api/people` | **Unchanged**; device tokens stored only as hashes, shown once | 2 | in place (phase 2): `cb.device_add` returns the token once and stores `token_hash`; `cb.devices_list` never returns it |
| 19 | Sign-in lockout, CSRF origin check, cookie flags | `server/main.ts` | **Unchanged** for browsers. Token requests get their own rate limit and never count as "the dashboard" | 4 | planned |
| 20 | `Sec-Fetch-Site` page-only reads (people, Telegram, memory-as-Ahmed) | `server/main.ts` | **Unchanged**; unreachable with a device token | 4 | planned |
| 21 | Telegram is Ahmed's alone | server | **Unchanged**; teammates' sessions' questions never go there unless assigned to Ahmed | 5 | planned |
| 22 | One polling server | server | **Unchanged** | - | planned |
| 23 | Removing a person hands their work back | `_user_hand_back` | **Extended**: also revokes devices, ends sessions, hands back tasks held by their sessions | 5 | planned |
| 24 | The DB test lock (`cb lock`) | schema | **Kept to Ahmed's machines**: refused on the session API | 4 | planned |
| 25 | Never truncate / seed / test against the live database; tests never on the VPS | CLAUDE.md | **Unchanged**; governs how this is built | all | planned |
| 26 | Never print `.env`, a token, a password, a link | CLAUDE.md | **Unchanged**; device tokens join the list | all | planned |
| 27 | No restart, merge or deploy without Ahmed's go | CLAUDE.md | **Unchanged** | all | planned |
| 28 | No client data anywhere new without his OK | CLAUDE.md | **Made explicit**: the per-person switch is that OK, recorded | 2, 6 | in place in SQL (phase 2): `cb.user_sessions`, dashboard only, one History line; the page for it is phase 6 |
| 29 | Backups stay on the VPS or Ahmed's machines | `deploy/backup.sh` | **Unchanged**; dumps now also hold device token hashes | - | planned |

Known weaknesses this design does **not** fix, listed so they are not mistaken for fixed: the `cb-web` deterrent on
Ahmed's own machines; `cb.users.token` stored in plain text (it is the cookie and the member link).
