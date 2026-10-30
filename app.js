/* Sheet App: a phone and desktop app for any Google Sheet.
   It reads the tabs and headings from the sheet, lets people search, view, add and edit rows,
   and keeps working with no signal: changes wait on the device and upload later. */
(function () {
'use strict';
const CFG = window.SHEET_APP_CONFIG || {};
const K = { user: 'sheetapp_user', schema: 'sheetapp_schema', rows: 'sheetapp_rows_', queue: 'sheetapp_queue', synced: 'sheetapp_synced' };
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('This device is out of storage space'); return false; } };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

if (CFG.accent) { document.documentElement.style.setProperty('--accent', CFG.accent); const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = CFG.accent; }
document.title = CFG.appName || 'Sheet App';

let user = load(K.user, null);
let schema = load(K.schema, null);
let queue = load(K.queue, []);
let busy = false, online = true, route = { view: 'home' };

/* ---------- server ---------- */
async function api(body) {
  if (!CFG.apiUrl || /PASTE_YOUR/.test(CFG.apiUrl)) throw Object.assign(new Error('The app is not connected yet: put the Web app URL in config.js'), { setup: true });
  const res = await fetch(CFG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ code: user && user.code, user: user && user.name }, body)), redirect: 'follow' });
  const out = await res.json();
  if (!out.ok) throw Object.assign(new Error(out.error || 'Server error'), { auth: out.auth === false });
  return out;
}

async function refresh(tabs) {
  schema = await api({ action: 'schema' });
  store(K.schema, schema);
  const names = tabs || schema.tabs.map(t => t.name);
  for (const n of names) {
    if (!schema.tabs.some(t => t.name === n)) continue;
    const r = await api({ action: 'rows', tab: n });
    store(K.rows + n, { headers: r.headers, rows: r.rows, truncated: r.truncated, at: Date.now() });
  }
  store(K.synced, Date.now());
}

async function sync(full) {
  if (busy || !user) return;
  busy = true; status();
  try {
    if (queue.length) {
      const sent = queue.slice();
      const out = await api({ action: 'sync', ops: sent });
      const failed = [];
      out.results.forEach(r => { if (!r.ok) failed.push(r); });
      const okIds = new Set(out.results.filter(r => r.ok).map(r => r.uid));
      queue = load(K.queue, []).filter(op => !okIds.has(op.uid));
      // a change the sheet rejected (e.g. row moved) is kept so it is not lost, but flagged
      failed.forEach(f => { const op = queue.find(o => o.uid === f.uid); if (op) op.error = f.error; });
      store(K.queue, queue);
      if (failed.length) toast(failed.length + ' change(s) need attention: ' + failed[0].error);
      await refresh(full ? null : [...new Set(sent.map(o => o.tab))]);
    } else {
      await refresh(full ? null : (route.tab ? [route.tab] : null));
    }
    online = true;
  } catch (e) {
    if (e.auth) { toast('The access code was changed. Please sign in again.'); signOut(); }
    else if (e.setup) { toast(e.message); }
    online = false;
  } finally { busy = false; status(); render(); }
}

/* ---------- local data ---------- */
function tabData(name) {
  const d = load(K.rows + name, { headers: (schema && (schema.tabs.find(t => t.name === name) || {}).headers) || [], rows: [] });
  const rows = d.rows.map(r => ({ row: r._row, v: r.v.slice(), pending: false }));
  // show changes that have not been uploaded yet
  queue.filter(op => op.tab === name).forEach(op => {
    if (op.type === 'update') {
      const r = rows.find(x => x.row === op.row);
      if (r) { d.headers.forEach((h, i) => { if (op.values.hasOwnProperty(h)) r.v[i] = op.values[h]; }); r.pending = true; r.error = op.error; }
    } else {
      rows.push({ row: null, uid: op.uid, v: d.headers.map(h => op.values[h] || ''), pending: true, error: op.error });
    }
  });
  return { headers: d.headers, rows, truncated: d.truncated };
}

