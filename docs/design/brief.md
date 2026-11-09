# Claude Board: design brief (#129)

## Subject, audience, primary job
- **Subject:** a local control tower for a fleet of Claude Code sessions (W1@macbook, fetch@vps2 …) building claims software across machines.
- **Audience:** one person, Ahmed. Director of engineering, reads dense UI fast, keyboard first, light and dark.
- **Primary job:** see which sessions are holding for him and clear them in one click. Everything else (board, backlog, sessions, huddles, history) is situational awareness.

## Concept: "Tower"
Sessions are callsigns. Tasks are flight strips racked in bays. A session that needs Ahmed holds,
and its **call lamp** lights. Answering is giving clearance: the lamp turns from amber to green and
the strip leaves the rack.

**The one memorable element: the amber call lamp.** It is the only saturated warm colour in the
product and it appears only where something waits on Ahmed: the Today tab count, a question's
strip, a session plate whose agent is asking, the logo, the browser tab. Everything else stays
quiet ink on paper (light) or instrument glass (dark).

## Palette
Named tokens; text pairs checked at AA (numbers are contrast ratios).

| Token | Light | Dark | Role |
|---|---|---|---|
| `paper` (background) | `#EEF1EC` | `#0F1719` | page |
| `strip` (card) | `#FFFFFF` | `#16201F` | cards, strips, panels |
| `rack` (muted) | `#E3E8E2` | `#1B2725` | column wells, inputs |
| `ink` (foreground) | `#14201F` (14.7) | `#E3EBE8` (15.0) | text |
| `graphite` (muted text) | `#55635F` (5.5 paper, 5.1 rack) | `#8A9B98` (6.2) | secondary text |
| `rule` (border) | `#D3DAD3` | `#25322F` | hairlines |
| `lamp` (call / waiting on you) | `#A34D00` (5.8 on white) | `#FFB43C` (10.2) | the call lamp, only |
| `clear` (live, done) | `#1F7A52` (5.3) | `#4FD69C` (9.9) | relay live, cleared, done |
| `stop` (blocked, P0) | `#C2361F` | `#FF7A63` | blocked, P0 |

Status hues for the board (OKLCH, equal lightness so no column shouts): backlog slate 200°,
next indigo 270°, in progress cyan 220°, blocked red 30°, review violet 310°, done green 155°.
The base is a green-grey graphite, not slate blue and not neutral black: the colour of instrument glass.

## Type
- **Archivo Variable** (new, `@fontsource-variable/archivo`) for the whole UI. It has a width axis
  (62–125%): **condensed bold for callsigns, IDs and column heads** (strip lettering), normal
  width for reading. One family, two voices.
- **JetBrains Mono** only for literal code: branches, commits, `cb` commands. Not for labels.
- Scale (px): 11 · 12 · 13 · **14 body** · 16 · 20 · 28. Question text 16/1.5, the thing he reads most.
  Sentence case everywhere; no all-caps eyebrows. `tabular-nums` on every count and clock.

## Layout principles
- Dense, left-aligned, 4px grid. Hierarchy from weight, width and the lamp, not from boxes inside boxes.
- **Strips, not cards:** task and question rows are white strips with a 3px left edge carrying
  status (tasks) or the lamp (questions). Radii are small (6px strips, 10px panels), so cards
  don't read as the generic rounded-SaaS kit.
- Today: queue left (7fr), shift log right (5fr) on a single hairline. Board: six bays with
  condensed heads; done collapses. Phone: one column; the nav scrolls.
- Every view keeps its keyboard number (1–7) visible in the nav.

## Motion
- One orchestrated moment: **clearance.** On answer, the lamp turns green, the strip slides out
  (220ms, ease-out), then the queue closes the gap.
- A blocking question's lamp breathes slowly (2.4s). That is the only ambient motion.
- Everything else is response to input: 120–160ms colour/opacity, transform only.
  `prefers-reduced-motion` turns all of it into instant state changes.

## Logo
**A racked C with the lamp in its mouth.** Three pill-shaped strips (top, spine, bottom; the top one
shorter, like strips of different lengths in a rack) form a "C" for Claude, and the call lamp sits
in its opening. Paper strips and an amber lamp on a graphite tile, so it holds on light and dark
tab bars. The same SVG is `public/favicon.svg` and the header mark (`components/Mark.tsx`).
At 16px it is a bold C and a dot. The mark is live: the lamp is amber while anything waits on
Ahmed and green when nothing does, in the header and in the browser tab (with the count in the title).
First drafts (three stacked strips with a lamp) read as a hamburger icon at 16px and were dropped.

## Guests and task types (merged from main: #165, #182)
- **The lamp follows the viewer.** Amber means "waiting on whoever is looking". On Ahmed's Today a
  question handed to Omar shows a dark, hollow lamp under "Waiting on others"; on Omar's page the
  same question is amber, and his tab carries the count.
- **Guest page: Tower without the engineering.** One 42rem column. No callsigns, task numbers or
  P-codes: the project, the time, "work is paused until you answer", and "Needed: today" in words.
  Questions that hold work come first. Tasks handed to the guest are strips with their own notes.
- **Task types.** A bug is the one type that earns colour: a red bug glyph beside the priority,
  where the eye scans. Other types are a quiet word ahead of the tags. The plain type `task` shows
  nothing. Clicking a type filters Board and Backlog ("Only bugs").

## Self-review: what was generic, what changed
- ui-ux-pro-max proposed slate `#0F172A` + run-green + JetBrains/IBM Plex (the "dark dev tool"
  default, trait #2 in the frontend-design list). Kept the dark-first instinct; moved the base to
  green-grey glass, gave green and amber distinct meanings, and dropped mono as a label face.
- First instinct was keeping Schibsted/Geist. Both are what any modern dashboard ships with. Archivo's
  width axis gives the strip lettering a voice no other choice here has.
- First layout draft was rounded cards with soft shadows everywhere (the SaaS kit). Replaced with
  strips with a meaningful left edge; shadows only on things that float (overlay, drag, sheet).
- Considered a 2×2 lamp grid for the logo: too close to a well-known four-square mark. Moved to the rack.
- Middle-dot meta strings (`A · B · C`) are a template tell; meta is spaced, not dotted.
