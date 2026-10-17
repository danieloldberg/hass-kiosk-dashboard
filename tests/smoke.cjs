const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const acorn = require('acorn');
const { chromium } = require('playwright');
const { createServer } = require('../hass-kiosk-dashboard/server.cjs');

acorn.parse(fs.readFileSync(path.join(__dirname, '../hass-kiosk-dashboard/app.js'), 'utf8'), { ecmaVersion: 5 });
const adminKey = 'test-admin-key';
let token = 'private-ha-token', authFailure = false, calendarFailure = false;
const calls = [];
const states = [
  { entity_id: 'calendar.test', state: 'on', attributes: { friendly_name: 'Testkalender' } },
  { entity_id: 'weather.test', state: 'rainy', attributes: { friendly_name: 'Testväder', temperature: 9, temperature_unit: '°C', humidity: 80, wind_speed: 4, wind_speed_unit: 'm/s' } },
  { entity_id: 'light.test', state: 'off', attributes: { friendly_name: 'Testlampa', supported_color_modes: ['brightness'], brightness: 0 } },
  { entity_id: 'light.other', state: 'off', attributes: { friendly_name: 'Privat lampa' } }
];
const upstream = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer ' + token);
  res.setHeader('Content-Type', 'application/json');
  if (authFailure) { res.writeHead(401); res.end('{}'); return; }
  const url = new URL(req.url, 'http://localhost');
  let body;
  if (url.pathname === '/api/states') { body = states; }
  else if (url.pathname.startsWith('/api/calendars/')) {
    if (calendarFailure) { res.writeHead(503); res.end('{}'); return; }
    const date = new Date();
    const dateString = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    body = [{ summary: '<script>unsafe</script> Heldag', start: { date: dateString(date) }, end: { date: dateString(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)) } }];
    assert.ok(url.searchParams.has('start') && url.searchParams.has('end'));
  } else if (url.pathname === '/api/services/weather/get_forecasts') {
    body = { service_response: { 'weather.test': { forecast: [{ datetime: new Date().toISOString(), condition: 'rainy', temperature: 10, templow: 4 }] } } };
  } else if (url.pathname.startsWith('/api/services/light/')) {
    let raw = ''; for await (const chunk of req) { raw += chunk; }
    const data = JSON.parse(raw); calls.push({ service: url.pathname.split('/').pop(), data });
    states[2].state = url.pathname.endsWith('turn_off') ? 'off' : 'on';
    if (data.brightness_pct !== undefined) { states[2].attributes.brightness = Math.round(data.brightness_pct * 255 / 100); }
    body = [];
  } else if (url.pathname === '/api/states/light.test') { body = states[2]; }
  else { res.writeHead(404); res.end('{}'); return; }
  res.end(JSON.stringify(body));
});
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
function stop(server) { return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemma-test-'));
  let server, browser;
  try {
    await listen(upstream);
    const haUrl = `http://127.0.0.1:${upstream.address().port}`;
    server = createServer({ adminKey, dataDir }); await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    async function api(route, method = 'GET', body, key, headers = {}) {
      return fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Hemma-Admin': key } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    }
    assert.equal((await api('/api/settings', 'PUT', {})).status, 401);
    assert.equal((await api('/api/admin/discover', 'POST', { url: haUrl, token })).status, 401);
    assert.equal((await api('/data/settings.json')).status, 404);
    assert.equal((await api('/server.cjs')).status, 404);

    browser = await chromium.launch();
    const desktop = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    const tablet = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    const page = await desktop.newPage(), screen = await tablet.newPage();
    const errors = [], tabletTraffic = [];
    page.on('pageerror', error => errors.push(error.message));
    screen.on('pageerror', error => errors.push(error.message));
    screen.on('response', async response => { if (response.url().includes('/api/')) { tabletTraffic.push(await response.text().catch(() => '')); } });
    await page.goto(base); await screen.goto(base);
    await page.waitForFunction(() => document.getElementById('connection').textContent === 'Demoläge');
    await screen.waitForFunction(() => document.getElementById('connection').textContent === 'Demoläge');
    assert.equal(await page.locator('.day-button').count(), 7);
    assert.equal(await page.locator('.light-card').count(), 3);
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    assert.ok(dimensions.width <= 1024 && dimensions.height <= 600, JSON.stringify(dimensions));
    const overflow = await page.locator('.panel').evaluateAll(panels => panels.map(panel => ({ height: panel.clientHeight, content: panel.scrollHeight })));
    overflow.forEach(panel => assert.ok(panel.content <= panel.height, JSON.stringify(panel)));
    await page.locator('.calendar-filter').filter({ hasText: 'Familjen' }).click();
    assert.equal(await page.locator('.event').count(), 1);
    await page.locator('#all-off').click();
    assert.equal(await page.locator('.light-card.on').count(), 0);

    await page.locator('#settings-button').click();
    await page.locator('#admin-key').fill(adminKey);
    await page.locator('#ha-url').fill(haUrl);
    await page.locator('#ha-token').fill(token);
    await page.locator('#discover-button').click();
    await page.locator('#entity-settings').waitFor({ state: 'visible' });
    await page.locator('#calendar-options input').check();
    await page.locator('#light-options input[value="light.test"]').check();
    await page.locator('#weather-select').selectOption('weather.test');
    await page.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.getElementById('connection').textContent === 'Ansluten');
    // A separate browser context receives desktop settings without a reload or credentials.
    await screen.waitForFunction(() => document.getElementById('connection').textContent === 'Ansluten', null, { timeout: 20000 });
    assert.equal(await screen.locator('.light-card').count(), 1);
    assert.equal(await screen.locator('#temperature').textContent(), '9°');
    assert.equal(await screen.locator('.event-time').textContent(), 'Heldag');
    assert.ok((await screen.locator('.event-title').textContent()).includes('<script>'));
    assert.equal(await screen.locator('.event script').count(), 0);
    assert.equal(await screen.locator('.forecast-day').count(), 1);
    assert.equal(await page.locator('#ha-token').inputValue(), '');
    assert.equal(await page.locator('#admin-key').inputValue(), '');
    const publicConfig = await (await api('/api/settings')).json();
    assert.equal(publicConfig.hasToken, true); assert.equal(publicConfig.token, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'))).token, token);
    assert.equal(fs.statSync(path.join(dataDir, 'settings.json')).mode & 0o777, 0o600);

    await screen.locator('.toggle').click();
    await screen.waitForFunction(() => document.querySelector('.toggle').getAttribute('aria-checked') === 'true' && !document.querySelector('.toggle').disabled);
    await screen.locator('input[type=range]').fill('42');
    await screen.locator('input[type=range]').dispatchEvent('change');
    await screen.waitForFunction(() => document.querySelector('.brightness-label').textContent === '42%' && !document.querySelector('.toggle').disabled);
    assert.ok(calls.some(call => call.data.brightness_pct === 42 && call.data.entity_id === 'light.test'));
    assert.equal((await api('/api/services/light/turn_on', 'POST', { entity_id: 'light.other' })).status, 403);
    assert.equal((await api('/api/states/light.other')).status, 403);
    assert.equal((await api('/api/services/light/turn_on', 'POST', { entity_id: 'light.test' }, null, { Origin: 'http://evil.example' })).status, 403);
    const limited = await (await api('/api/states')).json();
    assert.ok(!limited.some(state => state.entity_id === 'light.other'));
    const storage = await screen.evaluate(() => [localStorage.getItem('hemma-token'), sessionStorage.getItem('hemma-token'), localStorage.getItem('hemma-settings')]);
    assert.deepEqual(storage, [null, null, null]);
    assert.ok(!tabletTraffic.join('').includes(token));

    calendarFailure = true;
    await screen.locator('#refresh-button').click();
    await screen.waitForFunction(() => document.getElementById('connection').textContent === 'Anslutningsfel');
    assert.equal(await screen.locator('.event').count(), 1);
    calendarFailure = false; authFailure = true;
    await screen.locator('#refresh-button').click();
    await screen.waitForFunction(() => document.getElementById('last-updated').textContent.indexOf('HTTP 401') >= 0);
    assert.equal(await screen.locator('#temperature').textContent(), '9°');
    authFailure = false;
    await screen.locator('#refresh-button').click();
    await screen.waitForFunction(() => document.getElementById('connection').textContent === 'Ansluten');

    // Blank token preserves the server-side credential; competing edits are rejected.
    const update = { ...publicConfig, token: '', lights: [] };
    let response = await api('/api/settings', 'PUT', update, adminKey); assert.equal(response.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'))).token, token);
    assert.equal((await api('/api/settings', 'PUT', update, adminKey)).status, 409);
    await screen.waitForFunction(() => document.getElementById('lights-count').textContent === '0 av 0 tända', null, { timeout: 20000 });
    // Rotate the credential centrally, without sending it to the tablet.
    const latest = await (await api('/api/settings')).json();
    token = 'rotated-private-token';
    response = await api('/api/settings', 'PUT', { ...latest, token, lights: ['light.test'] }, adminKey);
    assert.equal(response.status, 200);
    await screen.waitForFunction(() => document.querySelectorAll('.light-card').length === 1 && document.getElementById('connection').textContent === 'Ansluten', null, { timeout: 20000 });
    assert.ok(!tabletTraffic.join('').includes(token));

    // Restarting the service restores the shared configuration from disk.
    await stop(server); server = createServer({ adminKey, dataDir }); await listen(server);
    const restored = await (await fetch(`http://127.0.0.1:${server.address().port}/api/settings`)).json();
    assert.deepEqual(restored.lights, ['light.test']); assert.equal(restored.hasToken, true); assert.equal(restored.token, undefined);
    assert.deepEqual(errors, []);
    console.log('PASS: ES5, 1024×600 layout, desktop-to-tablet automatic sync, central persistence, token rotation and redaction, admin protection, selected-entity proxy, controls, conflict handling, and connection recovery.');
  } finally {
    if (browser) { await browser.close(); }
    if (server) { await stop(server); }
    await stop(upstream); fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
