import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  CLAUDE_MODELS, REPO_BOUND, agentLabel, effortChoices, homeRepo, machineModels, isMulti, machineLabel, modelLabel, modelProblem, patchRole, plural, roleLabel,
  patchSeat, seatBlank, seatCount, seatKeyLabel, seatKeys, seatName, seatNote, setCount, setRoleOn, setupLabel,
  type Fallback, type ModelList, type Role, type Seat, type SeatSpec, type Squad, type SquadOptions,
} from '@/lib/squad'
import { NativeSelect, Problems, Stepper } from './bits'

const OTHER = '__other__' // never a model name: no agent's shape starts with an underscore

/** A model field. Claude: its four names. Another agent: the list the seat's machine sent, with Other for a name typed by
 *  hand; with no list, typed freely, with the names already used offered as buttons that replace the value. Never a native
 *  datalist: selecting a second suggestion appended it to the first with no separator (#4717). */
export function ModelField({ agent, value, onChange, label, options, list, blank }: {
  agent: string; value: string; onChange: (m: string) => void; label: string; options: SquadOptions; list: ModelList | null
  /** the empty choice, when empty means something (a seat taking its role's model) */
  blank?: string
}) {
  const [other, setOther] = useState(false)
  if (agent === 'claude') {
    return (
      <NativeSelect label={label} value={value} onChange={onChange}>
        {(blank || !(CLAUDE_MODELS as readonly string[]).includes(value)) && <option value="">{blank ?? 'Pick a model'}</option>}
        {options.claude_models.map((m) => <option key={m} value={m}>{modelLabel(m)}</option>)}
      </NativeSelect>
    )
  }
  const listed = !!list?.models.some((m) => m.id === value)
  const typed = !list || other || (!!value && !listed)
  const used = list ? [] : options.models_used[agent] ?? []
  return (
    <>
      {list && (
        <NativeSelect label={label} value={typed ? OTHER : value} onChange={(m) => { setOther(m === OTHER); onChange(m === OTHER ? '' : m) }}>
          {(blank || (!typed && !listed)) && <option value="">{blank ?? 'Pick a model'}</option>}
          {list.models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          <option value={OTHER}>Other…</option>
        </NativeSelect>
      )}
      {typed && (
        <Input aria-label={list ? `${label}, typed` : label} value={value} onChange={(e) => onChange(e.target.value.trim())} spellCheck={false}
          placeholder={blank ?? (agent === 'opencode' ? 'provider/model' : 'model name')} className="h-8 w-48 font-mono text-xs" />
      )}
      {used.length > 0 && (
        <span className="inline-flex flex-wrap gap-1" aria-label={`Models already used for ${label}`}>
          {used.map((m) => (
            <Button key={m} type="button" variant="outline" size="xs" aria-label={`Use ${m} for ${label}`} title={m}
              className="max-w-[12rem] truncate font-mono" onClick={() => onChange(m)}>{m}</Button>
          ))}
        </span>
      )}
    </>
  )
}

function AgentField({ value, onChange, label, options, backup }: {
  value: string; onChange: (a: string) => void; label: string; options: SquadOptions; backup?: boolean
}) {
  return (
    <NativeSelect label={label} value={value} onChange={onChange}>
      {options.agents.map((a) => (
        <option key={a.agent} value={a.agent} disabled={!backup && !a.main}>
          {agentLabel(a.agent)}{!backup && !a.main ? ' (not ready yet)' : ''}
        </option>
      ))}
    </NativeSelect>
  )
}

/** How hard the agent thinks, from the levels that agent takes at start; the first choice leaves it to the agent. An
 *  agent that takes none gets a line of text instead of a list. */
function EffortField({ agent, model, list, value, onChange, label, options, blank = 'Default effort' }: {
  agent: string; model: string; list: ModelList | null; value: string; onChange: (e: string | undefined) => void; label: string; options: SquadOptions
  blank?: string
}) {
  const levels = effortChoices(options, agent, list, model, value || undefined)
  if (levels.length === 0) return <span className="text-[13px] text-muted-foreground">{agentLabel(agent)} takes no effort setting.</span>
  return (
    <NativeSelect label={label} value={value} onChange={(e) => onChange(e || undefined)}>
      <option value="">{blank}</option>
      {levels.map((l) => <option key={l} value={l}>{l} effort</option>)}
    </NativeSelect>
  )
}

/** The seats set differently from their role, each with its agent, model and effort, and a list to set another one apart.
 *  A seat picked there is only on screen until one of its choices changes: nothing empty is saved. */
function SeatRows({ role, squad, options, edit, modelsOf }: {
  role: Role; squad: Squad; options: SquadOptions; edit: (f: (s: Squad) => Squad) => void
  modelsOf: (agent: string) => ModelList | null
}) {
  const [adding, setAdding] = useState<string>()
  const spec = squad.roles[role]!
  const keys = seatKeys(squad, role)
  const own = spec.seats ?? {}
  const rows = keys.filter((k) => own[k] || k === adding)
  const free = keys.filter((k) => !rows.includes(k))
  if (rows.length === 0 && keys.length < 2) return null // one seat is the role itself
  const roleAgent = spec.agent ?? 'claude'
  const patch = (k: string, p: SeatSpec) => edit((s) => patchSeat(s, role, k, p, options.default_models))
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">Seats set differently</div>
      {rows.map((k) => {
        const seat = own[k] ?? {}
        const agent = seat.agent ?? roleAgent
        const model = seat.model ?? (seat.agent ? '' : spec.model ?? '')
        const blank = seatBlank(spec, seat)
        const who = seatKeyLabel(squad, role, k)
        const list = modelsOf(agent)
        return (
          <div key={k} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 font-medium">{who}</span>
              <Button variant="ghost" size="xs" onClick={() => {
                if (adding === k) setAdding(undefined)
                edit((s) => {
                  const next = patchSeat(s, role, k, {}, options.default_models)
                  const st = next.roles[role]?.seats
                  if (st) { delete st[k]; if (Object.keys(st).length === 0) delete next.roles[role]!.seats }
                  return next
                })
              }}>Same as the others</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <AgentField value={agent} onChange={(a) => { setAdding(k); patch(k, { agent: a }) }} label={`Agent for ${who}`} options={options} />
              <ModelField key={`${agent}-${spec.machine}`} agent={agent} list={list} value={seat.model ?? ''} blank={blank.model}
                onChange={(m) => { setAdding(k); patch(k, { model: m }) }} label={`Model for ${who}`} options={options} />
              <EffortField agent={agent} model={model} list={list} value={seat.effort ?? ''} blank={blank.effort}
                onChange={(v) => { setAdding(k); patch(k, { effort: v }) }} label={`Effort for ${who}`} options={options} />
            </div>
            {!!seat.fallback?.length && <div className="text-[13px] text-muted-foreground">Has its own backups: {seat.fallback.map((f) => setupLabel(f.agent, f.model, f.effort)).join('; ')}.</div>}
          </div>
        )
      })}
      {free.length > 0 && keys.length > 1 && (
        <NativeSelect label={`Set one seat of ${roleLabel(role)} differently`} value="" onChange={(k) => setAdding(k || undefined)}>
          <option value="">Set one seat differently…</option>
          {free.map((k) => <option key={k} value={k}>{seatKeyLabel(squad, role, k)}</option>)}
        </NativeSelect>
      )}
    </div>
  )
}

