'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');

const store = require('./db');
const bracket = require('./bracket');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((req, res, next) => {
  res.locals.t = null;          // set by loadTournament on tournament routes
  res.locals.isAdmin = false;
  next();
});

const YEAR = 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute base URL for this deployment, used for the QR code target. */
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function loadTournament(req, res, next) {
  const code = String(req.params.code || '').toUpperCase();
  const t = store.q.tournamentByCode.get(code);
  if (!t) return res.status(404).render('error', { message: `No game found with code ${code}.` });
  req.tournament = t;
  req.isAdmin = req.cookies[`adm_${t.code}`] === t.admin_key;
  req.playerToken = req.cookies[`ply_${t.code}`] || null;
  res.locals.t = t;
  res.locals.isAdmin = req.isAdmin;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).render('error', {
      message: 'Only the organizer can do that. Open the organizer link on the device that created this game.',
    });
  }
  next();
}

/** Everything a view needs about the live state of a running tournament. */
function view(t) {
  const players = store.q.seededPlayers.all(t.id);
  const results = store.resultsMap(t.id);
  const doubleElim = !!t.double_elim;
  const resolved = bracket.resolve(players, results, doubleElim);
  const roundList = bracket.rounds(resolved, players.length, doubleElim);
  return {
    players,
    results,
    doubleElim,
    resolved,
    rounds: roundList,
    champion: bracket.champion(resolved, players.length, doubleElim),
    byes: bracket.byeCount(players.length),
  };
}

/** Index of the first round still waiting on a result. */
function currentRoundIndex(rounds) {
  const i = rounds.findIndex((r) => r.matches.some((m) => m.playable && !m.decided));
  return i === -1 ? Math.max(0, rounds.length - 1) : i;
}

function roundPath(t, r) {
  return `/t/${t.code}/r/${r.bracket}/${r.round}`;
}

// ---------------------------------------------------------------------------
// Home / create / join
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.render('home', { error: null });
});

app.post('/tournaments', (req, res) => {
  const name = String(req.body.name || '').trim() || 'Tournament';
  const doubleElim = req.body.double_elim === 'on';
  const t = store.createTournament(name.slice(0, 80), doubleElim);
  res.cookie(`adm_${t.code}`, t.admin_key, { httpOnly: true, sameSite: 'lax', maxAge: YEAR });
  res.redirect(`/t/${t.code}`);
});

app.post('/join', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!store.q.tournamentByCode.get(code)) {
    return res.status(404).render('home', { error: `No game found with code ${code || '(blank)'}.` });
  }
  res.redirect(`/j/${code}`);
});

// The QR code points here: enter your name and you are in.
app.get('/j/:code', loadTournament, (req, res) => {
  const players = store.q.lobbyPlayers.all(req.tournament.id);
  const me = players.find((p) => p.token === req.playerToken) || null;
  res.render('join', { players, me, error: null });
});

app.post('/j/:code', loadTournament, (req, res) => {
  const t = req.tournament;
  const players = store.q.lobbyPlayers.all(t.id);
  const me = players.find((p) => p.token === req.playerToken) || null;
  const fail = (message) => res.status(400).render('join', { players, me, error: message });

  if (t.status !== 'lobby') return fail('This game has already started, so the field is locked.');

  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return fail('Enter a name.');
  if (me) return fail(`You already joined as ${me.name}.`);

  const token = store.randomToken();
  try {
    store.q.addPlayer.run(t.id, name, token);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return fail(`${name} is already on the list — pick another name.`);
    throw err;
  }
  res.cookie(`ply_${t.code}`, token, { httpOnly: true, sameSite: 'lax', maxAge: YEAR });
  res.redirect(`/j/${t.code}`);
});

// ---------------------------------------------------------------------------
// Lobby & organizer controls
// ---------------------------------------------------------------------------

app.get('/t/:code', loadTournament, (req, res) => {
  const t = req.tournament;
  if (t.status === 'lobby') {
    const players = store.q.lobbyPlayers.all(t.id);
    return res.render('lobby', {
      players,
      joinUrl: `${baseUrl(req)}/j/${t.code}`,
      byes: bracket.byeCount(players.length),
      me: players.find((p) => p.token === req.playerToken) || null,
    });
  }
  const v = view(t);
  if (!v.rounds.length) return res.redirect(`/t/${t.code}/bracket`);
  res.redirect(roundPath(t, v.rounds[currentRoundIndex(v.rounds)]));
});

