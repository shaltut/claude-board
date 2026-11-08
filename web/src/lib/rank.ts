/** Rank for a task dropped at `index` in a list (sorted by rank) that excludes the task itself. */
export function rankAt(list: { rank: number }[], index: number): number {
  const prev = list[index - 1]?.rank
  const next = list[index]?.rank
  if (prev == null && next == null) return 0
  if (prev == null) return next! - 1024
  if (next == null) return prev + 1024
  return (prev + next) / 2
}