/** Backups a seat moves to if its agent stops: the supervisor moves it only where automatic backup is on (#4787). */
function Backups({ list, onChange, own, options, label, modelsOf, machine }: {
  list: Fallback[]; onChange: (l: Fallback[] | undefined) => void; own: Fallback; options: SquadOptions; label: string
  modelsOf: (agent: string) => ModelList | null
  machine: string
}) {
  const [agent, setAgent] = useState('codex')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<string>()
  const max = options.limits.fallbacks
  const problem = model ? modelProblem(agent, model, options.models_used[agent]) : null
  const dup = list.some((f) => f.agent === agent && f.model === model) || (own.agent === agent && own.model === model)
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">Backup if it stops <span className="text-muted-foreground/80">(used only while Automatic backup is on, under Switches)</span></div>
      {list.length === 0 && <div className="text-sm text-muted-foreground">None.</div>}
      <ol className="space-y-1">
        {list.map((f, i) => (
          <li key={`${f.agent}-${f.model}`} className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground tabular-nums">{i + 1}.</span>
            <span className="min-w-0 truncate">{setupLabel(f.agent, f.model, f.effort)}</span>
            <Button variant="ghost" size="icon-xs" aria-label={`Remove backup ${i + 1} of ${label}`}
              onClick={() => { const l = list.filter((_, j) => j !== i); onChange(l.length ? l : undefined) }}><X /></Button>
          </li>
        ))}
      </ol>
      {list.length < max && (
        <div className="flex flex-wrap items-center gap-2">
          <AgentField value={agent} onChange={(a) => { setAgent(a); setModel(a === 'claude' ? 'sonnet' : ''); setEffort(undefined) }} label={`Backup agent for ${label}`} options={options} backup />
          <ModelField key={`${agent}-${machine}`} agent={agent} list={modelsOf(agent)} value={model} onChange={setModel} label={`Backup model for ${label}`} options={options} />
          <EffortField agent={agent} model={model} list={modelsOf(agent)} value={effort ?? ''} onChange={setEffort} label={`Backup effort for ${label}`} options={options} />
          <Button variant="outline" size="sm" disabled={!model || !!problem || dup}
            onClick={() => { onChange([...list, { agent, model, ...(effort ? { effort } : {}) }]); setModel(agent === 'claude' ? 'sonnet' : ''); setEffort(undefined) }}><Plus /> Add a backup</Button>
          {model && problem && <span className="w-full text-[13px] text-destructive">{problem}</span>}
          {model && !problem && dup && <span className="w-full text-[13px] text-muted-foreground">That one is already listed, or is the seat itself.</span>}
        </div>
      )}
    </div>
  )
}