// Lets the organizer re-claim admin rights on another device.
app.get('/t/:code/admin', loadTournament, (req, res) => {
  const t = req.tournament;
  if (String(req.query.key || '') !== t.admin_key) {
    return res.status(403).render('error', { message: 'That organizer link is not valid for this game.' });
  }
  res.cookie(`adm_${t.code}`, t.admin_key, { httpOnly: true, sameSite: 'lax', maxAge: YEAR });
  res.redirect(`/t/${t.code}`);
});

app.get('/t/:code/qr.svg', loadTournament, async (req, res) => {
  const svg = await QRCode.toString(`${baseUrl(req)}/j/${req.tournament.code}`, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
  });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

app.post('/t/:code/players/:id/remove', loadTournament, requireAdmin, (req, res) => {
  const t = req.tournament;
  if (t.status === 'lobby') store.q.removePlayer.run(Number(req.params.id), t.id);
  res.redirect(`/t/${t.code}`);
});

app.post('/t/:code/start', loadTournament, requireAdmin, (req, res) => {
  const t = req.tournament;
  const players = store.q.lobbyPlayers.all(t.id);
  if (players.length < 2) {
    return res.status(400).render('error', { message: 'At least two players have to join before the draw.' });
  }
  store.drawSeeds(t, bracket.shuffle);
  res.redirect(`/t/${t.code}`);
});

// Re-draw the field. Every reported result is discarded.
app.post('/t/:code/reshuffle', loadTournament, requireAdmin, (req, res) => {
  const t = req.tournament;
  if (store.q.lobbyPlayers.all(t.id).length >= 2) store.drawSeeds(t, bracket.shuffle);
  res.redirect(`/t/${t.code}`);
});

// Back to the lobby so more people can join. Results are discarded.
app.post('/t/:code/reopen', loadTournament, requireAdmin, (req, res) => {
  const t = req.tournament;
  store.q.clearResults.run(t.id);
  store.q.setStatus.run('lobby', t.id);
  res.redirect(`/t/${t.code}`);
});

// ---------------------------------------------------------------------------
// Rounds (one page per round) and the full bracket
// ---------------------------------------------------------------------------

app.get('/t/:code/r/:bracket/:round', loadTournament, (req, res) => {
  const t = req.tournament;
  if (t.status === 'lobby') return res.redirect(`/t/${t.code}`);
  const v = view(t);
  const idx = v.rounds.findIndex(
    (r) => r.bracket === req.params.bracket && String(r.round) === String(req.params.round)
  );
  if (idx === -1) return res.status(404).render('error', { message: 'That round is not part of this bracket.' });

  res.render('round', {
    v,
    round: v.rounds[idx],
    idx,
    prev: idx > 0 ? v.rounds[idx - 1] : null,
    next: idx < v.rounds.length - 1 ? v.rounds[idx + 1] : null,
    current: currentRoundIndex(v.rounds),
    roundPath: (r) => roundPath(t, r),
    me: store.q.seededPlayers.all(t.id).find((p) => p.token === req.playerToken) || null,
  });
});

app.post('/t/:code/r/:bracket/:round/pick', loadTournament, requireAdmin, (req, res) => {
  const t = req.tournament;
  const key = String(req.body.match_key || '');
  const winnerId = req.body.winner_id ? Number(req.body.winner_id) : null;
  const v = view(t);
  const match = v.resolved.get(key);

  if (!match || !match.playable) {
    return res.status(400).render('error', { message: 'That match cannot be scored yet.' });
  }
  if (winnerId === null || (match.decided && match.winner.id === winnerId)) {
    store.q.deleteResult.run(t.id, key); // tapping the current winner clears the pick
  } else if (winnerId === match.a.id || winnerId === match.b.id) {
    store.q.putResult.run(t.id, key, winnerId);
  } else {
    return res.status(400).render('error', { message: 'That player is not in this match.' });
  }
  res.redirect(`/t/${t.code}/r/${req.params.bracket}/${req.params.round}`);
});

app.get('/t/:code/bracket', loadTournament, (req, res) => {
  const t = req.tournament;
  if (t.status === 'lobby') return res.redirect(`/t/${t.code}`);
  const v = view(t);
  res.render('overview', { v, roundPath: (r) => roundPath(t, r) });
});

// ---------------------------------------------------------------------------

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Bracket generator listening on http://localhost:${port}`));
}

module.exports = app;
