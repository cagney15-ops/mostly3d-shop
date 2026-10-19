import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49/+esm';
import { CONFIG } from './config.js';
import { LINES, LINE, CATALOG, CAT } from './catalog.js';

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

/* ---------------- state ---------------- */
const DEFAULT_SETTINGS = { energyRate: 0.15, otherWastePct: 0, failurePct: 0, laborRate: 0, marginPct: 50, reorderAt: 250, productReorderAt: 3, partReorderAt: 2, linePrices: {} };
const COLLAPSE_KEY = 'mostly3d.wall.collapsed';
function loadCollapsed(){ try { const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch (e) { return new Set(); } }
function saveCollapsed(){ try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(state.ui.collapsed))); } catch (e) {} }
const state = {
  session: null, allowed: null, loaded: false,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  spools: {}, products: {}, pf: {}, pc: {}, parts: {}, printers: {}, pp: {}, movements: [], audit: [], files: {}, gtin: {}, allowedUsers: [],
  ui: { line: 'all', q: '', rackLine: 'all', lowOnly: false, productQ: '', productFilter: 'all', logKind: 'all', labelKind: 'spools', collapsed: loadCollapsed(), scanMode: 'lookup', recovery: false, tab: 'home', partPrinter: 'all', partCat: 'all', partQ: '', partLowOnly: false, openProduct: null, openSpool: null, openPart: null, logView: 'stock', logActor: 'all', logFrom: '', logTo: '', logQ: '' }
};

/* ---------------- utils ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = n => USD.format(isFinite(n) ? n : 0);
const money4 = n => '$' + (isFinite(n) ? n : 0).toFixed(4);
const gnum = n => { n = +n || 0; return Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n).toString() : n.toFixed(1); };
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
function partMin(pt){ return (pt.reorder_at !== undefined && pt.reorder_at !== null && pt.reorder_at !== '') ? num(pt.reorder_at) : num(state.settings.partReorderAt); }
function partStatus(pt){ const n = num(pt.on_hand); if (n <= 0) return 'out'; if (n < partMin(pt)) return 'low'; return 'ok'; }
function partPrinters(pt){ return (state.pp[pt.id] || []).map(id => state.printers[id]).filter(Boolean); }
function sortPrinters(list){ return list.slice().sort((a, b) => num(a.position) - num(b.position) || String(a.name).localeCompare(String(b.name))); }
function sortParts(list){ return list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))); }
const PART_CATS = ['Nozzle', 'Hotend', 'Extruder', 'Build plate', 'Belt', 'Bearing & rod', 'Fan', 'PTFE & tubing', 'Electronics', 'AMS', 'Lubricant & cleaning', 'Fastener', 'Tool', 'Packaging', 'Other'];
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
// Filament rows hold the slicer's numbers for a whole plate (model / purged / tower grams);
// the product says how many units are on that plate and how long it prints. Everything is divided by that.
function recipe(p){ return (state.pf[p.id] || []).slice().sort((a, b) => num(a.position) - num(b.position)); }
function components(p){ return (state.pc[p.id] || []).slice().sort((a, b) => num(a.position) - num(b.position)); }
function isPlayset(p){ return !!p && p.kind === 'playset'; }
function plateQty(p){ const n = Math.round(num(p.plate_qty)); return n >= 1 ? n : 1; }
function productCost(p, depth){
  depth = depth || 0; const S = state.settings; const n = plateQty(p); const playset = isPlayset(p);
  let g = 0, modelG = 0, wasteG = 0, material = 0; const bySpool = {}; const missing = []; const rows = []; const comps = [];
  if (!playset) {
    recipe(p).forEach(r => {
      const sp = state.spools[r.spool_id];
      const model = num(r.grams) / n, purge = num(r.purge_g) / n, tower = num(r.tower_g) / n, tot = model + purge + tower;
      if (!sp) { if (tot > 0) missing.push(r); return; }
      g += tot; modelG += model; wasteG += purge + tower;
      bySpool[sp.id] = (bySpool[sp.id] || 0) + tot; const cost = tot * ppg(sp); material += cost;
      rows.push({ sp, model, purge, tower, tot, cost });
    });
  } else if (depth < 6) {
    components(p).forEach(c => {
      const cp = state.products[c.component_id]; const q = num(c.qty);
      if (!cp) { if (q > 0) missing.push(c); return; }
      const cc = productCost(cp, depth + 1);
      comps.push({ cp, qty: q, unit: cc.unit, cost: cc.unit * q, filamentG: cc.filamentG * q });
      material += cc.unit * q; g += cc.filamentG * q;
    });
  }
  const avg = g > 0 ? material / g : 0;
  const otherG = playset ? 0 : g * num(S.otherWastePct) / 100;
  const otherWaste = playset ? 0 : material * num(S.otherWastePct) / 100;
  const hours = playset ? 0 : num(p.plate_hours) / n;
  const energy = hours * num(S.energyRate);
  const base = material + otherWaste + energy; const failure = playset ? 0 : base * num(S.failurePct) / 100;
  const labor = num(p.finishing_min) / 60 * num(S.laborRate); const packaging = num(p.packaging);
  const unit = base + failure + labor + packaging;
  const price = num(p.price); const margin = price > 0 ? (price - unit) / price * 100 : null;
  const target = num(S.marginPct); const suggested = (target > 0 && target < 100) ? unit / (1 - target / 100) : 0;
  return { playset, n, g, modelG, wasteG, otherG, filamentG: g + otherG, material, avg, bySpool, rows, comps, otherWaste, hours, energy, failure, labor, packaging, unit, price, margin, suggested, missing };
}
// What making `units` of a product takes: grams per spool (other-waste % included) or component units.
function spoolPullFor(p, units){
  const c = productCost(p); const pulls = []; const factor = 1 + num(state.settings.otherWastePct) / 100;
  Object.keys(c.bySpool).forEach(id => pulls.push({ spoolId: id, grams: Math.round(c.bySpool[id] * factor * units * 10) / 10 }));
  const parts = c.comps.map(x => ({ productId: x.cp.id, name: x.cp.name, qty: Math.round(x.qty * units * 100) / 100 }));
  return { c, pulls, parts };
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
  const [s, sp, pr, pf, pc, pa, pi, ppx, mv, gt, au, al, fl] = await Promise.all([
    sb.from('shop_settings').select('data').eq('id', 1).maybeSingle(),
    sb.from('spools').select('*'),
    sb.from('products').select('*'),
    sb.from('product_filaments').select('*'),
    sb.from('product_components').select('*'),
    sb.from('parts').select('*'),
    sb.from('printers').select('*').order('position'),
    sb.from('part_printers').select('*'),
    sb.from('movements').select('*').gte('created_at', new Date(Date.now() - 365 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(5000),
    sb.from('gtin_map').select('*'),
    sb.from('allowed_users').select('*').order('email'),
    sb.from('audit_log').select('*').gte('created_at', new Date(Date.now() - 365 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(5000),
    sb.from('product_files').select('*').order('created_at')
  ]);
  const firstErr = [s, sp, pr, pf, pc, pa, pi, ppx, mv, gt, au, al, fl].find(r => r.error);
  if (firstErr) throw firstErr.error;
  if (lastLocalWrite > startedAt || pendingWrites > 0) { scheduleReload(); return false; } // a write landed meanwhile; this snapshot is stale
  if (!settingsDirty) { state.settings = Object.assign({}, DEFAULT_SETTINGS, (s.data && s.data.data) || {}); if (!state.settings.linePrices) state.settings.linePrices = {}; }
  state.spools = {}; (sp.data || []).forEach(r => state.spools[r.id] = r);
  state.products = {}; (pr.data || []).forEach(r => state.products[r.id] = r);
  state.pf = {}; (pf.data || []).forEach(r => { (state.pf[r.product_id] = state.pf[r.product_id] || []).push(r); });
  state.pc = {}; (pc.data || []).forEach(r => { (state.pc[r.product_id] = state.pc[r.product_id] || []).push(r); });
  state.parts = {}; (pa.data || []).forEach(r => state.parts[r.id] = r);
  state.printers = {}; (pi.data || []).forEach(r => state.printers[r.id] = r);
  state.pp = {}; (ppx.data || []).forEach(r => { (state.pp[r.part_id] = state.pp[r.part_id] || []).push(r.printer_id); });
  state.movements = mv.data || [];
  state.gtin = {}; (gt.data || []).forEach(r => state.gtin[r.gtin] = r.cat_key);
  state.allowedUsers = (au.data || []).map(r => r.email);
  state.audit = al.data || [];
  state.files = {}; (fl.data || []).forEach(r => { (state.files[r.product_id] = state.files[r.product_id] || []).push(r); });
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
const me = () => (state.session && state.session.user ? state.session.user.email : null);
const who = e => e ? String(e).split('@')[0] : 'someone';
// Fields worth a line in the changes log, per entity.
const TRACKED = {
  product: ['name', 'sku', 'barcode', 'price', 'kind', 'plate_qty', 'plate_hours', 'finishing_min', 'packaging', 'reorder_at', 'max_level', 'description', 'archived', 'photo_path'],
  spool: ['color', 'line_name', 'cost', 'grams', 'custom_price', 'reorder_at', 'max_level', 'location', 'notes', 'barcode'],
  part: ['name', 'part_no', 'barcode', 'category', 'cost', 'vendor', 'link', 'location', 'reorder_at', 'max_level', 'notes', 'archived', 'photo_path'],
  printer: ['name', 'model', 'serial', 'notes']
};
function diffRows(entity, before, after){
  const out = {}; (TRACKED[entity] || []).forEach(k => { const a = before ? before[k] : undefined, b = after ? after[k] : undefined; const na = a === undefined || a === null || a === '' ? null : a, nb = b === undefined || b === null || b === '' ? null : b; if (String(na) !== String(nb)) out[k] = [na, nb]; });
  return out;
}
async function logChange(action, entity, id, name, changes){
  try {
    const row = { actor: me(), action, entity, entity_id: id ? String(id) : null, name: name || null, changes: changes || null };
    const r = await sb.from('audit_log').insert(row).select().single();
    if (!r.error) state.audit.unshift(r.data);
  } catch (e) { console.warn('audit', e); }
}
function stamp(row, isNew){ if (isNew) row.created_by = row.created_by || me(); row.updated_by = me(); return row; }
async function saveSpool(sp, opts){
  opts = opts || {}; const before = sp.id ? state.spools[sp.id] : null; const isNew = !sp.id;
  const row = stamp(Object.assign({}, sp), isNew); delete row.created_at; delete row.updated_at;
  const r = await dbWrite(() => sb.from('spools').upsert(row).select().single(), 'Could not save the spool');
  state.spools[r.data.id] = r.data;
  if (!opts.silent) { const d = diffRows('spool', before, r.data); if (isNew) logChange('created', 'spool', r.data.id, r.data.color + ' · ' + (r.data.line_name || ''), null); else if (Object.keys(d).length) logChange('updated', 'spool', r.data.id, r.data.color + ' · ' + (r.data.line_name || ''), d); }
  return r.data;
}
async function deleteSpool(id){ const sp = state.spools[id]; await dbWrite(() => sb.from('spools').delete().eq('id', id), 'Could not remove the spool'); delete state.spools[id]; if (sp) logChange('deleted', 'spool', id, sp.color + ' · ' + (sp.line_name || ''), null); }
async function saveProduct(p, opts){
  opts = opts || {}; const before = p.id ? state.products[p.id] : null; const isNew = !p.id;
  const row = stamp(Object.assign({}, p), isNew); delete row.created_at; delete row.updated_at;
  const r = await dbWrite(() => sb.from('products').upsert(row).select().single(), 'Could not save the product');
  state.products[r.data.id] = r.data;
  if (!opts.silent) { const d = diffRows('product', before, r.data); if (isNew) logChange('created', 'product', r.data.id, r.data.name, null); else if (Object.keys(d).length) logChange('updated', 'product', r.data.id, r.data.name, d); }
  return r.data;
}
async function deleteProduct(id){
  const p = state.products[id];
  await dbWrite(() => sb.from('products').delete().eq('id', id), 'Could not delete the product'); delete state.products[id]; delete state.pf[id]; delete state.pc[id]; delete state.files[id];
  if (p) logChange('deleted', 'product', id, p.name, null);
  if (p && p.photo_path) removePhotos([p.photo_path]);
}
async function removePhotos(paths){ try { await sb.storage.from(CONFIG.photoBucket).remove(paths.filter(Boolean)); } catch (e) { console.warn('photo cleanup', e); } }
async function saveRecipe(productId, rows){
  await dbWrite(() => sb.from('product_filaments').delete().eq('product_id', productId), 'Could not save the filaments');
  const clean = rows.filter(r => r.spool_id || num(r.grams) > 0 || num(r.purge_g) > 0 || num(r.tower_g) > 0).map((r, i) => ({ product_id: productId, spool_id: r.spool_id || null, grams: num(r.grams), purge_g: num(r.purge_g), tower_g: num(r.tower_g), position: i }));
  if (clean.length) { const r = await dbWrite(() => sb.from('product_filaments').insert(clean).select(), 'Could not save the filaments'); state.pf[productId] = r.data; } else state.pf[productId] = [];
}
async function savePart(pt, opts){
  opts = opts || {}; const before = pt.id ? state.parts[pt.id] : null; const isNew = !pt.id;
  const row = stamp(Object.assign({}, pt), isNew); delete row.created_at; delete row.updated_at;
  const r = await dbWrite(() => sb.from('parts').upsert(row).select().single(), 'Could not save the part');
  state.parts[r.data.id] = r.data;
  if (!opts.silent) { const d = diffRows('part', before, r.data); if (isNew) logChange('created', 'part', r.data.id, r.data.name, null); else if (Object.keys(d).length) logChange('updated', 'part', r.data.id, r.data.name, d); }
  return r.data;
}
async function deletePart(id){ const pt = state.parts[id]; await dbWrite(() => sb.from('parts').delete().eq('id', id), 'Could not delete the part'); delete state.parts[id]; delete state.pp[id]; if (pt) logChange('deleted', 'part', id, pt.name, null); if (pt && pt.photo_path) removePhotos([pt.photo_path]); }
async function savePartPrinters(partId, printerIds){
  await dbWrite(() => sb.from('part_printers').delete().eq('part_id', partId), 'Could not save the printers');
  const rows = printerIds.filter(id => state.printers[id]).map(id => ({ part_id: partId, printer_id: id }));
  if (rows.length) await dbWrite(() => sb.from('part_printers').insert(rows), 'Could not save the printers');
  state.pp[partId] = rows.map(r => r.printer_id);
}
async function savePrinter(pr){
  const before = pr.id ? state.printers[pr.id] : null; const isNew = !pr.id;
  const row = Object.assign({}, pr); delete row.created_at; delete row.updated_at;
  const r = await dbWrite(() => sb.from('printers').upsert(row).select().single(), 'Could not save the printer');
  state.printers[r.data.id] = r.data;
  const d = diffRows('printer', before, r.data); if (isNew) logChange('created', 'printer', r.data.id, r.data.name, null); else if (Object.keys(d).length) logChange('updated', 'printer', r.data.id, r.data.name, d);
  return r.data;
}
async function deletePrinter(id){ const pr = state.printers[id]; await dbWrite(() => sb.from('printers').delete().eq('id', id), 'Could not remove the printer'); delete state.printers[id]; Object.keys(state.pp).forEach(k => { state.pp[k] = state.pp[k].filter(x => x !== id); }); if (pr) logChange('deleted', 'printer', id, pr.name, null); }
async function saveComponents(productId, rows){
  await dbWrite(() => sb.from('product_components').delete().eq('product_id', productId), 'Could not save the playset contents');
  const clean = rows.filter(r => r.component_id && r.component_id !== productId).map((r, i) => ({ product_id: productId, component_id: r.component_id, qty: num(r.qty) > 0 ? num(r.qty) : 1, position: i }));
  if (clean.length) { const r = await dbWrite(() => sb.from('product_components').insert(clean).select(), 'Could not save the playset contents'); state.pc[productId] = r.data; } else state.pc[productId] = [];
}
async function addMovement(m){
  const row = Object.assign({ actor: state.session && state.session.user ? state.session.user.email : null }, m);
  const r = await dbWrite(() => sb.from('movements').insert(row).select().single(), 'Could not log the movement');
  state.movements.unshift(r.data); return r.data;
}
async function deleteMovement(id){ await dbWrite(() => sb.from('movements').delete().eq('id', id), 'Could not remove the entry'); state.movements = state.movements.filter(m => m.id !== id); }
let settingsTimer = null, settingsDirty = false;
let settingsSnapshot = null;
function saveSettingsSoon(){ if (!settingsSnapshot) settingsSnapshot = JSON.parse(JSON.stringify(state.settings)); clearTimeout(settingsTimer); settingsDirty = true; setStatus('saving'); settingsTimer = setTimeout(async () => { try { await dbWrite(() => sb.from('shop_settings').upsert({ id: 1, data: state.settings }), 'Could not save settings'); settingsDirty = false; const before = settingsSnapshot || {}; settingsSnapshot = null; const ch = {}; const flat = o => { const out = {}; Object.keys(o || {}).forEach(k => { if (k === 'linePrices') Object.keys(o[k] || {}).forEach(l => out['price ' + l] = o[k][l] ? o[k][l].cost + '/' + o[k][l].grams + 'g' : null); else if (typeof o[k] !== 'object') out[k] = o[k]; }); return out; }; const a = flat(before), b = flat(state.settings); Object.keys(Object.assign({}, a, b)).forEach(k => { if (String(a[k]) !== String(b[k])) ch[k] = [a[k] === undefined ? null : a[k], b[k] === undefined ? null : b[k]]; }); if (Object.keys(ch).length) logChange('settings', 'settings', null, 'Shop settings', ch); } catch (e) {} }, 600); }

/* ---------------- stock actions ---------------- */
async function receiveSpool(sp, n, note){
  n = Math.max(1, Math.round(n)); const had = rollsOf(sp);
  sp.rolls = had + n; if (had === 0) sp.open_left = effGrams(sp);
  await saveSpool(sp, { silent: true });
  await addMovement({ kind: 'receive', spool_id: sp.id, qty: n, grams: n * effGrams(sp), cost: Math.round(n * effCost(sp) * 100) / 100, note: note || null });
}
async function makeProduct(p, units, note){
  units = Math.max(1, Math.round(units));
  const { c, pulls, parts } = spoolPullFor(p, units); const by = []; const taken = []; const shorts = [];
  for (const pull of pulls) { const sp = state.spools[pull.spoolId]; if (!sp) continue; const rem = consume(sp, pull.grams); await saveSpool(sp, { silent: true }); by.push({ spoolId: sp.id, color: sp.color, lineName: sp.line_name || '', grams: pull.grams, used: Math.round((pull.grams - rem) * 10) / 10 }); if (rem > 0.5) shorts.push(sp.color + ' short ' + grams(rem)); }
  for (const part of parts) { const cp = state.products[part.productId]; if (!cp) continue; const have = num(cp.on_hand); const take = Math.min(have, part.qty); cp.on_hand = Math.round((have - take) * 100) / 100; await saveProduct(cp, { silent: true }); taken.push({ productId: cp.id, name: cp.name, qty: part.qty, taken: take }); if (take < part.qty) shorts.push(cp.name + ' short ' + (Math.round((part.qty - take) * 100) / 100)); }
  p.on_hand = num(p.on_hand) + units; await saveProduct(p, { silent: true });
  await addMovement({ kind: 'made', product_id: p.id, qty: units, grams: Math.round(c.filamentG * units * 10) / 10, cost: Math.round(c.unit * units * 100) / 100, note: note || null, detail: { by, components: taken, unit: c.unit, hours: Math.round(c.hours * units * 100) / 100, short: shorts.join(', ') || null } });
  return { c, shorts };
}
async function receivePart(pt, n, note){
  n = Math.max(0.01, num(n)); pt.on_hand = Math.round((num(pt.on_hand) + n) * 100) / 100; await savePart(pt, { silent: true });
  await addMovement({ kind: 'receive', part_id: pt.id, qty: n, grams: 0, cost: Math.round(n * num(pt.cost) * 100) / 100, note: note || null });
}
async function usePart(pt, n, note){
  n = Math.max(0.01, num(n)); const have = num(pt.on_hand); pt.on_hand = Math.round(Math.max(0, have - n) * 100) / 100; await savePart(pt, { silent: true });
  await addMovement({ kind: 'consume', part_id: pt.id, qty: n, grams: 0, cost: Math.round(n * num(pt.cost) * 100) / 100, note: note || null, detail: { taken: Math.min(have, n), short: n > have ? Math.round((n - have) * 100) / 100 : 0 } });
}
async function adjustPart(pt, newQty, note, reason){
  const from = num(pt.on_hand); newQty = Math.max(0, num(newQty)); if (newQty === from) return;
  pt.on_hand = newQty; await savePart(pt, { silent: true });
  await addMovement({ kind: 'adjust', part_id: pt.id, qty: newQty - from, grams: 0, cost: Math.round(Math.abs(newQty - from) * num(pt.cost) * 100) / 100, note: note || null, reason: reason || null, detail: { from, to: newQty } });
}
async function sellProduct(p, units, note){
  units = Math.max(1, Math.round(units)); const c = productCost(p);
  p.on_hand = Math.max(0, num(p.on_hand) - units); await saveProduct(p, { silent: true });
  await addMovement({ kind: 'sold', product_id: p.id, qty: units, grams: 0, cost: Math.round(c.unit * units * 100) / 100, note: note || null, detail: { unit: c.unit, price: num(p.price), revenue: Math.round(num(p.price) * units * 100) / 100 } });
}
async function adjustProduct(p, newQty, note, reason){
  const from = num(p.on_hand); newQty = Math.max(0, Math.round(newQty)); if (newQty === from) return;
  p.on_hand = newQty; await saveProduct(p, { silent: true });
  await addMovement({ kind: 'adjust', product_id: p.id, qty: newQty - from, grams: 0, cost: Math.round(Math.abs(newQty - from) * productCost(p).unit * 100) / 100, note: note || null, reason: reason || null, detail: { from, to: newQty } });
}
async function adjustSpool(sp, rolls, left, note, reason){
  const from = { rolls: rollsOf(sp), open_left: openLeft(sp) }; const g = effGrams(sp);
  sp.rolls = Math.max(0, Math.round(num(rolls))); sp.open_left = sp.rolls > 0 ? Math.min(g, Math.max(0, num(left))) : 0;
  if (sp.rolls === from.rolls && Math.abs(sp.open_left - from.open_left) < 0.05) return;
  await saveSpool(sp, { silent: true });
  await addMovement({ kind: 'adjust', spool_id: sp.id, qty: sp.rolls - from.rolls, grams: Math.round((spoolAvailable(sp) - ((from.rolls > 0 ? (from.rolls - 1) * g + from.open_left : 0))) * 10) / 10, cost: 0, note: note || null, reason: reason || null, detail: { from, to: { rolls: sp.rolls, open_left: sp.open_left } } });
}
async function undoMovement(m){
  if (m.kind === 'made') { const p = state.products[m.product_id]; ((m.detail && m.detail.by) || []).forEach(b => { const sp = state.spools[b.spoolId]; const g = b.used !== undefined ? num(b.used) : num(b.grams); if (sp && g > 0) restock(sp, g); }); for (const b of ((m.detail && m.detail.by) || [])) { const sp = state.spools[b.spoolId]; if (sp) await saveSpool(sp); } for (const cpart of ((m.detail && m.detail.components) || [])) { const cp = state.products[cpart.productId]; const back = cpart.taken !== undefined ? num(cpart.taken) : num(cpart.qty); if (cp && back > 0) { cp.on_hand = num(cp.on_hand) + back; await saveProduct(cp); } } if (p) { p.on_hand = Math.max(0, num(p.on_hand) - num(m.qty)); await saveProduct(p); } }
  else if (m.kind === 'sold') { const p = state.products[m.product_id]; if (p) { p.on_hand = num(p.on_hand) + num(m.qty); await saveProduct(p); } }
  else if (m.kind === 'consume' && m.part_id) { const pt = state.parts[m.part_id]; if (pt) { const back = m.detail && m.detail.taken !== undefined ? num(m.detail.taken) : num(m.qty); pt.on_hand = Math.round((num(pt.on_hand) + back) * 100) / 100; await savePart(pt); } }
  else if (m.kind === 'receive' && m.part_id) { const pt = state.parts[m.part_id]; if (pt) { pt.on_hand = Math.round(Math.max(0, num(pt.on_hand) - num(m.qty)) * 100) / 100; await savePart(pt); } }
  else if (m.kind === 'receive') { const sp = state.spools[m.spool_id]; if (sp) { sp.rolls = Math.max(0, rollsOf(sp) - Math.round(num(m.qty))); if (sp.rolls === 0) sp.open_left = 0; await saveSpool(sp); } }
  else if (m.kind === 'adjust' && m.part_id) { const pt = state.parts[m.part_id]; if (pt && m.detail) { pt.on_hand = num(m.detail.from); await savePart(pt); } }
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
    const c = productCost(p); const st = productStatus(p); const url = photoUrl(p);
    const dots = isPlayset(p) ? playsetDots(p) : recipe(p).map(r => state.spools[r.spool_id]);
    const sub = isPlayset(p) ? 'Playset · ' + c.comps.length + ' product' + (c.comps.length === 1 ? '' : 's') + (p.sku ? ' · ' + esc(p.sku) : '') : esc(p.sku || p.barcode || '') + (c.n > 1 ? ' · ' + c.n + ' per plate' : '');
    const open = state.ui.openProduct === p.id;
    return '<button class="pcard' + (p.example ? ' ex' : '') + (open ? ' open' : '') + '" data-action="product-open" data-id="' + esc(p.id) + '" aria-expanded="' + open + '">' +
      '<div class="photo">' + (url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : '<span class="ph">no photo yet</span>') +
      '<span class="stock' + (st !== 'ok' ? ' low' : '') + '">' + num(p.on_hand) + (st === 'out' ? ' · out' : st === 'low' ? ' · low' : '') + '</span>' +
      (isPlayset(p) ? '<span class="kindtag">Playset</span>' : '') +
      '<span class="dots">' + dots.slice(0, 8).map(sp => dotHTML(sp, true)).join('') + '</span></div>' +
      '<div class="body"><div class="pn">' + esc(p.name || 'Unnamed product') + (p.archived ? ' <span class="badge-ex">archived</span>' : '') + '</div><div class="sku">' + sub + (p.example ? ' · example' : '') + '</div>' +
      '<div class="nums"><span>cost <b>' + money(c.unit) + '</b></span><span>' + (num(p.price) > 0 ? 'sells <b>' + money(num(p.price)) + '</b>' : 'no price') + '</span>' + (c.margin !== null ? '<span class="m">' + Math.round(c.margin) + '%</span>' : '') + '</div></div></button>' + (open ? productDetailHTML(p) : '');
  }).join('');
  if (!list.length) html = '<div class="empty">' + (state.ui.productFilter === 'archived' ? 'Nothing archived.' : q ? 'No products match that search.' : 'No products yet. Add one, give it a photo and its filaments, and the cost works itself out.') + '</div>';
  $('#productGrid').innerHTML = html; drawCharts($('#productGrid'));
}

