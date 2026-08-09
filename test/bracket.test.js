'use strict';

const test = require('node:test');
const assert = require('node:assert');
const b = require('../src/bracket');

const field = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));

/** Play the whole bracket, always advancing the lower id. Returns the champion. */
function playOut(players, doubleElim) {
  const results = {};
  for (let guard = 0; guard < 500; guard++) {
    const resolved = b.resolve(players, results, doubleElim);
    const next = [...resolved.values()].find((m) => m.playable && !m.decided && !m.void);
    if (!next) {
      return {
        champion: b.champion(resolved, players.length, doubleElim),
        resolved,
        played: Object.keys(results).length,
      };
    }
    results[next.key] = Math.min(next.a.id, next.b.id);
  }
  throw new Error('bracket did not converge');
}

test('byes pad the field up to a power of two', () => {
  assert.equal(b.byeCount(8), 0);
  assert.equal(b.byeCount(5), 3);
  assert.equal(b.byeCount(2), 0);
  assert.equal(b.byeCount(9), 7);
});

test('a player with a bye advances without playing', () => {
  const players = field(3);
  const resolved = b.resolve(players, {}, false);
  const m0 = resolved.get('W1-0');
  const m1 = resolved.get('W1-1');
  const withBye = [m0, m1].find((m) => m.auto);
  assert.ok(withBye, 'one first-round match should be a walkover');
  assert.equal(withBye.decided, true);
  assert.equal(withBye.loser, null);
  assert.equal(resolved.get('W2-0').playable, false, 'final waits on the played match');
});

test('single elimination produces one champion for every field size', () => {
  for (let n = 2; n <= 33; n++) {
    const players = field(n);
    const { champion } = playOut(players, false);
    assert.ok(champion, `no champion for ${n} players`);
    assert.equal(champion.id, 1, `${n} players: lowest id should win when it always wins`);
  }
});

test('single elimination plays exactly n-1 real matches', () => {
  for (let n = 2; n <= 20; n++) {
    const { played } = playOut(field(n), false);
    assert.equal(played, n - 1, `${n} players`);
  }
});

test('double elimination produces one champion for every field size', () => {
  for (let n = 2; n <= 33; n++) {
    const { champion } = playOut(field(n), true);
    assert.ok(champion, `no champion for ${n} players`);
    assert.equal(champion.id, 1, `${n} players`);
  }
});

test('every non-bye player gets a second life in double elimination', () => {
  const players = field(8);
  // P1 wins everything, so each other player loses their first match and must
  // appear at least once more in the consolation bracket.
  const { resolved } = playOut(players, true);
  const appearances = new Map();
  for (const m of resolved.values()) {
    if (m.void) continue;
    for (const p of [m.a, m.b]) if (p) appearances.set(p.id, (appearances.get(p.id) || 0) + 1);
  }
  for (const p of players.slice(1)) {
    assert.ok(appearances.get(p.id) >= 2, `${p.name} only appeared ${appearances.get(p.id)} time(s)`);
  }
});

test('the bracket reset is skipped when the winners-bracket champion holds on', () => {
  const players = field(4);
  const { resolved } = playOut(players, true); // P1 never loses
  assert.equal(resolved.get('G2-0').void, true);
});

test('the bracket reset is played when the winners-bracket champion loses the grand final', () => {
  const players = field(4);
  const results = {};
  // Winners bracket: 1 beats 2, 3 beats 4, then 1 beats 3.
  results['W1-0'] = 1; results['W1-1'] = 3; results['W2-0'] = 1;
  // Consolation: 2 beats 4, then 3 beats 2.
  results['L1-0'] = 2; results['L2-0'] = 3;
  // Grand final: the consolation winner takes it, forcing a reset.
  results['G1-0'] = 3;
  let resolved = b.resolve(players, results, true);
  const reset = resolved.get('G2-0');
  assert.equal(reset.void, false);
  assert.equal(reset.playable, true);
  assert.equal(b.champion(resolved, 4, true), null, 'not over until the reset is played');

  results['G2-0'] = 1;
  resolved = b.resolve(players, results, true);
  assert.equal(b.champion(resolved, 4, true).id, 1);
});

test('clearing a result clears everything downstream', () => {
  const players = field(4);
  const results = { 'W1-0': 1, 'W1-1': 3, 'W2-0': 1 };
  assert.equal(b.champion(b.resolve(players, results, false), 4, false).id, 1);
  delete results['W1-0'];
  const resolved = b.resolve(players, results, false);
  assert.equal(resolved.get('W2-0').decided, false);
  assert.equal(resolved.get('W2-0').a, undefined);
  assert.equal(b.champion(resolved, 4, false), null);
});

test('a stale winner is ignored once the match feeding it changes', () => {
  const players = field(4);
  // P1 was recorded as winning the final, then the semi result flips to P2.
  const results = { 'W1-0': 2, 'W1-1': 3, 'W2-0': 1 };
  const resolved = b.resolve(players, results, false);
  assert.equal(resolved.get('W2-0').decided, false, 'P1 is no longer in the final');
});

test('rounds are laid out one page at a time, byes-only rounds dropped', () => {
  const rs = b.rounds(b.resolve(field(5), {}, true), 5, true);
  const labels = rs.map((r) => r.label);
  assert.deepEqual(labels.slice(0, 3), ['Quarterfinals', 'Semifinals', 'Final']);
  assert.ok(labels.includes('Grand Final'));
  assert.ok(rs.every((r) => r.matches.some((m) => !m.void)));
});

test('round labels follow the size of the field', () => {
  assert.deepEqual(b.rounds(b.resolve(field(2), {}, false), 2, false).map((r) => r.label), ['Final']);
  assert.deepEqual(
    b.rounds(b.resolve(field(4), {}, false), 4, false).map((r) => r.label),
    ['Semifinals', 'Final']
  );
  assert.deepEqual(
    b.rounds(b.resolve(field(16), {}, false), 16, false).map((r) => r.label),
    ['Round of 16', 'Quarterfinals', 'Semifinals', 'Final']
  );
});

test('a field of fewer than two players has no bracket', () => {
  assert.deepEqual(b.generateStructure(1, true), []);
  assert.deepEqual(b.rounds(b.resolve(field(1), {}, true), 1, true), []);
  assert.equal(b.champion(b.resolve(field(0), {}, true), 0, true), null);
});
