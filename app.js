import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49/+esm';
import { CONFIG } from './config.js';
import { LINES, LINE, CATALOG, CAT } from './catalog.js';

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

/* ---------------- state ---------------- */
const DEFAULT_SETTINGS = { energyRate: 0.15, otherWastePct: 0, failurePct: 0, laborRate: 0, marginPct: 50, reorderAt: 250, productReorderAt: 3, linePrices: {} };
const COLLAPSE_KEY = 'mostly3d.wall.collapsed';
function loadCollapsed(){ try { const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch (e) { return new Set(); } }
function saveCollapsed(){ try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(state.ui.collapsed))); } catch (e) {} }
const state = {
  session: null, allowed: null, loaded: false,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  spools: {}, products: {}, pf: {}, movements: [], gtin: {}, allowedUsers: [],
  ui: { line: 'all', q: '', rackLine: 'all', lowOnly: false, productQ: '', productFilter: 'all', logKind: 'all', labelKind: 'spools', collapsed: loadCollapsed(), scanMode: 'lookup', recovery: false }
};

/* ---------------- utils ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = n => USD.format(isFinite(n) ? n : 0);
const money4 = n => '$' + (isFinite(n) ? n : 0).toFixed(4);
const grams = n => { n = +n || 0; return (Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n).toString() : n.toFixed(1)) + ' g'; };
const kg = n => (Math.round((+n || 0) / 10) / 100).toFixed(2) + ' kg';
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const code = (prefix) => 'M3D-' + prefix + Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '7');
const dateShort = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const timeShort = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
let toastTimer = null;
function toast(msg, bad){ const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 4200 : 2800); }
function download(filename, text, type){ const blob = new Blob([text], { type: type || 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function setStatus(kind, msg){
  const el = $('#status'), t = $('#statusText');
  el.className = 'status ' + (kind || 'live');
  t.textContent = kind === 'saving' ? 'Saving' : kind === 'error' ? (msg || 'Save failed') : 'Live';
}
function fail(err, what){ console.error(what || 'error', err); setStatus('error', what || 'Save failed'); toast((what || 'Something failed') + (err && err.message ? ': ' + err.message : ''), true); }

/* ---------------- pricing ---------------- */
function linePrice(key){
  const l = LINE[key]; const lp = (state.settings.linePrices || {})[key];
  if (lp && num(lp.cost) > 0) return { cost: num(lp.cost), grams: num(lp.grams) > 0 ? num(lp.grams) : 1000, set: true };
  return { cost: l ? l.price : 0, grams: 1000, set: false };
}
function followsLine(sp){ return !!(sp && !sp.custom_price && LINE[sp.line] && linePrice(sp.line).set); }
function effCost(sp){ if (!sp) return 0; return followsLine(sp) ? linePrice(sp.line).cost : num(sp.cost); }
function effGrams(sp){ if (!sp) return 0; return followsLine(sp) ? linePrice(sp.line).grams : num(sp.grams); }
const ppg = sp => (sp && effGrams(sp) > 0) ? effCost(sp) / effGrams(sp) : 0;
const lineOrder = {}; LINES.forEach((l, i) => lineOrder[l.key] = i);
function sortSpools(list){ return list.slice().sort((a, b) => { const la = lineOrder[a.line] === undefined ? 99 : lineOrder[a.line], lb = lineOrder[b.line] === undefined ? 99 : lineOrder[b.line]; if (la !== lb) return la - lb; return String(a.color).localeCompare(String(b.color)); }); }
function sortProducts(list){ return list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))); }

/* ---------------- stock ---------------- */
function rollsOf(sp){ return Math.max(0, Math.round(num(sp.rolls))); }
function openLeft(sp){ const g = effGrams(sp); if (rollsOf(sp) === 0) return 0; return Math.max(0, Math.min(g, num(sp.open_left))); }
function spoolAvailable(sp){ const q = rollsOf(sp); if (q === 0) return 0; return (q - 1) * effGrams(sp) + openLeft(sp); }
function reorderPoint(sp){ return (sp.reorder_at !== undefined && sp.reorder_at !== null && sp.reorder_at !== '') ? num(sp.reorder_at) : num(state.settings.reorderAt); }
function spoolStatus(sp){ const a = spoolAvailable(sp); if (a <= 0.5) return 'out'; if (a < reorderPoint(sp)) return 'low'; return 'ok'; }
function productMin(p){ return (p.reorder_at !== undefined && p.reorder_at !== null && p.reorder_at !== '') ? num(p.reorder_at) : num(state.settings.productReorderAt); }
function productStatus(p){ const n = num(p.on_hand); if (n <= 0) return 'out'; if (n < productMin(p)) return 'low'; return 'ok'; }
function consume(sp, g){
  let need = Math.max(0, g); const roll = effGrams(sp); let qty = rollsOf(sp); let left = openLeft(sp);
  while (need > 0.0001 && qty > 0) {
    if (need <= left) { left -= need; need = 0; }
    else { need -= left; qty -= 1; left = qty > 0 ? roll : 0; }
  }
  if (qty > 0 && left <= 0.01) { qty -= 1; left = qty > 0 ? roll : 0; }
  sp.rolls = qty; sp.open_left = Math.round(left * 10) / 10; return need;
}
function restock(sp, g){
  const roll = effGrams(sp); let qty = rollsOf(sp); let left = qty > 0 ? openLeft(sp) : 0;
  if (qty === 0) { qty = 1; left = 0; }
  left += g;
  while (left > roll + 0.0001 && roll > 0) { left -= roll; qty += 1; }
  sp.rolls = qty; sp.open_left = Math.round(Math.min(roll, left) * 10) / 10;
}

/* ---------------- product costing ---------------- */
function recipe(p){ return (state.pf[p.id] || []).slice().sort((a, b) => num(a.position) - num(b.position)); }
function productCost(p){
  const S = state.settings; const rec = recipe(p);
  let g = 0, material = 0; const bySpool = {}; const missing = [];
  rec.forEach(r => { const sp = state.spools[r.spool_id]; const gr = num(r.grams); g += gr; if (!sp) { if (gr > 0) missing.push(r); return; } bySpool[sp.id] = (bySpool[sp.id] || 0) + gr; material += gr * ppg(sp); });
  const avg = g > 0 ? material / g : 0;
  const flushG = num(p.flush_g), towerG = num(p.tower_g), otherG = g * num(S.otherWastePct) / 100;
  const waste = (flushG + towerG) * avg + material * num(S.otherWastePct) / 100;
  const energy = num(p.hours_per_unit) * num(S.energyRate);
  const base = material + waste + energy; const failure = base * num(S.failurePct) / 100;
  const labor = num(p.finishing_min) / 60 * num(S.laborRate); const packaging = num(p.packaging);
  const unit = base + failure + labor + packaging;
  const price = num(p.price); const margin = price > 0 ? (price - unit) / price * 100 : null;
  const target = num(S.marginPct); const suggested = (target > 0 && target < 100) ? unit / (1 - target / 100) : 0;
  return { g, material, avg, bySpool, flushG, towerG, otherG, wasteG: flushG + towerG + otherG, waste, energy, failure, labor, packaging, unit, price, margin, suggested, missing, filamentG: g + flushG + towerG + otherG };
}
function spoolPullFor(p, units){
  const c = productCost(p); const pulls = [];
  Object.keys(c.bySpool).forEach(id => { const share = c.g > 0 ? c.bySpool[id] / c.g : 0; pulls.push({ spoolId: id, grams: Math.round((c.bySpool[id] + c.wasteG * share) * units * 10) / 10 }); });
  return { c, pulls };
}

