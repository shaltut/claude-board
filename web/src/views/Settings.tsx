import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Settings as Gear } from 'lucide-react'
import { rpc, useProjects } from '@/lib/api'
import { href, type Route } from '@/lib/route'
import { Button } from '@/components/ui/button'
import { ProjectsList } from '@/components/projects/ProjectsList'
import {
  ROLES, checkSquad, diffSquads, isMulti, plural, saveError, seatCount, setSupervise, toDocument, type Squad, type SquadOptions, type SquadPage,
} from '@/lib/squad'
import { Notice, Section } from '@/components/settings/bits'
import { RoleCard } from '@/components/settings/RoleCard'
import { Areas, Machines, Repos } from '@/components/settings/Machines'
import { SquadHistory } from '@/components/settings/SquadHistory'
import { RoleTexts } from '@/components/settings/RoleTexts'
import { ProjectRoleText } from '@/components/settings/ProjectRoleText'
import { GitHub } from '@/components/settings/GitHub'

/** Project settings (#4332): one project's squad, switches, reminders and GitHub watches, and the board-wide role texts.
 *  With no project chosen: the Projects list (#4559), where Ahmed enables, disables and archives them.
 *  Owner only: App.tsx keeps other admins out, and the server refuses their writes. */
export function Settings({ route }: { route: Route }) {
  if (!route.project) return <ProjectsList />
  return <ProjectSettings key={route.project} project={route.project} />
}

const useSquadPage = (project: string) =>
  useQuery({ queryKey: ['squad-page', project], refetchInterval: 30_000, queryFn: () => rpc<SquadPage>('squad_page', { project }) })
const useSquadOptions = () => useQuery({ queryKey: ['squad-options'], queryFn: () => rpc<SquadOptions>('squad_options', {}) })

