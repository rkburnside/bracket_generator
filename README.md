# Tournament Bracket Generator

A single-file, zero-dependency single-elimination bracket generator. Paste a list of
names, build a randomized bracket, and click through the winners.

Open `index.html` in any browser — there is no build step, no server, and no
external assets.

## Current features

- **Name entry** — one name per line in a textarea. Blank lines are dropped and
  duplicates are removed case-insensitively.
- **Randomized seeding** — names are shuffled (Fisher–Yates) before being placed
  into first-round slots.
- **Automatic byes** — the field is padded up to the next power of two. Byes are
  spread evenly across the first round, and the player facing a bye is advanced
  automatically.
- **Click to advance** — clicking a name marks it the winner of that match and
  moves it into the next round. Clicking the same name again undoes the pick.
  Downstream picks that are no longer reachable are cleared.
- **Round labels** — Final, Semifinals, Quarterfinals, and "Round of N" above that.
- **Header status** — player count and bye count, plus the champion once the final
  is decided.
- **Controls** — `Randomize & build bracket`, `Reshuffle seeding` (rebuilds with a
  new random draw), and `Clear picks` (keeps the draw, drops all winners).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The entire app: markup, CSS, and JS in one file. |
| `README.md` | This document. |
| `LICENSE` | Project license. |

## Implementation notes

State lives in two module-level variables:

- `seeds` — a flat array of first-round slot occupants, in order. An empty string
  `""` marks a BYE slot.
- `picks` — a map of `"<round>-<match>"` → winning name.

`build()` derives the full round structure from `seeds` and `picks` on every
render, so there is no separate bracket tree to keep in sync. `render()` rebuilds
the DOM from scratch after each interaction.

Key functions:

| Function | Role |
| --- | --- |
| `parseNames()` | Trim, drop blanks, dedupe. |
| `shuffle(a)` | Fisher–Yates shuffle, returns a copy. |
| `seedWithByes(players)` | Pads to the next power of two and distributes byes. |
| `build()` | Produces `rounds[][]` from `seeds` + `picks`, auto-advances byes, prunes stale picks. |
| `render()` | Draws the board and the champion line. |
| `roundNames(size)` | Labels for each column. |

## Known limitations

These are the gaps to address as the project develops:

- **Not mobile friendly.** The layout is a horizontally scrolling flex board with
  fixed-width columns and a fixed-width textarea; it is built for a desktop
  viewport. This is the main thing to fix.
- **No persistence.** Reloading the page loses the bracket entirely.
- **No sharing or export.** No URL state, no image or print output.
- **Single-elimination only.** No double elimination, round robin, pools, or
  third-place match.
- **No manual seeding.** Seeding is always random; you cannot pin or rank players.
- **No connector lines** between matches, so the bracket structure reads only by
  column alignment.
- **No accessibility affordances** — slots are `div`s with click handlers, not
  focusable or keyboard-operable, and there are no ARIA roles.
- **`alert()` for validation** rather than inline messaging.

## Roadmap

Mobile-friendly layout first, then persistence and sharing, then additional
tournament formats.