/* ---------------- spool drawing ---------------- */
function spoolSVG(sp, size, cls){
  const f = sp.finish || 'basic';
  const id = 's' + String(sp.key || sp.id || 'x').replace(/[^A-Za-z0-9]/g, '') + size;
  let defs = '', fill = sp.hex || '#999', overlay = '', style = '';
  if (sp.hex2 && f === 'dual') { defs += '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="1" y2="1"><stop offset=".5" stop-color="' + sp.hex + '"/><stop offset=".5" stop-color="' + sp.hex2 + '"/></linearGradient>'; fill = 'url(#' + id + 'g)'; }
  else if (sp.hex2) { defs += '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + sp.hex + '"/>' + (sp.hex3 ? '<stop offset=".5" stop-color="' + sp.hex3 + '"/>' : '') + '<stop offset="1" stop-color="' + sp.hex2 + '"/></linearGradient>'; fill = 'url(#' + id + 'g)'; }
  const matte = f === 'matte' || f === 'wood' || f === 'cf' || f === 'marble';
  if (!matte) defs += '<radialGradient id="' + id + 's" cx=".36" cy=".3" r=".65"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></radialGradient>';
  if (f === 'sparkle' || f === 'galaxy') { const col = f === 'sparkle' ? '#ffffff' : '#dfe9ff'; defs += '<pattern id="' + id + 'p" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r=".75" fill="' + col + '"/><circle cx="5" cy="4.6" r=".5" fill="' + col + '"/></pattern>'; overlay += '<circle cx="50" cy="50" r="44" fill="url(#' + id + 'p)" opacity="' + (f === 'sparkle' ? '.8' : '.55') + '"/>'; }
  if (f === 'marble') overlay += '<g fill="none" stroke="#7a7a7a" stroke-width="1.1"><path d="M20 38 C32 44 40 30 52 40 S70 60 84 54" stroke-opacity=".45"/><path d="M28 70 C40 58 52 72 64 66 S76 76 86 70" stroke-opacity=".35"/></g>';
  if (f === 'wood') overlay += '<g fill="none" stroke="#000" stroke-opacity=".2" stroke-width="1.3"><circle cx="50" cy="50" r="24"/><circle cx="50" cy="50" r="30"/><circle cx="50" cy="50" r="36"/><circle cx="50" cy="50" r="41"/></g>';
  if (f === 'silk' || f === 'metal' || f === 'dual' || f === 'gradient') overlay += '<path d="M19 42 A34 34 0 0 1 58 16" fill="none" stroke="#fff" stroke-opacity="' + (f === 'silk' ? '.7' : '.45') + '" stroke-width="6" stroke-linecap="round"/>';
  if (f === 'glow') style = 'filter:drop-shadow(0 0 ' + Math.max(3, size * 0.09).toFixed(1) + 'px ' + sp.hex + ')';
  const op = f === 'translucent' ? '.72' : '1';
  return '<svg class="spool ' + (cls || '') + '" viewBox="0 0 100 100" width="' + size + '" height="' + size + '" aria-hidden="true" style="' + style + '">' +
    '<defs>' + defs + '</defs>' +
    '<circle cx="50" cy="50" r="49" fill="var(--spool-flange)"/>' +
    '<circle cx="50" cy="50" r="44" fill="' + fill + '" fill-opacity="' + op + '"/>' +
    (matte ? '' : '<circle cx="50" cy="50" r="44" fill="url(#' + id + 's)"/>') +
    '<g fill="none" stroke="#000" stroke-opacity=".1" stroke-width=".8"><circle cx="50" cy="50" r="22"/><circle cx="50" cy="50" r="27"/><circle cx="50" cy="50" r="32"/><circle cx="50" cy="50" r="37"/><circle cx="50" cy="50" r="42"/></g>' +
    overlay +
    '<circle cx="50" cy="50" r="18" fill="var(--spool-hub)"/><circle cx="50" cy="50" r="9" fill="var(--spool-hole)"/>' +
    '</svg>';
}
function dotHTML(sp, small){
  if (!sp) return '<span class="dot missing' + (small ? ' sm' : '') + '" title="Spool not on rack"></span>';
  const bg = sp.hex2 ? (sp.finish === 'dual' ? 'linear-gradient(135deg,' + sp.hex + ' 50%,' + sp.hex2 + ' 50%)' : 'linear-gradient(135deg,' + sp.hex + ',' + sp.hex2 + ')') : sp.hex;
  return '<span class="dot' + (small ? ' sm' : '') + '" style="background:' + bg + '" title="' + esc(sp.color) + '"></span>';
}
function photoUrl(p){ if (!p || !p.photo_path) return ''; return sb.storage.from(CONFIG.photoBucket).getPublicUrl(p.photo_path).data.publicUrl; }

/* ---------------- data ---------------- */
async function loadAll(){
  const startedAt = Date.now();
  const [s, sp, pr, pf, mv, gt, au] = await Promise.all([
    sb.from('shop_settings').select('data').eq('id', 1).maybeSingle(),
    sb.from('spools').select('*'),
    sb.from('products').select('*'),
    sb.from('product_filaments').select('*'),
    sb.from('movements').select('*').order('created_at', { ascending: false }).limit(400),
    sb.from('gtin_map').select('*'),
    sb.from('allowed_users').select('*').order('email')
  ]);
  const firstErr = [s, sp, pr, pf, mv, gt, au].find(r => r.error);
  if (firstErr) throw firstErr.error;
  if (lastLocalWrite > startedAt || pendingWrites > 0) { scheduleReload(); return false; } // a write landed meanwhile; this snapshot is stale
  if (!settingsDirty) { state.settings = Object.assign({}, DEFAULT_SETTINGS, (s.data && s.data.data) || {}); if (!state.settings.linePrices) state.settings.linePrices = {}; }
  state.spools = {}; (sp.data || []).forEach(r => state.spools[r.id] = r);
  state.products = {}; (pr.data || []).forEach(r => state.products[r.id] = r);
  state.pf = {}; (pf.data || []).forEach(r => { (state.pf[r.product_id] = state.pf[r.product_id] || []).push(r); });
  state.movements = mv.data || [];
  state.gtin = {}; (gt.data || []).forEach(r => state.gtin[r.gtin] = r.cat_key);
  state.allowedUsers = (au.data || []).map(r => r.email);
  state.loaded = true; return true;
}
let reloadTimer = null, lastLocalWrite = 0, pendingWrites = 0, reloading = false;
function scheduleReload(){ clearTimeout(reloadTimer); reloadTimer = setTimeout(async () => { if (reloading || pendingWrites > 0 || Date.now() - lastLocalWrite < 1200 || !$('#modal').hidden) { scheduleReload(); return; } reloading = true; try { if (await loadAll()) renderAll(); } catch (e) { console.warn('reload', e); } reloading = false; }, 500); }
let channel = null;
function subscribe(){
  if (channel) return;
  channel = sb.channel('shop-changes').on('postgres_changes', { event: '*', schema: 'public' }, () => scheduleReload()).subscribe();
}
async function dbWrite(fn, what){
  setStatus('saving'); lastLocalWrite = Date.now(); pendingWrites++;
  try { const r = await fn(); if (r && r.error) throw r.error; lastLocalWrite = Date.now(); setStatus('live'); return r; }
  catch (e) { fail(e, what); throw e; }
  finally { pendingWrites--; }
}
async function saveSpool(sp){
  const row = Object.assign({}, sp); delete row.created_at; delete row.updated_at;
  const r = await dbWrite(() => sb.from('spools').upsert(row).select().single(), 'Could not save the spool');
  state.spools[r.data.id] = r.data; return r.data;
}
async function deleteSpool(id){ await dbWrite(() => sb.from('spools').delete().eq('id', id), 'Could not remove the spool'); delete state.spools[id]; }
async function saveProduct(p){
  const row = Object.assign({}, p); delete row.created_at; delete row.updated_at;
  const r = await dbWrite(() => sb.from('products').upsert(row).select().single(), 'Could not save the product');
  state.products[r.data.id] = r.data; return r.data;
}
async function deleteProduct(id){
  const p = state.products[id];
  await dbWrite(() => sb.from('products').delete().eq('id', id), 'Could not delete the product'); delete state.products[id]; delete state.pf[id];
  if (p && p.photo_path) removePhotos([p.photo_path]);
}
async function removePhotos(paths){ try { await sb.storage.from(CONFIG.photoBucket).remove(paths.filter(Boolean)); } catch (e) { console.warn('photo cleanup', e); } }
async function saveRecipe(productId, rows){
  await dbWrite(() => sb.from('product_filaments').delete().eq('product_id', productId), 'Could not save the filaments');
  const clean = rows.filter(r => r.spool_id || num(r.grams) > 0).map((r, i) => ({ product_id: productId, spool_id: r.spool_id || null, grams: num(r.grams), position: i }));
  if (clean.length) { const r = await dbWrite(() => sb.from('product_filaments').insert(clean).select(), 'Could not save the filaments'); state.pf[productId] = r.data; } else state.pf[productId] = [];
}
async function addMovement(m){
  const row = Object.assign({ actor: state.session && state.session.user ? state.session.user.email : null }, m);
  const r = await dbWrite(() => sb.from('movements').insert(row).select().single(), 'Could not log the movement');
  state.movements.unshift(r.data); return r.data;
}
async function deleteMovement(id){ await dbWrite(() => sb.from('movements').delete().eq('id', id), 'Could not remove the entry'); state.movements = state.movements.filter(m => m.id !== id); }
let settingsTimer = null, settingsDirty = false;
function saveSettingsSoon(){ clearTimeout(settingsTimer); settingsDirty = true; setStatus('saving'); settingsTimer = setTimeout(async () => { try { await dbWrite(() => sb.from('shop_settings').upsert({ id: 1, data: state.settings }), 'Could not save settings'); settingsDirty = false; } catch (e) {} }, 600); }

/* ---------------- stock actions ---------------- */
async function receiveSpool(sp, n, note){
  n = Math.max(1, Math.round(n)); const had = rollsOf(sp);
  sp.rolls = had + n; if (had === 0) sp.open_left = effGrams(sp);
  await saveSpool(sp);
  await addMovement({ kind: 'receive', spool_id: sp.id, qty: n, grams: n * effGrams(sp), cost: Math.round(n * effCost(sp) * 100) / 100, note: note || null });
}
async function makeProduct(p, units, note){
  units = Math.max(1, Math.round(units));
  const { c, pulls } = spoolPullFor(p, units); const by = []; const shorts = [];
  for (const pull of pulls) { const sp = state.spools[pull.spoolId]; if (!sp) continue; const rem = consume(sp, pull.grams); await saveSpool(sp); by.push({ spoolId: sp.id, color: sp.color, lineName: sp.line_name || '', grams: pull.grams, used: Math.round((pull.grams - rem) * 10) / 10 }); if (rem > 0.5) shorts.push(sp.color + ' short ' + grams(rem)); }
  p.on_hand = num(p.on_hand) + units; await saveProduct(p);
  await addMovement({ kind: 'made', product_id: p.id, qty: units, grams: Math.round(c.filamentG * units * 10) / 10, cost: Math.round(c.unit * units * 100) / 100, note: note || null, detail: { by, unit: c.unit, hours: num(p.hours_per_unit) * units, short: shorts.join(', ') || null } });
  return { c, shorts };
}
async function sellProduct(p, units, note){
  units = Math.max(1, Math.round(units)); const c = productCost(p);
  p.on_hand = Math.max(0, num(p.on_hand) - units); await saveProduct(p);
  await addMovement({ kind: 'sold', product_id: p.id, qty: units, grams: 0, cost: Math.round(c.unit * units * 100) / 100, note: note || null, detail: { unit: c.unit, price: num(p.price), revenue: Math.round(num(p.price) * units * 100) / 100 } });
}
async function adjustProduct(p, newQty, note){
  const from = num(p.on_hand); newQty = Math.max(0, Math.round(newQty)); if (newQty === from) return;
  p.on_hand = newQty; await saveProduct(p);
  await addMovement({ kind: 'adjust', product_id: p.id, qty: newQty - from, grams: 0, cost: 0, note: note || null, detail: { from, to: newQty } });
}
async function undoMovement(m){
  if (m.kind === 'made') { const p = state.products[m.product_id]; ((m.detail && m.detail.by) || []).forEach(b => { const sp = state.spools[b.spoolId]; const g = b.used !== undefined ? num(b.used) : num(b.grams); if (sp && g > 0) restock(sp, g); }); for (const b of ((m.detail && m.detail.by) || [])) { const sp = state.spools[b.spoolId]; if (sp) await saveSpool(sp); } if (p) { p.on_hand = Math.max(0, num(p.on_hand) - num(m.qty)); await saveProduct(p); } }
  else if (m.kind === 'sold') { const p = state.products[m.product_id]; if (p) { p.on_hand = num(p.on_hand) + num(m.qty); await saveProduct(p); } }
  else if (m.kind === 'receive') { const sp = state.spools[m.spool_id]; if (sp) { sp.rolls = Math.max(0, rollsOf(sp) - Math.round(num(m.qty))); if (sp.rolls === 0) sp.open_left = 0; await saveSpool(sp); } }
  else if (m.kind === 'adjust') { if (m.product_id) { const p = state.products[m.product_id]; if (p && m.detail) { p.on_hand = num(m.detail.from); await saveProduct(p); } } else if (m.spool_id) { const sp = state.spools[m.spool_id]; if (sp && m.detail && m.detail.from) { sp.rolls = num(m.detail.from.rolls); sp.open_left = num(m.detail.from.open_left); await saveSpool(sp); } } }
  else { toast('That entry cannot be undone'); return; }
  await deleteMovement(m.id);
}

/* ---------------- render: products ---------------- */
function renderProducts(){
  const all = sortProducts(Object.values(state.products).filter(p => !p.archived));
  let units = 0, costValue = 0, retail = 0, low = 0;
  all.forEach(p => { const c = productCost(p); const n = num(p.on_hand); units += n; costValue += n * c.unit; retail += n * num(p.price); if (productStatus(p) !== 'ok') low++; });
  $('#productTiles').innerHTML =
    '<div class="tile-num"><span class="tl">Products</span><span class="tv">' + all.length + '</span><span class="ts">in the catalog</span></div>' +
    '<div class="tile-num"><span class="tl">On the shelf</span><span class="tv">' + units + '</span><span class="ts">finished units</span></div>' +
    '<div class="tile-num"><span class="tl">At cost</span><span class="tv">' + money(costValue) + '</span><span class="ts">what the shelf cost to make</span></div>' +
    '<div class="tile-num accent"><span class="tl">At retail</span><span class="tv">' + money(retail) + '</span><span class="ts">if it all sells at list</span></div>' +
    '<div class="tile-num' + (low ? ' alert' : '') + '"><span class="tl">Low or out</span><span class="tv">' + low + '</span><span class="ts">' + (low ? 'below shelf minimum' : 'all stocked') + '</span></div>';
  const nl = $('#navProductsLow'); nl.hidden = !low; nl.textContent = low;
  const anyEx = Object.values(state.products).some(p => p.example) || Object.values(state.spools).some(s => s.example);
  $('#btnRemoveExamples').hidden = !anyEx;
  $('#productChips').innerHTML = ['all', 'low', 'archived'].map(k => '<button class="chip' + (state.ui.productFilter === k ? ' on' : '') + (k === 'low' ? ' red' : '') + '" data-action="product-filter" data-k="' + k + '">' + (k === 'all' ? 'All' : k === 'low' ? 'Low & out only' : 'Archived') + '</button>').join('');
  const q = state.ui.productQ.trim().toLowerCase();
  let list = state.ui.productFilter === 'archived' ? sortProducts(Object.values(state.products).filter(p => p.archived)) : all;
  if (state.ui.productFilter === 'low') list = list.filter(p => productStatus(p) !== 'ok');
  if (q) list = list.filter(p => ((p.name || '') + ' ' + (p.sku || '') + ' ' + (p.barcode || '') + ' ' + (p.description || '')).toLowerCase().indexOf(q) >= 0);
  let html = list.map(p => {
    const c = productCost(p); const st = productStatus(p); const url = photoUrl(p); const rec = recipe(p);
    return '<button class="pcard' + (p.example ? ' ex' : '') + '" data-action="product-open" data-id="' + esc(p.id) + '">' +
      '<div class="photo">' + (url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : '<span class="ph">no photo yet</span>') +
      '<span class="stock' + (st !== 'ok' ? ' low' : '') + '">' + num(p.on_hand) + (st === 'out' ? ' · out' : st === 'low' ? ' · low' : '') + '</span>' +
      '<span class="dots">' + rec.map(r => dotHTML(state.spools[r.spool_id], true)).join('') + '</span></div>' +
      '<div class="body"><div class="pn">' + esc(p.name || 'Unnamed product') + (p.archived ? ' <span class="badge-ex">archived</span>' : '') + '</div><div class="sku">' + esc(p.sku || p.barcode || '') + (p.example ? ' · example' : '') + '</div>' +
      '<div class="nums"><span>cost <b>' + money(c.unit) + '</b></span><span>' + (num(p.price) > 0 ? 'sells <b>' + money(num(p.price)) + '</b>' : 'no price') + '</span>' + (c.margin !== null ? '<span class="m">' + Math.round(c.margin) + '%</span>' : '') + '</div></div></button>';
  }).join('');
  if (!list.length) html = '<div class="empty">' + (state.ui.productFilter === 'archived' ? 'Nothing archived.' : q ? 'No products match that search.' : 'No products yet. Add one, give it a photo and its filaments, and the cost works itself out.') + '</div>';
  $('#productGrid').innerHTML = html;
}

/* ---------------- render: rack ---------------- */
function renderRack(){
  const all = sortSpools(Object.values(state.spools));
  let rolls = 0, onHand = 0, value = 0, lowCount = 0;
  all.forEach(sp => { rolls += rollsOf(sp); const a = spoolAvailable(sp); onHand += a; value += a * ppg(sp); if (spoolStatus(sp) !== 'ok') lowCount++; });
  $('#rackTiles').innerHTML =
    '<div class="tile-num"><span class="tl">Colors</span><span class="tv">' + all.length + '</span><span class="ts">on the rack</span></div>' +
    '<div class="tile-num"><span class="tl">Rolls</span><span class="tv">' + rolls + '</span><span class="ts">on hand, open roll included</span></div>' +
    '<div class="tile-num"><span class="tl">Filament</span><span class="tv">' + kg(onHand) + '</span><span class="ts">on hand</span></div>' +
    '<div class="tile-num"><span class="tl">Value</span><span class="tv">' + money(value) + '</span><span class="ts">at your prices</span></div>' +
    '<div class="tile-num' + (lowCount ? ' alert' : '') + '"><span class="tl">Low or out</span><span class="tv">' + lowCount + '</span><span class="ts">' + (lowCount ? 'see the reorder list' : 'all stocked') + '</span></div>';
  const nl = $('#navLow'); nl.hidden = !lowCount; nl.textContent = lowCount;
  const present = []; all.forEach(sp => { if (present.indexOf(sp.line) < 0) present.push(sp.line); });
  $('#rackChips').innerHTML = '<button class="chip' + (state.ui.rackLine === 'all' ? ' on' : '') + '" data-action="rack-line" data-line="all">All</button>' +
    present.map(k => '<button class="chip' + (state.ui.rackLine === k ? ' on' : '') + '" data-action="rack-line" data-line="' + esc(k) + '">' + esc(LINE[k] ? LINE[k].short : 'Other') + '</button>').join('') +
    '<button class="chip red' + (state.ui.lowOnly ? ' on' : '') + '" data-action="rack-low">Low &amp; out only</button>';
  const spools = all.filter(sp => (state.ui.rackLine === 'all' || sp.line === state.ui.rackLine) && (!state.ui.lowOnly || spoolStatus(sp) !== 'ok'));
  let html = spools.map(sp => {
    const st = spoolStatus(sp); const q = rollsOf(sp); const left = openLeft(sp); const roll = effGrams(sp); const pct = roll > 0 ? Math.max(0, Math.min(100, left / roll * 100)) : 0;
    return '<button class="shelf-item ' + st + '" data-action="spool-edit" data-id="' + esc(sp.id) + '" title="Edit ' + esc(sp.color) + '">' +
      (st !== 'ok' ? '<span class="flag">' + st + '</span>' : '') + (sp.example ? '<span class="ex">example</span>' : '') +
      '<span class="nm">' + esc(sp.color) + '</span><span class="meta">' + esc(sp.line_name || '') + ' · ' + money4(ppg(sp)) + '/g' + (sp.location ? ' · ' + esc(sp.location) : '') + '</span>' +
      '<span class="stock">' + (q === 0 ? 'none on hand' : grams(spoolAvailable(sp)) + ' on hand') + '</span>' +
      '<span class="meter"><i style="width:' + pct.toFixed(0) + '%"></i></span>' +
      spoolSVG(sp, 72) + (q > 1 ? '<span class="rolls">×' + q + '</span>' : '') + '</button>';
  }).join('');
  if (!spools.length) html += '<div class="empty"><span>' + (all.length ? 'Nothing matches that filter.' : 'Nothing on the rack yet. Tap a spool on the color wall to add it with its price and roll size.') + '</span></div>';
  $('#shelves').innerHTML = html;
}

/* ---------------- render: wall ---------------- */
function renderChips(){
  const all = [{ key: 'all', short: 'All lines' }].concat(LINES);
  $('#lineChips').innerHTML = all.map(l => '<button class="chip' + (state.ui.line === l.key ? ' on' : '') + '" data-action="line" data-line="' + l.key + '">' + esc(l.short) + '</button>').join('');
}
function renderWall(){
  const q = state.ui.q.trim().toLowerCase();
  const onRack = {}; Object.values(state.spools).forEach(sp => { if (sp.cat_key) onRack[sp.cat_key] = rollsOf(sp); });
  const groups = LINES.filter(l => state.ui.line === 'all' || state.ui.line === l.key).map(line => {
    const list = CATALOG.filter(c => c.line === line.key && (!q || (c.color + ' ' + line.name).toLowerCase().indexOf(q) >= 0));
    if (!list.length) return '';
    const lp = linePrice(line.key); const racked = list.filter(c => onRack[c.key] !== undefined).length; const collapsed = !q && state.ui.collapsed.has(line.key);
    return '<div class="wall-group' + (collapsed ? ' collapsed' : '') + '"><div class="wall-group-head">' +
      '<button class="wg-toggle" data-action="wall-toggle" data-line="' + line.key + '" aria-expanded="' + (collapsed ? 'false' : 'true') + '"><span class="chev"></span><h3>' + esc(line.name) + '</h3><span class="wg-count">' + list.length + ' color' + (list.length === 1 ? '' : 's') + (racked ? ' · ' + racked + ' on rack' : '') + '</span></button>' +
      '<div class="wg-price"><span class="lp-tag' + (lp.set ? ' yours' : '') + '">' + (lp.set ? 'your price' : 'list price') + '</span>' +
      '<label><span>$</span><input type="number" inputmode="decimal" step="0.01" min="0" data-lineprice="' + line.key + '" data-field="cost" value="' + lp.cost + '" aria-label="' + esc(line.name) + ' price per roll"></label><span>per</span>' +
      '<label><input type="number" inputmode="decimal" step="1" min="1" data-lineprice="' + line.key + '" data-field="grams" value="' + lp.grams + '" aria-label="' + esc(line.name) + ' roll size in grams"><span>g</span></label></div></div>' +
      (collapsed ? '' : '<div class="wall">' +
      list.map(c => '<button class="tile" data-action="pick" data-key="' + esc(c.key) + '" title="' + esc(c.color) + (c.hex2 ? ' ' + c.hex + ' / ' + c.hex2 : ' ' + c.hex) + (c.approx ? ' (approximate)' : '') + '">' +
        spoolSVG(c, 64) + '<span class="tname">' + esc(c.color) + '</span><span class="thex">' + (c.approx ? '≈ ' : '') + esc(c.hex2 ? c.hex + ' / ' + c.hex2 : c.hex) + '</span>' +
        (onRack[c.key] !== undefined ? '<span class="onrack">' + (onRack[c.key] > 0 ? 'on rack' + (onRack[c.key] > 1 ? ' ×' + onRack[c.key] : '') : 'out') + '</span>' : '') + '</button>').join('') + '</div>') + '</div>';
  }).join('');
  $('#wallGroups').innerHTML = groups || '<p class="fine">No colors match that search.</p>';
}

/* ---------------- render: log ---------------- */
const KIND_LABEL = { receive: 'Received', made: 'Made', sold: 'Sold', adjust: 'Adjusted', consume: 'Used', undo: 'Undo' };
function renderLog(){
  const now = new Date(); const m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let made = 0, sold = 0, revenue = 0, cogs = 0, filament = 0;
  state.movements.forEach(m => { if (new Date(m.created_at).getTime() < m0) return; if (m.kind === 'made') { made += num(m.qty); filament += num(m.grams); } if (m.kind === 'sold') { sold += num(m.qty); cogs += num(m.cost); revenue += num(m.detail && m.detail.revenue); } });
  const monthName = now.toLocaleDateString('en-US', { month: 'long' });
  $('#logTiles').innerHTML =
    '<div class="tile-num"><span class="tl">' + esc(monthName) + '</span><span class="tv">' + made + '</span><span class="ts">units made</span></div>' +
    '<div class="tile-num"><span class="tl">Filament</span><span class="tv">' + kg(filament) + '</span><span class="ts">used making them</span></div>' +
    '<div class="tile-num"><span class="tl">Sold</span><span class="tv">' + sold + '</span><span class="ts">units this month</span></div>' +
    '<div class="tile-num accent"><span class="tl">Sales</span><span class="tv">' + money(revenue) + '</span><span class="ts">at list price</span></div>' +
    '<div class="tile-num"><span class="tl">Gross profit</span><span class="tv">' + money(revenue - cogs) + '</span><span class="ts">sales minus cost of goods</span></div>';
  $('#logChips').innerHTML = ['all', 'made', 'sold', 'receive', 'adjust'].map(k => '<button class="chip' + (state.ui.logKind === k ? ' on' : '') + '" data-action="log-kind" data-k="' + k + '">' + (k === 'all' ? 'All' : KIND_LABEL[k]) + '</button>').join('');
  const list = state.movements.filter(m => state.ui.logKind === 'all' || m.kind === state.ui.logKind);
  if (!list.length) { $('#logList').innerHTML = '<div class="empty">Nothing here yet. Receive a roll, make something, or sell something and it lands here.</div>'; return; }
  $('#logList').innerHTML = '<table class="list"><tr><th>When</th><th>What</th><th class="n">Qty</th><th class="n">Filament</th><th class="n">Cost</th><th></th></tr>' +
    list.map(m => {
      const p = m.product_id ? state.products[m.product_id] : null; const sp = m.spool_id ? state.spools[m.spool_id] : null;
      const what = p ? esc(p.name) : sp ? esc(sp.color) + ' · ' + esc(sp.line_name || '') : (m.detail && m.detail.name ? esc(m.detail.name) : '(removed)');
      let sub = '';
      if (m.kind === 'made' && m.detail && m.detail.by) sub = m.detail.by.map(b => esc(b.color) + ' ' + grams(b.grams)).join(', ') + (m.detail.short ? ' · <b style="color:var(--red)">' + esc(m.detail.short) + '</b>' : '');
      if (m.kind === 'sold' && m.detail) sub = (m.detail.revenue ? money(num(m.detail.revenue)) + ' in sales' : 'no price set');
      if (m.kind === 'adjust' && m.detail && m.detail.from !== undefined && typeof m.detail.from !== 'object') sub = m.detail.from + ' → ' + m.detail.to;
      if (m.note) sub += (sub ? ' · ' : '') + esc(m.note);
      if (m.actor) sub += (sub ? ' · ' : '') + esc(String(m.actor).split('@')[0]);
      const qty = m.kind === 'receive' ? '+' + num(m.qty) + ' roll' + (num(m.qty) === 1 ? '' : 's') : m.kind === 'sold' ? '−' + num(m.qty) : m.kind === 'made' ? '+' + num(m.qty) : (num(m.qty) > 0 ? '+' : '') + num(m.qty);
      return '<tr><td>' + esc(dateShort(m.created_at)) + '<span class="sub">' + esc(timeShort(m.created_at)) + '</span></td><td><span class="tag ' + (m.kind === 'sold' ? '' : 'ok') + '">' + (KIND_LABEL[m.kind] || m.kind) + '</span> ' + what + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</td>' +
        '<td class="n">' + qty + '</td><td class="n">' + (num(m.grams) ? grams(num(m.grams)) : '') + '</td><td class="n">' + (num(m.cost) ? money(num(m.cost)) : '') + '</td><td class="n">' + (['made', 'sold', 'receive', 'adjust'].indexOf(m.kind) >= 0 ? '<button class="btn ghost small" data-action="log-undo" data-id="' + esc(m.id) + '">Undo</button>' : '') + '</td></tr>';
    }).join('') + '</table>';
}
const csvq = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
function logCSV(){
  const rows = [['when', 'kind', 'item', 'qty', 'grams', 'cost', 'revenue', 'detail', 'note', 'by']];
  state.movements.slice().reverse().forEach(m => { const p = m.product_id ? state.products[m.product_id] : null; const sp = m.spool_id ? state.spools[m.spool_id] : null; rows.push([m.created_at, m.kind, p ? p.name : sp ? sp.color + ' ' + (sp.line_name || '') : '', num(m.qty), num(m.grams), num(m.cost), m.detail && m.detail.revenue ? num(m.detail.revenue) : '', m.detail && m.detail.by ? m.detail.by.map(b => b.color + ' ' + b.grams + 'g').join('; ') : '', m.note || '', m.actor || '']); });
  return rows.map(r => r.map(csvq).join(',')).join('\n');
}

/* ---------------- render: reorder ---------------- */
function reorderRows(){
  const spools = sortSpools(Object.values(state.spools)).filter(sp => spoolStatus(sp) !== 'ok').map(sp => ({ kind: 'spool', sp, status: spoolStatus(sp), avail: spoolAvailable(sp), at: reorderPoint(sp), cost: effCost(sp) }));
  const products = sortProducts(Object.values(state.products).filter(p => !p.archived && productStatus(p) !== 'ok')).map(p => ({ kind: 'product', p, status: productStatus(p), have: num(p.on_hand), at: productMin(p), need: Math.max(0, productMin(p) - num(p.on_hand)), cost: productCost(p).unit }));
  return { spools, products };
}
function renderReorder(){
  const r = reorderRows(); const nr = $('#navReorder'); nr.hidden = !(r.spools.length + r.products.length); nr.textContent = r.spools.length + r.products.length;
  if (!r.spools.length && !r.products.length) { $('#reorderList').innerHTML = '<div class="empty">Every spool is above its reorder point and every product is above its shelf minimum.</div>'; return; }
  let html = '';
  if (r.spools.length) html += '<table class="list"><tr><th>Filament to buy</th><th></th><th class="n">On hand</th><th class="n">Reorder below</th><th class="n">One roll</th></tr>' + r.spools.map(x => '<tr><td>' + dotHTML(x.sp) + ' ' + esc(x.sp.color) + '<span class="sub">' + esc(x.sp.line_name || '') + (x.sp.location ? ' · ' + esc(x.sp.location) : '') + '</span></td><td><span class="tag">' + x.status + '</span></td><td class="n">' + grams(x.avail) + '</td><td class="n">' + grams(x.at) + '</td><td class="n">' + money(x.cost) + '</td></tr>').join('') + '<tr class="total"><td colspan="4">' + r.spools.length + ' spool' + (r.spools.length === 1 ? '' : 's') + ', one roll each</td><td class="n">' + money(r.spools.reduce((a, x) => a + x.cost, 0)) + '</td></tr></table>';
  if (r.products.length) html += '<table class="list" style="margin-top:18px"><tr><th>Products to make</th><th></th><th class="n">On shelf</th><th class="n">Minimum</th><th class="n">To make</th><th class="n">Filament cost</th></tr>' + r.products.map(x => '<tr><td>' + esc(x.p.name) + '<span class="sub">' + esc(x.p.sku || '') + '</span></td><td><span class="tag">' + x.status + '</span></td><td class="n">' + x.have + '</td><td class="n">' + x.at + '</td><td class="n">' + x.need + '</td><td class="n">' + money(x.need * x.cost) + '</td></tr>').join('') + '</table>';
  $('#reorderList').innerHTML = html;
}
function reorderText(){
  const r = reorderRows(); const L = ['MOSTLY 3D · REORDER · ' + new Date().toLocaleDateString('en-US')];
  if (r.spools.length) { L.push('FILAMENT'); r.spools.forEach(x => L.push('  ' + x.sp.color + ' · ' + (x.sp.line_name || '') + '  (' + x.status + ', ' + grams(x.avail) + ' on hand)  ' + money(x.cost) + ' a roll')); }
  if (r.products.length) { L.push('MAKE'); r.products.forEach(x => L.push('  ' + x.need + ' × ' + x.p.name + '  (' + x.have + ' on shelf, minimum ' + x.at + ')')); }
  if (!r.spools.length && !r.products.length) L.push('  Nothing to reorder.');
  return L.join('\n');
}

/* ---------------- render: labels ---------------- */
function renderLabels(){
  $('#labelChips').innerHTML = ['spools', 'products'].map(k => '<button class="chip' + (state.ui.labelKind === k ? ' on' : '') + '" data-action="label-kind" data-k="' + k + '">' + (k === 'spools' ? 'Spools' : 'Products') + '</button>').join('');
  let items = state.ui.labelKind === 'spools' ? sortSpools(Object.values(state.spools)).map(sp => ({ id: sp.id, code: sp.barcode, name: sp.color, sub: sp.line_name || '' })) : sortProducts(Object.values(state.products).filter(p => !p.archived)).map(p => ({ id: p.id, code: p.barcode || p.sku, name: p.name, sub: p.sku || '' }));
  items = items.filter(i => i.code);
  if (!items.length) { $('#labelGrid').innerHTML = '<div class="empty">Nothing to label yet.</div>'; return; }
  $('#labelGrid').innerHTML = items.map(i => '<div class="label"><div class="ln">' + esc(i.name) + '</div><div class="ls">' + esc(i.sub) + '</div><svg class="bc" data-code="' + esc(i.code) + '"></svg></div>').join('');
  if (window.JsBarcode) document.querySelectorAll('#labelGrid svg.bc').forEach(el => { try { window.JsBarcode(el, el.dataset.code, { format: 'CODE128', width: 1.6, height: 44, fontSize: 12, margin: 4, displayValue: true }); } catch (e) {} });
  else $('#labelGrid').insertAdjacentHTML('afterbegin', '<p class="fine" style="grid-column:1/-1">Barcode drawing is still loading; reload if the bars do not appear.</p>');
}

/* ---------------- render: settings ---------------- */
function renderSettings(){
  const S = state.settings;
  const f = (k, label, step, hint) => '<div class="field"><label for="st_' + k + '">' + label + '</label><input id="st_' + k + '" type="number" inputmode="decimal" step="' + step + '" min="0" data-setting="' + k + '" value="' + (S[k] === 0 ? '0' : (S[k] === undefined || S[k] === null ? '' : S[k])) + '">' + (hint ? '<small>' + hint + '</small>' : '') + '</div>';
  $('#settingsBox').innerHTML = '<div class="card"><div class="shead">Shop assumptions<small>Apply to every product and every spool.</small></div>' +
    f('energyRate', 'Energy ($ per hour)', '0.01', 'Power, wear, consumables') +
    f('otherWastePct', 'Other waste (%)', '0.5', 'Skirts, supports, failed starts') +
    f('failurePct', 'Reprint allowance (%)', '0.5', 'Expected failed plates') +
    f('laborRate', 'Finishing rate ($ per hour)', '0.5', 'What your time costs') +
    f('marginPct', 'Target margin (%)', '1', 'Drives the suggested price') +
    f('reorderAt', 'Spool reorder below (g)', '10', 'Default per spool, overridable') +
    f('productReorderAt', 'Product shelf minimum', '1', 'Default per product, overridable') +
    '</div>';
  const me = state.session && state.session.user ? state.session.user.email : '';
  $('#allowedBox').innerHTML = '<div class="shead" style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:600;color:var(--ink-2)">Who can sign in<small style="display:block;font-weight:400;letter-spacing:0;text-transform:none;color:var(--ink-3);font-size:12px;margin-top:2px">Anyone can create an account, but only these emails can see or change the shop.</small></div>' +
    '<ul>' + state.allowedUsers.map(e => '<li><span>' + esc(e) + (e === me ? ' <span class="badge-ex">you</span>' : '') + '</span>' + (e === me ? '' : '<button class="btn ghost small" data-action="allowed-remove" data-email="' + esc(e) + '">Remove</button>') + '</li>').join('') + '</ul>' +
    '<form class="row" id="allowedForm"><input id="allowedEmail" type="email" placeholder="email to allow" required><button class="btn small" type="submit">Allow</button></form>' +
    '<div class="shead" style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:600;color:var(--ink-2);margin-top:22px">Your password<small style="display:block;font-weight:400;letter-spacing:0;text-transform:none;color:var(--ink-3);font-size:12px;margin-top:2px">Signed in as ' + esc(me) + '. Change it here; no email needed.</small></div>' +
    '<form class="row" id="passForm" autocomplete="off"><input id="passNew" type="password" placeholder="new password (8+ characters)" autocomplete="new-password" minlength="8" required><input id="passAgain" type="password" placeholder="again" autocomplete="new-password" minlength="8" required><button class="btn small" type="submit">Change</button></form>';
}

function renderAll(){
  // Remember which input had focus so a background refresh does not steal it mid-typing.
  const ae = document.activeElement; let find = null, sel = null;
  if (ae && ae.tagName === 'INPUT') { try { sel = ae.selectionStart; } catch (e) {} if (ae.dataset.setting) find = '[data-setting="' + ae.dataset.setting + '"]'; else if (ae.dataset.lineprice) find = '[data-lineprice="' + ae.dataset.lineprice + '"][data-field="' + ae.dataset.field + '"]'; }
  renderProducts(); renderRack(); renderChips(); renderWall(); renderLog(); renderReorder(); renderLabels(); renderSettings(); renderScanModes();
  if (find) { const el = document.querySelector(find); if (el) { el.focus(); try { if (sel !== null) el.setSelectionRange(sel, sel); } catch (e) {} } }
}

/* ---------------- modals ---------------- */
function openModal(html, wide){ const m = $('#modal'); m.innerHTML = '<div class="box' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div>'; m.hidden = false; }
function closeModal(){ const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
function fld(id, label, type, value, extra){ return '<div class="field' + (extra && extra.wide ? ' wide' : '') + '"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type + '"' + (type === 'number' ? ' inputmode="decimal" step="any" min="0"' : '') + ' value="' + esc(value) + '"' + (extra && extra.placeholder ? ' placeholder="' + esc(extra.placeholder) + '"' : '') + '>' + (extra && extra.hint ? '<small>' + extra.hint + '</small>' : '') + '</div>'; }

function openAddModal(key, prefill){
  const c = CAT[key]; if (!c) return; const line = LINE[c.line]; const lp = linePrice(c.line);
  const existing = Object.values(state.spools).find(sp => sp.cat_key === key);
  openModal('<div class="mh">' + spoolSVG(c, 84) + '<div><h3>' + esc(c.color) + '</h3><div class="sub">' + esc(line.name) + ' · ' + esc(c.hex2 ? c.hex + ' / ' + c.hex2 : c.hex) + (c.approx ? ' (approx.)' : '') + '</div></div></div>' +
    '<div class="fields">' + fld('m_cost', 'Roll cost ($)', 'number', existing ? effCost(existing) : lp.cost) + fld('m_grams', 'Roll size (g)', 'number', existing ? effGrams(existing) : lp.grams) + fld('m_qty', 'Rolls to add', 'number', (prefill && prefill.qty) || 1) + fld('m_loc', 'Location', 'text', existing ? (existing.location || '') : '', { placeholder: 'Shelf, bin, dry box' }) + '</div>' +
    (existing ? '<p class="note">Already on your rack with ' + rollsOf(existing) + ' roll' + (rollsOf(existing) === 1 ? '' : 's') + '. Adding receives more rolls.</p>' : '') +
    (lp.set ? '<p class="note">Your ' + esc(line.name) + ' price is ' + money(lp.cost) + ' per ' + grams(lp.grams) + ', from the line header. Change it here only for this spool.</p>' : '<p class="note">This is the list price. Set what you pay for all of ' + esc(line.name) + ' in its header on the wall, or enter it here for this spool only.</p>') +
    '<div class="acts"><span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="spool-add-confirm" data-key="' + esc(key) + '">' + (existing ? 'Receive rolls' : 'Add to rack') + '</button></span></div>');
  setTimeout(() => { const f = $('#m_qty'); if (f) f.select(); }, 30);
}
function openEditModal(id){
  const sp = state.spools[id]; if (!sp) return;
  const hasLine = !!LINE[sp.line]; const lp = hasLine ? linePrice(sp.line) : null; let note = '';
  if (hasLine && lp.set) note = followsLine(sp) ? '<p class="note">Follows your ' + esc(sp.line_name || '') + ' price of ' + money(lp.cost) + ' per ' + grams(lp.grams) + '. Changing cost or roll size here gives this spool its own price.</p>' : '<p class="note">This spool has its own price. <button class="btn ghost small" data-action="spool-use-line" data-id="' + esc(id) + '">Use the line price (' + money(lp.cost) + ')</button></p>';
  else if (hasLine) note = '<p class="note">No price is set for ' + esc(sp.line_name || '') + ' yet. Set one in the line header on the wall and every spool in the line follows it.</p>';
  openModal('<div class="mh">' + spoolSVG(sp, 84) + '<div><h3>' + esc(sp.color) + '</h3><div class="sub">' + esc(sp.line_name || '') + (sp.hex ? ' · ' + esc(sp.hex) : '') + ' · ' + grams(spoolAvailable(sp)) + ' on hand · label ' + esc(sp.barcode || '') + '</div></div></div>' +
    '<div class="quick"><button class="btn ghost small" data-action="quick-roll" data-n="1">+1 roll received</button><button class="btn ghost small" data-action="quick-roll" data-n="2">+2 rolls</button><button class="btn ghost small" data-action="quick-open">Open a fresh roll</button></div>' +
    '<div class="fields" style="margin-top:12px">' +
      fld('m_qty', 'Rolls on hand', 'number', rollsOf(sp), { hint: 'Including the open one; 0 means out' }) +
      fld('m_left', 'Left on the open roll (g)', 'number', rollsOf(sp) ? openLeft(sp) : 0, { hint: 'Weigh it, or use the printer\'s estimate' }) +
      fld('m_cost', 'Roll cost ($)', 'number', effCost(sp)) + fld('m_grams', 'Roll size (g)', 'number', effGrams(sp)) +
      fld('m_reorder', 'Reorder below (g)', 'number', (sp.reorder_at !== undefined && sp.reorder_at !== null) ? sp.reorder_at : '', { placeholder: 'default ' + num(state.settings.reorderAt) }) +
      fld('m_loc', 'Location', 'text', sp.location || '', { placeholder: 'Shelf, bin, dry box' }) +
      fld('m_notes', 'Notes', 'text', sp.notes || '', { wide: true, placeholder: 'Batch, supplier, quirks' }) +
    '</div>' + note +
    '<div class="acts"><button class="btn danger" data-action="spool-remove" data-id="' + esc(id) + '">Take off the rack</button><span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="spool-save" data-id="' + esc(id) + '">Save</button></span></div>');
}
function openCustomModal(){
  openModal('<div class="mh"><div><h3>Add a spool</h3><div class="sub">Any brand or any color not on the wall</div></div></div>' +
    '<div class="fields">' + fld('m_name', 'Color name', 'text', '', { wide: true, placeholder: 'e.g. Sunlu Matte Teal' }) + fld('m_line', 'Brand or line', 'text', '', { wide: true, placeholder: 'e.g. Sunlu PLA Matte' }) +
    '<div class="field wide"><label for="m_hex">Color</label><div class="hexrow"><input id="m_hexpick" type="color" value="#4a90d9" aria-label="Pick color"><input id="m_hex" type="text" value="#4A90D9" placeholder="#RRGGBB" style="flex:1"></div></div>' +
    fld('m_cost', 'Roll cost ($)', 'number', 19.99) + fld('m_grams', 'Roll size (g)', 'number', 1000) + fld('m_qty', 'Rolls on hand', 'number', 1) + fld('m_loc', 'Location', 'text', '', { placeholder: 'Shelf, bin, dry box' }) + '</div>' +
    '<div class="acts"><span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="custom-add-confirm">Add to rack</button></span></div>');
}
function spoolOptions(selectedId){
  const spools = sortSpools(Object.values(state.spools));
  let html = '<option value="">Choose a spool</option>' + spools.map(sp => '<option value="' + esc(sp.id) + '"' + (sp.id === selectedId ? ' selected' : '') + '>' + esc(sp.color) + ' · ' + esc(sp.line_name || '') + ' · ' + money4(ppg(sp)) + '/g' + (spoolStatus(sp) === 'out' ? ' (out)' : '') + '</option>').join('');
  if (selectedId && !state.spools[selectedId]) html += '<option value="' + esc(selectedId) + '" selected>(spool no longer on the rack)</option>';
  return html;
}
let draft = null;
function openProductModal(id){
  const p = id ? state.products[id] : null;
  draft = p ? Object.assign({}, p) : { name: '', sku: '', barcode: '', description: '', photo_path: null, on_hand: 0, price: null, hours_per_unit: 0, flush_g: 0, tower_g: 0, finishing_min: 0, packaging: 0, reorder_at: null, notes: '', archived: false };
  draft._rec = p ? recipe(p).map(r => ({ spool_id: r.spool_id, grams: num(r.grams) })) : [{ spool_id: '', grams: 0 }];
  draft._photoFile = null; draft._photoPreview = photoUrl(p);
  renderProductModal();
}
function renderProductModal(keepFocus){
  const p = draft; const c = productCostDraft();
  const st = p.id ? productStatus(p) : 'ok';
  const v = k => (num(p[k]) > 0 ? num(p[k]) : '');
  const html = '<div class="mh"><div><h3>' + (p.id ? 'Edit product' : 'New product') + '</h3><div class="sub">' + (p.id ? esc(p.name || '') + (p.barcode ? ' · label ' + esc(p.barcode) : '') : 'Photo, filaments, and the price you charge') + '</div></div></div>' +
    '<div class="pedit"><div>' +
      '<div class="photo" id="pPhoto">' + (p._photoPreview ? '<img src="' + esc(p._photoPreview) + '" alt="">' : '<span class="ph">Add a photo<br><small style="letter-spacing:0;text-transform:none;font-weight:400">Camera or library on an iPad</small></span>') + '</div>' +
      '<div class="photo-acts"><input type="file" id="pPhotoFile" accept="image/*" hidden><button class="btn ghost small" data-action="photo-pick">' + (p._photoPreview ? 'Change photo' : 'Add photo') + '</button>' + (p._photoPreview ? '<button class="btn ghost small" data-action="photo-clear">Remove</button>' : '') + '</div>' +
      '<div class="fields" style="margin-top:12px">' + fld('p_name', 'Name', 'text', p.name || '', { wide: true, placeholder: 'What it is called on the shelf' }) + fld('p_sku', 'SKU', 'text', p.sku || '', { placeholder: 'PP-MINI' }) + fld('p_price', 'Sell price ($)', 'number', v('price')) +
      '<div class="field wide"><label for="p_desc">Description</label><textarea id="p_desc" placeholder="Variants, size, notes for the booth">' + esc(p.description || '') + '</textarea></div>' +
      fld('p_min', 'Shelf minimum', 'number', (p.reorder_at !== null && p.reorder_at !== undefined) ? p.reorder_at : '', { placeholder: 'default ' + num(state.settings.productReorderAt) }) + fld('p_barcode', 'Label code', 'text', p.barcode || '', { placeholder: 'made for you if blank', hint: 'Scan a boxed product\'s own barcode here to use it instead' }) + '</div>' +
    '</div><div>' +
      '<div class="field"><label>Filaments per unit</label></div><div class="recipe" id="recipe">' + p._rec.map((r, i) => '<div class="slot">' + dotHTML(state.spools[r.spool_id]) + '<select data-rec="' + i + '" data-field="spool_id" aria-label="Color ' + (i + 1) + '">' + spoolOptions(r.spool_id) + '</select><span class="g"><input type="number" inputmode="decimal" step="any" min="0" data-rec="' + i + '" data-field="grams" value="' + (num(r.grams) > 0 ? num(r.grams) : '') + '" placeholder="0"></span><button class="iconbtn" data-action="rec-remove" data-i="' + i + '" aria-label="Remove color">×</button></div>').join('') + '</div>' +
      '<div style="margin-top:8px"><button class="btn ghost small" data-action="rec-add">Add a color</button></div>' +
      '<div class="grid3" style="margin-top:14px">' +
        fld('p_hours', 'Print hours per unit', 'number', v('hours_per_unit'), { hint: 'Plate time ÷ units on it' }) + fld('p_flush', 'Flushed g per unit', 'number', v('flush_g')) + fld('p_tower', 'Tower g per unit', 'number', v('tower_g')) +
        fld('p_fin', 'Finishing min per unit', 'number', v('finishing_min')) + fld('p_pack', 'Packaging $ per unit', 'number', v('packaging')) +
      '</div>' +
      '<div class="costbox" id="costbox">' + costboxHTML(c) + '</div>' +
      (p.id ? '<div class="stockline"><span class="onhand' + (st !== 'ok' ? ' low' : '') + '" id="pOnHand">' + num(p.on_hand) + '</span><span style="font-size:12.5px;color:var(--ink-2)">on the shelf</span><span style="flex:1"></span><input id="pN" type="number" inputmode="numeric" min="1" step="1" value="1" aria-label="How many"><button class="btn small" data-action="product-make">Made</button><button class="btn red small" data-action="product-sell">Sold</button><button class="btn ghost small" data-action="product-set">Set count</button></div><div id="pConfirm"></div>' : '') +
    '</div></div>' +
    '<div class="acts">' + (p.id ? '<span style="display:flex;gap:6px"><button class="btn ghost" data-action="product-archive">' + (p.archived ? 'Unarchive' : 'Archive') + '</button><button class="btn danger" data-action="product-delete">Delete</button></span>' : '<span></span>') + '<span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="product-save">' + (p.id ? 'Save' : 'Add product') + '</button></span></div>';
  if (keepFocus && !$('#modal').hidden) { const active = document.activeElement; const id = active && active.id; const sel = active && active.selectionStart; const box = $('#modal .box'); box.innerHTML = html; if (id) { const el = document.getElementById(id); if (el) { el.focus(); try { if (sel !== undefined && sel !== null) el.setSelectionRange(sel, sel); } catch (e) {} } } }
  else openModal(html, true);
}
function draftProduct(){ const d = Object.assign({}, draft); d.id = d.id || '__draft'; return d; }
function productCostDraft(){
  // Cost the editor's unsaved recipe by swapping it in for the saved one, then putting the saved one back.
  const d = draftProduct(); const prev = state.pf[d.id];
  state.pf[d.id] = draft._rec.map((r, i) => ({ spool_id: r.spool_id, grams: r.grams, position: i }));
  const c = productCost(d);
  if (prev === undefined) delete state.pf[d.id]; else state.pf[d.id] = prev;
  return c;
}
function costboxHTML(c){
  const colorRows = Object.keys(c.bySpool).map(id => { const sp = state.spools[id]; return '<tr><td>' + dotHTML(sp) + ' ' + esc(sp.color) + ' <span class="sub">' + grams(c.bySpool[id]) + ' × ' + money4(ppg(sp)) + '/g</span></td><td class="n">' + money(c.bySpool[id] * ppg(sp)) + '</td></tr>'; }).join('');
  return '<div class="big"><span>Cost per unit</span><b>' + money(c.unit) + '</b></div>' +
    '<div class="margin">' + (c.margin !== null ? 'Margin at ' + money(c.price) + ': <b>' + Math.round(c.margin) + '%</b> · ' : '') + (c.suggested ? num(state.settings.marginPct) + '% margin needs ' + money(c.suggested) : '') + '</div>' +
    '<div class="twrap"><table class="breakdown" style="margin-top:8px">' + colorRows + (c.missing.length ? '<tr><td class="sub" style="color:var(--red)">A color here is not on the rack</td><td class="n">—</td></tr>' : '') +
    ((c.flushG + c.towerG) > 0 ? '<tr><td>Flush + tower <span class="sub">' + grams(c.flushG + c.towerG) + ' at ' + money4(c.avg) + '/g</span></td><td class="n">' + money((c.flushG + c.towerG) * c.avg) + '</td></tr>' : '') +
    (c.otherG > 0 ? '<tr><td>Other waste <span class="sub">' + num(state.settings.otherWastePct) + '%</span></td><td class="n">' + money(c.material * num(state.settings.otherWastePct) / 100) + '</td></tr>' : '') +
    (c.energy > 0 ? '<tr><td>Energy <span class="sub">' + num(draft ? draft.hours_per_unit : 0) + ' h × ' + money(num(state.settings.energyRate)) + '</span></td><td class="n">' + money(c.energy) + '</td></tr>' : '') +
    (c.failure > 0 ? '<tr><td>Reprint allowance</td><td class="n">' + money(c.failure) + '</td></tr>' : '') +
    (c.labor > 0 ? '<tr><td>Finishing</td><td class="n">' + money(c.labor) + '</td></tr>' : '') +
    (c.packaging > 0 ? '<tr><td>Packaging</td><td class="n">' + money(c.packaging) + '</td></tr>' : '') + '</table></div>';
}
function refreshCostbox(){ const box = $('#costbox'); if (box) box.innerHTML = costboxHTML(productCostDraft()); }
function readProductForm(){
  draft.name = $('#p_name').value.trim(); draft.sku = $('#p_sku').value.trim() || null; draft.price = $('#p_price').value === '' ? null : num($('#p_price').value);
  draft.description = $('#p_desc').value.trim(); draft.reorder_at = $('#p_min').value === '' ? null : Math.round(num($('#p_min').value)); draft.barcode = $('#p_barcode').value.trim() || null;
  draft.hours_per_unit = num($('#p_hours').value); draft.flush_g = num($('#p_flush').value); draft.tower_g = num($('#p_tower').value); draft.finishing_min = num($('#p_fin').value); draft.packaging = num($('#p_pack').value);
}
async function resizeImage(file){
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const max = 1200; let w = img.width, h = img.height; const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s); const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); cv.toBlob(b => b ? resolve(b) : reject(new Error('no image')), 'image/jpeg', 0.86); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image')); }; img.src = url;
  });
}
async function saveProductFromModal(){
  readProductForm(); if (!draft.name) { toast('Give the product a name', true); $('#p_name').focus(); return; }
  const isNew = !draft.id; const row = Object.assign({}, draft); delete row._rec; delete row._photoFile; delete row._photoPreview;
  if (!row.barcode) row.barcode = row.sku || code('P-');
  if (isNew) delete row.id;
  try {
    const saved = await saveProduct(row);
    if (draft._photoFile) { const blob = await resizeImage(draft._photoFile); const path = saved.id + '/' + Date.now() + '.jpg'; const up = await sb.storage.from(CONFIG.photoBucket).upload(path, blob, { contentType: 'image/jpeg', upsert: true }); if (up.error) { fail(up.error, 'Could not upload the photo'); } else { const old = saved.photo_path; saved.photo_path = path; await saveProduct(saved); if (old && old !== path) removePhotos([old]); } }
    else if (draft._photoPreview === '' && saved.photo_path) { const old = saved.photo_path; saved.photo_path = null; await saveProduct(saved); removePhotos([old]); }
    await saveRecipe(saved.id, draft._rec);
    closeModal(); toast(isNew ? saved.name + ' added' : 'Saved'); renderAll();
  } catch (e) {}
}