export function RoleCard({ role, squad, options, seats, supervised, problems, edit }: {
  role: Role; squad: Squad; options: SquadOptions; seats: Seat[]; supervised: boolean; problems: string[]
  edit: (f: (s: Squad) => Squad) => void
}) {
  const spec = squad.roles[role]
  const name = roleLabel(role)
  const on = !!spec
  const defaults = options.default_models
  const lim = options.limits
  const live = seats.filter((s) => s.role === role)
  const notes = live.flatMap((s) => { const n = seatNote(s, squad, supervised); return n ? [{ actor: s.actor, n }] : [] })
  const multi = isMulti(squad)
  const agent = spec?.agent ?? 'claude'
  const modelsOf = (a: string) => (spec ? machineModels(options, spec.machine, squad.machines[spec.machine], a) : null)
  const models = modelsOf(agent)
  const machineName = spec && squad.machines[spec.machine] ? machineLabel(squad.machines[spec.machine], spec.machine) : 'This machine'

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">{name}</h3>
        {on && <span className="text-sm text-muted-foreground">{plural(seatCount(squad, role), 'seat')}</span>}
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={on}
            onChange={(e) => edit((s) => setRoleOn(s, role, e.target.checked, defaults))} />
          {on ? 'On' : 'Off'}
        </label>
      </div>
      {on && spec && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-16 text-xs text-muted-foreground">Seats</span>
            {role === 'lead' ? <span>1 (a squad has one lead)</span>
              : role === 'owner' ? <span className="min-w-0">One per area: {(squad.areas ?? []).length ? (squad.areas ?? []).map((a) => (typeof a === 'string' ? a : a.name)).join(', ') : 'no areas yet'} <span className="text-muted-foreground">(areas below)</span></span>
                : multi && REPO_BOUND.includes(role) ? (
                  Object.keys(squad.repos ?? {}).map((r) => (
                    <span key={r} className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">{r}</span>
                      <Stepper label={`${name} in ${r}`} value={typeof spec.count === 'object' ? spec.count[r] ?? 0 : 0} min={0} max={lim.count_max}
                        onChange={(n) => edit((s) => setCount(s, role, n, r))} />
                    </span>
                  ))
                ) : (
                  <Stepper label={name} value={typeof spec.count === 'number' ? spec.count : 1} min={lim.count_min} max={lim.count_max}
                    onChange={(n) => edit((s) => setCount(s, role, n))} />
                )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">Machine</span>
            <NativeSelect label={`Machine for ${name}`} value={spec.machine} onChange={(m) => edit((s) => patchRole(s, role, { machine: m }, defaults))}>
              {!squad.machines[spec.machine] && <option value={spec.machine}>Pick a machine</option>}
              {Object.entries(squad.machines).map(([k, m]) => <option key={k} value={k}>{machineLabel(m, k)} ({k})</option>)}
            </NativeSelect>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-16 text-xs text-muted-foreground">Runs</span>
            <AgentField value={agent} onChange={(a) => edit((s) => patchRole(s, role, { agent: a }, defaults))} label={`Agent for ${name}`} options={options} />
            <ModelField key={`${agent}-${spec.machine}`} agent={agent} list={models} value={spec.model ?? ''} onChange={(m) => edit((s) => patchRole(s, role, { model: m }, defaults))} label={`Model for ${name}`} options={options} />
            <EffortField agent={agent} model={spec.model ?? ''} list={models} value={spec.effort ?? ''} onChange={(v) => edit((s) => patchRole(s, role, { effort: v }, defaults))} label={`Effort for ${name}`} options={options} />
          </div>
          {agent !== 'claude' && <p className="text-[13px] text-muted-foreground">Starts only on machines where its tool check has been confirmed.</p>}
          {agent !== 'claude' && (
            <p className="text-[13px] text-muted-foreground">
              {models ? `The list is what ${agentLabel(agent)} offered on ${machineName} on ${models.at.slice(0, 10)}. To refresh it, run cb models report there.`
                : `${machineName} has not sent its ${agentLabel(agent)} models yet. Run cb models report there to get a list to pick from.`}
            </p>
          )}
          <Backups list={spec.fallback ?? []} own={{ agent, model: spec.model ?? '' }} options={options} label={name} modelsOf={modelsOf} machine={spec.machine}
            onChange={(l) => edit((s) => patchRole(s, role, { fallback: l }, defaults))} />
          <SeatRows role={role} squad={squad} options={options} edit={edit} modelsOf={modelsOf} />
          <div className="border-t pt-2 text-sm">
            <span className="text-muted-foreground">Running now: </span>
            {live.length === 0 ? 'none' : `${live.length} of ${seatCount(squad, role)}`}
            {notes.length === 0 && live.length > 0 && <span className="text-muted-foreground">, all on this setting</span>}
            {notes.length > 0 && (
              <ul className="mt-1 space-y-1 text-[13px] text-lamp-ink dark:text-lamp">
                {notes.map((x) => <li key={x.actor} title={x.actor}>{x.n}</li>)}
              </ul>
            )}
          </div>
        </>
      )}
      {!on && <p className="text-[13px] text-muted-foreground">{role === 'owner' ? 'Off. Adding an area below turns area owners on.' : 'Off: this squad has none. Turn it on to add seats.'}</p>}
      {!on && live.length > 0 && (
        <ul className="space-y-1 text-[13px] text-muted-foreground">
          {live.map((s) => <li key={s.actor} title={s.actor}>{seatNote(s, squad, supervised) ?? `${seatName(s, squad)} is still running.`}</li>)}
        </ul>
      )}
      <Problems items={problems} />
      {multi && REPO_BOUND.includes(role) && on && !homeRepo(squad) && <p className="text-[13px] text-muted-foreground">Mark a home repo below.</p>}
    </li>
  )
}
