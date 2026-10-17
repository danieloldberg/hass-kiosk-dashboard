const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');
const { createServer } = require('../hass-kiosk-dashboard/server.cjs');

const prefix = '/api/hassio_ingress/test-token/';
const token = 'supervisor-secret-not-for-the-browser';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemma-ingress-'));
const settingsUsers = ['desktop'];
const states = [
  { entity_id: 'light.demo', state: 'on', attributes: { friendly_name: 'Lampa', brightness: 128, supported_color_modes: ['brightness'] } },
  { entity_id: 'calendar.demo', state: 'off', attributes: { friendly_name: 'Kalender' } },
  { entity_id: 'weather.demo', state: 'sunny', attributes: { friendly_name: 'Vädret', temperature: 20, forecast: [] } }
];
const calls = [], browserPaths = [];
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
function stop(server) { return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }

(async () => {
  let core, backend, strictBackend, gateway, browser;
  try {
    core = http.createServer(async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer ' + token);
      calls.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      let data;
      if (req.url === '/core/api/states') { data = states; }
      else if (req.url.startsWith('/core/api/calendars/')) { data = []; }
      else if (req.url === '/core/api/states/light.demo') { data = states[0]; }
      else if (req.url === '/core/api/services/light/turn_off') { states[0].state = 'off'; data = []; }
      else if (req.url === '/core/api/services/light/turn_on') { states[0].state = 'on'; data = []; }
      else if (req.url === '/core/api/services/weather/get_forecasts?return_response') { data = { service_response: { 'weather.demo': { forecast: [{ datetime: new Date().toISOString(), condition: 'sunny', temperature: 20, templow: 10 }] } } }; }
      else { res.writeHead(404); res.end('{}'); return; }
      res.end(JSON.stringify(data));
    });
    await listen(core);
    fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify({ settings_users: settingsUsers }));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ revision: 'initial', connected: false, url: 'http://old-ha:8123', token: 'legacy-token', calendars: [], lights: [], weather: '' }));
    const options = { ingress: true, supervisorToken: token, dataDir, coreApiUrl: `http://127.0.0.1:${core.address().port}/core/api/` };
    // Spoofed user headers cannot bypass the real Supervisor peer-address restriction.
    strictBackend = createServer(options); await listen(strictBackend);
    assert.ok(!fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8').includes('legacy-token'));
    let response = await fetch(`http://127.0.0.1:${strictBackend.address().port}/api/settings`, { headers: { 'X-Remote-User-Id': 'desktop-id', 'X-Remote-User-Name': 'desktop', 'X-Forwarded-For': '172.30.32.2' } });
    assert.equal(response.status, 403);
    await stop(strictBackend); strictBackend = null;
    backend = createServer({ ...options, ingressProxyAddress: '127.0.0.1' }); await listen(backend);
    response = await fetch(`http://127.0.0.1:${backend.address().port}/api/settings`);
    assert.equal(response.status, 401);

    gateway = http.createServer((req, res) => {
      browserPaths.push(req.url);
      if (!req.url.startsWith(prefix)) { res.writeHead(404); res.end('Outside ingress'); return; }
      const match = /(?:^|;\s*)ingress_session=(desktop|tablet)(?:;|$)/.exec(req.headers.cookie || '');
      if (!match) { res.writeHead(401); res.end('Unauthorized'); return; }
      const user = match[1];
      const headers = { ...req.headers };
      delete headers['x-remote-user-id']; delete headers['x-remote-user-name'];
      headers['x-remote-user-id'] = user + '-id'; headers['x-remote-user-name'] = user; headers['x-ingress-path'] = prefix.slice(0, -1);
      const proxied = http.request({ hostname: '127.0.0.1', port: backend.address().port, path: '/' + req.url.slice(prefix.length), method: req.method, headers }, upstream => {
        res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
      });
      proxied.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(proxied);
    });
    await listen(gateway);
    const origin = `http://127.0.0.1:${gateway.address().port}`, base = origin + prefix;
    async function api(user, route, method = 'GET', body, extra = {}) {
      return fetch(base + route, { method, headers: { Cookie: 'ingress_session=' + user, 'Content-Type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined });
    }
    const initial = await (await api('desktop', 'api/settings')).json();
    assert.equal(initial.mode, 'ingress'); assert.equal(initial.canManage, true);
    const tabletConfig = await (await api('tablet', 'api/settings')).json();
    assert.equal(tabletConfig.canManage, false); assert.equal(tabletConfig.token, undefined); assert.equal(tabletConfig.url, undefined);
    assert.equal((await api('tablet', 'api/admin/discover', 'POST', {}, { 'X-Hemma-Admin': 'any', 'X-Remote-User-Name': 'desktop' })).status, 403);
    assert.equal((await api('tablet', 'api/settings', 'PUT', { ...initial, connected: true })).status, 403);
    assert.equal((await api('desktop', 'api/admin/discover', 'POST', {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await api('desktop', 'data/settings.json')).status, 404);

    browser = await chromium.launch();
    const desktop = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    const tablet = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    await desktop.addCookies([{ name: 'ingress_session', value: 'desktop', url: origin }]);
    await tablet.addCookies([{ name: 'ingress_session', value: 'tablet', url: origin }]);
    const page = await desktop.newPage(), screen = await tablet.newPage(), errors = [], traffic = [];
    page.on('pageerror', error => errors.push(error.message)); screen.on('pageerror', error => errors.push(error.message));
    screen.on('response', async response => { if (response.url().includes('/api/')) { traffic.push(await response.text().catch(() => '')); } });
    await page.goto(base); await screen.goto(base);
    await page.waitForFunction(() => document.getElementById('connection').textContent === 'Demoläge');
    await screen.waitForFunction(() => document.getElementById('connection').textContent === 'Demoläge');
    assert.equal(await screen.locator('#settings-button').isVisible(), false);
    assert.equal(await screen.locator('#direct-link').getAttribute('target'), '_top');
    assert.equal(await screen.locator('#direct-link').evaluate(link => link.href), base);
    await page.locator('#settings-button').click();
    assert.equal(await page.locator('#ha-token').isVisible(), false);
    assert.equal(await page.locator('#admin-key').isVisible(), false);
    await page.locator('#discover-button').click();
    await page.locator('#entity-settings').waitFor({ state: 'visible' });
    await page.locator('#calendar-options input').check(); await page.locator('#light-options input').check();
    await page.locator('#weather-select').selectOption('weather.demo');
    await page.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.getElementById('connection').textContent === 'Ansluten');
    await screen.waitForFunction(() => document.getElementById('connection').textContent === 'Ansluten', null, { timeout: 20000 });
    assert.equal(await screen.locator('#temperature').textContent(), '20°');
    assert.equal(await screen.locator('.forecast-day').count(), 1);
    await screen.locator('.toggle').click();
    await screen.waitForFunction(() => document.querySelector('.toggle').getAttribute('aria-checked') === 'false' && !document.querySelector('.toggle').disabled);
    assert.ok(calls.includes('/core/api/services/light/turn_off'));
    assert.ok(calls.includes('/core/api/services/weather/get_forecasts?return_response'));
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(saved.token, undefined); assert.equal(saved.url, undefined); assert.deepEqual(saved.lights, ['light.demo']);
    assert.ok(!traffic.join('').includes(token));
    const dimensions = await screen.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    assert.ok(dimensions.width <= 1024 && dimensions.height <= 600, JSON.stringify(dimensions));
    await tablet.clearCookies(); await screen.locator('#refresh-button').click();
    await screen.locator('#session-notice').waitFor({ state: 'visible' });
    assert.equal(await screen.locator('.toggle').isDisabled(), true);
    assert.equal(await screen.locator('#session-notice a').evaluate(link => link.pathname), '/');
    await tablet.addCookies([{ name: 'ingress_session', value: 'tablet', url: origin }]);
    await screen.locator('#refresh-button').click();
    await screen.locator('#session-notice').waitFor({ state: 'hidden' });
    await screen.waitForFunction(() => document.getElementById('connection').textContent === 'Ansluten');
    assert.equal(await screen.locator('.toggle').isDisabled(), false);
    await stop(backend); backend = createServer({ ...options, ingressProxyAddress: '127.0.0.1' }); await listen(backend);
    await screen.reload(); await screen.waitForFunction(() => document.getElementById('connection').textContent === 'Ansluten');
    assert.equal(await screen.locator('.light-card').count(), 1);
    assert.deepEqual(errors, []);
    assert.ok(browserPaths.every(route => route.startsWith(prefix)), browserPaths.join('\n'));
    console.log('PASS: ingress subpath assets and API, trusted proxy enforcement, user permissions, Supervisor API authentication, no PAT, desktop/tablet sync, controls, persistent storage, expired-session notice, and session recovery.');
  } finally {
    if (browser) { await browser.close(); }
    for (const server of [gateway, backend, strictBackend, core]) { if (server) { await stop(server); } }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