function ProjectSettings({ project }: { project: string }) {
  const qc = useQueryClient()
  const page = useSquadPage(project)
  const options = useSquadOptions()
  const { data: projects = [] } = useProjects()
  const name = projects.find((p) => p.slug === project)?.name ?? project
  // the unsaved squad and the version it was taken from; a refetch never overwrites it
  const [draft, setDraft] = useState<{ base: number; squad: Squad } | null>(null)
  const [saveState, setSaveState] = useState<{ kind: 'stale' | 'owner' | 'other'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  if (page.isError) console.error('settings did not load', page.error)
  if (options.isError) console.error('settings options did not load', options.error)
  const data = page.data, opts = options.data
  const header = (
    <header className="mb-6">
      <a href={href({ view: 'settings' })} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">← Projects</a>
      <h1 className="flex items-center gap-2 text-[28px] leading-tight font-semibold tracking-[-0.015em]">
        <Gear className="size-6 text-muted-foreground" aria-hidden /> Project settings
      </h1>
      <p className="mt-1 max-w-[80ch] text-sm text-muted-foreground text-pretty">
        How <span className="font-medium text-foreground">{name}</span> works: its squad, its switches, its GitHub watches,
        and the role texts every project's seats read.
      </p>
      <nav aria-label="Sections" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {[['squad', 'Squad'], ['switches', 'Switches and reminders'], ['role-text', 'Role text'], ['github', 'GitHub watches']].map(([id, l]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id!)?.scrollIntoView({ behavior: 'smooth' }) }}
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{l}</a>
        ))}
      </nav>
    </header>
  )
  if (page.isLoading || options.isLoading) return <div>{header}<p className="text-sm text-muted-foreground">Loading the settings…</p></div>
  if (!data || !opts) return <div>{header}<Notice tone="error">The settings did not load. Reload the page to try again.</Notice></div>

  const squad = draft?.squad ?? data.squad
  const edit = (f: (s: Squad) => Squad) => {
    setSaveState(null)
    setDraft((d) => ({ base: d?.base ?? data.version, squad: f(d?.squad ?? data.squad!) }))
  }
  const dirty = !!draft && JSON.stringify(toDocument(draft.squad)) !== JSON.stringify(data.squad)
  const movedOn = dirty && draft.base !== data.version // saved elsewhere while this was being edited
  const problems = squad ? checkSquad(squad, project, opts) : []
  const at = (where: string) => problems.filter((p) => p.where === where).map((p) => p.text)
  const changes = dirty && draft ? diffSquads(data.squad, draft.squad) : []
  const supervised = !!squad?.supervise // as it will be once saved: the save bar's sentence
  const supervisedNow = data.supervise // as saved: what running seats do now
  const reload = () => { setDraft(null); setSaveState(null); void qc.invalidateQueries({ queryKey: ['squad-page', project] }) }

  async function save() {
    if (!draft || problems.length) return
    setBusy(true); setSaveState(null)
    try {
      const r = await rpc<Squad & { version: number; changed: boolean }>('squad_set', { project, squad: toDocument(draft.squad), base: draft.base, with_version: true })
      setDraft(null)
      await qc.invalidateQueries({ queryKey: ['squad-page', project] })
      toast.success(r.changed ? `Squad saved (version ${r.version})` : 'Nothing changed: the squad is already this')
    } catch (e) {
      console.error('squad save failed', e)
      setSaveState(saveError(e, 'The squad was not saved. Nothing changed; check the settings above and try again.'))
    } finally { setBusy(false) }
  }

  const macSeats = squad ? ROLES.reduce((n, r) => n + (squad.machines[squad.roles[r]?.machine ?? '']?.herdr === 'macbook' ? seatCount(squad, r) : 0), 0) : 0
  const staleText = saveState?.kind === 'stale' ? saveState.text
    : movedOn ? `Someone saved this squad while you were editing (it is now version ${data.version}, your copy is version ${draft!.base}).` : null

  return (
    <div className="space-y-8">
      {header}
      <Section id="squad" title="Squad" who="owner"
        intro="Who works on this project, on which machine, with which agent and model. The lead can still change it from the command line."
        aside={<span className="text-xs text-muted-foreground tabular-nums">version {data.version}</span>}>
        {!squad ? (
          <p className="text-sm text-muted-foreground">This project has no squad yet. The lead sets up the first one from the command line; after that you change it here.</p>
        ) : (
          <div className="space-y-6">
            {staleText && (
              <Notice action={<Button size="sm" variant="outline" onClick={reload}>Reload</Button>}>
                {staleText} Reload to get the newest one, then make your change again.
              </Notice>
            )}
            <p className="text-sm text-muted-foreground">
              {plural(data.seats.filter((s) => s.role).length, 'seat')} running now
              {macSeats > 0 && ` · MacBook: ${macSeats} of ${opts.limits.macbook_seats} seats in this squad (other projects' running seats count too)`}
            </p>
            <ul className="grid items-start gap-3 lg:grid-cols-2">
              {ROLES.map((r) => <RoleCard key={r} role={r} squad={squad} options={opts} seats={data.seats} supervised={supervisedNow} problems={at(`role:${r}`)} edit={edit} />)}
            </ul>
            <div>
              <h3 className="mb-2 font-medium">Areas</h3>
              <Areas squad={squad} ownerModel={opts.default_models.owner ?? 'sonnet'} problems={at('areas')} edit={edit} />
            </div>
            <div>
              <h3 className="mb-2 font-medium">Machines and folders</h3>
              <Machines squad={squad} options={opts} problems={at('machines')} edit={edit} />
            </div>
            <div>
              <h3 className="mb-2 font-medium">{isMulti(squad) ? 'Repos' : 'Repo'}</h3>
              <Repos squad={squad} problems={at('repos')} edit={edit} />
            </div>
            {squad.protected && squad.protected.length > 0 && (
              <p className="text-sm text-muted-foreground">Protected branches: {squad.protected.join(', ')} (changed from the command line, not here).</p>
            )}
            {(dirty || saveState) && (
              <div className="sticky bottom-3 z-10 rounded-lg border bg-popover p-3 shadow-lg">
                {changes.length > 0 && (
                  <>
                    <div className="mb-1 text-sm font-medium">What will change</div>
                    <ul className="mb-2 max-h-40 space-y-0.5 overflow-auto text-[13px] text-pretty">{changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
                  </>
                )}
                {at('squad').length > 0 && <ul className="mb-2 space-y-0.5 text-[13px] text-destructive">{at('squad').map((t, i) => <li key={i}>{t}</li>)}</ul>}
                {problems.length > 0 && <p className="mb-2 text-[13px] text-destructive">Fix {plural(problems.length, 'thing')} marked above before saving.</p>}
                {saveState && saveState.kind !== 'stale' && <p className="mb-2 text-[13px] text-destructive" role="alert">{saveState.text}</p>}
                <p className="mb-2 text-[13px] text-muted-foreground">
                  {supervised ? `${data.pipeline ? 'Seats start and close' : 'With no pipeline, seats the squad no longer names close'} on the next supervisor round; idle seats on an old agent or model restart on the new one. A new effort applies when a seat next starts.`
                    : 'The supervisor is not acting on this project, so running seats keep their setting until they next start.'}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" onClick={() => { setDraft(null); setSaveState(null) }}>Discard changes</Button>
                  <Button disabled={!dirty || problems.length > 0 || busy || !!staleText} onClick={save}>{busy ? 'Saving…' : 'Save the squad'}</Button>
                </div>
              </div>
            )}
            <div>
              <h3 className="mb-2 font-medium">History <span className="font-normal text-muted-foreground">(the last 20 saves)</span></h3>
              <SquadHistory history={data.history} />
            </div>
          </div>
        )}
      </Section>
      <Switches project={project} page={data} squad={squad} edit={edit} />
      <Section id="role-text" title="Role text" who="owner"
        intro="What each role is told when its seat starts: this project's own rules and who its seats ask first, then the texts every project shares. Seats already running read a change the next time they read their role.">
        <div className="space-y-6">
          <ProjectRoleText project={project} name={name} />
          <RoleTexts />
        </div>
      </Section>
      <Section id="github" title="GitHub watches" who="owner" intro="Repos whose pull requests come to this project as cards, and logins the board ignores.">
        <GitHub project={project} />
      </Section>
    </div>
  )
}