/* ---------------- scanning ---------------- */
const SCAN_MODES = [['lookup', 'Look up'], ['receive', 'Receive'], ['made', 'Made'], ['sold', 'Sold']];
function renderScanModes(){ $('#scanModes').innerHTML = SCAN_MODES.map(([k, l]) => '<button data-action="scan-mode" data-k="' + k + '" class="' + (state.ui.scanMode === k ? 'on' : '') + (k === 'sold' ? ' sell' : '') + '">' + l + '</button>').join(''); }
function flash(html, bad){ const f = $('#scanFlash'); f.innerHTML = html; f.hidden = false; f.style.color = bad ? 'var(--red)' : ''; clearTimeout(flash.t); flash.t = setTimeout(() => { f.hidden = true; }, 6000); }
function findByCode(raw){
  const c = String(raw).trim(); if (!c) return null; const lc = c.toLowerCase();
  const prod = Object.values(state.products).find(p => (p.barcode && p.barcode.toLowerCase() === lc) || (p.sku && p.sku.toLowerCase() === lc));
  if (prod) return { kind: 'product', item: prod };
  const sp = Object.values(state.spools).find(s => s.barcode && s.barcode.toLowerCase() === lc);
  if (sp) return { kind: 'spool', item: sp };
  const catKey = state.gtin[c]; if (catKey) { const on = Object.values(state.spools).find(s => s.cat_key === catKey); return { kind: on ? 'spool' : 'catalog', item: on || CAT[catKey], catKey }; }
  return null;
}
async function handleScan(raw){
  const c = String(raw).trim(); if (!c) return; const qty = Math.max(1, Math.round(num($('#scanQty').value) || 1)); const mode = state.ui.scanMode;
  const hit = findByCode(c);
  if (!hit) { if (/^\d{8}$|^\d{12,14}$/.test(c)) { openGtinModal(c, qty); return; } openAssignModal(c); return; }
  if (hit.kind === 'catalog') { openAddModal(hit.catKey, { qty }); flash('New box of <b>' + esc(hit.item.color) + '</b>. Confirm the price to put it on the rack.'); return; }
  if (hit.kind === 'spool') {
    const sp = hit.item;
    if (mode === 'receive') { try { await receiveSpool(sp, qty, 'scan'); flash('<b>' + esc(sp.color) + '</b> +' + qty + ' roll' + (qty === 1 ? '' : 's') + ', now ' + rollsOf(sp) + ' on hand'); renderAll(); } catch (e) {} return; }
    if (mode === 'lookup') { openEditModal(sp.id); return; }
    flash('<b>' + esc(sp.color) + '</b> is filament; switch to Receive to add rolls or Look up to edit it.', true); return;
  }
  const p = hit.item;
  if (mode === 'made') { try { const r = await makeProduct(p, qty, 'scan'); flash('Made ' + qty + ' × <b>' + esc(p.name) + '</b>, ' + num(p.on_hand) + ' on the shelf' + (r.shorts.length ? ' · ' + esc(r.shorts.join(', ')) : '')); renderAll(); } catch (e) {} return; }
  if (mode === 'sold') { if (num(p.on_hand) < qty) flash('Only ' + num(p.on_hand) + ' of <b>' + esc(p.name) + '</b> on the shelf; selling anyway.', true); try { await sellProduct(p, qty, 'scan'); flash('Sold ' + qty + ' × <b>' + esc(p.name) + '</b>, ' + num(p.on_hand) + ' left'); renderAll(); } catch (e) {} return; }
  if (mode === 'receive') { try { await adjustProduct(p, num(p.on_hand) + qty, 'scan receive'); flash('<b>' + esc(p.name) + '</b> +' + qty + ', now ' + num(p.on_hand) + ' on the shelf'); renderAll(); } catch (e) {} return; }
  openProductModal(p.id);
}
function openGtinModal(gtin, qty){
  openModal('<div class="mh"><div><h3>New barcode</h3><div class="sub">' + esc(gtin) + ' · which Bambu color is in this box?</div></div></div>' +
    '<div class="field"><input id="gtinSearch" type="search" placeholder="Type a color or line" autocomplete="off"></div><div id="gtinList" style="margin-top:10px;max-height:300px;overflow:auto"></div>' +
    '<p class="note">Or <button class="btn ghost small" data-action="assign-open" data-code="' + esc(gtin) + '">attach it to a product</button> if this is a product\'s own barcode.</p>' +
    '<div class="acts"><span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button></span></div>');
  const render = () => { const q = $('#gtinSearch').value.trim().toLowerCase(); const list = CATALOG.filter(c => !q || (c.color + ' ' + c.lineName).toLowerCase().indexOf(q) >= 0).slice(0, 40); $('#gtinList').innerHTML = list.map(c => '<button class="btn ghost small" style="display:flex;align-items:center;gap:8px;width:100%;justify-content:flex-start;border-radius:10px;margin-bottom:4px" data-action="gtin-pick" data-gtin="' + esc(gtin) + '" data-key="' + esc(c.key) + '" data-qty="' + qty + '">' + spoolSVG(c, 28) + '<span>' + esc(c.color) + ' <span style="color:var(--ink-3)">· ' + esc(c.lineName) + '</span></span></button>').join('') || '<p class="note">No match.</p>'; };
  $('#gtinSearch').addEventListener('input', render); render(); setTimeout(() => $('#gtinSearch').focus(), 30);
}
function openAssignModal(code){
  const prods = sortProducts(Object.values(state.products).filter(p => !p.archived)); const spools = sortSpools(Object.values(state.spools));
  openModal('<div class="mh"><div><h3>Unknown code</h3><div class="sub">' + esc(code) + '</div></div></div>' +
    '<p class="note">Attach it to something so the next scan recognizes it.</p>' +
    '<div class="field" style="margin-top:10px"><label for="asgProd">Product</label><select id="asgProd"><option value="">Choose a product</option>' + prods.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') + '</select></div>' +
    '<div class="field" style="margin-top:10px"><label for="asgSpool">Or a spool</label><select id="asgSpool"><option value="">Choose a spool</option>' + spools.map(s => '<option value="' + esc(s.id) + '">' + esc(s.color) + ' · ' + esc(s.line_name || '') + '</option>').join('') + '</select></div>' +
    '<div class="acts"><span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="assign-save" data-code="' + esc(code) + '">Attach</button></span></div>');
}
// Bluetooth scanners type like a fast keyboard and finish with Enter.
let scanBuf = '', scanLast = 0, scanStart = 0;
document.addEventListener('keydown', e => {
  const t = e.target; const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  const now = Date.now();
  if (e.key === 'Enter') {
    if (scanBuf.length >= 4 && (now - scanStart) / scanBuf.length < 45) {
      e.preventDefault(); e.stopPropagation(); const codeStr = scanBuf; scanBuf = '';
      // The scanner's keystrokes landed in whatever field had focus; take them back out.
      if (inField && t.tagName !== 'SELECT' && typeof t.value === 'string' && t.value.endsWith(codeStr)) t.value = t.value.slice(0, t.value.length - codeStr.length);
      handleScan(codeStr); return;
    }
    scanBuf = ''; return;
  }
  if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
  if (now - scanLast > 90) { scanBuf = ''; scanStart = now; }
  scanBuf += e.key; scanLast = now;
}, true);

