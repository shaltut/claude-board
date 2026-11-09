type Target = { isContentEditable?: boolean; tagName?: string; closest?: (selector: string) => unknown } | null

/** Single-key shortcuts (1-7, c, /) stay quiet while you type, and while a menu or a select list has the
 *  keyboard: there the keys belong to the menu (typeahead, arrows), not to view switching. */
export function shortcutsOff(target: Target) {
  if (!target) return false
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName ?? '')) return true
  return !!target.closest?.('[role="menu"], [role="listbox"]')
}