// The colors a playset is made of: every spool in its components' recipes, once each.
function playsetDots(p, depth){
  depth = depth || 0; const out = []; const seen = {};
  if (depth > 5) return out;
  components(p).forEach(c => { const cp = state.products[c.component_id]; if (!cp) return; (isPlayset(cp) ? playsetDots(cp, depth + 1) : recipe(cp).map(r => state.spools[r.spool_id])).forEach(sp => { const k = sp ? sp.id : 'missing'; if (!seen[k]) { seen[k] = true; out.push(sp); } }); });
  return out;
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
    return '<button class="shelf-item ' + st + (state.ui.openSpool === sp.id ? ' open' : '') + '" data-action="spool-open" data-id="' + esc(sp.id) + '" title="' + esc(sp.color) + '">' +
      (st !== 'ok' ? '<span class="flag">' + st + '</span>' : '') + (sp.example ? '<span class="ex">example</span>' : '') +
      '<span class="nm">' + esc(sp.color) + '</span><span class="meta">' + esc(sp.line_name || '') + ' · ' + money4(ppg(sp)) + '/g' + (sp.location ? ' · ' + esc(sp.location) : '') + '</span>' +
      '<span class="stock">' + (q === 0 ? 'none on hand' : grams(spoolAvailable(sp)) + ' on hand') + '</span>' +
      '<span class="meter"><i style="width:' + pct.toFixed(0) + '%"></i></span>' +
      spoolSVG(sp, 72) + (q > 1 ? '<span class="rolls">×' + q + '</span>' : '') + '</button>';
  }).join('');
  if (!spools.length) html += '<div class="empty"><span>' + (all.length ? 'Nothing matches that filter.' : 'Nothing on the rack yet. Tap a spool on the color wall to add it with its price and roll size.') + '</span></div>';
  $('#shelves').innerHTML = html;
  const osp = state.ui.openSpool ? state.spools[state.ui.openSpool] : null; $('#spoolPanel').innerHTML = osp ? spoolDetailHTML(osp) : ''; if (!osp) state.ui.openSpool = null; drawCharts($('#spoolPanel'));
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
function movementTarget(m){ return m.product_id ? state.products[m.product_id] : m.spool_id ? state.spools[m.spool_id] : m.part_id ? state.parts[m.part_id] : null; }
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
  document.querySelectorAll('#logViews button').forEach(b => b.classList.toggle('on', b.dataset.k === state.ui.logView));
  // who filter: everyone who shows up anywhere
  const actors = {}; state.movements.forEach(m => { if (m.actor) actors[m.actor] = true; }); state.audit.forEach(a => { if (a.actor) actors[a.actor] = true; }); state.allowedUsers.forEach(e => actors[e] = true);
  const sel = $('#logActor'); const cur = state.ui.logActor; sel.innerHTML = '<option value="all">Everyone</option>' + Object.keys(actors).sort().map(e => '<option value="' + esc(e) + '"' + (e === cur ? ' selected' : '') + '>' + esc(who(e)) + '</option>').join(''); if (!actors[cur] && cur !== 'all') state.ui.logActor = 'all';
  if ($('#logFrom').value !== state.ui.logFrom) $('#logFrom').value = state.ui.logFrom; if ($('#logTo').value !== state.ui.logTo) $('#logTo').value = state.ui.logTo; if ($('#logQ').value !== state.ui.logQ) $('#logQ').value = state.ui.logQ;
  const inRange = iso => { const t = new Date(iso).getTime(); if (state.ui.logFrom && t < new Date(state.ui.logFrom + 'T00:00:00').getTime()) return false; if (state.ui.logTo && t > new Date(state.ui.logTo + 'T23:59:59').getTime()) return false; return true; };
  const q = state.ui.logQ.trim().toLowerCase();
  if (state.ui.logView === 'changes') { renderChanges(inRange, q); return; }
  $('#logChips').innerHTML = ['all', 'made', 'sold', 'receive', 'consume', 'adjust'].map(k => '<button class="chip' + (state.ui.logKind === k ? ' on' : '') + '" data-action="log-kind" data-k="' + k + '">' + (k === 'all' ? 'All' : KIND_LABEL[k]) + '</button>').join('');
  const list = state.movements.filter(m => (state.ui.logKind === 'all' || m.kind === state.ui.logKind) && (state.ui.logActor === 'all' || m.actor === state.ui.logActor) && inRange(m.created_at) && (!q || movementText(m).indexOf(q) >= 0));
  if (!list.length) { $('#logList').innerHTML = '<div class="empty">' + (state.movements.length ? 'Nothing matches those filters.' : 'Nothing here yet. Receive a roll, make something, or sell something and it lands here.') + '</div>'; return; }
  $('#logList').innerHTML = '<table class="list"><tr><th>When</th><th>What</th><th class="n">Qty</th><th class="n">Filament</th><th class="n">Cost</th><th></th></tr>' +
    list.map(m => {
      const p = m.product_id ? state.products[m.product_id] : null; const sp = m.spool_id ? state.spools[m.spool_id] : null; const pt = m.part_id ? state.parts[m.part_id] : null;
      const what = p ? esc(p.name) : sp ? esc(sp.color) + ' · ' + esc(sp.line_name || '') : pt ? esc(pt.name) + (pt.part_no ? ' <span class="sub" style="display:inline">' + esc(pt.part_no) + '</span>' : '') : (m.detail && m.detail.name ? esc(m.detail.name) : '(removed)');
      let sub = '';
      if (m.kind === 'made' && m.detail) sub = ((m.detail.by || []).map(b => esc(b.color) + ' ' + grams(b.grams)).concat((m.detail.components || []).map(cpart => num(cpart.qty) + ' × ' + esc(cpart.name)))).join(', ') + (m.detail.short ? ' · <b style="color:var(--red)">' + esc(m.detail.short) + '</b>' : '');
      if (m.kind === 'sold' && m.detail) sub = (m.detail.revenue ? money(num(m.detail.revenue)) + ' in sales' : 'no price set');
      if (m.kind === 'adjust' && m.detail && m.detail.from !== undefined && typeof m.detail.from !== 'object') sub = m.detail.from + ' → ' + m.detail.to;
      if (m.kind === 'consume' && m.detail && m.detail.short) sub = '<b style="color:var(--red)">only ' + num(m.detail.taken) + ' were there</b>';
      if (m.reason) sub += (sub ? ' · ' : '') + '<b>' + esc(m.reason) + '</b>';
      if (m.note) sub += (sub ? ' · ' : '') + esc(m.note);
      if (m.actor) sub += (sub ? ' · ' : '') + esc(String(m.actor).split('@')[0]);
      const qty = m.kind === 'receive' ? '+' + num(m.qty) + (m.part_id || m.product_id ? '' : ' roll' + (num(m.qty) === 1 ? '' : 's')) : m.kind === 'sold' || m.kind === 'consume' ? '−' + num(m.qty) : m.kind === 'made' ? '+' + num(m.qty) : (num(m.qty) > 0 ? '+' : '') + num(m.qty);
      return '<tr><td>' + esc(dateShort(m.created_at)) + '<span class="sub">' + esc(timeShort(m.created_at)) + '</span></td><td><span class="tag ' + (m.kind === 'sold' ? '' : 'ok') + '">' + (KIND_LABEL[m.kind] || m.kind) + '</span> ' + what + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</td>' +
        '<td class="n">' + qty + '</td><td class="n">' + (num(m.grams) ? grams(num(m.grams)) : '') + '</td><td class="n">' + (num(m.cost) ? money(num(m.cost)) : '') + '</td><td class="n">' + (['made', 'sold', 'receive', 'adjust', 'consume'].indexOf(m.kind) >= 0 ? '<button class="btn ghost small" data-action="log-undo" data-id="' + esc(m.id) + '">Undo</button>' : '') + '</td></tr>';
    }).join('') + '</table>';
}
function movementText(m){ const t = movementTarget(m); const by = (m.detail && m.detail.by || []).map(b => b.color).join(' '); return [t ? (t.name || t.color) : '', t && t.line_name, t && t.sku, t && t.part_no, m.kind, m.reason, m.note, by, m.actor].filter(Boolean).join(' ').toLowerCase(); }
const FIELD_LABEL = { name: 'name', sku: 'SKU', barcode: 'label code', price: 'price', kind: 'type', plate_qty: 'units per plate', plate_hours: 'plate hours', finishing_min: 'finishing min', packaging: 'packaging', reorder_at: 'minimum', max_level: 'maximum', description: 'description', archived: 'archived', photo_path: 'photo', color: 'color', line_name: 'line', cost: 'cost', grams: 'roll size', custom_price: 'own price', location: 'location', notes: 'notes', part_no: 'part number', category: 'type', vendor: 'vendor', link: 'link', model: 'model', serial: 'serial' };
const ACTION_LABEL = { created: 'Created', updated: 'Edited', deleted: 'Deleted', settings: 'Settings', replaced_color: 'Color swap', labels_printed: 'Labels', shop: 'Shop', files: 'Files' };
function changeText(a){ return [a.action, a.entity, a.name, a.actor, a.changes ? Object.keys(a.changes).map(k => (FIELD_LABEL[k] || k) + ' ' + JSON.stringify(a.changes[k])).join(' ') : ''].filter(Boolean).join(' ').toLowerCase(); }
function fmtChange(k, v){ const f = FIELD_LABEL[k] || k; const show = x => x === null || x === undefined ? '—' : k === 'photo_path' ? (x ? 'set' : 'none') : typeof x === 'boolean' ? (x ? 'yes' : 'no') : ['price', 'cost', 'packaging'].indexOf(k) >= 0 ? money(num(x)) : String(x).length > 40 ? String(x).slice(0, 40) + '…' : String(x); return '<span class="chg">' + esc(f) + ' <b>' + esc(show(v[0])) + ' → ' + esc(show(v[1])) + '</b></span>'; }
function renderChanges(inRange, q){
  const ents = ['all', 'product', 'spool', 'part', 'printer', 'settings'];
  $('#logChips').innerHTML = ents.map(k => '<button class="chip' + (state.ui.logEntity === k || (!state.ui.logEntity && k === 'all') ? ' on' : '') + '" data-action="log-entity" data-k="' + k + '">' + (k === 'all' ? 'Everything' : k === 'spool' ? 'Filament' : k.charAt(0).toUpperCase() + k.slice(1) + 's') + '</button>').join('');
  const ent = state.ui.logEntity || 'all';
  const list = state.audit.filter(a => (ent === 'all' || a.entity === ent) && (state.ui.logActor === 'all' || a.actor === state.ui.logActor) && inRange(a.created_at) && (!q || changeText(a).indexOf(q) >= 0));
  if (!list.length) { $('#logList').innerHTML = '<div class="empty">' + (state.audit.length ? 'Nothing matches those filters.' : 'No changes recorded yet. Creating, editing or deleting anything lands here.') + '</div>'; return; }
  $('#logList').innerHTML = '<table class="list"><tr><th>When</th><th>What changed</th><th>By</th></tr>' + list.map(a => {
    const changes = a.changes && typeof a.changes === 'object' ? Object.keys(a.changes).map(k => Array.isArray(a.changes[k]) ? fmtChange(k, a.changes[k]) : '<span class="chg">' + esc(k) + ' <b>' + esc(typeof a.changes[k] === 'object' ? JSON.stringify(a.changes[k]) : String(a.changes[k])) + '</b></span>').join('') : '';
    const open = a.entity === 'product' && state.products[a.entity_id] ? ' <button class="btn ghost small" data-action="product-open" data-id="' + esc(a.entity_id) + '">Open</button>' : a.entity === 'spool' && state.spools[a.entity_id] ? ' <button class="btn ghost small" data-action="spool-open" data-id="' + esc(a.entity_id) + '">Open</button>' : a.entity === 'part' && state.parts[a.entity_id] ? ' <button class="btn ghost small" data-action="part-open" data-id="' + esc(a.entity_id) + '">Open</button>' : '';
    return '<tr><td>' + esc(dateShort(a.created_at)) + '<span class="sub">' + esc(timeShort(a.created_at)) + '</span></td><td><span class="tag ' + (a.action === 'deleted' ? '' : 'ok') + '">' + esc(ACTION_LABEL[a.action] || a.action) + '</span> <span class="pbadge">' + esc(a.entity === 'spool' ? 'filament' : a.entity) + '</span> ' + esc(a.name || '') + open + (changes ? '<span class="sub">' + changes + '</span>' : '') + '</td><td>' + esc(who(a.actor)) + '</td></tr>';
  }).join('') + '</table>';
}
const csvq = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
function logCSV(){
  if (state.ui.logView === 'changes') { const rows = [['when', 'action', 'entity', 'name', 'changes', 'by']]; state.audit.slice().reverse().forEach(a => rows.push([a.created_at, a.action, a.entity, a.name || '', a.changes ? JSON.stringify(a.changes) : '', a.actor || ''])); return rows.map(r => r.map(csvq).join(',')).join('\n'); }
  const rows = [['when', 'kind', 'item', 'qty', 'grams', 'cost', 'revenue', 'detail', 'reason', 'note', 'by']];
  state.movements.slice().reverse().forEach(m => { const p = m.product_id ? state.products[m.product_id] : null; const sp = m.spool_id ? state.spools[m.spool_id] : null; const pt = m.part_id ? state.parts[m.part_id] : null; rows.push([m.created_at, m.kind, p ? p.name : sp ? sp.color + ' ' + (sp.line_name || '') : pt ? pt.name + (pt.part_no ? ' ' + pt.part_no : '') : '', num(m.qty), num(m.grams), num(m.cost), m.detail && m.detail.revenue ? num(m.detail.revenue) : '', m.detail ? (m.detail.by || []).map(b => b.color + ' ' + b.grams + 'g').concat((m.detail.components || []).map(cpart => cpart.qty + ' x ' + cpart.name)).join('; ') : '', m.reason || '', m.note || '', m.actor || '']); });
  return rows.map(r => r.map(csvq).join(',')).join('\n');
}

