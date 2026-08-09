'use strict';

/**
 * Pure bracket logic. No database, no DOM — everything here is a function of
 * (player list, reported results) so it can be unit tested and recomputed from
 * scratch on every request.
 *
 * A tournament is stored as:
 *   - an ordered list of players (the seeding order, produced by a shuffle)
 *   - a map of matchKey -> winning player id
 *
 * The bracket structure itself is derived, never stored. That means a result
 * can be changed or cleared at any time and everything downstream re-resolves.
 */

/** Smallest power of two >= n (minimum 2). */
function nextPow2(n) {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

function matchKey(bracket, round, idx) {
  return `${bracket}${round}-${idx}`;
}

/**
 * Build the match graph for `playerCount` players.
 *
 * Slot sources are one of:
 *   { t: 'seed', i }  seed index i (>= playerCount means BYE)
 *   { t: 'W', k }     winner of match k
 *   { t: 'L', k }     loser of match k
 *
 * Returns matches in topological order: every match appears after the matches
 * it draws from, so a single forward pass resolves the whole bracket.
 */
function generateStructure(playerCount, doubleElim) {
  if (playerCount < 2) return [];
  const size = nextPow2(playerCount);
  const wbRounds = Math.log2(size);
  const matches = [];

  const push = (bracket, round, idx, a, b, extra) =>
    matches.push(Object.assign({ key: matchKey(bracket, round, idx), bracket, round, idx, a, b }, extra));

  // ---- Winners bracket -----------------------------------------------------
  for (let r = 1; r <= wbRounds; r++) {
    const count = size / Math.pow(2, r);
    for (let i = 0; i < count; i++) {
      const a = r === 1 ? { t: 'seed', i: i * 2 } : { t: 'W', k: matchKey('W', r - 1, i * 2) };
      const b = r === 1 ? { t: 'seed', i: i * 2 + 1 } : { t: 'W', k: matchKey('W', r - 1, i * 2 + 1) };
      push('W', r, i, a, b);
    }
  }

  if (!doubleElim) return matches;

  // ---- Losers bracket ------------------------------------------------------
  // 2 * log2(size) - 2 rounds, alternating:
  //   odd rounds  - losers-bracket survivors play each other
  //   even rounds - survivors meet the players just knocked out of the winners
  //                 bracket ("drop-in" rounds)
  const lbRounds = 2 * wbRounds - 2;
  for (let r = 1; r <= lbRounds; r++) {
    const stage = Math.floor((r + 1) / 2);
    const count = size / Math.pow(2, stage + 1);
    for (let i = 0; i < count; i++) {
      let a, b;
      if (r === 1) {
        // Both sides are first-round losers.
        a = { t: 'L', k: matchKey('W', 1, i * 2) };
        b = { t: 'L', k: matchKey('W', 1, i * 2 + 1) };
      } else if (r % 2 === 0) {
        const wbRound = r / 2 + 1;
        const wbCount = size / Math.pow(2, wbRound);
        // Reverse the drop-in order on alternate rounds so players are less
        // likely to immediately replay the opponent who knocked them down.
        const j = wbRound % 2 === 0 ? wbCount - 1 - i : i;
        a = { t: 'W', k: matchKey('L', r - 1, i) };
        b = { t: 'L', k: matchKey('W', wbRound, j) };
      } else {
        a = { t: 'W', k: matchKey('L', r - 1, i * 2) };
        b = { t: 'W', k: matchKey('L', r - 1, i * 2 + 1) };
      }
      push('L', r, i, a, b);
    }
  }

  // ---- Grand final ---------------------------------------------------------
  const wbFinal = matchKey('W', wbRounds, 0);
  const lbFinal = lbRounds > 0 ? matchKey('L', lbRounds, 0) : null;
  push('G', 1, 0, { t: 'W', k: wbFinal }, lbFinal ? { t: 'W', k: lbFinal } : { t: 'L', k: wbFinal });
  // The reset: only played if the winners-bracket champion loses the first
  // grand final, since they would otherwise be eliminated on a single loss.
  push('G', 2, 0, { t: 'W', k: matchKey('G', 1, 0) }, { t: 'L', k: matchKey('G', 1, 0) }, { reset: true });

  return matches;
}

/**
 * Resolve the bracket.
 *
 * @param players ordered player objects ({ id, name }) in seeding order
 * @param results map of matchKey -> winning player id
 * @param doubleElim whether the consolation (losers) bracket is in play
 *
 * Each resolved match carries:
 *   a, b       player object, `null` for a BYE/empty slot, `undefined` for TBD
 *   winner     player object or null
 *   loser      player object or null
 *   decided    true once the outcome is known (including walkovers)
 *   playable   true when two real players are present and can be picked between
 *   auto       true when decided without being played (a bye)
 *   void       true when the match is not part of this tournament (unused
 *              bracket-reset match, or a slot pair that is entirely byes)
 */
function resolve(players, results, doubleElim) {
  const structure = generateStructure(players.length, doubleElim);
  const byKey = new Map();
  const wbRounds = players.length >= 2 ? Math.log2(nextPow2(players.length)) : 0;
  const wbFinalKey = matchKey('W', wbRounds, 0);

  const source = (s) => {
    if (s.t === 'seed') return s.i < players.length ? players[s.i] : null;
    const src = byKey.get(s.k);
    if (!src || src.void) return null;
    if (!src.decided) return undefined;
    return s.t === 'W' ? src.winner : src.loser;
  };

  for (const spec of structure) {
    const srcA = spec.a;
    const srcB = spec.b;
    const m = Object.assign({}, spec, {
      a: undefined, b: undefined, winner: null, loser: null,
      decided: false, playable: false, auto: false, void: false,
    });
    byKey.set(m.key, m);

    // The bracket reset is skipped unless the losers-bracket player won G1.
    if (m.reset) {
      const g1 = byKey.get(matchKey('G', 1, 0));
      const wbFinal = byKey.get(wbFinalKey);
      const wbChampion = wbFinal && wbFinal.decided ? wbFinal.winner : null;
      if (!g1.decided || !wbChampion || (g1.winner && g1.winner.id === wbChampion.id)) {
        m.void = true;
        continue;
      }
    }

    m.a = source(srcA);
    m.b = source(srcB);

    if (m.a === null && m.b === null) {
      // Nobody can ever reach this match (a whole sub-bracket of byes).
      m.void = true;
    } else if (m.b === null && m.a) {
      m.winner = m.a; m.decided = true; m.auto = true;
    } else if (m.a === null && m.b) {
      m.winner = m.b; m.decided = true; m.auto = true;
    } else if (m.a && m.b) {
      m.playable = true;
      const winnerId = results[m.key];
      if (winnerId != null) {
        if (m.a.id === winnerId) { m.winner = m.a; m.loser = m.b; m.decided = true; }
        else if (m.b.id === winnerId) { m.winner = m.b; m.loser = m.a; m.decided = true; }
      }
    }
  }

  return byKey;
}

/** Human label for a winners-bracket round. */
function winnersRoundLabel(round, totalRounds) {
  const remaining = Math.pow(2, totalRounds - round + 1);
  if (remaining === 2) return 'Final';
  if (remaining === 4) return 'Semifinals';
  if (remaining === 8) return 'Quarterfinals';
  return `Round of ${remaining}`;
}

/**
 * Group resolved matches into the ordered list of pages (one page per round).
 * Rounds that are entirely void are dropped.
 */
function rounds(resolved, playerCount, doubleElim) {
  if (playerCount < 2) return [];
  const wbRounds = Math.log2(nextPow2(playerCount));
  const out = [];
  const collect = (bracket, round) =>
    [...resolved.values()].filter((m) => m.bracket === bracket && m.round === round);

  for (let r = 1; r <= wbRounds; r++) {
    const ms = collect('W', r);
    if (ms.some((m) => !m.void)) {
      out.push({ bracket: 'W', round: r, label: winnersRoundLabel(r, wbRounds), group: 'Winners', matches: ms });
    }
  }
  if (doubleElim) {
    const lbRounds = 2 * wbRounds - 2;
    for (let r = 1; r <= lbRounds; r++) {
      const ms = collect('L', r);
      if (ms.some((m) => !m.void)) {
        out.push({ bracket: 'L', round: r, label: `Consolation ${r}`, group: 'Consolation', matches: ms });
      }
    }
    for (const r of [1, 2]) {
      const ms = collect('G', r);
      if (ms.some((m) => !m.void)) {
        out.push({
          bracket: 'G', round: r,
          label: r === 1 ? 'Grand Final' : 'Grand Final (Reset)',
          group: 'Final', matches: ms,
        });
      }
    }
  }
  return out;
}

/** The tournament winner, or null if it is still running. */
function champion(resolved, playerCount, doubleElim) {
  if (playerCount < 2) return null;
  const wbRounds = Math.log2(nextPow2(playerCount));
  if (!doubleElim) {
    const f = resolved.get(matchKey('W', wbRounds, 0));
    return f && f.decided ? f.winner : null;
  }
  const g2 = resolved.get(matchKey('G', 2, 0));
  if (g2 && !g2.void) return g2.decided ? g2.winner : null;
  const g1 = resolved.get(matchKey('G', 1, 0));
  return g1 && g1.decided && !g1.void ? g1.winner : null;
}

/** Number of first-round byes for a field of this size. */
function byeCount(playerCount) {
  if (playerCount < 2) return 0;
  return nextPow2(playerCount) - playerCount;
}

/** Fisher-Yates, returns a new array. */
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  nextPow2, matchKey, generateStructure, resolve, rounds,
  champion, byeCount, shuffle, winnersRoundLabel,
};