/** The pipeline switch and the reminders stay open to any admin (reminders also on Board and Backlog); the supervisor switch is part
 *  of the squad, so it is Ahmed's and saved with the squad. */
function Switches({ project, page, squad, edit }: { project: string; page: SquadPage; squad: Squad | null; edit: (f: (s: Squad) => Squad) => void }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const r = page.reminders
  async function run(fn: string, args: Record<string, unknown>, ok: (n: unknown) => string, plain: string) {
    setBusy(true)
    try {
      const n = await rpc(fn, { project, ...args })
      await qc.invalidateQueries({ queryKey: ['squad-page', project] })
      await qc.invalidateQueries({ queryKey: ['projects'] })
      toast.success(ok(n))
    } catch (e) {
      console.error(`${fn} failed`, e)
      toast.error(saveError(e, plain).text)
    } finally { setBusy(false) }
  }
  return (
    <Section id="switches" title="Switches and reminders" who="any"
      intro="Other admins can also change the pipeline switch and the reminders, from the command line (reminders also on Board and Backlog); this page is only yours. The supervisor switch belongs to the squad: only Ahmed changes it, and it is saved with the squad.">
      <div className="space-y-4">
        <label className="flex items-start gap-3 rounded-lg border bg-card p-3">
          <input type="checkbox" className="mt-0.5 size-4" checked={page.pipeline} disabled={busy}
            onChange={(e) => run('project_pipeline', { enabled: e.target.checked }, () => (e.target.checked ? 'Squad pipeline on' : 'Squad pipeline off'), 'The pipeline switch did not change. Try again.')} />
          <span className="text-sm">
            <span className="font-medium">Squad pipeline</span>
            <span className="block text-muted-foreground">Cards go design, your approval, build, review, merge and check.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-lg border bg-card p-3">
          <input type="checkbox" className="mt-0.5 size-4" checked={!!squad?.supervise} disabled={!squad}
            onChange={(e) => { const on = e.target.checked; edit((s) => setSupervise(s, on, page.squad)) }} />
          <span className="text-sm">
            <span className="font-medium">Supervisor</span> <span className="rounded-full bg-lamp-soft px-2 py-0.5 text-xs text-lamp-ink">Only Ahmed changes this</span>
            <span className="block text-muted-foreground">
              Restores down seats that hold cards and restarts idle seats on an old setting. With the pipeline on it also starts seats for waiting
              cards and closes idle ones; with it off, it closes only idle seats the squad no longer names.
              {' '}One supervisor serves every project, so starting it acts on: {page.acts_on?.map((a) => (a.winding_down ? `${a.project} (winding down)` : a.project)).join(', ') || 'no project yet'}.
              {squad && !!squad.supervise !== page.supervise && ' Changed here: press Save the squad above to keep it.'}
              {!squad && ' This project has no squad yet.'}
            </span>
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm">
          <span className="min-w-0 flex-1">
            <span className="font-medium">Reminders</span>
            <span className="block text-muted-foreground">{plural(r.open, 'open card')} · {r.on} with a reminder to chase it when it stops moving.</span>
          </span>
          <Button variant="outline" size="sm" disabled={busy || r.open === 0 || r.on === r.open}
            onClick={() => run('task_ping_bulk', { enabled: true }, (n) => `Reminders on for ${plural(Number(n), 'more card')}`, 'The reminders did not change. Try again.')}>Remind on all open</Button>
          <Button variant="outline" size="sm" disabled={busy || r.on === 0}
            onClick={() => run('task_ping_bulk', { enabled: false }, (n) => `Reminders off for ${plural(Number(n), 'card')}`, 'The reminders did not change. Try again.')}>Stop all</Button>
        </div>
      </div>
    </Section>
  )
}
