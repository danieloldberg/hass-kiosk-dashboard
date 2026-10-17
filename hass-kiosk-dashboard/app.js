(function () {
  'use strict';

  // ES5 and XMLHttpRequest keep this usable on older Android WebViews.
  var DAYS = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'];
  var LONG_DAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
  var MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
  var COLORS = ['#94cbbb', '#dcb482', '#aaa4d7', '#8fb8da', '#d89eaa', '#b6c789'];
  var CONDITIONS = { sunny: 'Soligt', clear: 'Klart', 'clear-night': 'Klar natt', partlycloudy: 'Växlande molnighet', cloudy: 'Molnigt', rainy: 'Regn', pouring: 'Kraftigt regn', snowy: 'Snö', 'snowy-rainy': 'Snöblandat regn', fog: 'Dimma', windy: 'Blåsigt', 'windy-variant': 'Blåsigt', lightning: 'Åska', 'lightning-rainy': 'Åska och regn', exceptional: 'Ovanligt väder' };
  var config = { calendars: [], lights: [], weather: '', connected: false };
  var states = [], events = [], forecasts = [], hiddenCalendars = {};
  var selectedDate = midnight(new Date()), weekStart = monday(selectedDate);
  var demo = false, generation = 0, refreshing = false, pending = {}, toastTimer;
  var syncing = false, syncEpoch = 0, saving = false, sessionExpired = false;

  function el(id) { return document.getElementById(id); }
  function text(node, value) { node.textContent = value; }
  function make(tag, className, value) { var node = document.createElement(tag); if (className) { node.className = className; } if (value !== undefined) { text(node, value); } return node; }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function midnight(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()); }
  function addDays(date, n) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n); }
  function monday(date) { return addDays(midnight(date), -((date.getDay() + 6) % 7)); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function time(date) { return pad(date.getHours()) + ':' + pad(date.getMinutes()); }
  function capital(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
  function dateLabel(date) { return LONG_DAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()]; }
  // Remove credentials left by the earlier, browser-local version.
  ['localStorage', 'sessionStorage'].forEach(function (store) {
    try { window[store].removeItem('hemma-token'); window[store].removeItem('hemma-settings'); } catch (ignore) {}
  });
  function request(method, path, body, callback, adminKey) {
    var xhr = new XMLHttpRequest(), finished = false;
    function finish(error, data) { if (!finished) { finished = true; callback(error, data); } }
    try {
      xhr.open(method, 'api/' + path, true);
      if (adminKey) { xhr.setRequestHeader('X-Hemma-Admin', adminKey); }
      xhr.setRequestHeader('Content-Type', 'application/json'); xhr.timeout = 15000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) { return; }
        if (xhr.status >= 200 && xhr.status < 300) {
          try { var data = xhr.responseText ? JSON.parse(xhr.responseText) : null; finish(null, data); } catch (error) { finish('Ogiltigt svar från Home Assistant.'); }
        } else {
          var message = 'Kan inte nå servern' + (xhr.status ? ' (HTTP ' + xhr.status + ').' : '. Kontrollera nätverket.');
          try { message = JSON.parse(xhr.responseText).error || message; } catch (ignore) {}
          if (xhr.status === 401 && (config.mode === 'ingress' || path === 'settings')) {
            sessionExpired = true; el('session-notice').hidden = false; renderLights();
            message = 'Sessionen har gått ut. Öppna tillägget via Home Assistant igen.';
          }
          finish(message);
        }
      };
      xhr.onerror = function () { finish('Kan inte nå servern. Kontrollera nätverket.'); };
      xhr.ontimeout = function () { finish('Servern svarade inte i tid.'); };
      xhr.send(body ? JSON.stringify(body) : null);
    } catch (error) { finish('Kunde inte ansluta till servern.'); }
  }
  function applySettings(shared) {
    el('settings-button').hidden = !shared.canManage;
    el('standalone-settings').hidden = shared.mode === 'ingress';
    el('ingress-settings-hint').hidden = shared.mode !== 'ingress';
    el('standalone-settings-hint').hidden = shared.mode === 'ingress';
    el('direct-link').hidden = shared.mode !== 'ingress';
    if (shared.revision === config.revision) { config.canManage = shared.canManage; config.mode = shared.mode; return; }
    config = shared; generation++; refreshing = false; pending = {}; hiddenCalendars = {}; states = []; events = []; forecasts = [];
    if (!config.connected) { startDemo(); } else { demo = false; connection('Ansluter…'); renderAll(); refresh(); }
  }
  function syncSettings(callback) {
    if (syncing || saving) { return; }
    syncing = true; var epoch = syncEpoch;
    request('GET', 'settings', null, function (error, shared) {
      syncing = false; if (epoch !== syncEpoch) { return; }
      if (error) { connection('Serverfel', 'offline'); text(el('last-updated'), error); return; }
      var wasExpired = sessionExpired; sessionExpired = false; el('session-notice').hidden = true;
      applySettings(shared);
      if (wasExpired) { renderLights(); refresh(); }
      if (demo) { connection('Demoläge'); text(el('last-updated'), 'Exempeldata · anslut i inställningar'); }
      if (callback) { callback(); }
    });
  }
  function findState(id) { for (var i = 0; i < states.length; i++) { if (states[i].entity_id === id) { return states[i]; } } return null; }
  function nameOf(id) { var state = findState(id); return state && state.attributes.friendly_name || id; }
  function calendars() { return demo ? ['calendar.familjen', 'calendar.arbete', 'calendar.aktiviteter'] : config.calendars; }
  function calendarColor(id) { var ids = calendars(), index = ids.indexOf(id); return COLORS[(index < 0 ? 0 : index) % COLORS.length]; }
  function weekNumber(date) { var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); return Math.ceil((((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7); }
  function updateClock() { var now = new Date(); text(el('clock'), time(now)); text(el('today-label'), capital(dateLabel(now))); }
  function connection(label, status) { text(el('connection'), label); el('connection').className = 'connection ' + (status || ''); }
  function toast(message) { clearTimeout(toastTimer); text(el('toast'), message); el('toast').hidden = false; toastTimer = setTimeout(function () { el('toast').hidden = true; }, 6000); }

  function renderWeek() {
    var end = addDays(weekStart, 6), now = new Date();
    text(el('month-label'), capital(MONTHS[weekStart.getMonth()]) + (end.getMonth() !== weekStart.getMonth() ? ' – ' + MONTHS[end.getMonth()] : '') + ' ' + end.getFullYear());
    text(el('week-label'), 'Vecka ' + weekNumber(weekStart)); clear(el('week-days'));
    for (var i = 0; i < 7; i++) { (function (date) {
      var button = make('button', 'day-button' + (sameDay(date, now) ? ' today' : '') + (sameDay(date, selectedDate) ? ' selected' : ''));
      button.setAttribute('aria-label', dateLabel(date)); button.setAttribute('aria-pressed', sameDay(date, selectedDate) ? 'true' : 'false');
      button.appendChild(make('span', 'day-name', capital(DAYS[date.getDay()]))); button.appendChild(make('span', 'day-number', date.getDate()));
      button.onclick = function () { selectedDate = date; renderWeek(); renderAgenda(); }; el('week-days').appendChild(button);
    }(addDays(weekStart, i))); }
  }
  function renderFilters() {
    clear(el('calendar-filters'));
    calendars().forEach(function (id) {
      var button = make('button', 'calendar-filter' + (hiddenCalendars[id] ? ' inactive' : '')), dot = make('span', 'calendar-dot');
      dot.style.backgroundColor = calendarColor(id); button.appendChild(dot); button.appendChild(document.createTextNode(nameOf(id)));
      button.setAttribute('aria-pressed', hiddenCalendars[id] ? 'false' : 'true');
      button.onclick = function () { hiddenCalendars[id] = !hiddenCalendars[id]; renderFilters(); renderAgenda(); }; el('calendar-filters').appendChild(button);
    });
  }
  function eventDate(value) { if (!value) { return new Date(NaN); } if (value.date) { var parts = value.date.split('-'); return new Date(+parts[0], +parts[1] - 1, +parts[2]); } return new Date(value.dateTime); }
  function renderAgenda() {
    text(el('agenda-title'), sameDay(selectedDate, new Date()) ? 'Idag' : capital(dateLabel(selectedDate)));
    clear(el('agenda'));
    var next = addDays(selectedDate, 1), visible = events.filter(function (event) { var start = eventDate(event.start), end = eventDate(event.end); return !hiddenCalendars[event.calendar] && start < next && (end > selectedDate || sameDay(start, selectedDate)); });
    visible.sort(function (a, b) { if (!!a.start.date !== !!b.start.date) { return a.start.date ? -1 : 1; } return eventDate(a.start) - eventDate(b.start); });
    text(el('event-count'), visible.length + (visible.length === 1 ? ' händelse' : ' händelser'));
    if (!visible.length) { el('agenda').appendChild(make('p', 'empty-message', calendars().length ? 'Inget planerat. Plats för en lugn stund.' : 'Välj kalendrar i inställningar.')); }
    visible.forEach(function (event) {
      var row = make('div', 'event'), start = eventDate(event.start), bar = make('span', 'event-bar'), content = make('div', 'event-content');
      row.appendChild(make('span', 'event-time', event.start.date ? 'Heldag' : start < selectedDate ? 'Pågår' : time(start)));
      bar.style.backgroundColor = calendarColor(event.calendar); row.appendChild(bar);
      content.appendChild(make('div', 'event-title', event.summary || 'Utan rubrik'));
      content.appendChild(make('div', 'event-meta', nameOf(event.calendar) + (event.location ? ' · ' + event.location : ''))); row.appendChild(content); el('agenda').appendChild(row);
    });
  }
  function weatherSvg(condition) {
    var sun = '<g stroke="#e8bd78" stroke-width="3" stroke-linecap="round"><circle cx="35" cy="32" r="12" fill="#e8bd78" stroke="none"/><path d="M35 10v-5m0 54v-5M13 32H8m54 0h-5M19 16l-4-4m40 40l-4-4M19 48l-4 4m40-40l-4 4"/></g>';
    var cloud = '<path d="M22 58h39c19 0 21-26 3-29-4-22-36-21-40-1-20-2-23 30-2 30z" fill="#bdcbd6"/>';
    var rain = '<path d="M29 65l-3 7m17-7l-3 7m17-7l-3 7" stroke="#91bace" stroke-width="3" stroke-linecap="round"/>';
    var shape = condition === 'sunny' || condition === 'clear' ? sun : condition === 'clear-night' ? '<path d="M51 12a27 27 0 1 0 18 42A29 29 0 0 1 51 12" fill="#c8c6e1"/>' : condition === 'partlycloudy' ? sun + cloud : cloud;
    if (/rain|pouring/.test(condition)) { shape += rain; }
    if (/snow/.test(condition)) { shape += '<g fill="#d5e6ef"><circle cx="28" cy="69" r="2"/><circle cx="43" cy="69" r="2"/><circle cx="58" cy="69" r="2"/></g>'; }
    if (/lightning/.test(condition)) { shape += '<path d="M44 49l-9 17h9l-5 13 19-23H46l6-7z" fill="#e8bd78"/>'; }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88" aria-hidden="true">' + shape + '</svg>';
  }
  function renderWeather() {
    var state = findState(demo ? 'weather.hemma' : config.weather), attr = state && state.attributes || {}, available = state && state.state !== 'unavailable' && state.state !== 'unknown';
    text(el('temperature'), available && typeof attr.temperature === 'number' ? Math.round(attr.temperature) + '°' + (attr.temperature_unit === '°F' ? 'F' : '') : '—');
    text(el('weather-condition'), available ? CONDITIONS[state.state] || 'Okänt väder' : 'Väder saknas');
    text(el('weather-location'), state ? nameOf(state.entity_id) : 'Hemma'); el('weather-icon').innerHTML = available ? weatherSvg(state.state) : '';
    text(el('wind'), available && typeof attr.wind_speed === 'number' ? attr.wind_speed + ' ' + (attr.wind_speed_unit || '') : '—');
    text(el('humidity'), available && typeof attr.humidity === 'number' ? attr.humidity + ' %' : '—'); clear(el('forecast'));
    if (!forecasts.length) { el('forecast').appendChild(make('p', 'forecast-note', 'Ingen dygnsprognos tillgänglig')); }
    forecasts.slice(0, 4).forEach(function (day) {
      var date = new Date(day.datetime), box = make('div', 'forecast-day', sameDay(date, new Date()) ? 'Idag' : capital(DAYS[date.getDay()])), icon = make('span'), temp = make('div', 'forecast-temp', typeof day.temperature === 'number' ? Math.round(day.temperature) + '°' : '—');
      icon.innerHTML = weatherSvg(day.condition || 'cloudy'); box.appendChild(icon);
      if (typeof day.templow === 'number') { temp.appendChild(make('span', '', Math.round(day.templow) + '°')); } box.appendChild(temp); el('forecast').appendChild(box);
    });
  }
  function supportsBrightness(state) { var a = state.attributes; return a.brightness !== undefined || (a.supported_features & 1) || (a.supported_color_modes && a.supported_color_modes.some(function (mode) { return mode !== 'onoff' && mode !== 'unknown'; })); }
  function bulbSvg() { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 16c0-3-3-3-3-7a7 7 0 0 1 14 0c0 4-3 4-3 7zM8 19h8m-6 3h4M9 9l3 3 3-3m-3 3v4"/></svg>'; }
  function renderLights() {
    var ids = demo ? ['light.vardagsrum', 'light.kok', 'light.hall'] : config.lights, onCount = 0;
    clear(el('lights'));
    ids.forEach(function (id) {
      var state = findState(id), available = state && state.state !== 'unavailable' && state.state !== 'unknown', on = available && state.state === 'on', brightness = on ? Math.round((state.attributes.brightness || 0) / 255 * 100) : 0;
      if (on) { onCount++; }
      var card = make('div', 'light-card' + (on ? ' on' : '')), top = make('div', 'light-top'), icon = make('div', 'bulb'), info = make('div', 'light-info'), toggle = make('button', 'toggle'), track = make('span', 'toggle-track');
      icon.innerHTML = bulbSvg(); top.appendChild(icon); info.appendChild(make('div', 'light-name', nameOf(id))); info.appendChild(make('div', 'light-state', !available ? 'Ej tillgänglig' : on ? 'Tänd' : 'Släckt')); top.appendChild(info);
      track.appendChild(make('span', 'toggle-thumb')); toggle.appendChild(track); toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', on ? 'true' : 'false'); toggle.setAttribute('aria-label', nameOf(id)); toggle.disabled = sessionExpired || !available || !!pending[id];
      toggle.onclick = function () { controlLight(id, on ? 'turn_off' : 'turn_on'); }; top.appendChild(toggle); card.appendChild(top);
      var row = make('div', 'brightness-row');
      if (available && supportsBrightness(state)) {
        var slider = make('input'), label = make('span', 'brightness-label', brightness + '%'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.value = brightness; slider.disabled = sessionExpired || !!pending[id]; slider.setAttribute('aria-label', 'Ljusstyrka ' + nameOf(id));
        slider.oninput = function () { text(label, slider.value + '%'); }; slider.onchange = function () { var value = +slider.value; controlLight(id, value ? 'turn_on' : 'turn_off', value ? { brightness_pct: value } : null); }; row.appendChild(slider); row.appendChild(label);
      } else { row.appendChild(make('span', 'muted', available ? 'Av / på' : 'Kontrollera anslutningen')); }
      card.appendChild(row); el('lights').appendChild(card);
    });
    text(el('lights-count'), onCount + ' av ' + ids.length + ' tända'); el('all-off').disabled = sessionExpired || !onCount;
    if (!ids.length) { el('lights').appendChild(make('p', 'empty-message', 'Välj lampor i inställningar.')); }
  }
  function controlLight(id, service, data) {
    var state = findState(id), currentGeneration = generation;
    if (sessionExpired || !state || pending[id]) { return; }
    if (demo) { state.state = service === 'turn_off' ? 'off' : 'on'; if (data) { state.attributes.brightness = Math.round(data.brightness_pct / 100 * 255); } renderLights(); return; }
    pending[id] = true; renderLights(); data = data || {}; data.entity_id = id;
    request('POST', 'services/light/' + service, data, function (error) {
      if (currentGeneration !== generation) { return; }
      if (error) { delete pending[id]; renderLights(); toast(error); return; }
      request('GET', 'states/' + encodeURIComponent(id), null, function (stateError, updated) {
        if (currentGeneration !== generation) { return; } delete pending[id];
        if (stateError) { toast(stateError); } else { replaceState(updated); } renderLights();
      });
    });
  }
  function replaceState(updated) { for (var i = 0; i < states.length; i++) { if (states[i].entity_id === updated.entity_id) { states[i] = updated; return; } } states.push(updated); }
  function renderAll() { updateClock(); renderWeek(); renderFilters(); renderAgenda(); renderWeather(); renderLights(); }

  function refresh() {
    if (demo || refreshing) { return; }
    refreshing = true; var run = generation, outstanding = 2, failures = [];
    function done(error) {
      if (run !== generation) { return; } if (error) { failures.push(error); } outstanding--;
      if (outstanding === 0) { refreshing = false; connection(failures.length ? 'Anslutningsfel' : 'Ansluten', failures.length ? 'offline' : 'online'); text(el('last-updated'), failures.length ? failures[0] : 'Uppdaterad ' + time(new Date())); }
    }
    request('GET', 'states', null, function (error, data) {
      if (run !== generation) { return; }
      if (error) { done(error); return; } states = data; renderFilters(); renderLights();
      var weather = findState(config.weather); forecasts = weather && weather.attributes.forecast || []; renderWeather();
      if (weather && !forecasts.length && weather.state !== 'unavailable') {
        outstanding++; request('POST', 'services/weather/get_forecasts?return_response', { entity_id: config.weather, type: 'daily' }, function (forecastError, result) {
          if (run !== generation) { return; }
          var response = result && result.service_response && result.service_response[config.weather]; forecasts = response && response.forecast || []; renderWeather();
          // Older integrations may not offer a forecast service; current weather remains useful.
          done(null);
        });
      }
      done(null);
    });
    loadEvents(run, function (error) { if (run !== generation) { return; } renderAgenda(); done(error); });
  }
  function loadEvents(run, callback) {
    var ids = config.calendars.slice(), left = ids.length, collected = [], firstError = null;
    if (!left) { events = []; callback(null); return; }
    var query = '?start=' + encodeURIComponent(weekStart.toISOString()) + '&end=' + encodeURIComponent(addDays(weekStart, 7).toISOString());
    ids.forEach(function (id) {
      request('GET', 'calendars/' + encodeURIComponent(id) + query, null, function (error, data) {
        if (run !== generation) { return; }
        if (error) {
          firstError = firstError || error;
          events.forEach(function (event) { if (event.calendar === id) { collected.push(event); } });
        } else { (data || []).forEach(function (event) { event.calendar = id; collected.push(event); }); }
        left--; if (!left) { events = collected; callback(firstError); }
      });
    });
  }
  function changeWeek(offset) {
    weekStart = addDays(weekStart, offset * 7); selectedDate = addDays(selectedDate, offset * 7); events = []; generation++; refreshing = false; pending = {};
    if (demo) { demoEvents(); } renderWeek(); renderAgenda(); refresh();
  }
  function demoEvents() {
    events = [];
    for (var i = 0; i < 7; i++) {
      var day = addDays(weekStart, i), start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 16, 30), end = new Date(start.getTime() + 3600000);
      events.push({ calendar: 'calendar.familjen', summary: 'Hämta på förskolan', location: 'Solrosens förskola', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } });
      start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 18, 0); end = new Date(start.getTime() + 3600000);
      events.push({ calendar: 'calendar.aktiviteter', summary: i % 2 ? 'Fotbollsträning' : 'Middag tillsammans', location: i % 2 ? 'Idrottsplatsen' : 'Hemma', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } });
    }
  }
  function startDemo() {
    demo = true; generation++; refreshing = false; pending = {};
    states = [{ entity_id: 'calendar.familjen', attributes: { friendly_name: 'Familjen' } }, { entity_id: 'calendar.arbete', attributes: { friendly_name: 'Arbete' } }, { entity_id: 'calendar.aktiviteter', attributes: { friendly_name: 'Aktiviteter' } }, { entity_id: 'weather.hemma', state: 'partlycloudy', attributes: { friendly_name: 'Hemma', temperature: 14, temperature_unit: '°C', wind_speed: 3.2, wind_speed_unit: 'm/s', humidity: 68 } }, { entity_id: 'light.vardagsrum', state: 'on', attributes: { friendly_name: 'Vardagsrum', brightness: 178, supported_features: 1 } }, { entity_id: 'light.kok', state: 'on', attributes: { friendly_name: 'Kök', brightness: 255, supported_features: 1 } }, { entity_id: 'light.hall', state: 'off', attributes: { friendly_name: 'Hall', brightness: 120, supported_features: 1 } }];
    forecasts = []; for (var i = 0; i < 4; i++) { forecasts.push({ datetime: addDays(new Date(), i).toISOString(), condition: ['partlycloudy', 'sunny', 'rainy', 'cloudy'][i], temperature: [14, 16, 12, 13][i], templow: [8, 9, 7, 8][i] }); }
    demoEvents(); connection('Demoläge'); text(el('last-updated'), 'Exempeldata · anslut i inställningar'); renderAll();
  }
  var discovered = null, settingsPreviousFocus, discoveryRevision = 0, draftRevision;
  function openSettings() {
    settingsPreviousFocus = document.activeElement; draftRevision = config.revision; el('ha-url').value = config.url || ''; el('ha-token').value = ''; el('ha-token').placeholder = config.hasToken ? 'Sparad på servern · lämna tomt för att behålla' : 'Klistra in din token'; text(el('settings-status'), '');
    discovered = null; discoveryRevision++; el('entity-settings').hidden = true; el('settings-overlay').hidden = false;
    if (config.mode === 'ingress') { el('discover-button').focus(); } else { el('ha-url').focus(); }
  }
  function closeSettings() { if (saving) { return; } discoveryRevision++; el('ha-token').value = ''; el('admin-key').value = ''; el('settings-overlay').hidden = true; if (settingsPreviousFocus) { settingsPreviousFocus.focus(); } }
  function renderEntityOptions() {
    clear(el('weather-select')); clear(el('calendar-options')); clear(el('light-options'));
    var none = make('option', '', 'Inget väder'); none.value = ''; el('weather-select').appendChild(none);
    discovered.slice().sort(function (a, b) { var x = a.attributes.friendly_name || a.entity_id, y = b.attributes.friendly_name || b.entity_id; return x.localeCompare(y); }).forEach(function (state) {
      var domain = state.entity_id.split('.')[0], name = state.attributes.friendly_name || state.entity_id;
      if (domain === 'weather') { var option = make('option', '', name); option.value = state.entity_id; el('weather-select').appendChild(option); }
      if (domain === 'calendar' || domain === 'light') {
        var label = make('label', 'checkbox-label'), checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.value = state.entity_id; checkbox.checked = (domain === 'calendar' ? config.calendars : config.lights).indexOf(state.entity_id) >= 0;
        label.appendChild(checkbox); label.appendChild(document.createTextNode(name)); el(domain === 'calendar' ? 'calendar-options' : 'light-options').appendChild(label);
      }
    });
    el('weather-select').value = config.weather || ''; el('entity-settings').hidden = false;
  }
  function selectedOptions(id) { var inputs = el(id).getElementsByTagName('input'), result = []; for (var i = 0; i < inputs.length; i++) { if (inputs[i].checked) { result.push(inputs[i].value); } } return result; }
  function readConnectionFields() {
    if (config.mode === 'ingress') { return {}; }
    var url = el('ha-url').value.replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s?#]+$/i.test(url)) { text(el('settings-status'), 'Ange en giltig http://- eller https://-adress.'); return null; }
    var token = el('ha-token').value.replace(/^\s+|\s+$/g, '');
    if (!url) { text(el('settings-status'), 'Ange Home Assistants fullständiga adress.'); return null; }
    if (!token && (!config.hasToken || url !== config.url)) { text(el('settings-status'), 'Ange en åtkomsttoken.'); return null; }
    return { url: url, token: token };
  }
  el('settings-button').onclick = openSettings; el('close-settings').onclick = closeSettings;
  el('settings-overlay').onkeydown = function (event) {
    event = event || window.event;
    if (event.keyCode === 27) { closeSettings(); }
    if (event.keyCode === 9) {
      var focusable = el('settings-overlay').querySelectorAll('button, input, select'), visible = [], i;
      for (i = 0; i < focusable.length; i++) { if (focusable[i].offsetWidth && !focusable[i].disabled) { visible.push(focusable[i]); } }
      if (visible.length && event.shiftKey && document.activeElement === visible[0]) { visible[visible.length - 1].focus(); event.preventDefault(); }
      else if (visible.length && !event.shiftKey && document.activeElement === visible[visible.length - 1]) { visible[0].focus(); event.preventDefault(); }
    }
  };
  el('discover-button').onclick = function () {
    var fields = readConnectionFields(); if (!fields) { return; }
    var revision = ++discoveryRevision; el('discover-button').disabled = true; text(el('settings-status'), 'Ansluter…');
    request('POST', 'admin/discover', fields, function (error, data) { el('discover-button').disabled = false; if (revision !== discoveryRevision) { return; } if (error) { text(el('settings-status'), error); return; } discovered = data; renderEntityOptions(); text(el('settings-status'), 'Ansluten. Välj vad som ska visas.'); }, el('admin-key').value);
  };
  el('ha-url').oninput = el('ha-token').oninput = function () { discovered = null; discoveryRevision++; el('entity-settings').hidden = true; text(el('settings-status'), 'Hämta enheter för den nya anslutningen.'); };
  el('settings-form').onsubmit = function (event) {
    event.preventDefault(); var fields = readConnectionFields(); if (!fields) { return; }
    if (!discovered) { text(el('settings-status'), 'Anslut och hämta enheter först.'); return; }
    fields.calendars = selectedOptions('calendar-options'); fields.lights = selectedOptions('light-options'); fields.weather = el('weather-select').value; fields.connected = true; saveShared(fields);
  };
  function saveShared(fields) {
    if (saving) { return; } saving = true; syncEpoch++; fields.revision = draftRevision; text(el('settings-status'), 'Sparar på servern…');
    request('PUT', 'settings', fields, function (error, shared) {
      saving = false; if (error) { text(el('settings-status'), error); return; }
      closeSettings(); applySettings(shared); toast('Inställningarna är sparade. Övriga skärmar uppdateras inom 15 sekunder.');
    }, el('admin-key').value);
  }
  el('demo-button').onclick = function () { saveShared({ connected: false, calendars: config.calendars, lights: config.lights, weather: config.weather }); };
  el('previous-week').onclick = function () { changeWeek(-1); }; el('next-week').onclick = function () { changeWeek(1); };
  el('today-button').onclick = function () { selectedDate = midnight(new Date()); weekStart = monday(selectedDate); generation++; refreshing = false; pending = {}; events = []; if (demo) { demoEvents(); } renderWeek(); renderAgenda(); refresh(); };
  el('refresh-button').onclick = function () { syncSettings(function () { if (demo) { startDemo(); } else { refresh(); } }); };
  el('all-off').onclick = function () { (demo ? ['light.vardagsrum', 'light.kok', 'light.hall'] : config.lights).forEach(function (id) { var state = findState(id); if (state && state.state === 'on') { controlLight(id, 'turn_off'); } }); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { updateClock(); syncSettings(refresh); } });
  setInterval(updateClock, 10000); setInterval(function () { if (!document.hidden && el('settings-overlay').hidden) { refresh(); } }, 60000);
  setInterval(function () { if (!document.hidden) { syncSettings(); } }, 15000);
  connection('Ansluter…'); renderAll(); syncSettings();
}());