function fieldKind(h, values) {
  const n = h.toLowerCase();
  const filled = values.filter(v => v !== '');
  if (/(^|\b)(date|day|dob|due|deadline|when)(\b|$)/.test(n)) return 'date';
  if (filled.length >= 2 && filled.every(v => /^(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})$/.test(v.trim()))) return 'date';
  if (/(note|comment|description|remark|detail|address)/.test(n)) return 'long';
  if (/(email|e-mail)/.test(n)) return 'email';
  if (/(phone|mobile|tel)/.test(n)) return 'tel';
  if (filled.length >= 3 && filled.every(v => /^-?[\d,]*\.?\d+%?$/.test(v.replace(/[$€£]/g, '').trim()))) return 'number';
  return 'text';
}

function toInputDate(v) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return isNaN(d) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/* ---------- screens ---------- */
function setHeader(crumb, back) {
  $('#brand').innerHTML = esc(CFG.appName || 'Sheet App') + '<small id="crumb">' + esc(crumb || '') + '</small>';
  $('#back').hidden = !back;
}

function render() {
  if (!user) return renderLogin();
  if (!schema) { setHeader('', false); app.innerHTML = '<div class="empty">' + (online ? 'Loading the sheet…' : 'No connection yet. Connect to Wi-Fi or data once to load the sheet.') + '</div>'; return; }
  if (route.view === 'tab') return renderTab();
  if (route.view === 'form') return renderForm();
  renderHome();
}

function renderLogin(msg) {
  setHeader('', false);
  const fab = document.querySelector('.fab'); if (fab) fab.remove();
  app.innerHTML = `<div class="card"><h2>Sign in</h2>
    <p class="meta">Ask the sheet owner for the access code.</p>
    <form id="login"><label for="nm">Your name</label><input id="nm" autocomplete="name" required maxlength="60">
    <label for="cd">Access code</label><input id="cd" type="password" autocomplete="off" required>
    <div class="foot"><button class="btn block" type="submit">Sign in</button></div>
    ${msg ? '<div class="err">' + esc(msg) + '</div>' : ''}</form></div>`;
  $('#login').onsubmit = async ev => {
    ev.preventDefault();
    user = { name: $('#nm').value.trim(), code: $('#cd').value.trim() };
    const btn = ev.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking…';
    try { await api({ action: 'ping' }); store(K.user, user); route = { view: 'home' }; await sync(true); }
    catch (e) { user = null; renderLogin(e.auth ? 'That access code is not right.' : (e.setup ? e.message : 'Could not reach the sheet. Check your connection and try again.')); }
  };
}

function renderHome() {
  setHeader(schema.title, false);
  removeFab();
  const tiles = schema.tabs.map(t => {
    const d = tabData(t.name);
    const p = queue.filter(o => o.tab === t.name).length;
    return `<button class="tab" data-tab="${esc(t.name)}"><b>${esc(t.name)}${t.readOnly ? '<span class="tag ro">view only</span>' : ''}</b>
      <span>${d.rows.length} rows${p ? ' · ' + p + ' not sent yet' : ''}</span></button>`;
  }).join('');
  app.innerHTML = `<div class="tabs">${tiles || '<div class="empty">No tabs to show.</div>'}</div>
    <div class="foot"><button class="btn ghost" id="refresh">Refresh from sheet</button><button class="btn ghost" id="out">Sign out (${esc(user.name)})</button></div>`;
  app.querySelectorAll('.tab').forEach(b => b.onclick = () => { route = { view: 'tab', tab: b.dataset.tab, q: '' }; render(); window.scrollTo(0, 0); });
  $('#refresh').onclick = () => sync(true);
  $('#out').onclick = () => { if (!queue.length || confirm('Some changes have not been sent yet. Sign out anyway? They will stay on this device.')) signOut(); };
}