/* ---------------- render: reorder ---------------- */
function reorderRows(){
  const spools = sortSpools(Object.values(state.spools)).filter(sp => spoolStatus(sp) !== 'ok').map(sp => ({ kind: 'spool', sp, status: spoolStatus(sp), avail: spoolAvailable(sp), at: reorderPoint(sp), cost: effCost(sp) }));
  const products = sortProducts(Object.values(state.products).filter(p => !p.archived && productStatus(p) !== 'ok')).map(p => ({ kind: 'product', p, status: productStatus(p), have: num(p.on_hand), at: productMin(p), need: Math.max(0, productMin(p) - num(p.on_hand)), cost: productCost(p).unit }));
  const parts = sortParts(Object.values(state.parts).filter(pt => !pt.archived && partStatus(pt) !== 'ok')).map(pt => ({ kind: 'part', pt, status: partStatus(pt), have: num(pt.on_hand), at: partMin(pt), need: Math.max(0, partMin(pt) - num(pt.on_hand)), cost: num(pt.cost) }));
  return { spools, products, parts };
}
function renderReorder(){
  const r = reorderRows(); const total = r.spools.length + r.products.length + r.parts.length; const nr = $('#navReorder'); nr.hidden = !total; nr.textContent = total;
  if (!total) { $('#reorderList').innerHTML = '<div class="empty">Every spool is above its reorder point, every product is above its shelf minimum, and no part is running out.</div>'; return; }
  let html = '';
  if (r.spools.length) html += '<table class="list"><tr><th>Filament to buy</th><th></th><th class="n">On hand</th><th class="n">Reorder below</th><th class="n">One roll</th></tr>' + r.spools.map(x => '<tr><td>' + dotHTML(x.sp) + ' ' + esc(x.sp.color) + '<span class="sub">' + esc(x.sp.line_name || '') + (x.sp.location ? ' · ' + esc(x.sp.location) : '') + '</span></td><td><span class="tag">' + x.status + '</span></td><td class="n">' + grams(x.avail) + '</td><td class="n">' + grams(x.at) + '</td><td class="n">' + money(x.cost) + '</td></tr>').join('') + '<tr class="total"><td colspan="4">' + r.spools.length + ' spool' + (r.spools.length === 1 ? '' : 's') + ', one roll each</td><td class="n">' + money(r.spools.reduce((a, x) => a + x.cost, 0)) + '</td></tr></table>';
  if (r.products.length) html += '<table class="list" style="margin-top:18px"><tr><th>Products to make</th><th></th><th class="n">On shelf</th><th class="n">Minimum</th><th class="n">To make</th><th class="n">Filament cost</th></tr>' + r.products.map(x => '<tr><td>' + esc(x.p.name) + '<span class="sub">' + esc(x.p.sku || '') + '</span></td><td><span class="tag">' + x.status + '</span></td><td class="n">' + x.have + '</td><td class="n">' + x.at + '</td><td class="n">' + x.need + '</td><td class="n">' + money(x.need * x.cost) + '</td></tr>').join('') + '</table>';
  if (r.parts.length) html += '<table class="list" style="margin-top:18px"><tr><th>Parts to buy</th><th></th><th class="n">On hand</th><th class="n">Reorder below</th><th class="n">To buy</th><th class="n">Cost</th></tr>' + r.parts.map(x => '<tr><td>' + esc(x.pt.name) + '<span class="sub">' + esc([x.pt.part_no, x.pt.vendor, fitsText(x.pt)].filter(Boolean).join(' · ')) + '</span></td><td><span class="tag">' + x.status + '</span></td><td class="n">' + x.have + '</td><td class="n">' + x.at + '</td><td class="n">' + x.need + '</td><td class="n">' + money(x.need * x.cost) + '</td></tr>').join('') + '</table>';
  $('#reorderList').innerHTML = html;
}
function reorderText(){
  const r = reorderRows(); const L = ['MOSTLY 3D · REORDER · ' + new Date().toLocaleDateString('en-US')];
  if (r.spools.length) { L.push('FILAMENT'); r.spools.forEach(x => L.push('  ' + x.sp.color + ' · ' + (x.sp.line_name || '') + '  (' + x.status + ', ' + grams(x.avail) + ' on hand)  ' + money(x.cost) + ' a roll')); }
  if (r.products.length) { L.push('MAKE'); r.products.forEach(x => L.push('  ' + x.need + ' × ' + x.p.name + '  (' + x.have + ' on shelf, minimum ' + x.at + ')')); }
  if (r.parts.length) { L.push('PARTS'); r.parts.forEach(x => L.push('  ' + x.need + ' × ' + x.pt.name + (x.pt.part_no ? ' (' + x.pt.part_no + ')' : '') + (x.pt.vendor ? ' from ' + x.pt.vendor : '') + '  (' + x.have + ' on hand)')); }
  if (!r.spools.length && !r.products.length && !r.parts.length) L.push('  Nothing to reorder.');
  return L.join('\n');
}

/* ---------------- render: labels ---------------- */
function renderLabels(){
  $('#labelChips').innerHTML = ['spools', 'products', 'parts'].map(k => '<button class="chip' + (state.ui.labelKind === k ? ' on' : '') + '" data-action="label-kind" data-k="' + k + '">' + (k === 'spools' ? 'Spools' : k === 'products' ? 'Products' : 'Parts') + '</button>').join('');
  let items = state.ui.labelKind === 'spools' ? sortSpools(Object.values(state.spools)).map(sp => ({ id: sp.id, code: sp.barcode, name: sp.color, sub: sp.line_name || '' })) : state.ui.labelKind === 'parts' ? sortParts(Object.values(state.parts).filter(pt => !pt.archived)).map(pt => ({ id: pt.id, code: pt.barcode || pt.part_no, name: pt.name, sub: [pt.part_no, fitsText(pt)].filter(Boolean).join(' · ') })) : sortProducts(Object.values(state.products).filter(p => !p.archived)).map(p => ({ id: p.id, code: p.barcode || p.sku, name: p.name, sub: p.sku || '' }));
  items = items.filter(i => i.code);
  if (!items.length) { $('#labelGrid').innerHTML = '<div class="empty">Nothing to label yet.</div>'; return; }
  $('#labelGrid').innerHTML = items.map(i => '<div class="label"><div class="ln">' + esc(i.name) + '</div><div class="ls">' + esc(i.sub) + '</div><svg class="bc" data-code="' + esc(i.code) + '"></svg></div>').join('');
  if (window.JsBarcode) document.querySelectorAll('#labelGrid svg.bc').forEach(el => { try { window.JsBarcode(el, el.dataset.code, { format: 'CODE128', width: 1.6, height: 44, fontSize: 12, margin: 4, displayValue: true }); } catch (e) {} });
  else $('#labelGrid').insertAdjacentHTML('afterbegin', '<p class="fine" style="grid-column:1/-1">Barcode drawing is still loading; reload if the bars do not appear.</p>');
}


/* ---------------- render: home ---------------- */
const TABS = { home: ['home', 'reorder'], products: ['products'], filament: ['rack', 'wall'], parts: ['parts'], log: ['log'], labels: ['labels'], settings: ['settings'] };
function applyTab(){
  const tab = TABS[state.ui.tab] ? state.ui.tab : 'home'; const show = TABS[tab];
  document.querySelectorAll('section.sec').forEach(sec => { sec.hidden = show.indexOf(sec.id) < 0; sec.classList.toggle('tab-last', sec.id === show[show.length - 1]); });
  document.querySelectorAll('nav.steps a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
}
function goTab(tab, anchor){
  if (!TABS[tab]) tab = 'home'; state.ui.tab = tab; applyTab(); drawCharts();
  try { history.replaceState(null, '', '#' + tab); } catch (e) {}
  const el = anchor ? document.getElementById(anchor) : null;
  if (el) el.scrollIntoView({ block: 'start' }); else window.scrollTo({ top: 0 });
}
function fitsText(pt){ const prs = partPrinters(pt); return prs.length ? prs.map(p => p.name).join(', ') : 'any printer'; }
function renderHome(){
  const products = Object.values(state.products).filter(p => !p.archived); let units = 0, retail = 0, lowP = 0;
  products.forEach(p => { const n = num(p.on_hand); units += n; retail += n * num(p.price); if (productStatus(p) !== 'ok') lowP++; });
  const spools = Object.values(state.spools); let onHand = 0, fval = 0, lowS = 0;
  spools.forEach(sp => { const a = spoolAvailable(sp); onHand += a; fval += a * ppg(sp); if (spoolStatus(sp) !== 'ok') lowS++; });
  const parts = Object.values(state.parts).filter(pt => !pt.archived); let pval = 0, lowA = 0;
  parts.forEach(pt => { pval += num(pt.on_hand) * num(pt.cost); if (partStatus(pt) !== 'ok') lowA++; });
  const now = new Date(); const m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); let made = 0, sold = 0, revenue = 0, cogs = 0;
  state.movements.forEach(m => { if (new Date(m.created_at).getTime() < m0) return; if (m.kind === 'made' && m.product_id) made += num(m.qty); if (m.kind === 'sold') { sold += num(m.qty); cogs += num(m.cost); revenue += num(m.detail && m.detail.revenue); } });
  const monthName = now.toLocaleDateString('en-US', { month: 'long' });
  const tile = (tab, label, value, sub, cls) => '<button class="tile-num link' + (cls ? ' ' + cls : '') + '" data-action="go" data-tab="' + tab + '"><span class="tl">' + label + '</span><span class="tv">' + value + '</span><span class="ts">' + sub + '</span></button>';
  $('#homeTiles').innerHTML =
    tile('products', 'Products', units, products.length + ' product' + (products.length === 1 ? '' : 's') + ' · ' + money(retail) + ' at retail', lowP ? 'alert' : '') +
    tile('filament', 'Filament', kg(onHand), spools.length + ' spool' + (spools.length === 1 ? '' : 's') + ' · ' + money(fval) + ' on the rack', lowS ? 'alert' : '') +
    tile('parts', 'Parts', parts.length, (lowA ? lowA + ' running out · ' : '') + money(pval) + ' in the drawer', lowA ? 'alert' : '') +
    tile('log', monthName, money(revenue), sold + ' sold · ' + made + ' made · ' + money(revenue - cogs) + ' gross profit', 'accent');
  const r = reorderRows(); const rows = [];
  r.products.forEach(x => rows.push('<div class="attn"><span class="tag">' + x.status + '</span><span class="what">' + esc(x.p.name) + '<span class="sub">' + x.have + ' on the shelf, minimum ' + x.at + ' · make ' + x.need + '</span></span><button class="btn ghost small" data-action="product-open" data-id="' + esc(x.p.id) + '">Open</button></div>'));
  r.spools.forEach(x => rows.push('<div class="attn"><span class="tag">' + x.status + '</span><span class="what">' + dotHTML(x.sp, true) + ' ' + esc(x.sp.color) + ' <span class="sub">' + esc(x.sp.line_name || '') + ' · ' + grams(x.avail) + ' left, reorder below ' + grams(x.at) + ' · ' + money(x.cost) + ' a roll</span></span><button class="btn ghost small" data-action="spool-open" data-id="' + esc(x.sp.id) + '">Open</button></div>'));
  r.parts.forEach(x => rows.push('<div class="attn"><span class="tag">' + x.status + '</span><span class="what">' + esc(x.pt.name) + '<span class="sub">' + x.have + ' on hand, reorder below ' + x.at + (x.pt.vendor ? ' · ' + esc(x.pt.vendor) : '') + '</span></span><button class="btn ghost small" data-action="part-open" data-id="' + esc(x.pt.id) + '">Open</button></div>'));
  $('#homeAttention').innerHTML = (rows.length ? rows.slice(0, 8).join('') : '<div class="attn"><span class="what" style="color:var(--ink-3)">Everything is stocked.</span></div>') + (rows.length > 8 ? '<button class="more" data-action="go" data-tab="home" data-anchor="reorder">All ' + rows.length + ' on the reorder list</button>' : rows.length ? '<button class="more" data-action="go" data-tab="home" data-anchor="reorder">Full reorder list</button>' : '');
  const recent = state.movements.slice(0, 8).map(m => { const t = movementTarget(m); const name = t ? (t.name || t.color) : '(removed)'; const q = m.kind === 'sold' || m.kind === 'consume' ? '−' + num(m.qty) : m.kind === 'adjust' ? (num(m.qty) > 0 ? '+' : '') + num(m.qty) : '+' + num(m.qty); return '<div class="attn"><span class="tag ' + (m.kind === 'sold' ? '' : 'ok') + '">' + (KIND_LABEL[m.kind] || m.kind) + '</span><span class="what">' + esc(name) + '<span class="sub">' + esc(dateShort(m.created_at)) + ' ' + esc(timeShort(m.created_at)) + (m.actor ? ' · ' + esc(String(m.actor).split('@')[0]) : '') + '</span></span><b style="font-variant-numeric:tabular-nums">' + q + '</b></div>'; });
  $('#homeRecent').innerHTML = (recent.length ? recent.join('') : '<div class="attn"><span class="what" style="color:var(--ink-3)">Nothing has moved yet.</span></div>') + (state.movements.length ? '<button class="more" data-action="go" data-tab="log">Full activity</button>' : '');
}

