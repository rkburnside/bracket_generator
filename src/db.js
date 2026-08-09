'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'brackets.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tournaments (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  double_elim INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'lobby',   -- lobby | running
  admin_key   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  seed          INTEGER,                        -- null until the draw is made
  token         TEXT NOT NULL,                  -- lets a device recognise itself
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS players_tournament ON players(tournament_id);
CREATE UNIQUE INDEX IF NOT EXISTS players_unique_name
  ON players(tournament_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS results (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  match_key     TEXT NOT NULL,
  winner_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tournament_id, match_key)
);
`);

const q = {
  createTournament: db.prepare(
    `INSERT INTO tournaments (code, name, double_elim, admin_key) VALUES (?, ?, ?, ?)`
  ),
  tournamentByCode: db.prepare(`SELECT * FROM tournaments WHERE code = ?`),
  setStatus: db.prepare(`UPDATE tournaments SET status = ? WHERE id = ?`),

  addPlayer: db.prepare(
    `INSERT INTO players (tournament_id, name, token) VALUES (?, ?, ?)`
  ),
  removePlayer: db.prepare(`DELETE FROM players WHERE id = ? AND tournament_id = ?`),
  lobbyPlayers: db.prepare(
    `SELECT * FROM players WHERE tournament_id = ? ORDER BY created_at, id`
  ),
  seededPlayers: db.prepare(
    `SELECT * FROM players WHERE tournament_id = ? ORDER BY seed`
  ),
  setSeed: db.prepare(`UPDATE players SET seed = ? WHERE id = ?`),

  putResult: db.prepare(
    `INSERT INTO results (tournament_id, match_key, winner_id) VALUES (?, ?, ?)
     ON CONFLICT (tournament_id, match_key)
     DO UPDATE SET winner_id = excluded.winner_id, reported_at = datetime('now')`
  ),
  deleteResult: db.prepare(`DELETE FROM results WHERE tournament_id = ? AND match_key = ?`),
  results: db.prepare(`SELECT match_key, winner_id FROM results WHERE tournament_id = ?`),
  clearResults: db.prepare(`DELETE FROM results WHERE tournament_id = ?`),
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
function randomCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function randomToken() {
  return require('crypto').randomBytes(16).toString('hex');
}

function createTournament(name, doubleElim) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = randomCode(attempt < 20 ? 4 : 5);
    if (q.tournamentByCode.get(code)) continue;
    const adminKey = randomToken();
    q.createTournament.run(code, name, doubleElim ? 1 : 0, adminKey);
    return q.tournamentByCode.get(code);
  }
  throw new Error('Could not allocate a unique game code');
}

/** Freeze the lobby: shuffle the joined players into seeding order. */
function drawSeeds(tournament, shuffle) {
  const players = q.lobbyPlayers.all(tournament.id);
  const order = shuffle(players);
  const apply = db.transaction(() => {
    order.forEach((p, i) => q.setSeed.run(i, p.id));
    q.clearResults.run(tournament.id);
    q.setStatus.run('running', tournament.id);
  });
  apply();
  return q.seededPlayers.all(tournament.id);
}

function resultsMap(tournamentId) {
  const map = {};
  for (const row of q.results.all(tournamentId)) map[row.match_key] = row.winner_id;
  return map;
}

module.exports = {
  db, q, DB_PATH,
  createTournament, drawSeeds, resultsMap, randomToken,
};