function renderTab() {
  const t = schema.tabs.find(x => x.name === route.tab);
  if (!t) { route = { view: 'home' }; return render(); }
  setHeader(t.name, true);
  const d = tabData(t.name);
  const q = (route.q || '').toLowerCase();
  let rows = d.rows.slice().reverse();          // newest at the top
  if (q) rows = rows.filter(r => r.v.join(' ').toLowerCase().includes(q));
  const shown = rows.slice(0, 200);
  const cols = d.headers.map((h, i) => i).filter(i => d.headers[i]);
  const list = shown.map(r => {
    const title = r.v[cols[0]] || '(blank)';
    const sub = cols.slice(1, 4).map(i => r.v[i]).filter(Boolean).join(' · ');
    const key = r.row ? 'r' + r.row : 'u' + r.uid;
    return `<button class="item" data-key="${key}"><b>${esc(title)}${r.pending ? '<span class="tag">' + (r.error ? 'needs attention' : 'not sent yet') + '</span>' : ''}</b><span>${esc(sub)}</span></button>`;
  }).join('');
  app.innerHTML = `<div class="search"><input id="q" type="search" placeholder="Search ${esc(t.name)}…" value="${esc(route.q || '')}"></div>
    <div class="meta">${rows.length} of ${d.rows.length} rows${d.truncated ? ' (latest rows only)' : ''}</div>
    ${list || '<div class="empty">No matching rows.</div>'}
    ${rows.length > shown.length ? '<div class="more">Showing the first 200. Search to narrow it down.</div>' : ''}`;
  const qi = $('#q');
  qi.oninput = () => { route.q = qi.value; const pos = qi.selectionStart; renderTab(); const n = $('#q'); n.focus(); n.setSelectionRange(pos, pos); };
  app.querySelectorAll('.item').forEach(b => b.onclick = () => { route = { view: 'form', tab: t.name, key: b.dataset.key, q: route.q }; render(); window.scrollTo(0, 0); });
  removeFab();
  if (!t.readOnly) {
    const f = document.createElement('button'); f.className = 'btn fab'; f.textContent = '+ Add'; f.onclick = () => { route = { view: 'form', tab: t.name, key: null, q: route.q }; render(); window.scrollTo(0, 0); };
    document.body.appendChild(f);
  }
}