/* ---------------- render: parts ---------------- */
function renderParts(){
  const all = sortParts(Object.values(state.parts).filter(pt => !pt.archived));
  let onHand = 0, value = 0, low = 0; const cats = {};
  all.forEach(pt => { onHand += num(pt.on_hand); value += num(pt.on_hand) * num(pt.cost); if (partStatus(pt) !== 'ok') low++; if (pt.category) cats[pt.category] = true; });
  const printers = sortPrinters(Object.values(state.printers));
  $('#partTiles').innerHTML =
    '<div class="tile-num"><span class="tl">Parts</span><span class="tv">' + all.length + '</span><span class="ts">different items</span></div>' +
    '<div class="tile-num"><span class="tl">On hand</span><span class="tv">' + Math.round(onHand * 100) / 100 + '</span><span class="ts">pieces in the drawer</span></div>' +
    '<div class="tile-num"><span class="tl">Value</span><span class="tv">' + money(value) + '</span><span class="ts">at cost</span></div>' +
    '<div class="tile-num"><span class="tl">Printers</span><span class="tv">' + printers.length + '</span><span class="ts">' + (printers.length ? printers.map(p => esc(p.name)).join(', ') : 'add yours') + '</span></div>' +
    '<div class="tile-num' + (low ? ' alert' : '') + '"><span class="tl">Running out</span><span class="tv">' + low + '</span><span class="ts">' + (low ? 'below reorder point' : 'all stocked') + '</span></div>';
  const nl = $('#navPartsLow'); nl.hidden = !low; nl.textContent = low;
  let chips = '<button class="chip' + (state.ui.partPrinter === 'all' ? ' on' : '') + '" data-action="part-printer" data-id="all">All</button>' +
    printers.map(p => '<button class="chip' + (state.ui.partPrinter === p.id ? ' on' : '') + '" data-action="part-printer" data-id="' + esc(p.id) + '">' + esc(p.name) + '</button>').join('') +
    (printers.length ? '<button class="chip' + (state.ui.partPrinter === 'any' ? ' on' : '') + '" data-action="part-printer" data-id="any">Fits any</button>' : '') +
    '<button class="chip red' + (state.ui.partLowOnly ? ' on' : '') + '" data-action="part-low">Running out</button>';
  const catList = Object.keys(cats).sort();
  if (catList.length) chips += '<span style="flex-basis:100%;height:0"></span><button class="chip' + (state.ui.partCat === 'all' ? ' on' : '') + '" data-action="part-cat" data-k="all">All types</button>' + catList.map(k => '<button class="chip' + (state.ui.partCat === k ? ' on' : '') + '" data-action="part-cat" data-k="' + esc(k) + '">' + esc(k) + '</button>').join('');
  $('#partChips').innerHTML = chips;
  const q = state.ui.partQ.trim().toLowerCase(); const pf = state.ui.partPrinter;
  let list = all.filter(pt => {
    const prs = state.pp[pt.id] || [];
    if (pf === 'any') return !prs.length;
    if (pf !== 'all') return !prs.length || prs.indexOf(pf) >= 0; // a printer's view includes the parts that fit anything
    return true;
  });
  if (state.ui.partCat !== 'all') list = list.filter(pt => pt.category === state.ui.partCat);
  if (state.ui.partLowOnly) list = list.filter(pt => partStatus(pt) !== 'ok');
  if (q) list = list.filter(pt => [pt.name, pt.part_no, pt.barcode, pt.category, pt.vendor, pt.location, pt.notes, fitsText(pt)].join(' ').toLowerCase().indexOf(q) >= 0);
  $('#partList').innerHTML = list.length ? list.map(pt => {
    const st = partStatus(pt); const prs = partPrinters(pt); const url = photoUrl(pt); const open = state.ui.openPart === pt.id;
    return '<div class="prow' + (st !== 'ok' ? ' low' : '') + (open ? ' open' : '') + '">' +
      '<button class="thumb" data-action="part-open" data-id="' + esc(pt.id) + '" aria-label="Open ' + esc(pt.name) + '">' + (url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : esc((pt.category || 'part').slice(0, 4))) + '</button>' +
      '<div><div class="nm"><button class="linklike" data-action="part-open" data-id="' + esc(pt.id) + '">' + esc(pt.name) + '</button>' + (st !== 'ok' ? ' <span class="tag">' + st + '</span>' : '') + '</div><div class="meta">' + (pt.part_no ? '<span>' + esc(pt.part_no) + '</span>' : '') + (pt.vendor ? '<span>' + esc(pt.vendor) + '</span>' : '') + (pt.location ? '<span>' + esc(pt.location) + '</span>' : '') + '<span class="fits">' + (prs.length ? prs.map(p => '<span>' + esc(p.name) + '</span>').join('') : '<span class="any">any printer</span>') + '</span></div></div>' +
      '<div class="cat">' + (pt.category ? '<span class="pbadge">' + esc(pt.category) + '</span>' : '') + '</div>' +
      '<div class="qty"><button class="iconbtn" data-action="part-minus" data-id="' + esc(pt.id) + '" aria-label="Used one">−</button><b>' + num(pt.on_hand) + '</b><button class="iconbtn" data-action="part-plus" data-id="' + esc(pt.id) + '" aria-label="Received one">+</button></div>' +
      '<div class="cost">' + (num(pt.cost) ? '<b>' + money(num(pt.cost)) + '</b>each' : '<b>—</b>no cost') + '</div>' +
      '<button class="iconbtn" data-action="part-edit" data-id="' + esc(pt.id) + '" aria-label="Edit">✎</button></div>' + (open ? partDetailHTML(pt) : '');
  }).join('') : '<div class="empty">' + (all.length ? 'No parts match.' : 'No parts yet. Add a nozzle, a hotend, a build plate, and tie each one to the printers it fits. Scanning an unknown barcode in Receive mode can create a part on the spot.') + '</div>';
  drawCharts($('#partList'));
}

/* ---------------- parts: modals ---------------- */
let partDraft = null;
function openPartModal(id, prefill){
  const pt = id ? state.parts[id] : null;
  partDraft = pt ? Object.assign({}, pt) : Object.assign({ name: '', part_no: '', barcode: '', category: '', cost: 0, vendor: '', link: '', location: '', on_hand: 0, reorder_at: null, photo_path: null, notes: '', archived: false }, prefill || {});
  partDraft._printers = pt ? (state.pp[pt.id] || []).slice() : []; partDraft._photoFile = null; partDraft._photoPreview = photoUrl(pt);
  renderPartModal();
}
function renderPartModal(keepFocus){
  const p = partDraft; const printers = sortPrinters(Object.values(state.printers)); const st = p.id ? partStatus(p) : 'ok';
  const v = k => (num(p[k]) > 0 ? num(p[k]) : '');
  const html = '<div class="mh"><div><h3>' + (p.id ? 'Edit part' : 'New part') + '</h3><div class="sub">' + (p.id ? esc(p.name) + (p.barcode ? ' · label ' + esc(p.barcode) : '') : 'A spare, a tool, a consumable, or an accessory') + '</div></div></div>' +
    '<div class="pedit"><div>' +
      '<div class="photo" id="pPhoto" style="aspect-ratio:3/2">' + (p._photoPreview ? '<img src="' + esc(p._photoPreview) + '" alt="">' : '<span class="ph">Photo (optional)</span>') + '</div>' +
      '<div class="photo-acts"><input type="file" id="pPhotoFile" accept="image/*" hidden><button class="btn ghost small" data-action="pphoto-pick">' + (p._photoPreview ? 'Change photo' : 'Add photo') + '</button>' + (p._photoPreview ? '<button class="btn ghost small" data-action="pphoto-clear">Remove</button>' : '') + '</div>' +
      '<div class="fields" style="margin-top:12px">' + fld('a_name', 'Name', 'text', p.name || '', { wide: true, placeholder: '0.4 mm hardened steel nozzle' }) + fld('a_partno', 'Part number', 'text', p.part_no || '', { placeholder: 'Vendor or Bambu part no.' }) +
      '<div class="field"><label for="a_cat">Type</label><input id="a_cat" list="partCats" value="' + esc(p.category || '') + '" placeholder="Nozzle, belt, tool…"><datalist id="partCats">' + PART_CATS.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist></div>' +
      fld('a_cost', 'Cost each ($)', 'number', v('cost')) + fld('a_vendor', 'Vendor', 'text', p.vendor || '', { placeholder: 'Bambu store, Amazon…' }) + fld('a_link', 'Reorder link', 'text', p.link || '', { wide: true, placeholder: 'https://' }) +
      fld('a_loc', 'Location', 'text', p.location || '', { placeholder: 'Drawer, bin' }) + fld('a_reorder', 'Reorder below', 'number', (p.reorder_at !== null && p.reorder_at !== undefined) ? p.reorder_at : '', { placeholder: 'default ' + num(state.settings.partReorderAt) }) +
      (p.id ? '' : fld('a_onhand', 'On hand now', 'number', v('on_hand'))) + fld('a_barcode', 'Label code', 'text', p.barcode || '', { placeholder: 'made for you if blank', hint: 'Or scan the package barcode here to use it instead' }) +
      '<div class="field wide"><label for="a_notes">Notes</label><textarea id="a_notes" placeholder="Torque, which side, when to replace">' + esc(p.notes || '') + '</textarea></div></div>' +
    '</div><div>' +
      '<div class="field"><label>Fits which printers</label><small>' + (printers.length ? 'Leave all unticked for a part that fits anything.' : 'No printers yet; add them with the Printers button on the Parts page.') + '</small></div>' +
      '<div class="checks">' + printers.map(pr => '<label class="' + (p._printers.indexOf(pr.id) >= 0 ? 'on' : '') + '"><input type="checkbox" data-printer="' + esc(pr.id) + '"' + (p._printers.indexOf(pr.id) >= 0 ? ' checked' : '') + '>' + esc(pr.name) + (pr.model ? ' <span style="opacity:.7">' + esc(pr.model) + '</span>' : '') + '</label>').join('') + '</div>' +
      (p.id ? '<div class="stockline"><span class="onhand' + (st !== 'ok' ? ' low' : '') + '" id="aOnHand">' + num(p.on_hand) + '</span><span style="font-size:12.5px;color:var(--ink-2)">on hand</span><span style="flex:1"></span><input id="aN" type="number" inputmode="decimal" min="0" step="any" value="1" aria-label="How many"><button class="btn small" data-action="part-recv">Received</button><button class="btn red small" data-action="part-use">Used</button><button class="btn ghost small" data-action="adjust-open" data-kind="part" data-id="' + esc(p.id) + '">Adjust…</button></div><div id="aConfirm"></div>' : '') +
      '<div class="costbox" style="margin-top:14px"><div class="big"><span>Worth on hand</span><b>' + money(num(p.on_hand) * num(p.cost)) + '</b></div><div class="margin">' + num(p.on_hand) + ' × ' + money(num(p.cost)) + (p.link ? ' · <a href="' + esc(p.link) + '" target="_blank" rel="noopener" style="color:var(--red)">reorder link</a>' : '') + '</div></div>' +
    '</div></div>' +
    '<div class="acts">' + (p.id ? '<span style="display:flex;gap:6px"><button class="btn ghost" data-action="part-archive">' + (p.archived ? 'Unarchive' : 'Archive') + '</button><button class="btn danger" data-action="part-delete">Delete</button></span>' : '<span></span>') + '<span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="part-save">' + (p.id ? 'Save' : 'Add part') + '</button></span></div>';
  if (keepFocus && !$('#modal').hidden) { const box = $('#modal .box'); box.innerHTML = html; } else openModal(html, true);
}
function readPartForm(){
  const p = partDraft;
  p.name = $('#a_name').value.trim(); p.part_no = $('#a_partno').value.trim() || null; p.category = $('#a_cat').value.trim() || null; p.cost = num($('#a_cost').value);
  p.vendor = $('#a_vendor').value.trim() || null; p.link = $('#a_link').value.trim() || null; p.location = $('#a_loc').value.trim() || null;
  p.reorder_at = $('#a_reorder').value === '' ? null : num($('#a_reorder').value); p.barcode = $('#a_barcode').value.trim() || null; p.notes = $('#a_notes').value.trim() || null;
  const oh = $('#a_onhand'); if (oh) p.on_hand = num(oh.value);
  p._printers = Array.from(document.querySelectorAll('#modal input[data-printer]:checked')).map(el => el.dataset.printer);
}
async function savePartFromModal(){
  readPartForm(); if (!partDraft.name) { toast('Give the part a name', true); $('#a_name').focus(); return; }
  const isNew = !partDraft.id; const row = Object.assign({}, partDraft); const printers = row._printers; delete row._printers; delete row._photoFile; delete row._photoPreview;
  if (!row.barcode) row.barcode = code('A-'); if (isNew) delete row.id;
  try {
    const saved = await savePart(row);
    if (partDraft._photoFile) { const blob = await resizeImage(partDraft._photoFile); const path = 'parts/' + saved.id + '/' + Date.now() + '.jpg'; const up = await sb.storage.from(CONFIG.photoBucket).upload(path, blob, { contentType: 'image/jpeg', upsert: true }); if (up.error) fail(up.error, 'Could not upload the photo'); else { const old = saved.photo_path; saved.photo_path = path; await savePart(saved); if (old && old !== path) removePhotos([old]); } }
    else if (partDraft._photoPreview === '' && saved.photo_path) { const old = saved.photo_path; saved.photo_path = null; await savePart(saved); removePhotos([old]); }
    await savePartPrinters(saved.id, printers);
    if (isNew && num(saved.on_hand) > 0) await addMovement({ kind: 'receive', part_id: saved.id, qty: num(saved.on_hand), grams: 0, cost: Math.round(num(saved.on_hand) * num(saved.cost) * 100) / 100, note: 'added' });
    closeModal(); toast(isNew ? saved.name + ' added' : 'Saved'); renderAll();
  } catch (e) {}
}
const REASONS = ['Miscount', 'Damaged or failed', 'Gift or sample', 'Returned', 'Lost', 'Used in-house', 'Opening count', 'Other'];
function openAdjustModal(kind, id){
  const item = kind === 'product' ? state.products[id] : kind === 'spool' ? state.spools[id] : state.parts[id]; if (!item) return;
  const name = kind === 'spool' ? item.color + ' · ' + (item.line_name || '') : item.name;
  const current = kind === 'spool' ? grams(spoolAvailable(item)) + ' on hand (' + rollsOf(item) + ' roll' + (rollsOf(item) === 1 ? '' : 's') + ', ' + grams(openLeft(item)) + ' on the open one)' : num(item.on_hand) + ' on hand';
  const fields = kind === 'spool'
    ? fld('adj_rolls', 'Rolls on hand', 'number', rollsOf(item), { hint: 'Including the open one' }) + fld('adj_left', 'Left on the open roll (g)', 'number', rollsOf(item) ? openLeft(item) : 0)
    : fld('adj_qty', 'New count', 'number', num(item.on_hand));
  openModal('<div class="mh"><div><h3>Adjust ' + (kind === 'spool' ? 'filament' : 'count') + '</h3><div class="sub">' + esc(name) + ' · ' + esc(current) + '</div></div></div>' +
    '<div class="fields">' + fields + '</div>' +
    '<div class="field" style="margin-top:12px"><label>Reason</label><div class="reasons checks">' + REASONS.map((r, i) => '<label class="' + (i === 0 ? 'on' : '') + '"><input type="radio" name="adjReason" value="' + esc(r) + '"' + (i === 0 ? ' checked' : '') + '>' + esc(r) + '</label>').join('') + '</div></div>' +
    '<div class="field" style="margin-top:10px"><label for="adj_note">Note</label><input id="adj_note" type="text" placeholder="What happened (optional)"></div>' +
    '<p class="note">Adjustments are logged with the reason so counts can be explained later. Use Made, Sold, Received or Used for the normal moves.</p>' +
    '<div class="acts"><span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="adjust-save" data-kind="' + kind + '" data-id="' + esc(id) + '">Save adjustment</button></span></div>');
}
function openPrintersModal(){
  const printers = sortPrinters(Object.values(state.printers));
  openModal('<div class="mh"><div><h3>Your printers</h3><div class="sub">Parts get tied to these, so a scan says which machine a part belongs to.</div></div></div>' +
    '<div class="printer-list" id="printerList">' + (printers.length ? printers.map(pr => '<div class="prl"><input type="text" value="' + esc(pr.name) + '" data-printer-name="' + esc(pr.id) + '" aria-label="Printer name"><input type="text" value="' + esc(pr.model || '') + '" placeholder="model, e.g. X1 Carbon" data-printer-model="' + esc(pr.id) + '" aria-label="Model"><button class="btn ghost small" data-action="printer-remove" data-id="' + esc(pr.id) + '">Remove</button></div>').join('') : '<p class="note">No printers yet.</p>') + '</div>' +
    '<form class="row" id="printerForm" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><input id="printerName" type="text" placeholder="name, e.g. X1C #1" required style="flex:1 1 140px;border:1px solid var(--line-2);border-radius:999px;padding:8px 14px"><input id="printerModel" type="text" placeholder="model, e.g. X1 Carbon" style="flex:1 1 140px;border:1px solid var(--line-2);border-radius:999px;padding:8px 14px"><button class="btn small" type="submit">Add printer</button></form>' +
    '<div class="acts"><span class="r"><button class="btn ghost" data-action="modal-close">Close</button><button class="btn" data-action="printers-save">Save names</button></span></div>');
  setTimeout(() => { const f = $('#printerName'); if (f && !printers.length) f.focus(); }, 30);
}