/* ---------------- events ---------------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action, id = el.dataset.id;
  try {
  if (a === 'line') { state.ui.line = el.dataset.line; renderChips(); renderWall(); return; }
  if (a === 'rack-line') { state.ui.rackLine = el.dataset.line; renderRack(); return; }
  if (a === 'rack-low') { state.ui.lowOnly = !state.ui.lowOnly; renderRack(); return; }
  if (a === 'product-filter') { state.ui.productFilter = el.dataset.k; renderProducts(); return; }
  if (a === 'log-kind') { state.ui.logKind = el.dataset.k; renderLog(); return; }
  if (a === 'label-kind') { state.ui.labelKind = el.dataset.k; renderLabels(); return; }
  if (a === 'labels-print') { document.querySelectorAll('section.sec').forEach(s => s.classList.toggle('printing', s.id === 'labels')); window.print(); return; }
  if (a === 'scan-mode') { state.ui.scanMode = el.dataset.k; renderScanModes(); return; }
  if (a === 'wall-toggle') { const k = el.dataset.line; if (state.ui.collapsed.has(k)) state.ui.collapsed.delete(k); else state.ui.collapsed.add(k); saveCollapsed(); renderWall(); return; }
  if (a === 'wall-collapse-all') { LINES.forEach(l => state.ui.collapsed.add(l.key)); saveCollapsed(); renderWall(); return; }
  if (a === 'wall-expand-all') { state.ui.collapsed.clear(); saveCollapsed(); renderWall(); return; }
  if (a === 'modal-close') { closeModal(); return; }
  if (a === 'pick') { openAddModal(el.dataset.key); return; }
  if (a === 'spool-add-confirm') {
    const c = CAT[el.dataset.key]; if (!c) return;
    const cost = num($('#m_cost').value), g = num($('#m_grams').value), q = Math.max(0, Math.round(num($('#m_qty').value))); const loc = $('#m_loc').value.trim();
    if (g <= 0) { toast('Roll size has to be more than 0 g', true); return; }
    const lp = linePrice(c.line); const custom = lp.set && (Math.abs(cost - lp.cost) > 0.004 || Math.abs(g - lp.grams) > 0.5);
    let sp = Object.values(state.spools).find(s => s.cat_key === c.key);
    if (sp) { sp.cost = cost; sp.grams = g; sp.custom_price = custom; if (loc) sp.location = loc; if (q > 0) await receiveSpool(sp, q); else await saveSpool(sp); toast(c.color + ': ' + q + ' roll' + (q === 1 ? '' : 's') + ' received, ' + rollsOf(sp) + ' on hand'); }
    else { sp = await saveSpool({ cat_key: c.key, line: c.line, line_name: c.lineName, color: c.color, hex: c.hex, hex2: c.hex2 || null, hex3: c.hex3 || null, finish: c.finish, cost, grams: g, custom_price: custom, rolls: q, open_left: q > 0 ? g : 0, location: loc || null, barcode: code('S-') }); if (q > 0) await addMovement({ kind: 'receive', spool_id: sp.id, qty: q, grams: q * g, cost: Math.round(q * cost * 100) / 100, note: 'added to rack' }); toast(c.color + ' added to the rack'); }
    closeModal(); renderAll(); return;
  }
  if (a === 'spool-edit') { openEditModal(id); return; }
  if (a === 'spool-use-line') { const sp = state.spools[id]; if (!sp || !LINE[sp.line]) return; const lp = linePrice(sp.line); $('#m_cost').value = lp.cost; $('#m_grams').value = lp.grams; toast('Save to put it back on the line price'); return; }
  if (a === 'quick-roll') { const q = $('#m_qty'); const left = $('#m_left'); const g = num($('#m_grams').value); const had = Math.max(0, Math.round(num(q.value))); q.value = had + num(el.dataset.n); if (had === 0 && left) left.value = g; return; }
  if (a === 'quick-open') { const left = $('#m_left'); const q = $('#m_qty'); const g = num($('#m_grams').value); const had = Math.max(0, Math.round(num(q.value))); if (had <= 1) { toast('No sealed roll to open', true); return; } q.value = had - 1; left.value = g; toast('Open roll discarded, fresh roll opened. Save to keep it.'); return; }
  if (a === 'spool-save') {
    const sp = state.spools[id]; if (!sp) return; const g = num($('#m_grams').value); if (g <= 0) { toast('Roll size has to be more than 0 g', true); return; }
    const cost = num($('#m_cost').value); const lp = LINE[sp.line] ? linePrice(sp.line) : null;
    const from = { rolls: rollsOf(sp), open_left: openLeft(sp) };
    sp.custom_price = lp ? (lp.set ? (Math.abs(cost - lp.cost) > 0.004 || Math.abs(g - lp.grams) > 0.5) : false) : true;
    sp.cost = cost; sp.grams = g; sp.rolls = Math.max(0, Math.round(num($('#m_qty').value))); sp.open_left = sp.rolls > 0 ? Math.min(g, Math.max(0, num($('#m_left').value))) : 0;
    const ro = $('#m_reorder').value.trim(); sp.reorder_at = ro === '' ? null : num(ro); sp.location = $('#m_loc').value.trim() || null; sp.notes = $('#m_notes').value.trim() || null;
    await saveSpool(sp);
    if (sp.rolls > from.rolls) await addMovement({ kind: 'receive', spool_id: sp.id, qty: sp.rolls - from.rolls, grams: (sp.rolls - from.rolls) * g, cost: Math.round((sp.rolls - from.rolls) * effCost(sp) * 100) / 100, note: 'edited on the rack' });
    else if (sp.rolls !== from.rolls || Math.abs(openLeft(sp) - from.open_left) > 0.05) await addMovement({ kind: 'adjust', spool_id: sp.id, qty: sp.rolls - from.rolls, grams: Math.round((spoolAvailable(sp) - ((from.rolls > 0 ? (from.rolls - 1) * g + from.open_left : 0))) * 10) / 10, cost: 0, note: 'edited on the rack', detail: { from, to: { rolls: sp.rolls, open_left: sp.open_left } } });
    closeModal(); renderAll(); return;
  }
  if (a === 'spool-remove') { const sp = state.spools[id]; if (!sp) return; const used = Object.values(state.pf).flat().filter(r => r.spool_id === id).length; await deleteSpool(id); closeModal(); toast(sp.color + ' taken off the rack' + (used ? ' · ' + used + ' product recipe' + (used === 1 ? '' : 's') + ' need a new color' : '')); renderAll(); return; }
  if (a === 'custom-open') { openCustomModal(); return; }
  if (a === 'custom-add-confirm') {
    const name = $('#m_name').value.trim(); if (!name) { toast('Give the color a name', true); $('#m_name').focus(); return; }
    let hex = $('#m_hex').value.trim(); if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) { toast('Color needs a 6-digit hex like #4A90D9', true); return; } if (hex[0] !== '#') hex = '#' + hex;
    const g = num($('#m_grams').value); if (g <= 0) { toast('Roll size has to be more than 0 g', true); return; } const q = Math.max(0, Math.round(num($('#m_qty').value)));
    const sp = await saveSpool({ cat_key: null, line: 'custom', line_name: $('#m_line').value.trim() || 'Other', color: name, hex: hex.toUpperCase(), finish: 'basic', cost: num($('#m_cost').value), grams: g, custom_price: true, rolls: q, open_left: q > 0 ? g : 0, location: $('#m_loc').value.trim() || null, barcode: code('S-') });
    if (q > 0) await addMovement({ kind: 'receive', spool_id: sp.id, qty: q, grams: q * g, cost: Math.round(q * num(sp.cost) * 100) / 100, note: 'added to rack' });
    closeModal(); toast(name + ' added to the rack'); renderAll(); return;
  }
  if (a === 'remove-examples') {
    const ps = Object.values(state.products).filter(p => p.example); const ss = Object.values(state.spools).filter(s => s.example);
    for (const p of ps) await deleteProduct(p.id); for (const s of ss) await deleteSpool(s.id);
    toast('Examples removed'); renderAll(); return;
  }
  if (a === 'product-new') { openProductModal(null); return; }
  if (a === 'product-open') { openProductModal(id); return; }
  if (a === 'photo-pick') { $('#pPhotoFile').click(); return; }
  if (a === 'photo-clear') { draft._photoFile = null; draft._photoPreview = ''; readProductForm(); renderProductModal(true); return; }
  if (a === 'rec-add') { readProductForm(); draft._rec.push({ spool_id: '', grams: 0 }); renderProductModal(true); return; }
  if (a === 'rec-remove') { readProductForm(); draft._rec.splice(+el.dataset.i, 1); if (!draft._rec.length) draft._rec.push({ spool_id: '', grams: 0 }); renderProductModal(true); return; }
  if (a === 'product-save') { await saveProductFromModal(); return; }
  if (a === 'product-archive') { readProductForm(); draft.archived = !draft.archived; await saveProductFromModal(); return; }
  if (a === 'product-delete') { $('#pConfirm').innerHTML = '<div class="confirm">Delete <b>' + esc(draft.name) + '</b> and its recipe? Its history stays in the activity log.<div class="acts"><button class="btn red" data-action="product-delete-do">Delete</button><button class="btn ghost" data-action="product-delete-cancel">Keep it</button></div></div>'; return; }
  if (a === 'product-delete-cancel') { $('#pConfirm').innerHTML = ''; return; }
  if (a === 'product-delete-do') { await deleteProduct(draft.id); closeModal(); toast('Deleted'); renderAll(); return; }
  if (a === 'product-make' || a === 'product-sell' || a === 'product-set') {
    const p = state.products[draft.id]; if (!p) return; const n = Math.max(0, Math.round(num($('#pN').value)));
    if (a === 'product-make') { if (n < 1) return; const { c, pulls } = spoolPullFor(p, n); const lines = pulls.map(pl => { const sp = state.spools[pl.spoolId]; return esc(sp.color) + ' ' + grams(pl.grams); }); $('#pConfirm').innerHTML = '<div class="confirm">Make <b>' + n + '</b>: pull ' + (lines.join(' · ') || 'no filament (recipe is empty)') + ' off the rack, cost ' + money(c.unit * n) + '.<div class="acts"><button class="btn red" data-action="product-make-do" data-n="' + n + '">Made ' + n + '</button><button class="btn ghost" data-action="product-delete-cancel">Cancel</button></div></div>'; return; }
    if (a === 'product-sell') { if (n < 1) return; await sellProduct(p, n); $('#pOnHand').textContent = num(p.on_hand); $('#pConfirm').innerHTML = ''; toast('Sold ' + n + ', ' + num(p.on_hand) + ' left'); renderProducts(); renderLog(); renderReorder(); return; }
    if (a === 'product-set') { await adjustProduct(p, n, 'set on product'); $('#pOnHand').textContent = num(p.on_hand); toast('Shelf count set to ' + n); renderProducts(); renderLog(); renderReorder(); return; }
  }
  if (a === 'product-make-do') { const p = state.products[draft.id]; const n = num(el.dataset.n); const r = await makeProduct(p, n); $('#pOnHand').textContent = num(p.on_hand); $('#pConfirm').innerHTML = ''; toast('Made ' + n + ', ' + num(p.on_hand) + ' on the shelf' + (r.shorts.length ? ' · ' + r.shorts.join(', ') : '')); renderAll(); return; }
  if (a === 'log-undo') { const m = state.movements.find(x => x.id === id); if (!m) return; await undoMovement(m); toast('Undone'); renderAll(); return; }
  if (a === 'log-export') { if (!state.movements.length) { toast('Nothing logged yet'); return; } download('mostly3d-activity.csv', logCSV(), 'text/csv'); return; }
  if (a === 'reorder-copy') { copyText(reorderText(), 'Reorder list copied'); return; }
  if (a === 'gtin-pick') { const gtin = el.dataset.gtin, key = el.dataset.key; await dbWrite(() => sb.from('gtin_map').upsert({ gtin, cat_key: key }), 'Could not save the barcode'); state.gtin[gtin] = key; closeModal(); const on = Object.values(state.spools).find(s => s.cat_key === key); if (on && state.ui.scanMode === 'receive') { await receiveSpool(on, num(el.dataset.qty) || 1, 'scan'); flash('<b>' + esc(on.color) + '</b> +' + (num(el.dataset.qty) || 1) + ', now ' + rollsOf(on) + ' on hand'); renderAll(); } else if (on) openEditModal(on.id); else openAddModal(key, { qty: num(el.dataset.qty) || 1 }); return; }
  if (a === 'assign-open') { openAssignModal(el.dataset.code); return; }
  if (a === 'assign-save') { const c = el.dataset.code; const pid = $('#asgProd').value, sid = $('#asgSpool').value; if (pid) { const p = state.products[pid]; p.barcode = c; await saveProduct(p); toast('Attached to ' + p.name); } else if (sid) { const s = state.spools[sid]; s.barcode = c; await saveSpool(s); toast('Attached to ' + s.color); } else { toast('Pick a product or a spool', true); return; } closeModal(); renderAll(); return; }
  if (a === 'allowed-remove') { const email = el.dataset.email; await dbWrite(() => sb.from('allowed_users').delete().eq('email', email), 'Could not remove'); state.allowedUsers = state.allowedUsers.filter(x => x !== email); renderSettings(); return; }
  } catch (err) { console.error(err); }
});
function copyText(txt, okMsg){
  const fallback = () => { const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (err) {} ta.remove(); toast(ok ? okMsg : 'Could not copy on this browser', !ok); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast(okMsg), fallback); else fallback();
}
document.addEventListener('submit', async e => {
  if (e.target.id === 'scanForm') { e.preventDefault(); const v = $('#scanCode').value; $('#scanCode').value = ''; handleScan(v); return; }
  if (e.target.id === 'passForm') { e.preventDefault(); const a = $('#passNew').value, b2 = $('#passAgain').value; if (a.length < 8) { toast('Use at least 8 characters', true); return; } if (a !== b2) { toast('The two passwords do not match', true); return; } const r = await sb.auth.updateUser({ password: a }); if (r.error) { toast('Could not change it: ' + r.error.message, true); return; } $('#passNew').value = ''; $('#passAgain').value = ''; toast('Password changed'); return; }
  if (e.target.id === 'allowedForm') { e.preventDefault(); const email = $('#allowedEmail').value.trim().toLowerCase(); if (!email) return; try { await dbWrite(() => sb.from('allowed_users').upsert({ email }), 'Could not add'); if (state.allowedUsers.indexOf(email) < 0) state.allowedUsers.push(email); state.allowedUsers.sort(); renderSettings(); toast(email + ' can sign in now'); } catch (err) {} return; }
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'pPhotoFile') { const f = el.files && el.files[0]; if (!f) return; draft._photoFile = f; draft._photoPreview = URL.createObjectURL(f); readProductForm(); renderProductModal(true); return; }
  if (el.dataset.rec !== undefined && el.dataset.field === 'spool_id') { readProductForm(); draft._rec[+el.dataset.rec].spool_id = el.value; renderProductModal(true); return; }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'wallSearch') { state.ui.q = el.value; renderWall(); return; }
  if (el.id === 'productSearch') { state.ui.productQ = el.value; renderProducts(); return; }
  if (el.id === 'm_hexpick') { const h = $('#m_hex'); if (h) h.value = el.value.toUpperCase(); return; }
  if (el.id === 'm_hex') { const v = el.value.trim(); if (/^#[0-9a-fA-F]{6}$/.test(v)) { const pk = $('#m_hexpick'); if (pk) pk.value = v.toLowerCase(); } return; }
  if (el.dataset.rec !== undefined && el.dataset.field === 'grams') { draft._rec[+el.dataset.rec].grams = num(el.value); refreshCostbox(); return; }
  if (['p_hours', 'p_flush', 'p_tower', 'p_fin', 'p_pack', 'p_price'].indexOf(el.id) >= 0) { readProductForm(); refreshCostbox(); return; }
  if (el.dataset.setting) { state.settings[el.dataset.setting] = el.value === '' ? 0 : num(el.value); saveSettingsSoon(); renderProducts(); renderRack(); renderReorder(); return; }
  if (el.dataset.lineprice) {
    const key = el.dataset.lineprice; if (!LINE[key]) return;
    const lps = state.settings.linePrices = state.settings.linePrices || {};
    const before = linePrice(key); const cur = { cost: before.cost, grams: before.grams }; const v = num(el.value);
    if (el.dataset.field === 'cost') { if (el.value === '' || v <= 0) delete lps[key]; else { cur.cost = v; lps[key] = cur; } }
    else { if (el.value !== '' && v > 0) { cur.grams = v; lps[key] = cur; } }
    saveSettingsSoon();
    const set = !!lps[key]; const tag = el.closest('.wg-price') && el.closest('.wg-price').querySelector('.lp-tag'); if (tag) { tag.textContent = set ? 'your price' : 'list price'; tag.classList.toggle('yours', set); }
    renderRack(); renderProducts(); renderReorder(); return;
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
$('#modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

/* ---------------- auth ---------------- */
function showAuth(msg, bad){ $('#auth').hidden = false; $('#app').hidden = true; const m = $('#authMsg'); m.textContent = msg || ''; m.className = 'msg' + (bad ? ' bad' : ''); }
function showApp(){ $('#auth').hidden = true; $('#app').hidden = false; }
let authMode = 'signin';
function setAuthMode(mode){
  authMode = mode; const sub = $('#authSubmit'); const pf = $('#authPassField'); const pw = $('#authPass');
  if (mode === 'signin') { sub.textContent = 'Sign in'; pf.hidden = false; pw.autocomplete = 'current-password'; $('#authSignup').textContent = 'Create an account'; $('#authForgot').hidden = false; }
  if (mode === 'signup') { sub.textContent = 'Create account'; pf.hidden = false; pw.autocomplete = 'new-password'; $('#authSignup').textContent = 'Back to sign in'; $('#authForgot').hidden = true; }
  if (mode === 'forgot') { sub.textContent = 'Send reset link'; pf.hidden = true; $('#authSignup').textContent = 'Back to sign in'; $('#authForgot').hidden = true; }
  if (mode === 'recovery') { sub.textContent = 'Set new password'; pf.hidden = false; pw.autocomplete = 'new-password'; $('#authSignup').hidden = true; $('#authForgot').hidden = true; $('#authEmail').closest('.field').hidden = true; }
}
$('#authForgot').addEventListener('click', () => { setAuthMode('forgot'); showAuth('We will email you a link to choose a new password.'); });
$('#authSignup').addEventListener('click', () => { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); showAuth(authMode === 'signup' ? 'Only emails on the shop list get in, but the account is yours to create.' : ''); });
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault(); const email = $('#authEmail').value.trim(); const password = $('#authPass').value; const sub = $('#authSubmit'); sub.disabled = true;
  try {
    if (authMode === 'signin') { const r = await sb.auth.signInWithPassword({ email, password }); if (r.error) throw r.error; await enter(); }
    else if (authMode === 'signup') { if (password.length < 8) throw new Error('Use at least 8 characters'); const r = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }); if (r.error) throw r.error; if (r.data.session) { await enter(); } else { showAuth('Check ' + email + ' for a confirmation link, then sign in.'); setAuthMode('signin'); } }
    else if (authMode === 'forgot') { const r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); if (r.error) throw r.error; showAuth('If that address has an account, a reset link is on its way.'); setAuthMode('signin'); }
    else if (authMode === 'recovery') { if (password.length < 8) throw new Error('Use at least 8 characters'); const r = await sb.auth.updateUser({ password }); if (r.error) throw r.error; state.ui.recovery = false; toast('Password updated'); await enter(); }
  } catch (err) { showAuth(err.message || 'That did not work', true); }
  sub.disabled = false;
});
$('#signOut').addEventListener('click', async () => { await sb.auth.signOut(); state.session = null; location.reload(); });
async function enter(){
  const { data } = await sb.auth.getSession(); state.session = data.session;
  if (!state.session) { setAuthMode('signin'); showAuth(''); return; }
  if (state.ui.recovery) { setAuthMode('recovery'); showAuth('Choose a new password for ' + state.session.user.email); return; }
  const allowed = await sb.rpc('is_allowed'); state.allowed = !!allowed.data;
  if (!state.allowed) { setAuthMode('signin'); showAuth(state.session.user.email + ' is not on the shop\'s sign-in list yet. Ask Cagney or Brittany to add it under Settings, then sign in again.', true); const m = $('#authMsg'); m.insertAdjacentHTML('beforeend', '<br><button type="button" class="btn ghost small" id="authOut" style="margin-top:8px">Sign out</button>'); $('#authOut').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); }); return; }
  showApp(); setStatus('live');
  try { await loadAll(); renderAll(); subscribe(); } catch (e) { fail(e, 'Could not load the shop'); }
}
sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') { state.ui.recovery = true; enter(); } });
renderScanModes();
enter();
window.__m3d = { state, productCost, spoolAvailable };