function renderForm() {
  removeFab();
  const t = schema.tabs.find(x => x.name === route.tab);
  const d = tabData(route.tab);
  const rec = route.key ? d.rows.find(r => (r.row ? 'r' + r.row : 'u' + r.uid) === route.key) : null;
  const isNew = !rec;
  setHeader((isNew ? 'New row · ' : 'Row ' + (rec.row || '(not sent)') + ' · ') + t.name, true);
  const ro = t.readOnly || (rec && !rec.row);   // unsent new rows are edited by re-adding
  const fields = d.headers.map((h, i) => {
    if (!h) return '';
    const vals = d.rows.map(r => r.v[i] || '');
    const kind = fieldKind(h, vals);
    const val = rec ? (rec.v[i] || '') : '';
    const id = 'f' + i;
    const dis = ro ? ' disabled' : '';
    if (kind === 'long') return `<label for="${id}">${esc(h)}</label><textarea id="${id}" data-h="${esc(h)}"${dis}>${esc(val)}</textarea>`;
    if (kind === 'date') { const iv = toInputDate(val); return `<label for="${id}">${esc(h)}</label><input id="${id}" data-h="${esc(h)}" data-kind="date" type="${iv || !val ? 'date' : 'text'}" value="${esc(iv || val)}"${dis}>`; }
    const distinct = [...new Set(vals.filter(Boolean))];
    const list = kind === 'text' && distinct.length > 1 && distinct.length <= 40 ? `<datalist id="dl${i}">${distinct.map(v => `<option value="${esc(v)}">`).join('')}</datalist>` : '';
    const type = kind === 'email' ? 'email' : kind === 'tel' ? 'tel' : 'text';
    const im = kind === 'number' ? ' inputmode="decimal"' : '';
    return `<label for="${id}">${esc(h)}</label><input id="${id}" data-h="${esc(h)}" type="${type}"${im} value="${esc(val)}"${list ? ` list="dl${i}"` : ''}${dis}>${list}`;
  }).join('');
  app.innerHTML = `<form class="card" id="form">${fields}
    ${rec && rec.error ? '<div class="err">' + esc(rec.error) + '</div>' : ''}
    <div class="foot">${ro ? '' : `<button class="btn" type="submit">${isNew ? 'Save new row' : 'Save changes'}</button>`}
    <button class="btn ghost" type="button" id="cancel">${ro ? 'Back' : 'Cancel'}</button></div>
    ${ro && rec && !rec.row ? '<p class="meta" style="margin-top:12px">This row is waiting to upload. It can be edited after it reaches the sheet.</p>' : ''}</form>`;
  $('#cancel').onclick = () => back();
  if (ro) return;
  $('#form').onsubmit = ev => {
    ev.preventDefault();
    const values = {};
    app.querySelectorAll('[data-h]').forEach(el => {
      const h = el.dataset.h, i = d.headers.indexOf(h), v = el.value.trim();
      if (isNew) { if (v !== '') values[h] = v; }
      else if (v !== (el.dataset.kind === 'date' ? toInputDate(rec.v[i]) || rec.v[i] : (rec.v[i] || ''))) values[h] = v;
    });
    if (!Object.keys(values).length) { toast(isNew ? 'Fill in at least one field' : 'Nothing changed'); return; }
    const op = { uid: uid(), type: isNew ? 'add' : 'update', tab: route.tab, values, at: new Date().toISOString() };
    if (!isNew) {
      op.row = rec.row;
      const check = {}; const first = d.headers.findIndex(Boolean);
      const base = load(K.rows + route.tab, { rows: [] }).rows.find(r => r._row === rec.row);
      if (base && first >= 0) check[d.headers[first]] = base.v[first];   // make sure the row was not moved by a sort
      op.check = check;
    }
    queue.push(op); store(K.queue, queue);
    toast(navigator.onLine ? 'Saved. Uploading…' : 'Saved on this device. It will upload when online.');
    back(); sync(false);
  };
}

function back() {
  if (route.view === 'form') route = { view: 'tab', tab: route.tab, q: route.q };
  else route = { view: 'home' };
  render(); window.scrollTo(0, 0);
}
$('#back').onclick = back;

function removeFab() { document.querySelectorAll('.fab').forEach(f => f.remove()); }

function signOut() { user = null; try { localStorage.removeItem(K.user); } catch (e) {} route = { view: 'home' }; render(); status(); }

function status() {
  const dot = $('#dot'), txt = $('#syncText');
  const p = load(K.queue, []).length;
  if (!user) { dot.className = 'dot'; txt.textContent = 'Signed out'; return; }
  if (busy) { dot.className = 'dot wait'; txt.textContent = 'Syncing…'; return; }
  if (p) { dot.className = 'dot ' + (online ? 'wait' : 'bad'); txt.textContent = p + ' not sent' + (online ? ' · tap to retry' : ' · offline'); return; }
  const at = load(K.synced, 0);
  dot.className = 'dot ' + (online ? 'ok' : 'bad');
  txt.textContent = online ? 'Up to date' + (at ? ' · ' + new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') : 'Offline · saved on device';
}
$('#sync').onclick = () => sync(false);

let tt;
function toast(m) { let el = document.querySelector('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); } el.textContent = m; clearTimeout(tt); tt = setTimeout(() => el.remove(), 3500); }

addEventListener('online', () => sync(false));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(false); });
setInterval(() => { if (document.visibilityState === 'visible' && queue.length) sync(false); }, 90000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});

render(); status();
if (user) sync(true);
})();