/* ---------------- usage: weekly buckets + charts ---------------- */
const WEEKS = 12;
function weekStart(d){ const x = new Date(d); x.setHours(0, 0, 0, 0); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; }
function weekBuckets(){ const out = []; const w0 = weekStart(new Date()); for (let i = WEEKS - 1; i >= 0; i--) { const d = new Date(w0); d.setDate(d.getDate() - i * 7); out.push(d); } return out; }
function bucketIndex(buckets, iso){ const t = new Date(iso).getTime(); for (let i = buckets.length - 1; i >= 0; i--) if (t >= buckets[i].getTime()) return i; return -1; }
const wkLabel = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
// Returns { buckets, series: [{ name, color, values[] }], totals }
function usageFor(kind, id){
  const buckets = weekBuckets(); const z = () => buckets.map(() => 0);
  if (kind === 'product') {
    const made = z(), sold = z(); let madeAll = 0, soldAll = 0, revenue = 0, lastMade = null, lastSold = null;
    state.movements.forEach(m => { if (m.product_id !== id) return; const i = bucketIndex(buckets, m.created_at); if (m.kind === 'made') { madeAll += num(m.qty); if (!lastMade) lastMade = m.created_at; if (i >= 0) made[i] += num(m.qty); } if (m.kind === 'sold') { soldAll += num(m.qty); revenue += num(m.detail && m.detail.revenue); if (!lastSold) lastSold = m.created_at; if (i >= 0) sold[i] += num(m.qty); } });
    return { buckets, series: [{ name: 'Sold', color: 'var(--red)', values: sold }, { name: 'Made', color: 'var(--ink-3)', values: made }], totals: { madeAll, soldAll, revenue, lastMade, lastSold, soldWeekly: sold.reduce((a, b) => a + b, 0) / WEEKS } };
  }
  if (kind === 'spool') {
    const used = z(); let usedAll = 0, rolls = 0, lastUsed = null;
    state.movements.forEach(m => { const i = bucketIndex(buckets, m.created_at); if (m.kind === 'made' && m.detail && m.detail.by) m.detail.by.forEach(b => { if (b.spoolId !== id) return; const g = b.used !== undefined ? num(b.used) : num(b.grams); usedAll += g; if (!lastUsed) lastUsed = m.created_at; if (i >= 0) used[i] += g; }); if (m.kind === 'receive' && m.spool_id === id) rolls += num(m.qty); });
    return { buckets, series: [{ name: 'Grams used', color: 'var(--red)', values: used.map(v => Math.round(v * 10) / 10) }], totals: { usedAll, rolls, lastUsed, weekly: used.reduce((a, b) => a + b, 0) / WEEKS } };
  }
  const used = z(); let usedAll = 0, received = 0, lastUsed = null;
  state.movements.forEach(m => { if (m.part_id !== id) return; const i = bucketIndex(buckets, m.created_at); if (m.kind === 'consume') { const g = m.detail && m.detail.taken !== undefined ? num(m.detail.taken) : num(m.qty); usedAll += g; if (!lastUsed) lastUsed = m.created_at; if (i >= 0) used[i] += g; } if (m.kind === 'receive') received += num(m.qty); });
  return { buckets, series: [{ name: 'Used', color: 'var(--red)', values: used }], totals: { usedAll, received, lastUsed, weekly: used.reduce((a, b) => a + b, 0) / WEEKS } };
}
const CHARTS = {};
function chartHTML(key, u, unit){
  CHARTS[key] = { u, unit: unit || '' };
  const legend = u.series.length > 1 ? '<div class="legend">' + u.series.map(sr => '<span><i style="background:' + sr.color + '"></i>' + esc(sr.name) + '</span>').join('') + '</div>' : '';
  return legend + '<div class="chart" data-chart="' + esc(key) + '"></div>';
}
function drawCharts(root){
  (root || document).querySelectorAll('.chart[data-chart]').forEach(el => {
    const c = CHARTS[el.dataset.chart]; if (!c) return; const u = c.u;
    const W = Math.max(240, el.clientWidth || 480), H = 150, padL = 30, padR = 6, padT = 14, padB = 22;
    const n = u.buckets.length; const slot = (W - padL - padR) / n; const groups = u.series.length;
    const max = Math.max(1, ...u.series.map(sr => Math.max(...sr.values)));
    const nice = (() => { const p = Math.pow(10, Math.floor(Math.log10(max))); const m = max / p; const step = m <= 1 ? 0.25 : m <= 2 ? 0.5 : m <= 5 ? 1 : 2; return Math.ceil(max / (step * p)) * step * p; })();
    const y = v => padT + (H - padT - padB) * (1 - v / nice);
    const barW = Math.min(24, Math.max(4, (slot - 6) / groups - 2));
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(u.series.map(s => s.name).join(' and ')) + ' per week">';
    [0, 0.5, 1].forEach(f => { const yy = y(nice * f); svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '" stroke="var(--line)" stroke-width="1"/><text x="' + (padL - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end">' + fmtTick(nice * f) + '</text>'; });
    const maxI = u.series.map(sr => sr.values.indexOf(Math.max(...sr.values)));
    for (let i = 0; i < n; i++) {
      const x0 = padL + i * slot + (slot - (barW * groups + 2 * (groups - 1))) / 2;
      u.series.forEach((sr, gi) => {
        const v = sr.values[i]; const x = x0 + gi * (barW + 2); const yy = y(v); const h = Math.max(0, H - padB - yy); const r = Math.min(4, h);
        const path = h > 0 ? 'M' + x.toFixed(1) + ',' + (H - padB) + ' V' + (yy + r).toFixed(1) + ' Q' + x.toFixed(1) + ',' + yy.toFixed(1) + ' ' + (x + r).toFixed(1) + ',' + yy.toFixed(1) + ' H' + (x + barW - r).toFixed(1) + ' Q' + (x + barW).toFixed(1) + ',' + yy.toFixed(1) + ' ' + (x + barW).toFixed(1) + ',' + (yy + r).toFixed(1) + ' V' + (H - padB) + ' Z' : '';
        if (path) svg += '<path class="bar" d="' + path + '" fill="' + sr.color + '"/>';
        if (v > 0 && i === maxI[gi] && gi === 0) svg += '<text class="vl" x="' + (x + barW / 2).toFixed(1) + '" y="' + (yy - 4).toFixed(1) + '" text-anchor="middle">' + fmtTick(v) + (c.unit ? ' ' + c.unit : '') + '</text>';
      });
      svg += '<rect class="hit" data-i="' + i + '" x="' + (padL + i * slot).toFixed(1) + '" y="' + padT + '" width="' + slot.toFixed(1) + '" height="' + (H - padT - padB) + '" fill="transparent"/>';
      if (i % 3 === 0 || i === n - 1) svg += '<text x="' + (padL + i * slot + slot / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(wkLabel(u.buckets[i])) + '</text>';
    }
    svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '" stroke="var(--line-2)" stroke-width="1"/></svg>';
    el.innerHTML = svg;
  });
}
function fmtTick(v){ if (v >= 1000) return (Math.round(v / 100) / 10) + 'K'; return Math.abs(v - Math.round(v)) < 0.01 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString(); }
let ctip = null;
document.addEventListener('pointermove', e => {
  const hit = e.target.closest ? e.target.closest('.chart .hit') : null;
  if (!hit) { if (ctip) { ctip.remove(); ctip = null; } return; }
  const chartEl = hit.closest('.chart'); const c = CHARTS[chartEl.dataset.chart]; if (!c) return; const i = +hit.dataset.i; const u = c.u;
  if (!ctip) { ctip = document.createElement('div'); ctip.className = 'ctip'; }
  if (ctip.parentNode !== chartEl) chartEl.appendChild(ctip);
  ctip.textContent = ''; const d = document.createElement('div'); d.className = 'd'; const end = new Date(u.buckets[i]); end.setDate(end.getDate() + 6); d.textContent = 'Week of ' + wkLabel(u.buckets[i]) + ' – ' + wkLabel(end); ctip.appendChild(d);
  u.series.forEach(sr => { const row = document.createElement('div'); const k = document.createElement('span'); k.className = 'k'; k.style.background = sr.color; const b = document.createElement('b'); b.textContent = fmtTick(sr.values[i]) + (c.unit ? ' ' + c.unit : ''); row.appendChild(k); row.appendChild(b); row.appendChild(document.createTextNode(' ' + sr.name.toLowerCase())); ctip.appendChild(row); });
  const r = chartEl.getBoundingClientRect(); const hr = hit.getBoundingClientRect(); const half = ctip.offsetWidth / 2 + 4;
  ctip.style.left = Math.max(half, Math.min(r.width - half, hr.left - r.left + hr.width / 2)) + 'px'; ctip.style.top = (hr.top - r.top + 6) + 'px';
});
document.addEventListener('pointerleave', () => { if (ctip) { ctip.remove(); ctip = null; } }, true);
let resizeTimer = null; window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => drawCharts(), 150); });

/* ---------------- detail panels ---------------- */
function provHTML(item){
  const lines = [];
  if (item.created_at) lines.push('Created ' + esc(dateShort(item.created_at)) + ' ' + esc(timeShort(item.created_at)) + (item.created_by ? ' by ' + esc(who(item.created_by)) : ''));
  if (item.updated_at && item.updated_by && new Date(item.updated_at) - new Date(item.created_at) > 60000) lines.push('Last edited ' + esc(dateShort(item.updated_at)) + ' ' + esc(timeShort(item.updated_at)) + ' by ' + esc(who(item.updated_by)));
  return lines.length ? '<div class="prov">' + lines.join('<br>') + '</div>' : '';
}
function productDetailHTML(p){
  const c = productCost(p); const u = usageFor('product', p.id); const url = photoUrl(p); const st = productStatus(p);
  const colors = c.playset
    ? c.comps.map(x => '<div class="cr"><span class="pbadge">' + x.qty + ' ×</span>' + esc(x.cp.name) + '<span class="sub">' + money(x.unit) + ' each</span><b>' + money(x.cost) + '</b></div>').join('') + (c.missing.length ? '<div class="cr sub">A product in this set no longer exists</div>' : '')
    : c.rows.map(x => '<div class="cr">' + dotHTML(x.sp) + esc(x.sp.color) + '<span class="sub">' + esc(x.sp.line_name || '') + (x.purge + x.tower > 0 ? ' · ' + gnum(x.model) + ' + ' + gnum(x.purge + x.tower) + ' waste' : '') + '</span><b>' + grams(x.tot) + '</b></div>').join('') + (c.missing.length ? '<div class="cr sub" style="color:var(--red)">A color here is not on the rack</div>' : '');
  const weeks = u.totals.soldWeekly > 0 ? num(p.on_hand) / u.totals.soldWeekly : null;
  return '<div class="pdetail" id="pd-' + esc(p.id) + '"><div>' +
    '<div class="dhead">' + (url ? '<img src="' + esc(url) + '" alt="">' : '<div class="dph">no photo</div>') + '<div><h3>' + esc(p.name) + '</h3><div class="sub">' + (c.playset ? 'Playset · ' + c.comps.length + ' products' : (p.sku ? esc(p.sku) + ' · ' : '') + (c.n > 1 ? c.n + ' per plate' : 'single item')) + (p.barcode ? ' · label ' + esc(p.barcode) : '') + '</div></div></div>' +
    '<div class="facts">' +
      '<div><span class="fl">Cost</span><span class="fv">' + money(c.unit) + '</span><span class="fs">per ' + (c.playset ? 'set' : 'unit') + '</span></div>' +
      '<div><span class="fl">Sells</span><span class="fv red">' + (c.price > 0 ? money(c.price) : '—') + '</span><span class="fs">' + (c.margin !== null ? Math.round(c.margin) + '% margin' : 'no price yet') + '</span></div>' +
      '<div><span class="fl">On shelf</span><span class="fv' + (st !== 'ok' ? ' red' : '') + '">' + num(p.on_hand) + '</span><span class="fs">' + (st !== 'ok' ? st + ' · minimum ' + productMin(p) : weeks ? '≈ ' + (weeks >= 52 ? '1+ yr' : Math.round(weeks) + ' wk') + ' at this pace' : 'minimum ' + productMin(p)) + '</span></div>' +
      (c.playset ? '' : '<div><span class="fl">Print time</span><span class="fv">' + (Math.round(c.hours * 100) / 100) + ' h</span><span class="fs">per unit' + (c.n > 1 ? ' · ' + num(p.plate_hours) + ' h plate' : '') + '</span></div>') +
      (c.playset ? '' : '<div><span class="fl">Filament</span><span class="fv">' + grams(c.g) + '</span><span class="fs">per unit, waste included</span></div>') +
      '<div><span class="fl">Energy</span><span class="fv">' + money(c.energy) + '</span><span class="fs">' + (c.labor + c.packaging > 0 ? '+ ' + money(c.labor + c.packaging) + ' finish & pack' : 'per unit') + '</span></div>' +
    '</div>' +
    '<div class="usage"><h4>' + (c.playset ? 'What goes in it' : 'Colors used') + '</h4></div><div class="colors">' + (colors || '<div class="cr sub">Nothing entered yet</div>') + '</div>' +
    (p.description ? '<p class="note" style="margin-top:10px">' + esc(p.description) + '</p>' : '') +
    '<div class="dacts"><input type="number" inputmode="numeric" min="1" step="1" value="' + (c.playset ? 1 : c.n) + '" id="pdN-' + esc(p.id) + '" aria-label="How many"><button class="btn small" data-action="pd-make" data-id="' + esc(p.id) + '">' + (c.playset ? 'Assembled' : 'Made') + '</button><button class="btn red small" data-action="pd-sell" data-id="' + esc(p.id) + '">Sold</button><button class="btn ghost small" data-action="adjust-open" data-kind="product" data-id="' + esc(p.id) + '">Adjust…</button><span class="sp"></span><button class="btn ghost small" data-action="product-edit" data-id="' + esc(p.id) + '">Edit</button><button class="iconbtn close" data-action="product-open" data-id="' + esc(p.id) + '" aria-label="Close">×</button></div>' + provHTML(p) +
    '</div><div class="usage"><h4>Usage</h4><div class="usub">Made and sold per week, last ' + WEEKS + ' weeks</div>' + chartHTML('product:' + p.id, u) +
    '<div class="totals"><span>sold <b>' + u.totals.soldAll + '</b></span><span>made <b>' + u.totals.madeAll + '</b></span><span>sales <b>' + money(u.totals.revenue) + '</b></span>' + (u.totals.lastSold ? '<span>last sold <b>' + esc(dateShort(u.totals.lastSold)) + '</b></span>' : '') + '</div></div></div>';
}
function spoolDetailHTML(sp){
  const u = usageFor('spool', sp.id); const st = spoolStatus(sp); const avail = spoolAvailable(sp); const roll = effGrams(sp);
  const usedIn = sortProducts(Object.values(state.products).filter(p => !p.archived && recipe(p).some(r => r.spool_id === sp.id)));
  const weeksLeft = u.totals.weekly > 0 ? avail / u.totals.weekly : null;
  return '<div class="pdetail" id="sd-' + esc(sp.id) + '"><div>' +
    '<div class="dhead">' + spoolSVG(sp, 72) + '<div><h3>' + esc(sp.color) + '</h3><div class="sub">' + esc(sp.line_name || '') + (sp.hex ? ' · ' + esc(sp.hex) : '') + ' · label ' + esc(sp.barcode || '') + (sp.location ? ' · ' + esc(sp.location) : '') + '</div></div></div>' +
    '<div class="facts">' +
      '<div><span class="fl">On hand</span><span class="fv' + (st !== 'ok' ? ' red' : '') + '">' + grams(avail) + '</span><span class="fs">' + rollsOf(sp) + ' roll' + (rollsOf(sp) === 1 ? '' : 's') + (rollsOf(sp) ? ', ' + grams(openLeft(sp)) + ' on the open one' : '') + '</span></div>' +
      '<div><span class="fl">Price</span><span class="fv">' + money4(ppg(sp)) + '</span><span class="fs">per g · ' + money(effCost(sp)) + ' a ' + grams(roll) + ' roll' + (followsLine(sp) ? ' (line price)' : '') + '</span></div>' +
      '<div><span class="fl">Reorder</span><span class="fv">' + grams(reorderPoint(sp)) + '</span><span class="fs">' + (st !== 'ok' ? st + ' now' : weeksLeft ? '≈ ' + (weeksLeft >= 52 ? '1+ yr' : Math.round(weeksLeft) + ' wk') + ' left at this pace' : 'no use yet') + '</span></div>' +
    '</div>' +
    '<div class="usage"><h4>Used in</h4></div><div class="colors">' + (usedIn.length ? usedIn.map(p => { const r = recipe(p).filter(x => x.spool_id === sp.id); const g = r.reduce((a, x) => a + (num(x.grams) + num(x.purge_g) + num(x.tower_g)), 0) / plateQty(p); return '<div class="cr"><button class="btn ghost small" data-action="product-open" data-id="' + esc(p.id) + '">' + esc(p.name) + '</button><b>' + grams(g) + ' / unit</b></div>'; }).join('') : '<div class="cr sub">No product uses this color yet</div>') + '</div>' +
    (sp.notes ? '<p class="note" style="margin-top:10px">' + esc(sp.notes) + '</p>' : '') +
    '<div class="dacts"><button class="btn small" data-action="quick-receive" data-id="' + esc(sp.id) + '">+1 roll received</button><button class="btn ghost small" data-action="adjust-open" data-kind="spool" data-id="' + esc(sp.id) + '">Adjust…</button><span class="sp"></span><button class="btn ghost small" data-action="spool-edit" data-id="' + esc(sp.id) + '">Edit</button><button class="iconbtn close" data-action="spool-open" data-id="' + esc(sp.id) + '" aria-label="Close">×</button></div>' + provHTML(sp) +
    '</div><div class="usage"><h4>Usage</h4><div class="usub">Grams pulled off this spool per week, last ' + WEEKS + ' weeks</div>' + chartHTML('spool:' + sp.id, u, 'g') +
    '<div class="totals"><span>used <b>' + grams(u.totals.usedAll) + '</b></span><span>≈ <b>' + grams(u.totals.weekly) + '</b> a week</span><span>received <b>' + u.totals.rolls + ' roll' + (u.totals.rolls === 1 ? '' : 's') + '</b></span>' + (u.totals.lastUsed ? '<span>last used <b>' + esc(dateShort(u.totals.lastUsed)) + '</b></span>' : '') + '</div></div></div>';
}
function partDetailHTML(pt){
  const u = usageFor('part', pt.id); const st = partStatus(pt); const url = photoUrl(pt); const prs = partPrinters(pt);
  const weeksLeft = u.totals.weekly > 0 ? num(pt.on_hand) / u.totals.weekly : null;
  return '<div class="pdetail part" id="ad-' + esc(pt.id) + '"><div>' +
    '<div class="dhead">' + (url ? '<img src="' + esc(url) + '" alt="">' : '<div class="dph">' + esc((pt.category || 'part').slice(0, 5)) + '</div>') + '<div><h3>' + esc(pt.name) + '</h3><div class="sub">' + esc([pt.part_no, pt.category, pt.vendor, pt.barcode ? 'label ' + pt.barcode : ''].filter(Boolean).join(' · ')) + '</div></div></div>' +
    '<div class="facts">' +
      '<div><span class="fl">On hand</span><span class="fv' + (st !== 'ok' ? ' red' : '') + '">' + num(pt.on_hand) + '</span><span class="fs">' + (st !== 'ok' ? st + ' · reorder below ' + partMin(pt) : weeksLeft ? '≈ ' + (weeksLeft >= 52 ? '1+ yr' : Math.round(weeksLeft) + ' wk') + ' at this pace' : 'reorder below ' + partMin(pt)) + '</span></div>' +
      '<div><span class="fl">Cost</span><span class="fv">' + (num(pt.cost) ? money(num(pt.cost)) : '—') + '</span><span class="fs">' + (num(pt.cost) ? money(num(pt.cost) * num(pt.on_hand)) + ' on hand' : 'no cost entered') + '</span></div>' +
      '<div><span class="fl">Fits</span><span class="fv" style="font-size:15px;line-height:1.3">' + (prs.length ? prs.map(p => esc(p.name)).join(', ') : 'Any printer') + '</span><span class="fs">' + (pt.location ? esc(pt.location) : '') + '</span></div>' +
    '</div>' +
    (pt.notes ? '<p class="note">' + esc(pt.notes) + '</p>' : '') +
    '<div class="dacts"><input type="number" inputmode="decimal" min="0" step="any" value="1" id="adN-' + esc(pt.id) + '" aria-label="How many"><button class="btn small" data-action="ad-recv" data-id="' + esc(pt.id) + '">Received</button><button class="btn red small" data-action="ad-use" data-id="' + esc(pt.id) + '">Used</button>' + (pt.link ? '<a class="btn ghost small" href="' + esc(pt.link) + '" target="_blank" rel="noopener">Reorder link</a>' : '') + '<button class="btn ghost small" data-action="adjust-open" data-kind="part" data-id="' + esc(pt.id) + '">Adjust…</button><span class="sp"></span><button class="btn ghost small" data-action="part-edit" data-id="' + esc(pt.id) + '">Edit</button><button class="iconbtn close" data-action="part-open" data-id="' + esc(pt.id) + '" aria-label="Close">×</button></div>' + provHTML(pt) +
    '</div><div class="usage"><h4>Usage</h4><div class="usub">Used per week, last ' + WEEKS + ' weeks</div>' + chartHTML('part:' + pt.id, u) +
    '<div class="totals"><span>used <b>' + u.totals.usedAll + '</b></span><span>received <b>' + u.totals.received + '</b></span>' + (u.totals.lastUsed ? '<span>last used <b>' + esc(dateShort(u.totals.lastUsed)) + '</b></span>' : '') + '</div></div></div>';
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
    f('partReorderAt', 'Part reorder below', '1', 'Default per part, overridable') +
    '</div>';
  const me = state.session && state.session.user ? state.session.user.email : '';
  $('#allowedBox').innerHTML = '<div class="shead" style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:600;color:var(--ink-2)">Who can sign in<small style="display:block;font-weight:400;letter-spacing:0;text-transform:none;color:var(--ink-3);font-size:12px;margin-top:2px">Anyone can create an account, but only these emails can see or change the shop.</small></div>' +
    '<div class="people">' + state.allowedUsers.map(e => { const made = state.audit.filter(a => a.actor === e && a.action === 'created'); const n = k => made.filter(a => a.entity === k).length; const moves = state.movements.filter(m => m.actor === e).length; return '<div class="pr"><span>' + esc(e) + (e === me ? ' <span class="badge-ex">you</span>' : '') + '<span class="sub" style="display:block">created ' + n('product') + ' product' + (n('product') === 1 ? '' : 's') + ', ' + n('spool') + ' spool' + (n('spool') === 1 ? '' : 's') + ', ' + n('part') + ' part' + (n('part') === 1 ? '' : 's') + ' · ' + moves + ' stock move' + (moves === 1 ? '' : 's') + '</span></span><span class="sp"></span><button class="btn ghost small" data-action="person-activity" data-email="' + esc(e) + '" data-view="changes">Changes</button><button class="btn ghost small" data-action="person-activity" data-email="' + esc(e) + '" data-view="stock">Stock moves</button>' + (e === me ? '' : '<button class="btn ghost small" data-action="allowed-remove" data-email="' + esc(e) + '">Remove</button>') + '</div>'; }).join('') + '</div>' +
    '<form class="row" id="allowedForm"><input id="allowedEmail" type="email" placeholder="email to allow" required><button class="btn small" type="submit">Allow</button></form>' +
    '<div class="shead" style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:600;color:var(--ink-2);margin-top:22px">Your password<small style="display:block;font-weight:400;letter-spacing:0;text-transform:none;color:var(--ink-3);font-size:12px;margin-top:2px">Signed in as ' + esc(me) + '. Change it here; no email needed.</small></div>' +
    '<form class="row" id="passForm" autocomplete="off"><input id="passNew" type="password" placeholder="new password (8+ characters)" autocomplete="new-password" minlength="8" required><input id="passAgain" type="password" placeholder="again" autocomplete="new-password" minlength="8" required><button class="btn small" type="submit">Change</button></form>';
}

function renderAll(){
  // Remember which input had focus so a background refresh does not steal it mid-typing.
  const ae = document.activeElement; let find = null, sel = null;
  if (ae && ae.tagName === 'INPUT') { try { sel = ae.selectionStart; } catch (e) {} if (ae.dataset.setting) find = '[data-setting="' + ae.dataset.setting + '"]'; else if (ae.dataset.lineprice) find = '[data-lineprice="' + ae.dataset.lineprice + '"][data-field="' + ae.dataset.field + '"]'; }
  renderProducts(); renderRack(); renderChips(); renderWall(); renderParts(); renderLog(); renderReorder(); renderLabels(); renderSettings(); renderScanModes(); renderHome(); applyTab();
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
function openProductModal(id, kind){
  const p = id ? state.products[id] : null;
  draft = p ? Object.assign({}, p) : { kind: kind || 'item', name: '', sku: '', barcode: '', description: '', photo_path: null, on_hand: 0, price: null, plate_qty: 1, plate_hours: 0, hours_per_unit: 0, flush_g: 0, tower_g: 0, finishing_min: 0, packaging: 0, reorder_at: null, notes: '', archived: false };
  if (!draft.kind) draft.kind = 'item';
  draft._rec = p ? recipe(p).map(r => ({ spool_id: r.spool_id, grams: num(r.grams), purge_g: num(r.purge_g), tower_g: num(r.tower_g) })) : [{ spool_id: '', grams: 0, purge_g: 0, tower_g: 0 }];
  draft._comps = p ? components(p).map(c => ({ component_id: c.component_id, qty: num(c.qty) || 1 })) : [{ component_id: '', qty: 1 }];
  draft._mode = plateQty(draft) > 1 ? 'plate' : 'unit';
  draft._photoFile = null; draft._photoPreview = photoUrl(p);
  renderProductModal();
}
const gIn = (i, field, val, label) => '<span class="g"><input type="number" inputmode="decimal" step="any" min="0" data-rec="' + i + '" data-field="' + field + '" value="' + (num(val) > 0 ? num(val) : '') + '" placeholder="0" aria-label="' + label + '"></span>';
function recipeRowsHTML(){
  const p = draft; const n = p._mode === 'plate' ? plateQty(p) : 1;
  let plateTotal = 0, mT = 0, pT = 0, tT = 0;
  const rows = p._rec.map((r, i) => {
    const tot = num(r.grams) + num(r.purge_g) + num(r.tower_g); plateTotal += tot; mT += num(r.grams); pT += num(r.purge_g); tT += num(r.tower_g);
    return '<div class="slot">' + dotHTML(state.spools[r.spool_id]) + '<select data-rec="' + i + '" data-field="spool_id" aria-label="Color ' + (i + 1) + '">' + spoolOptions(r.spool_id) + '</select>' +
      '<span class="gs">' + gIn(i, 'grams', r.grams, 'Model grams') + gIn(i, 'purge_g', r.purge_g, 'Purged grams') + gIn(i, 'tower_g', r.tower_g, 'Tower grams') + '<span class="g total" data-rec-total="' + i + '">' + (tot > 0 ? gnum(tot) : '') + '</span></span>' +
      '<button class="iconbtn" data-action="rec-remove" data-i="' + i + '" aria-label="Remove color">×</button></div>';
  }).join('');
  return '<div class="head"><span></span><span class="lbl">Filament' + (n > 1 ? ' · whole plate' : '') + '</span><span class="gs"><span>Model</span><span>Purged</span><span>Tower</span><span>Total</span></span><span></span></div>' + rows +
    '<div class="foot"><span></span><span class="lbl">' + (n > 1 ? 'Plate total' : 'Total') + '</span><span class="gs"><span>' + grams(mT) + '</span><span>' + grams(pT) + '</span><span>' + grams(tT) + '</span><span class="total">' + grams(plateTotal) + '</span></span><span></span></div>';
}
function compRowsHTML(){
  const p = draft;
  const rows = p._comps.map((c, i) => {
    const cp = state.products[c.component_id]; const unit = cp ? productCost(cp).unit : 0; const url = cp ? photoUrl(cp) : '';
    return '<div class="crow">' + (url ? '<img class="thumb" src="' + esc(url) + '" alt="">' : '<span class="thumb"></span>') +
      '<select data-comp="' + i + '" data-field="component_id" aria-label="Product ' + (i + 1) + '">' + componentOptions(c.component_id) + '</select>' +
      '<input type="number" inputmode="decimal" step="any" min="0" data-comp="' + i + '" data-field="qty" value="' + (num(c.qty) > 0 ? num(c.qty) : '') + '" placeholder="1" aria-label="Quantity">' +
      '<span class="lc">' + (cp ? money(unit * (num(c.qty) || 1)) : '') + '</span>' +
      '<button class="iconbtn" data-action="comp-remove" data-i="' + i + '" aria-label="Remove product">×</button></div>';
  }).join('');
  return '<div class="head"><span></span><span>Product</span><span>Qty</span><span>Cost</span><span></span></div>' + rows;
}
function componentOptions(selectedId){
  const list = sortProducts(Object.values(state.products).filter(p => !p.archived && p.id !== draft.id));
  let html = '<option value="">Choose a product</option>' + list.map(p => '<option value="' + esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + '>' + esc(p.name) + (isPlayset(p) ? ' (playset)' : '') + ' · ' + money(productCost(p).unit) + '</option>').join('');
  if (selectedId && !state.products[selectedId]) html += '<option value="' + esc(selectedId) + '" selected>(product no longer exists)</option>';
  return html;
}
function perUnitHTML(c){
  if (c.playset) return '';
  return '<div class="perunit" id="perunit"><span>Per unit: <b>' + grams(c.g) + '</b> filament' + (c.wasteG > 0 ? ' <span style="color:var(--ink-3)">(' + grams(c.modelG) + ' model + ' + grams(c.wasteG) + ' purge &amp; tower)</span>' : '') + '</span>' + (c.hours > 0 ? '<span><b>' + (Math.round(c.hours * 100) / 100) + ' h</b> print time</span>' : '') + '</div>';
}
function renderProductModal(keepFocus){
  const p = draft; const c = productCostDraft(); const playset = p.kind === 'playset';
  const st = p.id ? productStatus(p) : 'ok';
  const v = k => (num(p[k]) > 0 ? num(p[k]) : '');
  const title = (p.id ? 'Edit ' : 'New ') + (playset ? 'playset' : 'product');
  const right = playset ?
      '<div class="field"><label>What goes in the set</label></div><div class="comps" id="comps">' + compRowsHTML() + '</div>' +
      '<div style="margin-top:8px"><button class="btn ghost small" data-action="comp-add">Add a product</button></div>' +
      '<p class="note" style="margin-top:10px">Making a set takes those products off their shelves and puts a set on this one. Their cost comes in automatically; add the set\'s own packaging or finishing below.</p>' +
      '<div class="grid3" style="margin-top:14px">' + fld('p_fin', 'Finishing min per set', 'number', v('finishing_min')) + fld('p_pack', 'Packaging $ per set', 'number', v('packaging')) + '</div>'
    :
      '<div class="recipe" id="recipe">' + recipeRowsHTML() + '</div>' +
      '<div style="margin-top:8px"><button class="btn ghost small" data-action="rec-add">Add a color</button></div>' +
      '<div class="plate"><div class="seg" role="group" aria-label="How the numbers were entered"><button type="button" data-action="mode-unit" class="' + (p._mode === 'unit' ? 'on' : '') + '">Single item</button><button type="button" data-action="mode-plate" class="' + (p._mode === 'plate' ? 'on' : '') + '">Whole plate</button></div>' +
        (p._mode === 'plate' ? fld('p_plate_qty', 'Units on the plate', 'number', plateQty(p), { hint: 'Everything above is divided by this' }) : '<div></div>') +
        fld('p_plate_hours', p._mode === 'plate' ? 'Plate print time (h)' : 'Print time (h)', 'number', v('plate_hours'), { hint: 'From the slicer' }) + '</div>' +
      perUnitHTML(c) +
      '<div class="grid3" style="margin-top:14px">' + fld('p_fin', 'Finishing min per unit', 'number', v('finishing_min')) + fld('p_pack', 'Packaging $ per unit', 'number', v('packaging')) + '</div>';
  const html = '<div class="mh"><div><h3>' + title + '</h3><div class="sub">' + (p.id ? esc(p.name || '') + (p.barcode ? ' · label ' + esc(p.barcode) : '') : playset ? 'Pick the products that go in it; the cost adds itself up' : 'Photo, the slicer\'s filament numbers, and the price you charge') + '</div></div></div>' +
    '<div class="pedit"><div>' +
      '<div class="photo" id="pPhoto">' + (p._photoPreview ? '<img src="' + esc(p._photoPreview) + '" alt="">' : '<span class="ph">Add a photo<br><small style="letter-spacing:0;text-transform:none;font-weight:400">Camera or library on an iPad</small></span>') + '</div>' +
      '<div class="photo-acts"><input type="file" id="pPhotoFile" accept="image/*" hidden><button class="btn ghost small" data-action="photo-pick">' + (p._photoPreview ? 'Change photo' : 'Add photo') + '</button>' + (p._photoPreview ? '<button class="btn ghost small" data-action="photo-clear">Remove</button>' : '') + '</div>' +
      '<div class="fields" style="margin-top:12px">' + fld('p_name', 'Name', 'text', p.name || '', { wide: true, placeholder: playset ? 'Dragon and egg playset' : 'What it is called on the shelf' }) + fld('p_sku', 'SKU', 'text', p.sku || '', { placeholder: playset ? 'SET-DRAGON' : 'PP-MINI' }) + fld('p_price', 'Sell price ($)', 'number', v('price')) +
      '<div class="field wide"><label for="p_desc">Description</label><textarea id="p_desc" placeholder="Variants, size, notes for the booth">' + esc(p.description || '') + '</textarea></div>' +
      fld('p_min', 'Shelf minimum', 'number', (p.reorder_at !== null && p.reorder_at !== undefined) ? p.reorder_at : '', { placeholder: 'default ' + num(state.settings.productReorderAt) }) + fld('p_barcode', 'Label code', 'text', p.barcode || '', { placeholder: 'made for you if blank', hint: 'Scan a boxed product\'s own barcode here to use it instead' }) + '</div>' +
    '</div><div>' + right +
      '<div class="costbox" id="costbox">' + costboxHTML(c) + '</div>' +
      (p.id ? '<div class="stockline"><span class="onhand' + (st !== 'ok' ? ' low' : '') + '" id="pOnHand">' + num(p.on_hand) + '</span><span style="font-size:12.5px;color:var(--ink-2)">on the shelf</span><span style="flex:1"></span><input id="pN" type="number" inputmode="numeric" min="1" step="1" value="' + (playset ? 1 : plateQty(p)) + '" aria-label="How many"><button class="btn small" data-action="product-make">' + (playset ? 'Assembled' : 'Made') + '</button><button class="btn red small" data-action="product-sell">Sold</button><button class="btn ghost small" data-action="adjust-open" data-kind="product" data-id="' + esc(p.id) + '">Adjust…</button></div><div id="pConfirm"></div>' : '') +
    '</div></div>' +
    '<div class="acts">' + (p.id ? '<span style="display:flex;gap:6px"><button class="btn ghost" data-action="product-archive">' + (p.archived ? 'Unarchive' : 'Archive') + '</button><button class="btn danger" data-action="product-delete">Delete</button></span>' : '<span></span>') + '<span class="r"><button class="btn ghost" data-action="modal-close">Cancel</button><button class="btn" data-action="product-save">' + (p.id ? 'Save' : playset ? 'Add playset' : 'Add product') + '</button></span></div>';
  if (keepFocus && !$('#modal').hidden) { const active = document.activeElement; const id = active && active.id; const sel = active && active.selectionStart; const box = $('#modal .box'); box.innerHTML = html; if (id) { const el = document.getElementById(id); if (el) { el.focus(); try { if (sel !== undefined && sel !== null) el.setSelectionRange(sel, sel); } catch (e) {} } } }
  else openModal(html, true);
}
function draftProduct(){ const d = Object.assign({}, draft); d.id = d.id || '__draft'; if (d._mode === 'unit') d.plate_qty = 1; return d; }
function productCostDraft(){
  // Cost the editor's unsaved recipe or contents by swapping them in for the saved ones, then putting those back.
  const d = draftProduct(); const prevF = state.pf[d.id], prevC = state.pc[d.id];
  state.pf[d.id] = draft._rec.map((r, i) => ({ spool_id: r.spool_id, grams: r.grams, purge_g: r.purge_g, tower_g: r.tower_g, position: i }));
  state.pc[d.id] = draft._comps.map((c, i) => ({ component_id: c.component_id, qty: c.qty, position: i }));
  const c = productCost(d);
  if (prevF === undefined) delete state.pf[d.id]; else state.pf[d.id] = prevF;
  if (prevC === undefined) delete state.pc[d.id]; else state.pc[d.id] = prevC;
  return c;
}
function costboxHTML(c){
  const rows = c.playset
    ? c.comps.map(x => '<tr><td>' + esc(x.cp.name) + ' <span class="sub">' + (x.qty === 1 ? '' : x.qty + ' × ') + money(x.unit) + '</span></td><td class="n">' + money(x.cost) + '</td></tr>').join('')
    : c.rows.map(x => '<tr><td>' + dotHTML(x.sp) + ' ' + esc(x.sp.color) + ' <span class="sub">' + grams(x.tot) + (x.purge + x.tower > 0 ? ' (' + grams(x.model) + ' + ' + grams(x.purge + x.tower) + ' waste)' : '') + ' × ' + money4(ppg(x.sp)) + '/g</span></td><td class="n">' + money(x.cost) + '</td></tr>').join('');
  return '<div class="big"><span>Cost per ' + (c.playset ? 'set' : 'unit') + '</span><b>' + money(c.unit) + '</b></div>' +
    '<div class="margin">' + (c.margin !== null ? 'Margin at ' + money(c.price) + ': <b>' + Math.round(c.margin) + '%</b> · ' : '') + (c.suggested ? num(state.settings.marginPct) + '% margin needs ' + money(c.suggested) : '') + '</div>' +
    '<div class="twrap"><table class="breakdown" style="margin-top:8px">' + rows + (c.missing.length ? '<tr><td class="sub" style="color:var(--red)">' + (c.playset ? 'A product in this set no longer exists' : 'A color here is not on the rack') + '</td><td class="n">—</td></tr>' : '') +
    (c.otherWaste > 0 ? '<tr><td>Other waste <span class="sub">' + num(state.settings.otherWastePct) + '%</span></td><td class="n">' + money(c.otherWaste) + '</td></tr>' : '') +
    (c.energy > 0 ? '<tr><td>Energy <span class="sub">' + (Math.round(c.hours * 100) / 100) + ' h × ' + money(num(state.settings.energyRate)) + '</span></td><td class="n">' + money(c.energy) + '</td></tr>' : '') +
    (c.failure > 0 ? '<tr><td>Reprint allowance</td><td class="n">' + money(c.failure) + '</td></tr>' : '') +
    (c.labor > 0 ? '<tr><td>Finishing</td><td class="n">' + money(c.labor) + '</td></tr>' : '') +
    (c.packaging > 0 ? '<tr><td>Packaging</td><td class="n">' + money(c.packaging) + '</td></tr>' : '') + '</table></div>';
}
function refreshCostbox(){
  const c = productCostDraft(); const box = $('#costbox'); if (box) box.innerHTML = costboxHTML(c);
  const pu = $('#perunit'); if (pu) pu.outerHTML = perUnitHTML(c);
  if (draft.kind !== 'playset') {
    let mT = 0, pT = 0, tT = 0, all = 0;
    draft._rec.forEach((r, i) => { const tot = num(r.grams) + num(r.purge_g) + num(r.tower_g); mT += num(r.grams); pT += num(r.purge_g); tT += num(r.tower_g); all += tot; const el = document.querySelector('[data-rec-total="' + i + '"]'); if (el) el.textContent = tot > 0 ? gnum(tot) : ''; });
    const foot = document.querySelectorAll('#recipe .foot .gs span'); if (foot.length === 4) { foot[0].textContent = grams(mT); foot[1].textContent = grams(pT); foot[2].textContent = grams(tT); foot[3].textContent = grams(all); }
  } else {
    draft._comps.forEach((cmp, i) => { const cp = state.products[cmp.component_id]; const el = document.querySelector('#comps .crow:nth-of-type(' + (i + 2) + ') .lc'); if (el) el.textContent = cp ? money(productCost(cp).unit * (num(cmp.qty) || 1)) : ''; });
  }
}
function readProductForm(){
  draft.name = $('#p_name').value.trim(); draft.sku = $('#p_sku').value.trim() || null; draft.price = $('#p_price').value === '' ? null : num($('#p_price').value);
  draft.description = $('#p_desc').value.trim(); draft.reorder_at = $('#p_min').value === '' ? null : Math.round(num($('#p_min').value)); draft.barcode = $('#p_barcode').value.trim() || null;
  draft.finishing_min = num($('#p_fin').value); draft.packaging = num($('#p_pack').value);
  const pq = $('#p_plate_qty'); draft.plate_qty = draft._mode === 'plate' && pq ? Math.max(1, Math.round(num(pq.value)) || 1) : 1;
  const ph = $('#p_plate_hours'); if (ph) draft.plate_hours = num(ph.value);
  draft.hours_per_unit = 0; draft.flush_g = 0; draft.tower_g = 0;
}
async function resizeImage(file){
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const max = 1200; let w = img.width, h = img.height; const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s); const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); cv.toBlob(b => b ? resolve(b) : reject(new Error('no image')), 'image/jpeg', 0.86); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image')); }; img.src = url;
  });
}
async function saveProductFromModal(){
  readProductForm(); if (!draft.name) { toast('Give it a name', true); $('#p_name').focus(); return; }
  const isNew = !draft.id; const row = Object.assign({}, draft); delete row._rec; delete row._comps; delete row._mode; delete row._photoFile; delete row._photoPreview;
  if (!row.barcode) row.barcode = row.sku || code('P-');
  if (isNew) delete row.id;
  try {
    const saved = await saveProduct(row);
    if (draft._photoFile) { const blob = await resizeImage(draft._photoFile); const path = saved.id + '/' + Date.now() + '.jpg'; const up = await sb.storage.from(CONFIG.photoBucket).upload(path, blob, { contentType: 'image/jpeg', upsert: true }); if (up.error) { fail(up.error, 'Could not upload the photo'); } else { const old = saved.photo_path; saved.photo_path = path; await saveProduct(saved); if (old && old !== path) removePhotos([old]); } }
    else if (draft._photoPreview === '' && saved.photo_path) { const old = saved.photo_path; saved.photo_path = null; await saveProduct(saved); removePhotos([old]); }
    if (draft.kind === 'playset') { await saveComponents(saved.id, draft._comps); if (!isNew) await saveRecipe(saved.id, []); }
    else { await saveRecipe(saved.id, draft._rec); if (!isNew && (state.pc[saved.id] || []).length) await saveComponents(saved.id, []); }
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
  const pt = Object.values(state.parts).find(x => (x.barcode && x.barcode.toLowerCase() === lc) || (x.part_no && x.part_no.toLowerCase() === lc));
  if (pt) return { kind: 'part', item: pt };
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
    if (mode === 'lookup') { openDetail('spool', sp.id, true); return; }
    flash('<b>' + esc(sp.color) + '</b> is filament; switch to Receive to add rolls or Look up to edit it.', true); return;
  }
  if (hit.kind === 'part') {
    const pt = hit.item; const where = fitsText(pt);
    if (mode === 'receive') { try { await receivePart(pt, qty, 'scan'); flash('<b>' + esc(pt.name) + '</b> +' + qty + ', now ' + num(pt.on_hand) + ' on hand · fits ' + esc(where)); renderAll(); } catch (e) {} return; }
    if (mode === 'made' || mode === 'sold') { const had = num(pt.on_hand); try { await usePart(pt, qty, 'scan'); flash('Used ' + qty + ' × <b>' + esc(pt.name) + '</b>, ' + num(pt.on_hand) + ' left · fits ' + esc(where) + (had < qty ? ' · <b>only ' + had + ' were on hand</b>' : ''), had < qty); renderAll(); } catch (e) {} return; }
    openDetail('part', pt.id, true); return;
  }
  const p = hit.item;
  if (mode === 'made') { try { const r = await makeProduct(p, qty, 'scan'); flash('Made ' + qty + ' × <b>' + esc(p.name) + '</b>, ' + num(p.on_hand) + ' on the shelf' + (r.shorts.length ? ' · ' + esc(r.shorts.join(', ')) : '')); renderAll(); } catch (e) {} return; }
  if (mode === 'sold') { if (num(p.on_hand) < qty) flash('Only ' + num(p.on_hand) + ' of <b>' + esc(p.name) + '</b> on the shelf; selling anyway.', true); try { await sellProduct(p, qty, 'scan'); flash('Sold ' + qty + ' × <b>' + esc(p.name) + '</b>, ' + num(p.on_hand) + ' left'); renderAll(); } catch (e) {} return; }
  if (mode === 'receive') { try { await adjustProduct(p, num(p.on_hand) + qty, 'scan receive'); flash('<b>' + esc(p.name) + '</b> +' + qty + ', now ' + num(p.on_hand) + ' on the shelf'); renderAll(); } catch (e) {} return; }
  openDetail('product', p.id, true);
}
function openGtinModal(gtin, qty){
  openModal('<div class="mh"><div><h3>New barcode</h3><div class="sub">' + esc(gtin) + ' · which Bambu color is in this box?</div></div></div>' +
    '<div class="field"><input id="gtinSearch" type="search" placeholder="Type a color or line" autocomplete="off"></div><div id="gtinList" style="margin-top:10px;max-height:300px;overflow:auto"></div>' +
    '<p class="note">Not filament? <button class="btn ghost small" data-action="part-new-code" data-code="' + esc(gtin) + '">It\'s a new part</button> <button class="btn ghost small" data-action="assign-open" data-code="' + esc(gtin) + '">Attach it to something I have</button></p>' +
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
    '<div class="field" style="margin-top:10px"><label for="asgPart">Or a part</label><select id="asgPart"><option value="">Choose a part</option>' + sortParts(Object.values(state.parts).filter(x => !x.archived)).map(x => '<option value="' + esc(x.id) + '">' + esc(x.name) + (x.part_no ? ' · ' + esc(x.part_no) : '') + '</option>').join('') + '</select></div>' +
    '<p class="note" style="margin-top:10px">Or <button class="btn ghost small" data-action="part-new-code" data-code="' + esc(code) + '">create a new part with this code</button></p>' +
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

// Expand an item's detail panel in place (toggle), switching to its tab when needed.
function openDetail(kind, id, force){
  const key = kind === 'product' ? 'openProduct' : kind === 'spool' ? 'openSpool' : 'openPart';
  const tab = kind === 'product' ? 'products' : kind === 'spool' ? 'filament' : 'parts';
  const wasOpen = state.ui[key] === id; state.ui[key] = (wasOpen && !force) ? null : id;
  if (state.ui.tab !== tab) goTab(tab);
  if (kind === 'product') renderProducts(); else if (kind === 'spool') renderRack(); else renderParts();
  if (state.ui[key]) { const el = document.getElementById((kind === 'product' ? 'pd-' : kind === 'spool' ? 'sd-' : 'ad-') + id); if (el) setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30); }
}

/* ---------------- events ---------------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action, id = el.dataset.id;
  try {
  if (a === 'go') { goTab(el.dataset.tab, el.dataset.anchor); return; }
  if (a === 'line') { state.ui.line = el.dataset.line; renderChips(); renderWall(); return; }
  if (a === 'part-printer') { state.ui.partPrinter = el.dataset.id; renderParts(); return; }
  if (a === 'part-cat') { state.ui.partCat = el.dataset.k; renderParts(); return; }
  if (a === 'part-low') { state.ui.partLowOnly = !state.ui.partLowOnly; renderParts(); return; }
  if (a === 'part-new') { openPartModal(null); return; }
  if (a === 'part-new-code') { closeModal(); openPartModal(null, { barcode: el.dataset.code }); return; }
  if (a === 'part-open') { openDetail('part', id); return; }
  if (a === 'part-edit') { openPartModal(id); return; }
  if (a === 'part-plus') { const pt = state.parts[id]; if (!pt) return; await receivePart(pt, 1); renderParts(); renderHome(); renderReorder(); renderLog(); return; }
  if (a === 'part-minus') { const pt = state.parts[id]; if (!pt) return; if (num(pt.on_hand) <= 0) { toast('None on hand', true); return; } await usePart(pt, 1); renderParts(); renderHome(); renderReorder(); renderLog(); return; }
  if (a === 'pphoto-pick') { $('#pPhotoFile').click(); return; }
  if (a === 'pphoto-clear') { partDraft._photoFile = null; partDraft._photoPreview = ''; readPartForm(); renderPartModal(true); return; }
  if (a === 'part-save') { await savePartFromModal(); return; }
  if (a === 'part-archive') { readPartForm(); partDraft.archived = !partDraft.archived; await savePartFromModal(); return; }
  if (a === 'part-delete') { $('#aConfirm').innerHTML = '<div class="confirm">Delete <b>' + esc(partDraft.name) + '</b>? Its history stays in the activity log.<div class="acts"><button class="btn red" data-action="part-delete-do">Delete</button><button class="btn ghost" data-action="part-cancel">Keep it</button></div></div>'; return; }
  if (a === 'part-cancel') { $('#aConfirm').innerHTML = ''; return; }
  if (a === 'part-delete-do') { await deletePart(partDraft.id); closeModal(); toast('Deleted'); renderAll(); return; }
  if (a === 'part-recv' || a === 'part-use') {
    const pt = state.parts[partDraft.id]; if (!pt) return; const n = Math.max(0, num($('#aN').value));
    if (a === 'part-recv') { if (n <= 0) return; await receivePart(pt, n); toast('Received ' + n); }
    else if (a === 'part-use') { if (n <= 0) return; const had = num(pt.on_hand); await usePart(pt, n); toast('Used ' + n + (had < n ? ' (only ' + had + ' were on hand)' : ''), had < n); }
    $('#aOnHand').textContent = num(pt.on_hand); partDraft.on_hand = pt.on_hand; renderParts(); renderHome(); renderReorder(); renderLog(); return;
  }
  if (a === 'adjust-open') { openAdjustModal(el.dataset.kind, el.dataset.id); return; }
  if (a === 'adjust-save') {
    const kind = el.dataset.kind; const reasonEl = document.querySelector('input[name="adjReason"]:checked'); const reason = reasonEl ? reasonEl.value : 'Other'; const note = $('#adj_note').value.trim();
    if (kind === 'product') { const p = state.products[id]; await adjustProduct(p, num($('#adj_qty').value), note, reason); }
    else if (kind === 'part') { const pt = state.parts[id]; await adjustPart(pt, num($('#adj_qty').value), note, reason); }
    else { const sp = state.spools[id]; await adjustSpool(sp, num($('#adj_rolls').value), num($('#adj_left').value), note, reason); }
    closeModal(); toast('Adjusted · ' + reason); renderAll(); return;
  }
  if (a === 'printers-manage') { openPrintersModal(); return; }
  if (a === 'printer-remove') { const pr = state.printers[id]; if (!pr) return; await deletePrinter(id); toast(pr.name + ' removed'); openPrintersModal(); renderParts(); return; }
  if (a === 'printers-save') { for (const inp of document.querySelectorAll('[data-printer-name]')) { const pr = state.printers[inp.dataset.printerName]; const model = document.querySelector('[data-printer-model="' + inp.dataset.printerName + '"]'); if (pr && (pr.name !== inp.value.trim() || (pr.model || '') !== (model ? model.value.trim() : ''))) { pr.name = inp.value.trim() || pr.name; pr.model = model ? (model.value.trim() || null) : pr.model; await savePrinter(pr); } } closeModal(); toast('Printers saved'); renderParts(); return; }
  if (a === 'rack-line') { state.ui.rackLine = el.dataset.line; renderRack(); return; }
  if (a === 'rack-low') { state.ui.lowOnly = !state.ui.lowOnly; renderRack(); return; }
  if (a === 'product-filter') { state.ui.productFilter = el.dataset.k; renderProducts(); return; }
  if (a === 'log-kind') { state.ui.logKind = el.dataset.k; renderLog(); return; }
  if (a === 'log-entity') { state.ui.logEntity = el.dataset.k; renderLog(); return; }
  if (a === 'log-view') { state.ui.logView = el.dataset.k; renderLog(); return; }
  if (a === 'log-clear') { state.ui.logActor = 'all'; state.ui.logFrom = ''; state.ui.logTo = ''; state.ui.logQ = ''; state.ui.logKind = 'all'; state.ui.logEntity = 'all'; renderLog(); return; }
  if (a === 'person-activity') { state.ui.logActor = el.dataset.email; state.ui.logView = el.dataset.view || 'changes'; goTab('log'); renderLog(); return; }
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
  if (a === 'product-new') { openProductModal(null, 'item'); return; }
  if (a === 'playset-new') { openProductModal(null, 'playset'); return; }
  if (a === 'mode-unit' || a === 'mode-plate') { readProductForm(); draft._mode = a === 'mode-unit' ? 'unit' : 'plate'; if (draft._mode === 'plate' && plateQty(draft) < 2) draft.plate_qty = 2; renderProductModal(true); return; }
  if (a === 'comp-add') { readProductForm(); draft._comps.push({ component_id: '', qty: 1 }); renderProductModal(true); return; }
  if (a === 'comp-remove') { readProductForm(); draft._comps.splice(+el.dataset.i, 1); if (!draft._comps.length) draft._comps.push({ component_id: '', qty: 1 }); renderProductModal(true); return; }
  if (a === 'product-open') { openDetail('product', id); return; }
  if (a === 'product-edit') { openProductModal(id); return; }
  if (a === 'spool-open') { openDetail('spool', id); return; }
  if (a === 'quick-receive') { const sp = state.spools[id]; if (!sp) return; await receiveSpool(sp, 1); toast(sp.color + ' +1 roll'); renderAll(); return; }
  if (a === 'pd-make' || a === 'pd-sell') { const p = state.products[id]; if (!p) return; const inp = document.getElementById('pdN-' + id); const n = Math.max(1, Math.round(num(inp && inp.value))); if (a === 'pd-make') { const r = await makeProduct(p, n); toast((isPlayset(p) ? 'Assembled ' : 'Made ') + n + ', ' + num(p.on_hand) + ' on the shelf' + (r.shorts.length ? ' · ' + r.shorts.join(', ') : ''), r.shorts.length > 0); } else { await sellProduct(p, n); toast('Sold ' + n + ', ' + num(p.on_hand) + ' left'); } renderAll(); return; }
  if (a === 'ad-recv' || a === 'ad-use') { const pt = state.parts[id]; if (!pt) return; const inp = document.getElementById('adN-' + id); const n = num(inp && inp.value); if (n <= 0) return; if (a === 'ad-recv') { await receivePart(pt, n); toast('Received ' + n); } else { const had = num(pt.on_hand); await usePart(pt, n); toast('Used ' + n + (had < n ? ' (only ' + had + ' were on hand)' : ''), had < n); } renderAll(); return; }
  if (a === 'photo-pick') { $('#pPhotoFile').click(); return; }
  if (a === 'photo-clear') { draft._photoFile = null; draft._photoPreview = ''; readProductForm(); renderProductModal(true); return; }
  if (a === 'rec-add') { readProductForm(); draft._rec.push({ spool_id: '', grams: 0, purge_g: 0, tower_g: 0 }); renderProductModal(true); return; }
  if (a === 'rec-remove') { readProductForm(); draft._rec.splice(+el.dataset.i, 1); if (!draft._rec.length) draft._rec.push({ spool_id: '', grams: 0, purge_g: 0, tower_g: 0 }); renderProductModal(true); return; }
  if (a === 'product-save') { await saveProductFromModal(); return; }
  if (a === 'product-archive') { readProductForm(); draft.archived = !draft.archived; await saveProductFromModal(); return; }
  if (a === 'product-delete') { $('#pConfirm').innerHTML = '<div class="confirm">Delete <b>' + esc(draft.name) + '</b> and its recipe? Its history stays in the activity log.<div class="acts"><button class="btn red" data-action="product-delete-do">Delete</button><button class="btn ghost" data-action="product-delete-cancel">Keep it</button></div></div>'; return; }
  if (a === 'product-delete-cancel') { $('#pConfirm').innerHTML = ''; return; }
  if (a === 'product-delete-do') { await deleteProduct(draft.id); closeModal(); toast('Deleted'); renderAll(); return; }
  if (a === 'product-make' || a === 'product-sell') {
    const p = state.products[draft.id]; if (!p) return; const n = Math.max(0, Math.round(num($('#pN').value)));
    if (a === 'product-make') { if (n < 1) return; const { c, pulls, parts } = spoolPullFor(p, n); const lines = pulls.map(pl => { const sp = state.spools[pl.spoolId]; return esc(sp.color) + ' ' + grams(pl.grams); }); const partLines = parts.map(pt => { const cp = state.products[pt.productId]; const have = cp ? num(cp.on_hand) : 0; return pt.qty + ' × ' + esc(pt.name) + (have < pt.qty ? ' <b style="color:var(--red)">(only ' + have + ' on the shelf)</b>' : ''); }); const what = isPlayset(p) ? 'take ' + (partLines.join(' · ') || 'nothing (the set is empty)') + ' off the shelf' : 'pull ' + (lines.join(' · ') || 'no filament (no colors entered)') + ' off the rack'; $('#pConfirm').innerHTML = '<div class="confirm">' + (isPlayset(p) ? 'Assemble' : 'Make') + ' <b>' + n + '</b>: ' + what + ', cost ' + money(c.unit * n) + '.<div class="acts"><button class="btn red" data-action="product-make-do" data-n="' + n + '">' + (isPlayset(p) ? 'Assembled ' : 'Made ') + n + '</button><button class="btn ghost" data-action="product-delete-cancel">Cancel</button></div></div>'; return; }
    if (a === 'product-sell') { if (n < 1) return; await sellProduct(p, n); $('#pOnHand').textContent = num(p.on_hand); $('#pConfirm').innerHTML = ''; toast('Sold ' + n + ', ' + num(p.on_hand) + ' left'); renderProducts(); renderLog(); renderReorder(); return; }
  }
  if (a === 'product-make-do') { const p = state.products[draft.id]; const n = num(el.dataset.n); const r = await makeProduct(p, n); $('#pOnHand').textContent = num(p.on_hand); $('#pConfirm').innerHTML = ''; toast((isPlayset(p) ? 'Assembled ' : 'Made ') + n + ', ' + num(p.on_hand) + ' on the shelf' + (r.shorts.length ? ' · ' + r.shorts.join(', ') : '')); renderAll(); return; }
  if (a === 'log-undo') { const m = state.movements.find(x => x.id === id); if (!m) return; await undoMovement(m); toast('Undone'); renderAll(); return; }
  if (a === 'log-export') { if (!state.movements.length) { toast('Nothing logged yet'); return; } download('mostly3d-activity.csv', logCSV(), 'text/csv'); return; }
  if (a === 'reorder-copy') { copyText(reorderText(), 'Reorder list copied'); return; }
  if (a === 'gtin-pick') { const gtin = el.dataset.gtin, key = el.dataset.key; await dbWrite(() => sb.from('gtin_map').upsert({ gtin, cat_key: key }), 'Could not save the barcode'); state.gtin[gtin] = key; closeModal(); const on = Object.values(state.spools).find(s => s.cat_key === key); if (on && state.ui.scanMode === 'receive') { await receiveSpool(on, num(el.dataset.qty) || 1, 'scan'); flash('<b>' + esc(on.color) + '</b> +' + (num(el.dataset.qty) || 1) + ', now ' + rollsOf(on) + ' on hand'); renderAll(); } else if (on) openEditModal(on.id); else openAddModal(key, { qty: num(el.dataset.qty) || 1 }); return; }
  if (a === 'assign-open') { openAssignModal(el.dataset.code); return; }
  if (a === 'assign-save') { const c = el.dataset.code; const pid = $('#asgProd').value, sid = $('#asgSpool').value, aid = $('#asgPart') ? $('#asgPart').value : ''; if (pid) { const p = state.products[pid]; p.barcode = c; await saveProduct(p); toast('Attached to ' + p.name); } else if (sid) { const s = state.spools[sid]; s.barcode = c; await saveSpool(s); toast('Attached to ' + s.color); } else if (aid) { const x = state.parts[aid]; x.barcode = c; await savePart(x); toast('Attached to ' + x.name); } else { toast('Pick a product, a spool or a part', true); return; } closeModal(); renderAll(); return; }
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
  if (e.target.id === 'printerForm') { e.preventDefault(); const name = $('#printerName').value.trim(); if (!name) return; const model = $('#printerModel').value.trim() || null; try { await savePrinter({ name, model, brand: 'Bambu Lab', position: Object.keys(state.printers).length }); toast(name + ' added'); openPrintersModal(); renderParts(); } catch (err) {} return; }
  if (e.target.id === 'allowedForm') { e.preventDefault(); const email = $('#allowedEmail').value.trim().toLowerCase(); if (!email) return; try { await dbWrite(() => sb.from('allowed_users').upsert({ email }), 'Could not add'); if (state.allowedUsers.indexOf(email) < 0) state.allowedUsers.push(email); state.allowedUsers.sort(); renderSettings(); toast(email + ' can sign in now'); } catch (err) {} return; }
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'pPhotoFile') { const f = el.files && el.files[0]; if (!f) return; if (partDraft && $('#a_name')) { partDraft._photoFile = f; partDraft._photoPreview = URL.createObjectURL(f); readPartForm(); renderPartModal(true); return; } draft._photoFile = f; draft._photoPreview = URL.createObjectURL(f); readProductForm(); renderProductModal(true); return; }
  if (el.dataset.printer !== undefined) { el.closest('label').classList.toggle('on', el.checked); return; }
  if (el.name === 'adjReason') { document.querySelectorAll('input[name="adjReason"]').forEach(r => r.closest('label').classList.toggle('on', r.checked)); return; }
  if (el.id === 'logActor') { state.ui.logActor = el.value; renderLog(); return; }
  if (el.id === 'logFrom' || el.id === 'logTo') { state.ui[el.id] = el.value; renderLog(); return; }
  if (el.dataset.rec !== undefined && el.dataset.field === 'spool_id') { readProductForm(); draft._rec[+el.dataset.rec].spool_id = el.value; renderProductModal(true); return; }
  if (el.dataset.comp !== undefined && el.dataset.field === 'component_id') { readProductForm(); draft._comps[+el.dataset.comp].component_id = el.value; renderProductModal(true); return; }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'wallSearch') { state.ui.q = el.value; renderWall(); return; }
  if (el.id === 'productSearch') { state.ui.productQ = el.value; renderProducts(); return; }
  if (el.id === 'partSearch') { state.ui.partQ = el.value; renderParts(); return; }
  if (el.id === 'logQ') { state.ui.logQ = el.value; renderLog(); return; }
  if (el.id === 'm_hexpick') { const h = $('#m_hex'); if (h) h.value = el.value.toUpperCase(); return; }
  if (el.id === 'm_hex') { const v = el.value.trim(); if (/^#[0-9a-fA-F]{6}$/.test(v)) { const pk = $('#m_hexpick'); if (pk) pk.value = v.toLowerCase(); } return; }
  if (el.dataset.rec !== undefined && ['grams', 'purge_g', 'tower_g'].indexOf(el.dataset.field) >= 0) { draft._rec[+el.dataset.rec][el.dataset.field] = num(el.value); refreshCostbox(); return; }
  if (el.dataset.comp !== undefined && el.dataset.field === 'qty') { draft._comps[+el.dataset.comp].qty = num(el.value); refreshCostbox(); return; }
  if (['p_plate_qty', 'p_plate_hours', 'p_fin', 'p_pack', 'p_price'].indexOf(el.id) >= 0) { readProductForm(); refreshCostbox(); return; }
  if (el.dataset.setting) { state.settings[el.dataset.setting] = el.value === '' ? 0 : num(el.value); saveSettingsSoon(); renderProducts(); renderRack(); renderParts(); renderReorder(); renderHome(); return; }
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
document.querySelectorAll('nav.steps a[data-tab]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); goTab(a.dataset.tab); }));
window.addEventListener('hashchange', () => { const t = location.hash.replace('#', ''); if (TABS[t] && t !== state.ui.tab) { state.ui.tab = t; applyTab(); } });
(function(){ const t = location.hash.replace('#', ''); if (TABS[t]) state.ui.tab = t; })();
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
