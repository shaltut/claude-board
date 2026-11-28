// #4787: whether a pane's tail ends in the CLI's own limit message. detectQuotaStop is broad and only tells; this is the
// narrow check a switch needs, so a seat whose own output quotes the words is not closed. A miss only means no switch.

// where the CLI's input area starts: a prompt glyph, or the edge of its box or rule
const INPUT = /^[ \t]*[>❯›│┃╭╰╌─━▌]/;
// what the CLIs put before what the agent itself says or runs
const OUTPUT = /^[ \t]*[●⏺•⎿]/;
// lines the limit message may wrap or continue over, plus a status line, before the input area
const MORE_LINES = 3;

/** True when a line begins as banner says (anchored with ^; it may match on across wrapped lines), at most MORE_LINES
 *  lines follow before the input area, and no line the agent printed follows at all: not before the input area, and not
 *  after it, as one would if that prompt had been sent and answered. */
export function atBannerSpot(tail: string, banner: RegExp): boolean {
  const lines = tail.split(/\r?\n/).filter((l) => l.trim());
  return lines.some((_, at) => {
    if (!banner.test(lines.slice(at).join('\n'))) return false;
    const below = lines.slice(at + 1);
    if (below.some((l) => OUTPUT.test(l))) return false;
    const input = below.findIndex((l) => INPUT.test(l));
    return (input < 0 ? below.length : input) <= MORE_LINES;
  });
}
