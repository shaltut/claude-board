// The project settings page's pure parts (#4332): plain-word names, the form's checks (the same limits as cb.squad_set,
// so a refusal is caught before the save), the edits the form makes to a squad document, history sentences, seat lines,
// the role text counter and which server messages a person may see. No imports: test/settings-web.test.ts runs it in node.

export const ROLES = ['lead', 'architect', 'owner', 'builder', 'reviewer', 'qa', 'investigator'] as const
export type Role = (typeof ROLES)[number]
export const REPO_BOUND: readonly Role[] = ['builder', 'reviewer']
export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const

export interface Fallback { agent: string; model: string; effort?: string }
export interface SeatSpec { agent?: string; model?: string; effort?: string; fallback?: Fallback[] }
export interface RoleSpec {
  count?: number | Record<string, number>; model?: string; machine: string; agent?: string; effort?: string; fallback?: Fallback[]
  seats?: Record<string, SeatSpec>
}
export interface MachineSpec { herdr: string | null; repo?: string; board: string; workspace?: string }
export interface RepoSpec { home?: boolean; paths: Record<string, string> }
export type Area = string | { name: string; repo: string }
export interface Squad {
  machines: Record<string, MachineSpec>; roles: Partial<Record<Role, RoleSpec>>; areas?: Area[]; supervise?: boolean
  repos?: Record<string, RepoSpec>; protected?: string[]
}
export interface Seat {
  actor: string; machine: string | null; role: string | null; area: string | null; repo: string | null; agent: string | null
  model: string | null; in_squad: boolean; want_agent: string | null; want_model: string | null; same: boolean | null
  holds: number; last_seen: string
  /** #4786: the model the seat really runs, where the board can tell, and whether it is another than `model` */
  running_model?: string | null; model_differs?: boolean
}
export interface SquadPage {
  project: string; squad: Squad | null; version: number; pipeline: boolean; supervise: boolean; seats: Seat[]
  acts_on?: { project: string; winding_down: boolean }[] // #4806: every project with the supervisor switch on
  history: { id: number; at: string; actor: string; version: number | null; via: 'page' | 'cli' | null; squad: Squad }[]
  reminders: { open: number; on: number }
}
export interface ModelList { models: { id: string; efforts?: string[] }[]; at: string }
export interface SquadOptions {
  roles: Role[]; agents: { agent: string; main: boolean }[]; claude_models: string[]; default_models: Record<string, string>
  limits: { count_min: number; count_max: number; macbook_seats: number; fallbacks: number; session_name: number }
  /** per agent, the effort levels a seat can be started with; an empty list: that agent takes none */
  efforts: Record<string, string[]>
  /** per machine name, per agent: the models its CLI listed when it last sent them (cb models report) */
  machine_models?: Record<string, Record<string, ModelList>>
  models_used: Record<string, string[]>; machines_used: ({ key: string } & MachineSpec)[]
}
export interface RoleTextPage {
  /** edited: the last change was made by hand on this page (not seeded, not a Load the new texts) */
  roles: { role: string; body: string; updated_at: string; updated_by: string | null; edited?: boolean }[]
  edits: { id: number; role: string; actor: string; at: string; before: string | null; after: string }[]
}
/** cb.project_role_page: one project's addition to the role texts and who its stuck seats ask first (#4525). */
export interface ProjectRolePage {
  project: string; addition: string; ask_first: string; updated_at: string | null; updated_by: string | null; cap: number; sessions: string[]
}
export interface Watch {
  repo: string; to: string | null; project: string | null; card_projects?: string[]; since: string | null
  last_ok: string | null; last_error: string | null
}

// ---------------------------------------------------------------- plain words (design section 13)
const ROLE_MANY: Record<Role, string> = {
  lead: 'Lead', architect: 'Architects', owner: 'Area owners', builder: 'Builders', reviewer: 'Reviewers', qa: 'QA testers', investigator: 'Investigators',
}
const ROLE_ONE: Record<Role, string> = {
  lead: 'Lead', architect: 'Architect', owner: 'Area owner', builder: 'Builder', reviewer: 'Reviewer', qa: 'QA tester', investigator: 'Investigator',
}
const AGENT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', agy: 'Antigravity' }

export const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as readonly string[]).includes(r)
export const roleLabel = (r: string) => (isRole(r) ? ROLE_MANY[r] : 'Another role')
export const roleOne = (r: string) => (isRole(r) ? ROLE_ONE[r] : 'A seat')
/** The role texts' names: _common holds the rules every role follows. */
export const roleTextLabel = (r: string) => (r === '_common' ? 'Rules every role follows' : roleOne(r))
export const agentLabel = (a?: string | null) => AGENT[a ?? 'claude'] ?? 'Another agent'
/** Claude's four names get a capital; other agents' model names are what Ahmed typed, shown as typed. */
export const modelLabel = (m?: string | null) =>
  !m ? 'its usual model' : (CLAUDE_MODELS as readonly string[]).includes(m) ? m[0]!.toUpperCase() + m.slice(1) : m
