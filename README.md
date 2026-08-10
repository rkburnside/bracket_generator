# Tournament Bracket Generator

A mobile-first tournament bracket app. The organizer creates a game, players scan a
QR code and type their own name, and the bracket is played one round per page.
Everything is stored in SQLite, so a closed tab, a dead phone, or a server restart
does not lose the tournament.

```
npm install
npm start          # http://localhost:3000
npm test
```

To put it online, see **[DEPLOY.md](DEPLOY.md)** — one Railway service plus a
volume, no other infrastructure.

## How a game runs

1. **Create.** The organizer opens `/`, names the tournament, and optionally ticks
   **Consolation bracket**. They get a four-character game code such as `KP7M`.
2. **Join.** The lobby shows a QR code pointing at `/j/KP7M`. Players scan it,
   type their name, and they are in. The lobby refreshes itself as people arrive.
3. **Draw.** The organizer taps *Draw the bracket*. The field is shuffled and
   seeded; if the count is not a power of two the extra players get a first-round
   bye and advance automatically.
4. **Play.** Each round is its own page — `/t/KP7M/r/W/2` — listing only that
   round's matches. The organizer taps the winner; tapping the same name again
   undoes it. Everyone else can watch the same page live.
5. **Finish.** The champion banner appears once the final (or the grand final, in
   double elimination) is decided.

## Consolation bracket

Ticking the box makes the tournament **double elimination**:

- Losing a match drops you into the consolation (losers) bracket instead of
  knocking you out.
- The consolation bracket alternates between rounds where its own survivors play
  each other and *drop-in* rounds where they meet the players just knocked out of
  the winners bracket. The drop-in order is reversed on alternate rounds so
  players are less likely to immediately replay whoever knocked them down.
- The **grand final** is the winners-bracket champion against the consolation
  champion. If the consolation champion wins it, a **bracket reset** is played —
  the winners-bracket champion has only lost once at that point, so they get their
  second life too. If the winners-bracket champion wins the first grand final, the
  reset match never appears.

Byes flow through the consolation bracket correctly: the "loser" of a walkover is
nobody, so the consolation match it feeds simply advances its one real player.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /` | anyone | Create a game, or join by typing a code |
| `POST /tournaments` | anyone | Create; the creator's browser gets the organizer cookie |
| `GET /j/:code` | players | The QR target — enter your name |
| `GET /t/:code` | anyone | Lobby while open; redirects to the live round once started |
| `GET /t/:code/qr.svg` | anyone | The join QR code |
| `GET /t/:code/r/:bracket/:round` | anyone | One round, one page (`W` winners, `L` consolation, `G` grand final) |
| `POST /t/:code/r/:bracket/:round/pick` | organizer | Report or clear a result |
| `GET /t/:code/bracket` | anyone | Every round side by side |
| `POST /t/:code/start` · `/reshuffle` · `/reopen` | organizer | Draw, re-draw, or reopen the lobby |
| `GET /t/:code/admin?key=…` | organizer | Claim organizer rights on a second device |

## Who can do what

- The **organizer** is whoever created the game; their browser holds an
  `adm_<code>` cookie containing the game's admin key. The lobby shows an
  organizer link that transfers those rights to another device — anyone holding
  that link can report results, so it should not be shared around.
- **Players** get a `ply_<code>` cookie so the app can recognise them, highlight
  their own name in the bracket, and stop them joining twice.
- **Everyone else** can watch any game whose code they know. Spectator pages
  refresh on a timer; the organizer's pages do not, so a tap is never interrupted.

## Layout

```
src/bracket.js        bracket maths — pure functions, no I/O
src/db.js             SQLite schema and prepared statements
src/server.js         Express routes
src/views/*.ejs       server-rendered pages
public/app.css        mobile-first stylesheet
test/bracket.test.js  bracket maths, fields of 2–33 players
test/server.test.js   end-to-end HTTP walkthrough
legacy/single-page.html   the original standalone prototype
```

### Data model

Three tables: `tournaments`, `players`, and `results` (one row per reported
match). The bracket structure is **not** stored. `src/bracket.js` derives the
whole match graph from the player count on every request and resolves it against
the reported results, which is why a result can be changed at any point and every
downstream match re-resolves — a pick that is no longer reachable is simply
ignored rather than left stranded.

Matches are addressed by a stable key: `W2-0` is the first match of winners round
two, `L3-1` the second match of consolation round three, `G1-0` the grand final.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `DB_PATH` | `data/brackets.db` | SQLite file; the directory is created on boot |
| `PUBLIC_URL` | request host | Base URL encoded in the QR code — set this behind a proxy or tunnel, otherwise phones get an unreachable `localhost` link |
| `RAILWAY_VOLUME_MOUNT_PATH` | unset | Set by Railway; when present and `DB_PATH` is not, the database lives on the mounted volume |
| `RAILWAY_PUBLIC_DOMAIN` | unset | Set by Railway; used for the QR target when `PUBLIC_URL` is not set |

`GET /healthz` returns `{"ok":true,"db":"…"}` once the process is up and the
database opens — it is what the platform health check watches, and the quickest
way to confirm which database file a deployment is actually using.

## Known limitations

- Results are reported by the organizer only; players cannot self-report.
- Pages poll on a refresh timer rather than pushing updates over a socket.
- Seeding is random — there is no way to rank or pin players, and no way to edit
  the draw once it is made short of re-drawing it.
- No third-place match in single elimination (the consolation bracket covers the
  double-elimination case instead).
- No accounts, so a cleared cookie means losing organizer rights unless the
  organizer link was saved.
- Nothing is ever deleted; old tournaments accumulate in the database.
