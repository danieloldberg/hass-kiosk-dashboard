const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createServer(options = {}) {
  const ingress = options.ingress !== undefined ? options.ingress : process.env.HEMMA_INGRESS === '1';
  const adminKey = options.adminKey || process.env.HEMMA_ADMIN_KEY;
  const supervisorToken = options.supervisorToken || process.env.SUPERVISOR_TOKEN;
  if (ingress && !supervisorToken) { throw new Error('Ingress mode requires SUPERVISOR_TOKEN and homeassistant_api: true.'); }
  if (!ingress && !adminKey) { throw new Error('Set HEMMA_ADMIN_KEY before starting the server.'); }
  const dataDir = options.dataDir || process.env.HEMMA_DATA_DIR || (ingress ? '/data' : path.join(__dirname, 'data'));
  const ingressProxyAddress = options.ingressProxyAddress || '172.30.32.2';
  let settingsUsers = options.settingsUsers;
  if (ingress && !settingsUsers) { settingsUsers = JSON.parse(fs.readFileSync(path.join(dataDir, 'options.json'), 'utf8')).settings_users || []; }
  if (ingress && (!Array.isArray(settingsUsers) || settingsUsers.some(user => typeof user !== 'string'))) { throw new Error('settings_users must be a list of Home Assistant usernames.'); }
  const supervisorConnection = { apiUrl: options.coreApiUrl || 'http://supervisor/core/api/', token: supervisorToken };
  const file = path.join(dataDir, 'settings.json');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let settings = { revision: 'initial', connected: false, url: '', token: '', calendars: [], lights: [], weather: '' };
  if (fs.existsSync(file)) { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
  if (ingress && ('token' in settings || 'url' in settings)) {
    const { token, url, ...shared } = settings; settings = shared;
    if (fs.existsSync(file)) { persist(settings); }
  }
  function persist(next) {
    const temp = file + '.tmp';
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
    catch (_) { fail(500, 'Kunde inte spara inställningarna på servern.'); }
  }
  function canManage(req) { return ingress ? settingsUsers.includes(req.headers['x-remote-user-name']) : true; }
  function publicSettings(req) {
    const { token, url, ...result } = settings;
    return { ...result, mode: ingress ? 'ingress' : 'standalone', canManage: canManage(req), ...(ingress ? {} : { url, hasToken: !!token }) };
  }
  function fail(status, message) { throw Object.assign(new Error(message), { status }); }
  function authorize(req) {
    if (ingress) {
      if (!canManage(req)) { fail(403, 'Ditt Home Assistant-konto får inte ändra inställningarna. Lägg till användarnamnet i tilläggets settings_users.'); }
      return;
    }
    const supplied = Buffer.from(req.headers['x-hemma-admin'] || '');
    const expected = Buffer.from(adminKey);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { fail(401, 'Fel administratörsnyckel.'); }
  }
  function credentials(body) {
    let url;
    try { url = new URL(body.url); } catch (_) { fail(400, 'Ange Home Assistants fullständiga adress.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) { fail(400, 'Ogiltig Home Assistant-adress.'); }
    const normalized = url.href.replace(/\/+$/, '');
    const token = typeof body.token === 'string' && body.token.trim() || (normalized === settings.url ? settings.token : '');
    if (!token || /[\r\n]/.test(token)) { fail(400, 'Ange en åtkomsttoken.'); }
    return { url: normalized, token };
  }
  function entityList(value, domain) {
    if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !new RegExp('^' + domain + '\\.[a-z0-9_]+$').test(id))) { fail(400, 'Ogiltigt enhetsval.'); }
    return [...new Set(value)];
  }
  async function upstream(connection, method, endpoint, body) {
    let response;
    try {
      response = await fetch((connection.apiUrl || connection.url + '/api/') + endpoint, {
        method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000), redirect: 'error'
      });
    } catch (_) { fail(502, 'Kan inte nå Home Assistant. Kontrollera adress och nätverk.'); }
    if (!response.ok) { fail(response.status === 401 || response.status === 403 ? 502 : response.status, 'Home Assistant svarade med HTTP ' + response.status + '. Kontrollera anslutning och token.'); }
    try { return await response.json(); } catch (_) { fail(502, 'Ogiltigt svar från Home Assistant.'); }
  }
  async function readBody(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) { fail(415, 'JSON krävs.'); }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 65536) { fail(413, 'För stor begäran.'); } }
    let body;
    try { body = JSON.parse(raw); } catch (_) { fail(400, 'Ogiltig JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { fail(400, 'Ogiltig JSON.'); }
    return body;
  }
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      if (ingress) {
        const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (remote !== ingressProxyAddress) { fail(403, 'Endast Home Assistant ingress är tillåten.'); }
        if (!req.headers['x-remote-user-id']) { fail(401, 'Ingress-session saknas. Öppna tillägget via Home Assistant igen.'); }
      }
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;
      // Do not allow cross-origin writes, including from other sites on the LAN.
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch (_) { fail(403, 'Otillåtet ursprung.'); }
        if (origin.host !== req.headers.host) { fail(403, 'Otillåtet ursprung.'); }
      }
      if (route === '/api/settings' && req.method === 'GET') { json(res, 200, publicSettings(req)); return; }
      if (route === '/api/admin/discover' && req.method === 'POST') {
        authorize(req); const body = await readBody(req);
        json(res, 200, await upstream(ingress ? supervisorConnection : credentials(body), 'GET', 'states')); return;
      }
      if (route === '/api/settings' && req.method === 'PUT') {
        authorize(req); const body = await readBody(req);
        if (body.revision !== settings.revision) { fail(409, 'Inställningarna har ändrats. Stäng och öppna inställningar igen.'); }
        if (typeof body.connected !== 'boolean') { fail(400, 'Ogiltigt läge.'); }
        const connection = ingress ? {} : body.connected ? credentials(body) : { url: settings.url, token: settings.token };
        const next = { ...connection, revision: crypto.randomUUID(), connected: body.connected,
          calendars: entityList(body.calendars, 'calendar'), lights: entityList(body.lights, 'light'), weather: body.weather || '' };
        if (typeof next.weather !== 'string' || (next.weather && !/^weather\.[a-z0-9_]+$/.test(next.weather))) { fail(400, 'Ogiltigt väderval.'); }
        // Keep updates atomic and serialize the short persistence step before publishing them.
        persist(next);
        settings = next; json(res, 200, publicSettings(req)); return;
      }
      if (route.startsWith('/api/')) {
        const current = ingress ? { ...settings, ...supervisorConnection } : settings;
        if (!current.connected) { fail(503, 'Home Assistant är inte konfigurerad.'); }
        const selected = [...current.calendars, ...current.lights, current.weather].filter(Boolean);
        if (req.method === 'GET' && route === '/api/states') {
          const states = await upstream(current, 'GET', 'states');
          json(res, 200, states.filter(state => selected.includes(state.entity_id))); return;
        }
        if (req.method === 'GET' && route.startsWith('/api/states/')) {
          const id = decodeURIComponent(route.slice('/api/states/'.length));
          if (!selected.includes(id)) { fail(403, 'Enheten är inte vald.'); }
          json(res, 200, await upstream(current, 'GET', 'states/' + encodeURIComponent(id))); return;
        }
        if (req.method === 'GET' && route.startsWith('/api/calendars/')) {
          const id = decodeURIComponent(route.slice('/api/calendars/'.length));
          if (!current.calendars.includes(id)) { fail(403, 'Kalendern är inte vald.'); }
          const start = url.searchParams.get('start'), end = url.searchParams.get('end');
          const duration = new Date(end) - new Date(start);
          if (!Number.isFinite(duration) || duration <= 0 || duration > 32 * 86400000) { fail(400, 'Ogiltigt datumintervall.'); }
          json(res, 200, await upstream(current, 'GET', 'calendars/' + encodeURIComponent(id) + '?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end))); return;
        }
        if (req.method === 'POST' && ['/api/services/light/turn_on', '/api/services/light/turn_off'].includes(route)) {
          const body = await readBody(req);
          if (!current.lights.includes(body.entity_id)) { fail(403, 'Lampan är inte vald.'); }
          const command = { entity_id: body.entity_id };
          if (body.brightness_pct !== undefined) {
            if (typeof body.brightness_pct !== 'number' || !Number.isFinite(body.brightness_pct) || body.brightness_pct < 0 || body.brightness_pct > 100) { fail(400, 'Ogiltig ljusstyrka.'); }
            command.brightness_pct = body.brightness_pct;
          }
          json(res, 200, await upstream(current, 'POST', route.slice(5), command)); return;
        }
        if (req.method === 'POST' && route === '/api/services/weather/get_forecasts') {
          const body = await readBody(req);
          if (!current.weather || body.entity_id !== current.weather) { fail(403, 'Vädret är inte valt.'); }
          json(res, 200, await upstream(current, 'POST', 'services/weather/get_forecasts?return_response', { entity_id: current.weather, type: 'daily' })); return;
        }
        fail(404, 'Okänd API-adress.');
      }
      const staticFile = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js' }[route];
      if (!staticFile || !['GET', 'HEAD'].includes(req.method)) { fail(404, 'Sidan saknas.'); }
      res.setHeader('Content-Type', { 'index.html': 'text/html; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'app.js': 'application/javascript; charset=utf-8' }[staticFile]);
      res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname, staticFile)));
    } catch (error) { if (!res.headersSent) { json(res, error.status || 500, { error: error.status ? error.message : 'Internt serverfel.' }); } else { res.end(); } }
  });
}

if (require.main === module) {
  try {
    const server = createServer();
    const port = Number(process.env.PORT || 8080);
    server.listen(port, process.env.HOST || '0.0.0.0', () => console.log('hass-kiosk-dashboard listening on port ' + port));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createServer };