export const setupLabel = (agent?: string | null, model?: string | null, effort?: string | null) =>
  `${agentLabel(agent)}, ${modelLabel(model)}${effort ? `, ${effort} effort` : ''}`
/** A machine as a person knows it: herdr null is the PC the board runs on. */
export function machineLabel(m?: Pick<MachineSpec, 'herdr'> | null, key?: string) {
  if (!m) return key ? `machine ${key}` : 'an unknown machine'
  if (m.herdr == null) return 'This PC'
  return m.herdr === 'macbook' ? 'MacBook' : m.herdr
}
/** The herdr name a machine gets back when it is switched from This PC to Another machine: the one it had before the
 *  switch on this page, else the one another project's squad gives that key, else the MacBook. */
export function restoredHerdr(key: string, before: Record<string, string>, used: readonly ({ key: string } & Pick<MachineSpec, 'herdr'>)[]) {
  return before[key] || used.find((m) => m.key === key && m.herdr)?.herdr || 'macbook'
}
/** Who did something, in words: Ahmed, the lead or another session (the session name goes in a tooltip), or a signed-in
 *  admin by name. */
// #3779: leads (useLeads: sessions_overview's lead, by role) says who leads, whatever the name; not read yet, the old orch@ name
export const actorLabel = (a: string, leads?: ReadonlySet<string>) =>
  (a === 'ahmed' ? 'Ahmed' : (leads ? leads.has(a) : /(^|-)orch@/.test(a)) ? 'The lead' : a.includes('@') ? 'A session' : a)
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------- shape helpers
export const isMulti = (sq: Squad) => !!sq.repos && Object.keys(sq.repos).length > 0
export const areaName = (a: Area) => (typeof a === 'string' ? a : a.name)
export const homeRepo = (sq: Squad) => {
  const r = Object.entries(sq.repos ?? {})
  return (r.find(([, v]) => v.home)?.[0]) ?? (r.length === 1 ? r[0]![0] : undefined)
}
/** How many seats a role has: owners one per area, repo-bound roles the sum of their repo counts. */
export function seatCount(sq: Squad, role: Role): number {
  const spec = sq.roles[role]
  if (!spec) return 0
  if (role === 'owner') return (sq.areas ?? []).length
  if (typeof spec.count === 'object') return Object.values(spec.count).reduce((n, c) => n + c, 0)
  return spec.count ?? 0
}
/** A role's seat keys, as cb.squad_set (and cli/squad-up.ts) name them. */
export function seatKeys(sq: Squad, role: Role): string[] {
  const spec = sq.roles[role]
  if (!spec) return []
  if (role === 'owner') return (sq.areas ?? []).map(areaName)
  if (typeof spec.count === 'object') {
    return Object.keys(spec.count).sort().flatMap((r) => Array.from({ length: (spec.count as Record<string, number>)[r] ?? 0 }, (_, i) => `${r}:${i + 1}`))
  }
  return Array.from({ length: spec.count ?? 0 }, (_, i) => String(i + 1))
}
/** A seat key in words: "Builder 2 in platform", "Area owner of payments", "Lead". */
export function seatKeyLabel(sq: Squad, role: Role, key: string) {
  if (role === 'lead') return 'Lead'
  if (role === 'owner') return `Area owner of ${key}`
  const [repo, n] = key.includes(':') ? key.split(':') as [string, string] : [undefined, key]
  return `${ROLE_ONE[role]} ${n}${repo && isMulti(sq) ? ` in ${repo}` : ''}`
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** The document to save: the draft without what the server returned beside the squad (squad_set refuses unknown keys). */
export function toDocument(sq: Squad): Squad {
  const { version: _v, changed: _c, ...rest } = sq as Squad & { version?: number; changed?: boolean }
  return clone(rest)
}

/** Drops the single-seat settings whose seat no longer exists (a lower count, a removed area or repo): squad_set refuses
 *  them. Returns the labels of the dropped ones, for the note under the save button. */
export function pruneSeats(sq: Squad): string[] {
  const gone: string[] = []
  for (const role of ROLES) {
    const spec = sq.roles[role]
    if (!spec?.seats) continue
    const keep = new Set(seatKeys(sq, role))
    for (const k of Object.keys(spec.seats)) if (!keep.has(k)) { gone.push(seatKeyLabel(sq, role, k)); delete spec.seats[k] }
    if (Object.keys(spec.seats).length === 0) delete spec.seats
  }
  return gone
}

/** The Supervisor switch. Off on a saved squad that has no supervise key drops the key again (squad_set stores it only
 *  when given), so ticking it on and off leaves nothing to save. */
export function setSupervise(sq: Squad, on: boolean, saved: Squad | null): Squad {
  const next = clone(sq)
  if (on || (saved && 'supervise' in saved)) next.supervise = on; else delete next.supervise
  return next
}

export function setRoleOn(sq: Squad, role: Role, on: boolean, defaults: Record<string, string>): Squad {
  const next = clone(sq)
  if (!on) { delete next.roles[role]; if (role === 'owner') next.areas = []; return next }
  const machine = Object.keys(next.machines)[0] ?? ''
  const home = homeRepo(next)
  const count: RoleSpec['count'] = role === 'owner' ? undefined : isMulti(next) && REPO_BOUND.includes(role) && home ? { [home]: 1 } : 1
  next.roles[role] = { ...(count !== undefined ? { count } : {}), model: defaults[role] ?? 'sonnet', machine }
  return next
}

/** A role's count (repo given: that repo's, 0 drops the repo from the role), with seats past it pruned. */
export function setCount(sq: Squad, role: Role, n: number, repo?: string): Squad {
  const next = clone(sq)
  const spec = next.roles[role]
  if (!spec) return next
  if (repo) {
    const c = typeof spec.count === 'object' ? spec.count : {}
    if (n <= 0) delete c[repo]; else c[repo] = n
    spec.count = c
  } else spec.count = n
  pruneSeats(next)
  return next
}

export function patchRole(sq: Squad, role: Role, patch: Partial<RoleSpec>, defaults: Record<string, string>): Squad {
  const next = clone(sq)
  const spec = next.roles[role]
  if (!spec) return next
  Object.assign(spec, patch)
  if ('effort' in patch && !patch.effort) delete spec.effort // squad_set refuses a null: no key is the agent's default
  if ('agent' in patch) {
    // levels differ by agent: the role starts at the new one's default, and so does each seat that would inherit it
    delete spec.effort
    for (const [k, s] of Object.entries(spec.seats ?? {})) {
      if (!s.agent) delete s.effort
      if (Object.keys(s).length === 0) delete spec.seats![k]
    }
    if (spec.seats && Object.keys(spec.seats).length === 0) delete spec.seats
    const claude = (CLAUDE_MODELS as readonly string[]).includes(spec.model ?? '')
    if ((patch.agent ?? 'claude') === 'claude') { delete spec.agent; if (!claude) spec.model = defaults[role] ?? 'sonnet' }
    else if (claude) spec.model = '' // a Claude name never fits another agent: the field asks for one
  }
  return next
}

/** The squad with one seat set differently (#4763). A model or effort given empty goes: the seat takes the role's. A new
 *  agent drops the effort; back on the role's agent the model goes too, and on another agent the seat names its own ('' until
 *  one is picked, which checkSquad flags). A seat with nothing of its own is not kept: squad_set refuses an empty one. */
export function patchSeat(sq: Squad, role: Role, key: string, patch: SeatSpec, defaults: Record<string, string>): Squad {
  const next = clone(sq)
  const spec = next.roles[role]
  if (!spec) return next
  const roleAgent = spec.agent ?? 'claude'
  const seat: SeatSpec = { ...spec.seats?.[key] }
  if (seat.agent === roleAgent) delete seat.agent // the role moved to the seat's agent since: it is the role's now (as squad_set stores it)
  if ('agent' in patch) {
    delete seat.effort
    const agent = patch.agent || roleAgent
    if (agent === roleAgent) { delete seat.agent; delete seat.model }
    else { seat.agent = agent; seat.model = agent === 'claude' ? defaults[role] ?? 'sonnet' : '' }
  }
  if ('model' in patch) { if (patch.model || seat.agent) seat.model = patch.model ?? ''; else delete seat.model }
  if ('effort' in patch) { if (patch.effort) seat.effort = patch.effort; else delete seat.effort }
  const all = { ...spec.seats }
  if (Object.keys(seat).length) all[key] = seat; else delete all[key]
  if (Object.keys(all).length) spec.seats = all; else delete spec.seats
  return next
}

/** What a seat's empty choices say. model undefined: the seat is on another agent, so it must pick a model. */
export function seatBlank(role: RoleSpec, seat: SeatSpec): { model: string | undefined; effort: string } {
  const same = (seat.agent ?? role.agent ?? 'claude') === (role.agent ?? 'claude')
  return {
    model: same ? `Same as the role: ${modelLabel(role.model)}` : undefined,
    effort: same && role.effort ? `Same as the role: ${role.effort} effort` : 'Default effort',
  }
}

/** The squad with one area added or removed (with repos an area names its repo); removing the last turns owners off. */
export function setAreas(sq: Squad, areas: Area[]): Squad {
  const next = clone(sq)
  next.areas = areas
  if (areas.length === 0) delete next.roles.owner
  pruneSeats(next)
  return next
}

// ---------------------------------------------------------------- checks (cb.squad_set's rules, in plain words)
// JS forms of squad_set's POSIX patterns (squad_options.patterns is POSIX text: [[:space:]] means nothing to RegExp).
export const RX = {
  slug: /^[a-z][a-z0-9-]{0,31}$/,
  area: /^[a-z][a-z0-9-]*$/,
  absolute: /^(\/|[A-Za-z]:[/\\])/,
  forbidden: /[\s;&|$`<>()'"*?~]/,
  codex: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  opencode: /^[a-z0-9][a-z0-9._-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/,
  agy: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  repo: /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/,
  login: /^[a-z0-9][a-z0-9-]{0,38}$/,
}
export const pathOk = (p?: string) => !!p && RX.absolute.test(p) && !RX.forbidden.test(p)

/** The two model names a value is, when it is two known names joined with no separator: the settings field's picker
 *  slip, where the second click appended to the first instead of replacing it (#4717). null when it is not such a
 *  pair (a single name, a new name, or a value that does not split into two known ones). */
export function joinedModels(model: string, known: readonly string[]): [string, string] | null {
  const v = model ?? ''
  if (!v) return null
  for (const a of known) {
    if (a && v.length > a.length && v.startsWith(a)) {
      const b = v.slice(a.length)
      if (known.includes(b)) return [a, b]
    }
  }
  return null
}

/** Why a model does not fit its agent, or null. known (the names already used for that agent) catches two names joined
 *  with no separator, which still fit the agent's shape alone (#4717). */
export function modelProblem(agent: string | undefined, model: string | undefined, known: readonly string[] = []): string | null {
  const m = model ?? ''
  const joined = joinedModels(m, known)
  if (joined) return `That is two model names joined (${joined[0]} and ${joined[1]}): pick one.`
  const claudeName = (CLAUDE_MODELS as readonly string[]).includes(m)
  switch (agent ?? 'claude') {
    case 'claude': return claudeName ? null : 'Pick Opus, Sonnet, Haiku or Fable.'
    case 'codex': return RX.codex.test(m) && !claudeName ? null : 'Codex needs its own model name, like gpt-6.1-sol.'
    case 'opencode': return RX.opencode.test(m) ? null : 'OpenCode needs the provider and the model, like anthropic/claude-opus-5-5.'
    case 'agy': return RX.agy.test(m) && !claudeName ? null : 'Antigravity needs its own model name, like gemini-4-neon-xhigh.'
    default: return 'Pick an agent from the list.'
  }
}

export interface Problem { where: string; text: string }

/** Everything cb.squad_set would refuse, said plainly and placed by section ('role:<role>', 'machines', 'repos',
 *  'areas', 'squad'). An empty list means the save should pass the server's checks. */
export function checkSquad(sq: Squad, project: string, opts: Pick<SquadOptions, 'agents'> & { models_used?: SquadOptions['models_used'] }): Problem[] {
  const out: Problem[] = []
  const add = (where: string, text: string) => out.push({ where, text })
  const mains = new Set(opts.agents.filter((a) => a.main).map((a) => a.agent))
  const machines = Object.entries(sq.machines)
  const multi = isMulti(sq)
  if (machines.length === 0) add('machines', 'Add at least one machine.')
  for (const [k, m] of machines) {
    const name = `Machine ${k}`
    if (!RX.slug.test(k)) add('machines', `${name}: use lower-case letters, digits and dashes, starting with a letter (at most 32).`)
    if (m.herdr !== null && (typeof m.herdr !== 'string' || m.herdr.trim() === '')) add('machines', `${name}: give its herdr name, or pick This PC.`)
    if (!pathOk(m.board)) add('machines', `${name}: the board folder must be a full path with no spaces or special characters.`)
    if (!multi && !pathOk(m.repo)) add('machines', `${name}: the repo folder must be a full path with no spaces or special characters.`)
    if (m.workspace !== undefined && (m.workspace.length < 1 || m.workspace.length > 64 || m.workspace.trim() !== m.workspace || m.workspace.startsWith('-') || [...m.workspace].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) {
      add('machines', `${name}: the workspace name must be 1 to 64 characters, with no space at either end and not starting with a dash.`)
    }
  }
  const repos = Object.entries(sq.repos ?? {})
  if (multi) {
    for (const [k, r] of repos) {
      if (!RX.slug.test(k)) add('repos', `Repo ${k}: use lower-case letters, digits and dashes, starting with a letter.`)
      for (const [mk, p] of Object.entries(r.paths)) {
        if (!sq.machines[mk]) add('repos', `Repo ${k} has a folder on a machine that is not in the list.`)
        else if (!pathOk(p)) add('repos', `Repo ${k} on ${machineLabel(sq.machines[mk], mk)}: the folder must be a full path with no spaces or special characters.`)
      }
    }
    const homes = repos.filter(([, r]) => r.home ?? repos.length === 1)
    if (homes.length !== 1) add('repos', 'Mark exactly one repo as home: the lead, architects, QA and investigators start there.')
  }
  const areas = sq.areas ?? []
  const seen = new Set<string>()
  for (const a of areas) {
    const n = areaName(a)
    if (!RX.area.test(n)) add('areas', `Area "${n}": use lower-case letters, digits and dashes, starting with a letter.`)
    if (seen.has(n)) add('areas', `Area ${n} is listed twice.`)
    seen.add(n)
    if (multi && (typeof a === 'string' || !sq.repos?.[a.repo])) add('areas', `Area ${n}: pick the repo it belongs to.`)
  }
  if (sq.roles.owner && areas.length === 0) add('areas', 'Area owners need at least one area.')
  if (areas.length > 0 && !sq.roles.owner) add('areas', 'Areas need area owners: turn them on, or remove the areas.')
  const home = homeRepo(sq)
  let mac = 0
  for (const role of ROLES) {
    const spec = sq.roles[role]
    if (!spec) continue
    const where = `role:${role}`, name = ROLE_MANY[role]
    const agent = spec.agent ?? 'claude'
    if (!sq.machines[spec.machine]) add(where, `${name}: pick a machine.`)
    if (!mains.has(agent)) add(where, `${agentLabel(agent)} is not ready to run a seat yet. You can list it as a backup.`)
    const mp = modelProblem(agent, spec.model, opts.models_used?.[agent])
    if (mp) add(where, `${name}: ${mp}`)
    let need: string[] = []
    if (role === 'owner') need = multi ? [...new Set(areas.flatMap((a) => (typeof a === 'string' ? [] : [a.repo])))] : []
    else if (multi && REPO_BOUND.includes(role)) {
      const c = typeof spec.count === 'object' ? spec.count : {}
      if (Object.keys(c).length === 0) add(where, `${name}: give at least one repo a seat.`)
      for (const [r, n] of Object.entries(c)) {
        if (!sq.repos?.[r]) add(where, `${name}: repo ${r} is not in the list.`)
        if (!Number.isInteger(n) || n < 1 || n > 8) add(where, `${name} in ${r}: from 1 to 8 seats.`)
      }
      need = Object.keys(c)
    } else {
      const n = spec.count
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 8) add(where, `${name}: from 1 to 8 seats.`)
      else if (role === 'lead' && n !== 1) add(where, 'A squad has one lead.')
      need = home ? [home] : []
    }
    if (multi) for (const r of need) if (sq.repos?.[r] && !sq.repos[r]!.paths[spec.machine]) add(where, `${name}: repo ${r} has no folder on ${machineLabel(sq.machines[spec.machine], spec.machine)}.`)
    fallbackProblems(spec.fallback, agent, spec.model, name, opts.models_used).forEach((t) => add(where, t))
    for (const [k, s] of Object.entries(spec.seats ?? {})) {
      const label = seatKeyLabel(sq, role, k), sa = s.agent ?? agent, sm = s.model ?? spec.model
      if (s.agent && !mains.has(s.agent)) add(where, `${label}: ${agentLabel(s.agent)} is not ready to run a seat yet.`)
      if ('model' in s || 'agent' in s) { const p = modelProblem(sa, sm, opts.models_used?.[sa]); if (p) add(where, `${label}: ${p}`) }
      fallbackProblems(s.fallback, sa, sm, label, opts.models_used).forEach((t) => add(where, t))
    }
    if (sq.machines[spec.machine]?.herdr === 'macbook') mac += seatCount(sq, role)
  }
  if (multi) {
    const b = sq.roles.builder?.count, r = sq.roles.reviewer?.count
    for (const k of Object.keys(typeof b === 'object' ? b : {}).sort()) {
      if (!(typeof r === 'object' && k in r)) add('role:reviewer', `Repo ${k} has builders but no reviewers: add a reviewer there.`)
    }
  }
  if (mac > 8) add('squad', `That puts ${mac} seats on the MacBook; it takes 8.`)
  const long = longSessionName(sq, project)
  if (long) add('squad', 'A seat name would be longer than herdr allows (32 characters): use a shorter repo, area or machine name.')
  return out
}

function fallbackProblems(fb: Fallback[] | undefined, agent: string, model: string | undefined, label: string, used?: SquadOptions['models_used']): string[] {
  if (!fb) return []
  const out: string[] = []
  if (fb.length > 5) out.push(`${label}: at most 5 backups.`)
  const seen = new Set<string>()
  fb.forEach((f, i) => {
    const p = modelProblem(f.agent, f.model, used?.[f.agent])
    if (p) out.push(`${label}, backup ${i + 1}: ${p}`)
    const pair = `${f.agent} ${f.model}`
    if (f.agent === agent && f.model === model) out.push(`${label}, backup ${i + 1} is the same as the seat itself.`)
    if (seen.has(pair)) out.push(`${label}, backup ${i + 1} is listed twice.`)
    seen.add(pair)
  })
  return out
}

/** The first session name over herdr's 32 characters, as cb.squad_set builds them, or null. */
export function longSessionName(sq: Squad, p: string): string | null {
  const names: string[] = []
  const r = sq.roles, multi = isMulti(sq), home = homeRepo(sq)
  if (r.lead) names.push(`orch@${r.lead.machine}`, `${p}-orch@${r.lead.machine}`)
  if (r.owner) for (const a of sq.areas ?? []) names.push(`${p}-O-${areaName(a)}@${r.owner.machine}`)
  const letters: [Role, string][] = [['architect', 'A'], ['builder', 'B'], ['reviewer', 'R'], ['qa', 'Q'], ['investigator', 'I']]
  for (const [role, letter] of letters) {
    const spec = r[role]
    if (!spec) continue
    const counts = typeof spec.count === 'object' ? spec.count : { main: spec.count ?? 0 }
    for (const [k, n] of Object.entries(counts)) {
      const part = !multi || k === home || !REPO_BOUND.includes(role) ? '' : `${k}-`
      names.push(`${p}-${part}${letter}${n}@${spec.machine}`)
    }
  }
  return names.find((n) => n.length > 32) ?? null
}

// ---------------------------------------------------------------- summary and history sentences
function countWords(sq: Squad, role: Role): string {
  const spec = sq.roles[role]!
  if (role === 'owner') return `one per area (${(sq.areas ?? []).map(areaName).join(', ') || 'none'})`
  if (typeof spec.count === 'object') return Object.entries(spec.count).map(([r, n]) => `${n} in ${r}`).join(', ')
  return plural(spec.count ?? 0, 'seat')
}
const fbWords = (fb?: Fallback[]) => (fb?.length ? fb.map((f) => setupLabel(f.agent, f.model, f.effort)).join('; ') : 'none')
/** The list the chosen machine sent for an agent: under its name in the squad, else under its herdr label; null: none. */
export function machineModels(opts: Pick<SquadOptions, 'machine_models'>, key: string, machine: MachineSpec | undefined, agent: string): ModelList | null {
  const all = opts.machine_models ?? {}
  return all[key]?.[agent] ?? (machine?.herdr ? all[machine.herdr.toLowerCase()]?.[agent] : undefined) ?? null
}
/** The efforts to offer: the listed model's own when its CLI names them, else the agent's. The saved one stays shown. */
export function effortChoices(opts: Pick<SquadOptions, 'efforts'>, agent: string, list: ModelList | null, model: string, current?: string): string[] {
  const all = opts.efforts[agent] ?? []
  const own = list?.models.find((m) => m.id === model)?.efforts
  return all.filter((e) => !own?.length || own.includes(e) || e === current)
}
/** A seat's effort: its own, else its role's when it runs the role's agent (as seatSpec, cli/squad-up.ts). */
export const seatEffort = (role: { agent?: string; effort?: string }, seat: { agent?: string; effort?: string }) =>
  seat.effort ?? ((seat.agent ?? role.agent ?? 'claude') === (role.agent ?? 'claude') ? role.effort : undefined)

/** A saved squad as lines a person reads (the history's "view"). */
export function summarizeSquad(sq: Squad | null): string[] {
  if (!sq) return ['No squad.']
  const lines: string[] = []
  for (const role of ROLES) {
    const spec = sq.roles[role]
    if (!spec) continue
    let line = `${ROLE_MANY[role]}: ${countWords(sq, role)} on ${machineLabel(sq.machines[spec.machine], spec.machine)}, ${setupLabel(spec.agent, spec.model, spec.effort)}`
    if (spec.fallback?.length) line += `; backup if it stops: ${fbWords(spec.fallback)}`
    lines.push(line + '.')
    for (const [k, s] of Object.entries(spec.seats ?? {})) {
      lines.push(`${seatKeyLabel(sq, role, k)} runs ${setupLabel(s.agent ?? spec.agent, s.model ?? spec.model, seatEffort(spec, s))}${s.fallback?.length ? `; backup: ${fbWords(s.fallback)}` : ''}.`)
    }
  }
  const off = ROLES.filter((r) => !sq.roles[r]).map((r) => ROLE_MANY[r])
  if (off.length) lines.push(`Off: ${off.join(', ')}.`)
  lines.push(`Supervisor: ${sq.supervise ? 'on' : 'off'}.`)
  for (const [k, m] of Object.entries(sq.machines)) lines.push(`Machine ${k}: ${machineLabel(m, k)}${m.repo ? `, repo folder ${m.repo}` : ''}, board folder ${m.board}.`)
  for (const [k, r] of Object.entries(sq.repos ?? {})) {
    lines.push(`Repo ${k}${r.home ? ' (home)' : ''}: ${Object.entries(r.paths).map(([mk, p]) => `${machineLabel(sq.machines[mk], mk)} ${p}`).join(', ')}.`)
  }
  if (sq.protected?.length) lines.push(`Protected branches: ${sq.protected.join(', ')}.`)
  return lines
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** What changed from one saved squad to the next, as sentences ("Builders in platform: 4 → 5"). */
export function diffSquads(a: Squad | null, b: Squad | null): string[] {
  if (!a || !b) return b ? ['First setup.'] : ['Squad removed.']
  const out: string[] = []
  for (const role of ROLES) {
    const x = a.roles[role], y = b.roles[role], name = ROLE_MANY[role]
    if (!x && !y) continue
    if (!x) { out.push(`${name} turned on: ${countWords(b, role)}, ${setupLabel(y!.agent, y!.model, y!.effort)}.`); continue }
    if (!y) { out.push(`${name} turned off.`); continue }
    if (role !== 'owner' && !same(x.count, y.count)) {
      if (typeof x.count === 'object' || typeof y.count === 'object') {
        const xc = typeof x.count === 'object' ? x.count : {}, yc = typeof y.count === 'object' ? y.count : {}
        for (const r of [...new Set([...Object.keys(xc), ...Object.keys(yc)])].sort()) {
          if (xc[r] !== yc[r]) out.push(`${name} in ${r}: ${xc[r] ?? 0} → ${yc[r] ?? 0}.`)
        }
      } else out.push(`${name}: ${x.count ?? 0} → ${y.count ?? 0} seats.`)
    }
    if (x.machine !== y.machine) out.push(`${name} moved from ${machineLabel(a.machines[x.machine], x.machine)} to ${machineLabel(b.machines[y.machine], y.machine)}.`)
    if ((x.agent ?? 'claude') !== (y.agent ?? 'claude') || x.model !== y.model || x.effort !== y.effort) {
      out.push(`${name}: ${setupLabel(x.agent, x.model, x.effort)} → ${setupLabel(y.agent, y.model, y.effort)}.`)
    }
    if (!same(x.fallback, y.fallback)) out.push(`${name} backups: ${fbWords(x.fallback)} → ${fbWords(y.fallback)}.`)
    if (!same(x.seats, y.seats)) out.push(`${name}: single-seat settings changed.`)
  }
  const an = (a.areas ?? []).map(areaName), bn = (b.areas ?? []).map(areaName)
  for (const n of bn) if (!an.includes(n)) out.push(`Area ${n} added.`)
  for (const n of an) if (!bn.includes(n)) out.push(`Area ${n} removed.`)
  if (!!a.supervise !== !!b.supervise) out.push(`Supervisor turned ${b.supervise ? 'on' : 'off'}.`)
  for (const k of new Set([...Object.keys(a.machines), ...Object.keys(b.machines)])) {
    const x = a.machines[k], y = b.machines[k]
    if (!x) out.push(`Machine ${k} added (${machineLabel(y, k)}).`)
    else if (!y) out.push(`Machine ${k} removed.`)
    else if (!same(x, y)) out.push(`Machine ${k} changed (${machineLabel(y, k)}).`)
  }
  for (const k of new Set([...Object.keys(a.repos ?? {}), ...Object.keys(b.repos ?? {})])) {
    const x = a.repos?.[k], y = b.repos?.[k]
    if (!x) out.push(`Repo ${k} added.`)
    else if (!y) out.push(`Repo ${k} removed.`)
    else if (!same(x, y)) out.push(`Repo ${k}: folders or home changed.`)
  }
  if (!same(a.protected, b.protected)) out.push('Protected branches changed.')
  return out.length ? out : ['No change anyone would see (the same squad saved again).']
}

/** One history row's sentences: the change from the save before it. The oldest row in the window has no save before it
 *  to compare with: it reads "First setup" only when it was the first version. */
export function historyLines(history: SquadPage['history'], i: number): string[] {
  const row = history[i]!, prev = history[i + 1]
  if (prev) return diffSquads(prev.squad, row.squad)
  return row.version === 1 ? ['First setup.'] : ['Saved. Earlier saves are not listed here.']
}

// ---------------------------------------------------------------- live seats
/** A live session in words: "Builder 3 on MacBook", "The lead on This PC". The session name stays in a tooltip. */
export function seatName(s: Seat, sq: Squad | null): string {
  const key = s.actor.split('@')[1]
  // a session name whose machine key is not in the squad: the squad machine with that herdr name, never the raw name
  const byHerdr = s.machine ? Object.values(sq?.machines ?? {}).find((x) => x.herdr === s.machine) ?? (s.machine === 'macbook' ? { herdr: s.machine } : null) : null
  const m = key && sq?.machines[key] ? machineLabel(sq.machines[key], key) : byHerdr ? machineLabel(byHerdr) : 'another machine'
  const n = (s.actor.match(/[ABRQI]([0-9]+)@/) ?? [])[1]
  if (s.role === 'lead') return `The lead on ${m}`
  if (s.role === 'owner') return `Area owner${s.area ? ` of ${s.area}` : ''} on ${m}`
  const repo = sq && isMulti(sq) && s.repo && s.repo !== homeRepo(sq) ? ` in ${s.repo}` : ''
  return `${roleOne(s.role ?? '')}${n ? ` ${n}` : ''}${repo} on ${m}`
}

/** What happens to a live seat that is not on the squad's setting. Only a supervised project (the supervisor switch on)
 *  restarts or closes seats by itself, and never the lead (Q2970). null: the seat is fine. */
export function seatNote(s: Seat, sq: Squad | null, supervised: boolean): string | null {
  const name = seatName(s, sq)
  if (!s.in_squad) {
    return supervised ? `${name} is no longer in this squad: it closes once it is idle.` : `${name} is no longer in this squad: nothing closes it on its own.`
  }
  // #4786: first, since the squad's setting says nothing about a model switched inside the agent
  if (s.model_differs) return `${name} was started on ${setupLabel(s.agent, s.model)} and now runs ${s.running_model}.`
  if (s.same !== false) return null
  const was = `${name} runs ${setupLabel(s.agent, s.model)}; the squad says ${setupLabel(s.want_agent, s.want_model)}.`
  if (!supervised || s.role === 'lead') return `${was} It changes at its next start.`
  return s.holds > 0 ? `${was} It is busy with ${plural(s.holds, 'card')}: it will restart on the new setting when idle.` : `${was} It will restart on the new setting when idle.`
}

// ---------------------------------------------------------------- role text and server messages
export const ROLE_TEXT_CAP = 8000
/** Characters as the server counts them (code points): the counter and the Last edits lengths agree. */
export const charCount = (s: string) => [...s].length
/** The role text as cb.role_text_set will store it (spaces, tabs and line breaks trimmed at both ends) and its length in
 *  characters (Postgres length counts code points, so does [...s]). */
export function roleTextState(body: string, saved: string) {
  const t = body.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
  const count = charCount(t)
  const over = count > ROLE_TEXT_CAP, empty = count === 0, changed = t !== saved
  return { count, over, empty, changed, canSave: changed && !over && !empty }
}

/** A project's addition (#4525): trimmed as cb.project_role_set stores it, against its 1000 cap. Empty is allowed: it
 *  removes the addition. */
export const ADDITION_CAP = 1000
export function additionState(body: string, saved: string) {
  const t = body.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
  const count = charCount(t)
  const over = count > ADDITION_CAP, changed = t !== saved
  return { count, over, changed, canSave: changed && !over }
}
/** Who stuck seats ask first, as cb.project_role_set takes it: lead, ahmed, or a session name. */
export const SESSION_NAME = /^[A-Za-z0-9@._-]{1,64}$/
export type AskFirst = { kind: 'lead' | 'ahmed' | 'session'; name: string }
export const askFirstOf = (v: string): AskFirst => (v === 'lead' || v === 'ahmed' ? { kind: v, name: '' } : { kind: 'session', name: v })
export const askFirstValue = (a: AskFirst) => (a.kind === 'session' ? a.name.trim() : a.kind)
export const askFirstOk = (a: AskFirst) => a.kind !== 'session' || (SESSION_NAME.test(a.name.trim()) && !['lead', 'ahmed'].includes(a.name.trim().toLowerCase()))
/** Mid-sentence: "seats ask the lead first". */
export const askFirstLabel = (v: string) => (v === 'lead' ? 'the lead' : v === 'ahmed' ? 'Ahmed' : v)
/** The roles whose stored text differs from the one this release ships: what "Load the new texts" would change. */
export function seedChanges(seeds: Record<string, string>, roles: RoleTextPage['roles']): string[] {
  const stored = new Map(roles.map((r) => [r.role, r.body]))
  return Object.keys(seeds).filter((k) => seeds[k] !== stored.get(k))
    .sort((a, b) => (a === '_common' ? -1 : b === '_common' ? 1 : ROLES.indexOf(a as Role) - ROLES.indexOf(b as Role)))
}

/** Of those, the ones changed by hand on this page since they were seeded or last loaded: loading would replace an edit
 *  (review M1: a load sets updated_by too, so updated_by alone would flag every loaded text). */
export const handEdited = (changes: string[], roles: RoleTextPage['roles']) =>
  changes.filter((k) => roles.find((r) => r.role === k)?.edited === true)

/** A named ask-first session that has not worked on this project lately (review M2): the page warns, the server allows. */
export const askFirstUnknown = (a: AskFirst, sessions: string[]) =>
  a.kind === 'session' && askFirstOk(a) && !sessions.some((s) => s.toLowerCase() === a.name.trim().toLowerCase())

/** squad_set's stale refusal opens with these words (db/schema.sql; test/settings-web.test.ts pins them). */
export const STALE_PREFIX = 'Someone changed this squad since your copy was taken'
export const OWNER_ONLY_MESSAGE = 'Only Ahmed changes project settings.'

/** What a person sees when a save fails. Only two server sentences are shown as they are: the stale-copy one (its
 *  first sentence: the rest names a CLI command) and the owner-only one. squad_set's open-work refusal (a repo removed
 *  while open cards name it: the form can't see that) is reworded with its card numbers. Anything else is the caller's
 *  plain sentence; the details belong in the console. */
export function saveError(e: unknown, plain: string): { kind: 'stale' | 'owner' | 'other'; text: string } {
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (msg.startsWith(STALE_PREFIX)) {
    const first = msg.match(/^[^.]*?\(it is now version \d+, your copy is version \d+\)\./)
    return { kind: 'stale', text: first ? first[0] : `${STALE_PREFIX}.` }
  }
  if (msg.trim() === OWNER_ONLY_MESSAGE) return { kind: 'owner', text: OWNER_ONLY_MESSAGE }
  const work = msg.match(/^repo ([a-z][a-z0-9-]*) still has open work \(((?:#\d+(?:, )?)+)\)/)
  if (work) return { kind: 'other', text: `Repo ${work[1]} still has open cards (${work[2]}). Finish or move them before removing it.` }
  return { kind: 'other', text: plain }
}
