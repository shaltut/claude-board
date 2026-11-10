// Ahmed's asks (#936): the shape /api/asks returns (cb.asks_list) and the two choices the Today box makes.

export interface AskLine { id: number; at: string; actor: string; action: 'open' | 'say' | 'reply' | 'close' | 'reroute'; text: string; done: boolean }
export interface Ask {
  id: number; project: string | null; task_id: number | null; to_actor: string; body: string; status: 'open' | 'done'
  created_at: string; delivered_at: string | null; closed_at: string | null
  state: 'sent' | 'seen' | 'replied' | 'done'; awaiting: boolean; late: boolean; live: boolean; lines: AskLine[]
}
type Session = { actor: string; project: string | null; live: boolean }

/** Who an ask goes to by default: the project's orchestrator (orch@...), a live one first. No project picked, or no
 *  orchestrator on it: nobody, so Ahmed picks rather than ask the wrong session. */
export function defaultRecipient(sessions: Session[], project?: string): string {
  if (!project) return ''
  const orch = sessions.filter((s) => s.actor.startsWith('orch@') && s.project === project)
  return (orch.find((s) => s.live) ?? orch[0])?.actor ?? ''
}

/** The sessions' replies (not Ahmed's lines): one joining the set rings (lib/ring.ts). */
export const replyIds = (asks: Ask[]) =>
  asks.flatMap((a) => a.lines.filter((l) => l.action === 'reply' && l.actor !== 'ahmed').map((l) => l.id))
