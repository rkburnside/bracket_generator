'use strict';

// End-to-end smoke test over real HTTP against a throwaway database.
process.env.DB_PATH = require('path').join(
  require('os').tmpdir(), `bracket-test-${process.pid}-${Date.now()}.db`
);

const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/server');

let base;
const server = app.listen(0);
test.before(() => { base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

/** Minimal cookie jar so each "device" in the test keeps its own identity. */
function device() {
  const jar = new Map();
  return async function req(path, { method = 'GET', form, follow = true } = {}) {
    const headers = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(base + path, {
      method, headers, redirect: 'manual',
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if (follow && res.status >= 300 && res.status < 400) return req(res.headers.get('location'), { follow });
    return { status: res.status, body: await res.text(), location: res.headers.get('location') };
  };
}

test('an organizer can run a whole tournament from the browser', async () => {
  const organizer = device();

  const created = await organizer('/tournaments', {
    method: 'POST', form: { name: 'Test Cup', double_elim: 'on' }, follow: false,
  });
  const code = created.location.split('/').pop();
  assert.match(code, /^[A-Z0-9]{4,5}$/);

  // Three players join from three separate phones.
  for (const name of ['Ada', 'Grace', 'Alan']) {
    const phone = device();
    const res = await phone(`/j/${code}`, { method: 'POST', form: { name } });
    assert.equal(res.status, 200);
    assert.match(res.body, /You&#39;re in|You're in/);
  }

  // Duplicate names are rejected.
  const dup = await device()(`/j/${code}`, { method: 'POST', form: { name: 'ada' } });
  assert.equal(dup.status, 400);

  const lobby = await organizer(`/t/${code}`);
  assert.match(lobby.body, /3 players joined/);
  assert.match(lobby.body, /1 bye in round 1/);

  // The QR code is served and points at the join page.
  const qr = await fetch(`${base}/t/${code}/qr.svg`);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await qr.text(), /^<\?xml|<svg/);

  // A spectator cannot start the draw.
  assert.equal((await device()(`/t/${code}/start`, { method: 'POST' })).status, 403);

  const round1 = await organizer(`/t/${code}/start`, { method: 'POST' });
  assert.match(round1.body, /Semifinals/);

  // Play the tournament out by always picking the first pickable name.
  const pickKeys = (html) => [...html.matchAll(/name="match_key" value="([^"]+)"[\s\S]*?name="winner_id" value="(\d+)"/g)];
  let page = round1;
  for (let guard = 0; guard < 20; guard++) {
    const picks = pickKeys(page.body);
    if (!picks.length) {
      const nextChip = page.body.match(/href="(\/t\/[^"]+\/r\/[^"]+)"[^>]*>(?!.*Full)/);
      if (!nextChip) break;
      page = await organizer(nextChip[1]);
      if (!pickKeys(page.body).length) break;
      continue;
    }
    const [, key, winner] = picks[0];
    const bracketPath = page.body.match(/action="(\/t\/[^"]+\/pick)"/)[1];
    page = await organizer(bracketPath, { method: 'POST', form: { match_key: key, winner_id: winner } });
  }

  const overview = await organizer(`/t/${code}/bracket`);
  assert.match(overview.body, /Consolation 1/, 'the consolation bracket is part of the board');

  // A spectator cannot report a result.
  const spectator = await device()(`/t/${code}/r/W/1/pick`, {
    method: 'POST', form: { match_key: 'W1-0', winner_id: '1' },
  });
  assert.equal(spectator.status, 403);
});

test('joining an unknown code fails cleanly', async () => {
  const res = await device()('/join', { method: 'POST', form: { code: 'ZZZZ' } });
  assert.equal(res.status, 404);
  assert.match(res.body, /No game found/);
});

test('the field locks once the draw is made', async () => {
  const organizer = device();
  const created = await organizer('/tournaments', {
    method: 'POST', form: { name: 'Locked' }, follow: false,
  });
  const code = created.location.split('/').pop();
  for (const name of ['A', 'B']) await device()(`/j/${code}`, { method: 'POST', form: { name } });
  await organizer(`/t/${code}/start`, { method: 'POST' });

  const late = await device()(`/j/${code}`, { method: 'POST', form: { name: 'C' } });
  assert.equal(late.status, 400);
  assert.match(late.body, /already started/);
});
