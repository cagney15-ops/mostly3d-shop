// 812 Sensory Daily Brief: the owner's view of the agent office.
// Reads and writes the office_* tables in the same Supabase project as the shop app; same sign-in list.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49/+esm';
import { CONFIG } from './config.js';

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const TABS = { today: 1, orders: 1, parties: 1, events: 1, stock: 1, office: 1 };
const OWNER_FIRST = 'Brittany';

const state = {
  session: null, allowed: false,
  ui: { tab: 'today', orderChip: 'all', eventChip: null, eventView: 'board', calMonth: null, openEvent: null, openAgent: null, openRun: null },
  agents: [], runs: [], briefs: [], decisions: [], tasks: [], orders: [], bookings: [], events: [], insights: [], settings: {},
  runEvents: {}, viewingBrief: null
};

// ---------- helpers ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => n == null || isNaN(n) ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FULLDOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function parseDate(d) { if (!d) return null; if (d instanceof Date) return d; if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); } const x = new Date(d); return isNaN(x) ? null : x; }
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fmtDay(d) { d = parseDate(d); if (!d) return ''; return DOW[d.getDay()] + ' ' + MON[d.getMonth()] + ' ' + d.getDate(); }
function fmtDayYear(d) { d = parseDate(d); if (!d) return ''; const now = new Date(); return fmtDay(d) + (d.getFullYear() !== now.getFullYear() ? ', ' + d.getFullYear() : ''); }
function fmtTime(d) { d = parseDate(d); if (!d) return ''; let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0'); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return h + ':' + m + ' ' + ap; }
function fmtDateTime(d) { d = parseDate(d); if (!d) return ''; return fmtDay(d) + ' · ' + fmtTime(d); }
function fmtRange(a, b) { a = parseDate(a); b = parseDate(b); if (!a) return 'Date TBD'; if (!b || ymd(a) === ymd(b)) return fmtDayYear(a); if (a.getMonth() === b.getMonth()) return DOW[a.getDay()] + ' ' + MON[a.getMonth()] + ' ' + a.getDate() + ' – ' + DOW[b.getDay()] + ' ' + b.getDate(); return fmtDay(a) + ' – ' + fmtDayYear(b); }
function ago(d) { d = parseDate(d); if (!d) return 'never'; const s = (Date.now() - d.getTime()) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago'; return fmtDay(d); }
function daysUntil(d) { d = parseDate(d); if (!d) return null; const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 86400000); }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function md(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n'); let out = '', inList = false; const close = () => { if (inList) { out += '</ul>'; inList = false; } };
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>').replace(/`([^`]+)`/g, '$1');
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { close(); continue; }
    if (/^#{1,2}\s/.test(l)) { close(); out += '<h3>' + inline(l.replace(/^#+\s/, '')) + '</h3>'; continue; }
    if (/^#{3,}\s/.test(l)) { close(); out += '<h4>' + inline(l.replace(/^#+\s/, '')) + '</h4>'; continue; }
    if (/^([-*•]|\d+[.)])\s/.test(l)) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + inline(l.replace(/^([-*•]|\d+[.)])\s/, '')) + '</li>'; continue; }
    close(); out += '<p>' + inline(l) + '</p>';
  }
  close(); return out;
}
function toast(msg, bad) { const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), bad ? 4000 : 2200); }
function setStatus(kind, text) { const s = $('#status'); s.className = 'status ' + kind; $('#statusText').textContent = text || (kind === 'live' ? 'Live' : kind === 'error' ? 'Problem' : 'Working'); }
function setting(key, path, dflt) { const v = state.settings[key]; if (!v) return dflt; if (!path) return v; return v[path] == null ? dflt : v[path]; }
async function dbWrite(fn, failMsg) { try { const r = await fn(); if (r.error) throw r.error; return r; } catch (e) { console.error(e); toast((failMsg || 'Could not save') + ': ' + (e.message || e), true); throw e; } }
const me = () => state.session && state.session.user ? state.session.user.email : null;
const wixDash = p => 'https://manage.wix.com/dashboard/' + setting('business', 'wix_site_id', '') + '/' + p;

// ---------- data ----------
async function loadAll() {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const since2 = new Date(Date.now() - 2 * 86400000).toISOString();
  const [agents, runs, briefs, decisions, tasks, orders, bookings, events, insights, settings] = await Promise.all([
    sb.from('office_agents').select('*').order('sort'),
    sb.from('office_runs').select('*').order('started_at', { ascending: false }).limit(80),
    sb.from('office_briefs').select('*').order('created_at', { ascending: false }).limit(14),
    sb.from('office_decisions').select('*').or('status.eq.open,answered_at.gte.' + since7).order('created_at', { ascending: false }).limit(60),
    sb.from('office_tasks').select('*').or('done.eq.false,done_at.gte.' + since2).order('due_at', { ascending: true, nullsFirst: false }).limit(120),
    sb.from('office_orders').select('*').order('placed_at', { ascending: false }).limit(200),
    sb.from('office_bookings').select('*').gte('starts_at', since30).order('starts_at').limit(200),
    sb.from('office_events').select('*').order('start_date', { ascending: true, nullsFirst: false }).limit(400),
    sb.from('office_insights').select('*').gte('created_at', since2).order('created_at', { ascending: false }).limit(80),
    sb.from('office_settings').select('*')
  ]);
  for (const r of [agents, runs, briefs, decisions, tasks, orders, bookings, events, insights, settings]) if (r.error) throw r.error;
  state.agents = agents.data; state.runs = runs.data; state.briefs = briefs.data; state.decisions = decisions.data; state.tasks = tasks.data;
  state.orders = orders.data; state.bookings = bookings.data; state.events = events.data;
  // insights: keep only the newest run's set per agent
  const latestRun = {}; for (const i of insights.data) { if (!latestRun[i.agent_id]) latestRun[i.agent_id] = i.run_id || i.created_at.slice(0, 13); }
  state.insights = insights.data.filter(i => (i.run_id || i.created_at.slice(0, 13)) === latestRun[i.agent_id]);
  state.settings = {}; for (const s of settings.data) state.settings[s.key] = s.value;
}
let reloadTimer = null;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(async () => { try { await loadAll(); renderAll(); } catch (e) { console.error(e); } }, 600); }
let channel = null;
function subscribe() {
  if (channel) return;
  channel = sb.channel('office-changes');
  for (const t of ['office_agents', 'office_runs', 'office_run_events', 'office_briefs', 'office_decisions', 'office_tasks', 'office_orders', 'office_bookings', 'office_events', 'office_insights', 'office_settings']) channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => scheduleReload());
  channel.subscribe();
}

// ---------- render ----------
function renderAll() { renderHello(); renderToday(); renderOrders(); renderParties(); renderEvents(); renderStock(); renderOffice(); renderSettings(); renderNav(); applyTab(); }
function renderNav() {
  const openDec = state.decisions.filter(d => d.status === 'open').length;
  const dueTasks = state.tasks.filter(t => !t.done && (!t.snoozed_until || new Date(t.snoozed_until) <= new Date()) && (!t.due_at || new Date(t.due_at) <= new Date(Date.now() + 86400000))).length;
  const flagged = state.orders.filter(o => o.flags && o.flags.length && !o.flags.includes('test')).length;
  const pending = state.bookings.filter(b => (b.status || '').toUpperCase() === 'PENDING').length;
  const found = state.events.filter(e => e.status === 'found').length;
  const act = state.insights.filter(i => i.severity === 'act').length;
  const set = (id, n) => { const el = $(id); el.textContent = n; el.hidden = !n; };
  set('#navToday', openDec + dueTasks); set('#navOrders', flagged); set('#navParties', pending); set('#navEvents', found); set('#navStock', act);
}
function goTab(t) { state.ui.tab = t; history.replaceState(null, '', '#' + t); applyTab(); }
function applyTab() { $$('section.sec').forEach(s => s.hidden = s.dataset.tab !== state.ui.tab); $$('nav.steps a[data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === state.ui.tab)); }

function renderHello() {
  const now = new Date(); const h = now.getHours();
  $('#helloBig').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + ', ' + OWNER_FIRST + '.';
  const latest = state.briefs[0];
  let line = null;
  if (latest && latest.greeting && latest.for_date === ymd(now)) line = latest.greeting;
  if (!line) { const g = setting('greetings', null, {}); const pool = (h < 14 ? g.morning : g.evening) || g.morning || ["Grab your coffee, take a sip, and let's see what's new."]; const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000); line = pool[doy % pool.length]; }
  $('#helloLine').textContent = line;
  $('#helloDate').textContent = FULLDOW[now.getDay()] + ', ' + MONTHS[now.getMonth()] + ' ' + now.getDate();
}

function renderToday() {
  const now = new Date(); const dayAgo = new Date(Date.now() - 86400000);
  const newOrders = state.orders.filter(o => o.placed_at && new Date(o.placed_at) >= dayAgo && !(o.flags || []).includes('test'));
  const newTotal = newOrders.reduce((s, o) => s + Number(o.total || 0), 0);
  const parties7 = state.bookings.filter(b => b.starts_at && new Date(b.starts_at) >= startOfDay(now) && new Date(b.starts_at) < new Date(Date.now() + 7 * 86400000) && !/CANCEL|DECLIN/i.test(b.status || ''));
  const openDec = state.decisions.filter(d => d.status === 'open');
  const openTasks = state.tasks.filter(t => !t.done && (!t.snoozed_until || new Date(t.snoozed_until) <= now));
  const dueToday = openTasks.filter(t => !t.due_at || new Date(t.due_at) <= new Date(Date.now() + 86400000));
  const found = state.events.filter(e => e.status === 'found');
  const tile = (tab, label, value, sub, cls) => '<button class="tile-num' + (cls ? ' ' + cls : '') + '" data-action="go" data-tab="' + tab + '"><span class="tl">' + label + '</span><span class="tv">' + value + '</span><span class="ts">' + sub + '</span></button>';
  $('#todayTiles').innerHTML = tile('orders', 'New orders', newOrders.length, newOrders.length ? money(newTotal) + ' in the last 24 h' : 'last 24 hours')
    + tile('parties', 'Parties', parties7.length, 'in the next 7 days')
    + tile('today', 'Decisions', openDec.length, openDec.length ? 'waiting on you' : 'nothing waiting', openDec.length ? 'alert' : '')
    + tile('today', 'Reminders', dueToday.length, openTasks.length ? openTasks.length + ' open, ' + dueToday.length + ' due' : 'all clear', dueToday.some(t => t.due_at && new Date(t.due_at) < startOfDay(now)) ? 'alert' : '')
    + tile('events', 'Events to review', found.length, found.length ? 'new from Scout' : 'board is clear');

  // the brief
  const b = state.viewingBrief || state.briefs[0];
  if (!b) {
    $('#briefBox').innerHTML = '<div class="bh">Your first brief is on its way.</div><div class="bm"><span>The Chief writes one every morning at 7 and every evening at 5</span></div><div class="md"><p>Until then the team is already filing orders, parties, events and stock findings into the tabs above.</p></div>';
  } else {
    const isOld = b !== state.briefs[0];
    $('#briefBox').innerHTML = '<div class="bh">' + esc(b.headline) + '</div><div class="bm"><span>' + (b.period === 'evening' ? 'Evening' : b.period === 'morning' ? 'Morning' : 'Special') + ' brief · ' + fmtDateTime(b.created_at) + '</span>' + (b.emailed_at ? '<span>Emailed to ' + esc((b.emailed_to || []).join(', ')) + '</span>' : '') + (isOld ? '<button type="button" class="linklike" data-action="brief-latest">Back to the latest</button>' : '') + '</div><div class="md">' + md(b.body_md) + '</div>';
  }
  // decisions
  const dec = state.decisions.slice().sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1));
  $('#decisionList').innerHTML = dec.length ? dec.map(d => {
    const agent = state.agents.find(a => a.id === d.agent_id);
    const opts = Array.isArray(d.options) && d.options.length ? d.options : [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }];
    if (d.status !== 'open') { const chosen = opts.find(o => o.key === d.chosen); return '<div class="decision done"><div class="dt">' + esc(d.title) + '<span class="tag ok">' + esc(chosen ? chosen.label : d.chosen || 'answered') + '</span></div><div class="dd">Answered ' + ago(d.answered_at) + (d.answer_note ? ' · ' + esc(d.answer_note) : '') + '</div></div>'; }
    return '<div class="decision' + (d.priority === 'high' ? ' high' : '') + '" data-id="' + d.id + '"><div class="dt">' + esc(d.title) + (d.priority === 'high' ? '<span class="tag">Today</span>' : '') + '</div><div class="dd md">' + md(d.detail_md) + (d.link_url ? '<a href="' + esc(d.link_url) + '" target="_blank" rel="noopener">Open the details</a>' : '') + '</div><div class="opts">' + opts.map(o => '<button class="btn small' + (o.key === 'no' || o.key === 'skip' ? ' ghost' : '') + '" data-action="decide" data-id="' + d.id + '" data-key="' + esc(o.key) + '">' + esc(o.label) + '</button>').join('') + '</div><div class="note"><input type="text" placeholder="Add a note with your answer (optional)" data-note-for="' + d.id + '"></div><div class="who" style="margin-top:6px">Asked by ' + esc(agent ? agent.name : d.agent_id) + ' · ' + ago(d.created_at) + (d.due_at ? ' · needs an answer by ' + fmtDay(d.due_at) : '') + '</div></div>';
  }).join('') : '<div class="empty">Nothing needs a decision right now.</div>';
  // tasks
  const tasks = state.tasks.filter(t => !t.done || (t.done_at && new Date(t.done_at) > new Date(Date.now() - 6 * 3600000))).filter(t => !t.snoozed_until || new Date(t.snoozed_until) <= now);
  $('#taskList').innerHTML = tasks.length ? tasks.map(t => {
    const agent = state.agents.find(a => a.id === t.agent_id); const du = t.due_at ? daysUntil(t.due_at) : null;
    const dueTxt = du == null ? '' : du < 0 ? (-du) + 'd overdue' : du === 0 ? 'today' : du === 1 ? 'tomorrow' : fmtDay(t.due_at);
    return '<label class="todo' + (t.done ? ' done' : '') + '"><input type="checkbox" data-action="task-done" data-id="' + t.id + '"' + (t.done ? ' checked' : '') + '><span class="t">' + esc(t.title) + (t.detail ? '<span class="sub">' + esc(t.detail) + '</span>' : '') + (t.link_url ? '<span class="sub"><a href="' + esc(t.link_url) + '" target="_blank" rel="noopener">Open</a></span>' : '') + '<span class="sub">' + esc(agent ? agent.name : t.agent_id) + '</span></span>' + (dueTxt ? '<span class="due' + (du < 0 ? ' over' : '') + '">' + esc(dueTxt) + '</span>' : '') + '</label>';
  }).join('') : '<div class="empty">No reminders. Nice.</div>';
  // team
  $('#teamList').innerHTML = state.agents.filter(a => a.phase === 1).map(a => '<div class="teamline"><b>' + esc(a.name) + '</b><span class="s">' + esc(a.status === 'running' && a.current_task ? a.current_task : a.last_summary || (a.last_run_at ? 'Ran, nothing to report.' : 'Has not run yet.')) + '</span><span class="w">' + (a.status === 'running' ? 'working now' : ago(a.last_run_at)) + '</span></div>').join('');
  // past briefs
  $('#pastBriefs').innerHTML = state.briefs.length > 1 ? state.briefs.slice(1, 8).map(b => '<button type="button" data-action="brief-view" data-id="' + b.id + '">' + esc(b.headline) + '<span>' + fmtDateTime(b.created_at) + '</span></button>').join('') : '<div class="empty">Earlier briefs will collect here.</div>';
}

function renderOrders() {
  const real = state.orders.filter(o => !(o.flags || []).includes('test'));
  const today = real.filter(o => o.placed_at && new Date(o.placed_at) >= startOfDay(new Date()));
  const week = real.filter(o => o.placed_at && new Date(o.placed_at) >= new Date(Date.now() - 7 * 86400000));
  const month = real.filter(o => o.placed_at && new Date(o.placed_at) >= new Date(Date.now() - 30 * 86400000));
  const flagged = real.filter(o => o.flags && o.flags.length);
  const open = real.filter(o => /UNFULFILLED|NOT_FULFILLED|PARTIAL/i.test(o.fulfillment_status || '') && /PAID/i.test(o.payment_status || ''));
  const sum = arr => arr.reduce((s, o) => s + Number(o.total || 0), 0);
  const tile = (label, value, sub, cls) => '<div class="tile-num' + (cls ? ' ' + cls : '') + '"><span class="tl">' + label + '</span><span class="tv">' + value + '</span><span class="ts">' + sub + '</span></div>';
  $('#orderTiles').innerHTML = tile('Today', today.length, money(sum(today)) || 'no orders yet') + tile('This week', money(sum(week)) || '$0', week.length + ' orders') + tile('30 days', money(sum(month)) || '$0', month.length + ' orders') + tile('To fulfill', open.length, 'paid, not shipped', open.length ? 'alert' : '') + tile('Flagged', flagged.length, 'need a look', flagged.length ? 'alert' : '');
  const chans = {}; for (const o of real) chans[o.channel] = (chans[o.channel] || 0) + 1;
  const chip = (k, l, n) => '<button class="chip' + (state.ui.orderChip === k ? ' on' : '') + '" data-action="order-chip" data-k="' + k + '">' + l + (n != null ? '<span class="n">' + n + '</span>' : '') + '</button>';
  $('#orderChips').innerHTML = chip('all', 'All', real.length) + chip('flagged', 'Flagged', flagged.length) + Object.keys(chans).sort().map(c => chip(c, chanLabel(c), chans[c])).join('');
  let rows = state.ui.orderChip === 'all' ? real : state.ui.orderChip === 'flagged' ? flagged : real.filter(o => o.channel === state.ui.orderChip);
  $('#orderList').innerHTML = rows.length ? '<table class="list"><thead><tr><th>When</th><th>Order</th><th>Customer</th><th>Items</th><th class="n">Total</th><th>Status</th></tr></thead><tbody>' + rows.map(o => '<tr' + (o.flags && o.flags.length ? ' class="flagged"' : '') + '><td>' + fmtDay(o.placed_at) + '<span class="sub">' + fmtTime(o.placed_at) + '</span></td><td><span class="chan">' + esc(chanLabel(o.channel)) + '</span><span class="sub">' + (o.source_url ? '<a href="' + esc(o.source_url) + '" target="_blank" rel="noopener">#' + esc(o.number || o.external_id) + '</a>' : '#' + esc(o.number || o.external_id)) + '</span></td><td>' + esc(o.customer_name || '—') + (o.customer_email ? '<span class="sub">' + esc(o.customer_email) + '</span>' : '') + '</td><td>' + esc(o.items_summary || '') + (o.buyer_note ? '<span class="sub">Note: ' + esc(o.buyer_note) + '</span>' : '') + '</td><td class="n">' + money(o.total) + '</td><td><span class="order-flags">' + (o.flags || []).map(f => '<span class="tag">' + esc(f) + '</span>').join('') + '</span><span class="sub">' + esc(prettyStatus(o.payment_status)) + (o.fulfillment_status ? ' · ' + esc(prettyStatus(o.fulfillment_status)) : '') + '</span></td></tr>').join('') + '</tbody></table>' : '<div class="empty">' + (real.length ? 'Nothing in this filter.' : 'No orders filed yet. Till runs every two hours during the day.') + '</div>';
  $('#wixOrdersLink').href = wixDash('ecom-platform/orders');
}
function chanLabel(c) { return ({ wix: 'Website', etsy: 'Etsy', tiktok: 'TikTok Shop', booking: 'Party', plan: 'Plan', giftcard: 'Gift card', paylink: 'Pay link', pos: 'In person' })[c] || c; }
function prettyStatus(s) { return String(s || '').toLowerCase().replace(/_/g, ' '); }

function renderParties() {
  const now = new Date();
  const live = state.bookings.filter(b => !/CANCEL|DECLIN/i.test(b.status || ''));
  const pending = live.filter(b => (b.status || '').toUpperCase() === 'PENDING');
  const upcoming = live.filter(b => b.starts_at && new Date(b.starts_at) >= startOfDay(now)).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const next7 = upcoming.filter(b => new Date(b.starts_at) < new Date(Date.now() + 7 * 86400000));
  const month = upcoming.filter(b => new Date(b.starts_at).getMonth() === now.getMonth() && new Date(b.starts_at).getFullYear() === now.getFullYear());
  const tile = (label, value, sub, cls) => '<div class="tile-num' + (cls ? ' ' + cls : '') + '"><span class="tl">' + label + '</span><span class="tv">' + value + '</span><span class="ts">' + sub + '</span></div>';
  $('#partyTiles').innerHTML = tile('Waiting on you', pending.length, pending.length ? 'requests to approve in Wix' : 'no requests waiting', pending.length ? 'alert' : '') + tile('Next 7 days', next7.length, next7.length ? next7.map(b => fmtDay(b.starts_at)).join(', ') : 'nothing booked') + tile('This month', month.length, MONTHS[now.getMonth()]) + tile('Booked ahead', upcoming.length, 'parties on the calendar') + tile('Unpaid deposits', upcoming.filter(b => /NOT_PAID|UNDEFINED/i.test(b.payment_status || '')).length, 'collect at booking or on the day');
  // weekends
  const cap = Number(setting('parties', 'cap_per_weekend', 2));
  const sat = startOfDay(now); sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7));
  let wk = '';
  for (let i = 0; i < 8; i++) {
    const s = new Date(sat); s.setDate(sat.getDate() + i * 7); const sun = new Date(s); sun.setDate(s.getDate() + 1); const e = new Date(s); e.setDate(s.getDate() + 2);
    const n = live.filter(b => b.starts_at && new Date(b.starts_at) >= s && new Date(b.starts_at) < e).length;
    wk += '<div class="wk' + (n >= cap ? ' full' : '') + '"><b>' + MON[s.getMonth()] + ' ' + s.getDate() + '–' + (sun.getMonth() !== s.getMonth() ? MON[sun.getMonth()] + ' ' : '') + sun.getDate() + '</b>' + (n >= cap ? 'Full' : n + ' of ' + cap + ' booked') + '<div class="pips">' + Array.from({ length: Math.max(cap, n) }, (_, k) => '<i class="' + (k < n ? 'on' : '') + '"></i>').join('') + '</div></div>';
  }
  $('#weekendList').innerHTML = wk;
  $('#bookingList').innerHTML = upcoming.length ? upcoming.map(b => '<div class="bk' + ((b.status || '').toUpperCase() === 'PENDING' ? ' pending' : '') + '"><div class="when">' + fmtDay(b.starts_at) + ' · ' + fmtTime(b.starts_at) + '</div><div class="svc">' + esc(b.service_name || 'Party') + (b.ends_at ? ' · until ' + fmtTime(b.ends_at) : '') + '</div><div class="who">' + esc(b.customer_name || 'Name not given') + (b.participants ? ' · ' + b.participants + ' guests' : '') + '</div><div class="meta">' + ((b.status || '').toUpperCase() === 'PENDING' ? '<span class="tag">Needs your yes</span>' : '<span class="tag ok">' + esc(prettyStatus(b.status || 'booked')) + '</span>') + '<span>' + esc(prettyStatus(b.payment_status || '')) + '</span>' + (b.customer_phone ? '<span>' + esc(b.customer_phone) + '</span>' : '') + (b.customer_email ? '<span>' + esc(b.customer_email) + '</span>' : '') + '</div>' + (b.notes ? '<div class="meta" style="margin-top:6px">' + esc(b.notes) + '</div>' : '') + '</div>').join('') : '<div class="empty">No parties on the books yet. When a request comes in through the site, it shows here and Booker leaves you a reminder.</div>';
  $('#wixBookingsLink').href = wixDash('bookings/calendar');
}

const EV_FLOW = { found: [['kept', 'Keep', ''], ['removed', 'Remove', 'ghost']], kept: [['applied', 'Applied', ''], ['removed', 'Remove', 'ghost']], applied: [['accepted', 'Accepted', ''], ['declined', 'Declined', 'ghost']], accepted: [['scheduled', 'Scheduled', ''], ['declined', 'Fell through', 'ghost']], scheduled: [['removed', 'Not going', 'ghost']], removed: [['kept', 'Restore', 'ghost']], declined: [['kept', 'Restore', 'ghost']], past: [] };
const EV_LABEL = { found: 'To review', kept: 'Kept', applied: 'Applied', accepted: 'Accepted', scheduled: 'Scheduled', removed: 'Removed', declined: 'Declined', past: 'Past' };
function renderEvents() {
  const counts = {}; for (const e of state.events) counts[e.status] = (counts[e.status] || 0) + 1;
  const tent = (counts.applied || 0) + (counts.accepted || 0);
  const tile = (label, value, sub, cls) => '<div class="tile-num' + (cls ? ' ' + cls : '') + '"><span class="tl">' + label + '</span><span class="tv">' + value + '</span><span class="ts">' + sub + '</span></div>';
  const soon = state.events.filter(e => ['kept', 'applied'].includes(e.status) && e.deadline && daysUntil(e.deadline) != null && daysUntil(e.deadline) >= 0 && daysUntil(e.deadline) <= 14);
  $('#eventTiles').innerHTML = tile('To review', counts.found || 0, 'keep or remove', counts.found ? 'alert' : '') + tile('Kept', counts.kept || 0, 'worth applying to') + tile('Tentative', tent, 'applied or accepted') + tile('Scheduled', counts.scheduled || 0, 'on the calendar') + tile('Deadlines', soon.length, soon.length ? 'in the next 14 days' : 'none close', soon.length ? 'alert' : '');
  if (!state.ui.eventChip) state.ui.eventChip = counts.found ? 'found' : counts.kept ? 'kept' : 'all';
  const chip = (k, l, n) => '<button class="chip' + (state.ui.eventChip === k ? ' on' : '') + '" data-action="event-chip" data-k="' + k + '">' + l + (n != null ? '<span class="n">' + n + '</span>' : '') + '</button>';
  $('#eventChips').innerHTML = ['found', 'kept', 'applied', 'accepted', 'scheduled', 'removed', 'declined', 'past'].map(k => chip(k, EV_LABEL[k], counts[k] || 0)).join('') + chip('all', 'All', state.events.length);
  const rows = (state.ui.eventChip === 'all' ? state.events.slice() : state.events.filter(e => e.status === state.ui.eventChip)).sort((a, b) => (a.start_date || '9999') < (b.start_date || '9999') ? -1 : 1);
  $('#eventList').innerHTML = rows.length ? rows.map(e => eventCard(e)).join('') : '<div class="empty">' + (state.events.length ? 'Nothing here.' : 'Scout has not filed any events yet. The first search runs Monday morning.') + '</div>';
  $('#eventBoard').hidden = state.ui.eventView !== 'board';
  $('#eventCalendar').hidden = state.ui.eventView !== 'calendar';
  $$('#eventView button').forEach(b => b.classList.toggle('on', b.dataset.view === state.ui.eventView));
  if (state.ui.eventView === 'calendar') renderCalendar();
}
function eventCard(e) {
  const flow = EV_FLOW[e.status] || [];
  const du = e.deadline ? daysUntil(e.deadline) : null;
  const fit = e.fit_score ? '<span class="fit" title="Fit for a kids-and-family crowd">' + [1, 2, 3, 4, 5].map(i => '<i class="' + (i <= e.fit_score ? 'on' : '') + '"></i>').join('') + '</span>' : '';
  return '<div class="ev ' + esc(e.status) + (state.ui.openEvent === e.id ? ' open' : '') + '" data-id="' + e.id + '" id="ev-' + e.id + '">'
    + '<div class="top"><div class="nm">' + esc(e.name) + '</div><span class="stat">' + esc(EV_LABEL[e.status] || e.status) + '</span></div>'
    + '<div class="dates">' + fmtRange(e.start_date, e.end_date) + '</div>'
    + '<div class="where">' + esc([e.venue, e.city].filter(Boolean).join(' · ')) + (e.distance_miles != null ? ' · ' + Math.round(e.distance_miles) + ' mi' : '') + '</div>'
    + '<div class="facts">' + (e.category ? '<span><b>' + esc(e.category) + '</b></span>' : '') + (e.fee ? '<span>Fee <b>' + esc(e.fee) + '</b></span>' : '') + (e.booth ? '<span>Booth <b>' + esc(e.booth) + '</b></span>' : '') + (e.attendance ? '<span>Crowd <b>' + esc(e.attendance) + '</b></span>' : '') + (e.deadline ? '<span class="deadline' + (du != null && du <= 14 && du >= 0 ? ' soon' : '') + '">Apply by <b>' + fmtDayYear(e.deadline) + '</b>' + (du != null ? (du < 0 ? ' (passed)' : du === 0 ? ' (today)' : ' (' + du + ' d)') : '') + '</span>' : '') + fit + '</div>'
    + (e.summary ? '<button type="button" class="sum linklike" style="text-decoration:none" data-action="event-toggle" data-id="' + e.id + '">' + esc(e.summary) + (e.fit_notes ? ' ' + esc(e.fit_notes) : '') + '</button>' : '')
    + '<div class="notes"><textarea placeholder="Your notes (saved when you click away)" data-action="event-notes" data-id="' + e.id + '">' + esc(e.notes || '') + '</textarea></div>'
    + '<div class="acts">' + flow.map(([to, label, cls]) => '<button class="btn small' + (cls ? ' ' + cls : '') + '" data-action="event-status" data-id="' + e.id + '" data-to="' + to + '">' + label + '</button>').join('')
    + (['accepted', 'scheduled'].includes(e.status) ? '<label class="res"><input type="checkbox" data-action="event-reserved" data-id="' + e.id + '"' + (e.reserved ? ' checked' : '') + '>Booth reserved</label>' : '')
    + (['kept', 'applied', 'accepted', 'scheduled'].includes(e.status) && e.start_date ? '<button class="btn small ghost" data-action="event-ics" data-id="' + e.id + '">' + (e.on_calendar ? 'Calendar file again' : 'Add to my calendar') + '</button>' : '')
    + '<span class="sp"></span><span class="links">' + (e.apply_url ? '<a href="' + esc(e.apply_url) + '" target="_blank" rel="noopener">Apply</a>' : '') + (e.info_url ? '<a href="' + esc(e.info_url) + '" target="_blank" rel="noopener">Info</a>' : '') + '<button type="button" class="linklike" data-action="event-toggle" data-id="' + e.id + '">' + (state.ui.openEvent === e.id ? 'Less' : 'More') + '</button></span></div>'
    + '</div>';
}
function renderCalendar() {
  const now = new Date();
  if (!state.ui.calMonth) state.ui.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const m = state.ui.calMonth; const first = new Date(m.getFullYear(), m.getMonth(), 1); const start = new Date(first); start.setDate(1 - first.getDay());
  const items = [];
  for (const e of state.events) { if (!e.start_date || !['kept', 'applied', 'accepted', 'scheduled'].includes(e.status)) continue; items.push({ kind: e.status === 'scheduled' ? 'sched' : e.status === 'kept' ? 'kept' : 'tent', s: parseDate(e.start_date), e: parseDate(e.end_date || e.start_date), label: e.name, id: e.id, type: 'event' }); }
  for (const b of state.bookings) { if (!b.starts_at || /CANCEL|DECLIN/i.test(b.status || '')) continue; const d = parseDate(b.starts_at); items.push({ kind: 'party', s: d, e: d, label: fmtTime(d) + ' ' + (b.service_name || 'Party') + (b.customer_name ? ' · ' + b.customer_name : ''), type: 'party' }); }
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i); const key = ymd(d); const off = d.getMonth() !== m.getMonth();
    const todays = items.filter(it => ymd(it.s) <= key && ymd(it.e) >= key);
    cells += '<div class="d' + (off ? ' off' : '') + (key === ymd(now) ? ' today' : '') + '"><span class="dn">' + d.getDate() + '</span>' + todays.map(it => '<button type="button" class="it ' + (it.kind === 'sched' ? '' : it.kind) + '" title="' + esc(it.label) + '"' + (it.type === 'event' ? ' data-action="event-jump" data-id="' + it.id + '"' : ' data-action="go" data-tab="parties"') + '>' + esc(it.label) + '</button>').join('') + '</div>';
    if (i >= 34 && d.getMonth() !== m.getMonth() && (i + 1) % 7 === 0) break;
  }
  $('#eventCalendar').innerHTML = '<div class="cal"><div class="ch"><button class="btn ghost small" data-action="cal-prev">‹ Prev</button><h3>' + MONTHS[m.getMonth()] + ' ' + m.getFullYear() + '</h3><div style="display:flex;gap:6px"><button class="btn ghost small" data-action="cal-today">Today</button><button class="btn ghost small" data-action="cal-next">Next ›</button></div></div><div class="dow">' + DOW.map(d => '<span>' + d + '</span>').join('') + '</div><div class="days">' + cells + '</div><div class="legend"><span><i></i>Scheduled</span><span><i class="tent"></i>Tentative (applied or accepted)</span><span><i class="kept"></i>Kept, not applied yet</span><span><i class="party"></i>Party booking</span></div></div>';
}
function icsFor(e) {
  const s = parseDate(e.start_date); const en = parseDate(e.end_date || e.start_date); en.setDate(en.getDate() + 1);
  const d8 = d => ymd(d).replace(/-/g, '');
  const escI = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const desc = [e.summary, e.fee ? 'Fee: ' + e.fee : '', e.booth ? 'Booth: ' + e.booth : '', e.deadline ? 'Apply by ' + e.deadline : '', e.apply_url ? 'Apply: ' + e.apply_url : '', e.info_url ? 'Info: ' + e.info_url : '', e.notes ? 'Notes: ' + e.notes : ''].filter(Boolean).join('\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//812 Sensory//Daily Brief//EN', 'BEGIN:VEVENT', 'UID:' + e.id + '@812sensory', 'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''), 'DTSTART;VALUE=DATE:' + d8(s), 'DTEND;VALUE=DATE:' + d8(en), 'SUMMARY:' + escI((e.status === 'scheduled' ? '' : 'Tentative: ') + e.name), 'LOCATION:' + escI([e.venue, e.address, e.city].filter(Boolean).join(', ')), 'DESCRIPTION:' + escI(desc), e.info_url ? 'URL:' + e.info_url : '', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
}

function renderStock() {
  const by = k => state.insights.filter(i => i.severity === k);
  const tile = (label, value, sub, cls) => '<div class="tile-num' + (cls ? ' ' + cls : '') + '"><span class="tl">' + label + '</span><span class="tv">' + value + '</span><span class="ts">' + sub + '</span></div>';
  const stock = state.agents.find(a => a.id === 'stock');
  $('#stockTiles').innerHTML = tile('Act today', by('act').length, 'findings', by('act').length ? 'alert' : '') + tile('Watch', by('watch').length, 'findings') + tile('Low stock', state.insights.filter(i => i.kind === 'low_stock').length, 'items or groups flagged') + tile('Top sellers', state.insights.filter(i => i.kind === 'top_seller').length, 'listed') + tile('As of', stock && stock.last_run_at ? fmtTime(stock.last_run_at) : '—', stock && stock.last_run_at ? fmtDay(stock.last_run_at) : 'not run yet');
  const order = { act: 0, watch: 1, info: 2 };
  const rows = state.insights.slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  $('#insightList').innerHTML = rows.length ? rows.map(i => '<div class="ins ' + esc(i.severity) + '"><span class="tag' + (i.severity === 'act' ? '' : i.severity === 'watch' ? ' ok' : ' mute') + '">' + esc(i.severity === 'act' ? 'Act' : i.severity) + '</span> <span class="chan">' + esc(String(i.kind).replace(/_/g, ' ')) + '</span><div class="it">' + esc(i.title) + '</div><div class="md">' + md(i.detail_md) + '</div></div>').join('') : '<div class="empty">Stock has not filed findings yet. It reads the store every morning around 5:40.</div>';
}

function renderOffice() {
  const runsFor = id => state.runs.filter(r => r.agent_id === id);
  let html = state.agents.map(a => {
    const st = a.status === 'hiring' || a.phase > 1 ? 'hiring' : !a.enabled ? 'paused' : a.status === 'running' ? 'running' : a.status === 'error' ? 'error' : 'live';
    const stTxt = { hiring: 'Starting soon', paused: 'Paused', running: 'Working now', error: 'Needs a look', live: 'On shift' }[st];
    const now = a.status === 'running' && a.current_task ? a.current_task : a.last_summary || a.blurb;
    return '<button class="desk ' + st + (state.ui.openAgent === a.id ? ' open' : '') + '" data-action="agent-open" data-id="' + a.id + '"><div class="head"><span class="mono">' + esc(a.name.replace(/^The /, '')[0]) + '</span><div><div class="nm">' + esc(a.name) + '</div><div class="rl">' + esc(a.role) + '</div></div></div><div class="st ' + st + '"><span class="led"></span>' + stTxt + '</div><div class="now">' + esc(now) + '</div><div class="meta">' + (st === 'hiring' ? esc(a.cadence_text) : 'Last run ' + ago(a.last_run_at) + ' · ' + esc(a.cadence_text)) + '</div></button>';
  }).join('');
  const open = state.agents.find(a => a.id === state.ui.openAgent);
  if (open) {
    const runs = runsFor(open.id).slice(0, 12);
    html += '<div class="agentpanel" id="agentPanel"><div><h3>' + esc(open.name) + '</h3><div class="blurb">' + esc(open.blurb) + '</div><div class="field"><label>Standing orders</label><textarea id="agentInstr" data-id="' + open.id + '">' + esc(open.instructions) + '</textarea><small>' + esc(open.name) + ' reads this at the start of every run. Plain English is fine.</small></div><div class="acts"><button class="btn small" data-action="agent-save" data-id="' + open.id + '">Save orders</button>' + (open.phase === 1 ? '<button class="btn small ghost" data-action="agent-toggle" data-id="' + open.id + '">' + (open.enabled ? 'Pause ' + esc(open.name) : 'Resume ' + esc(open.name)) + '</button>' : '') + '<span class="sp" style="flex:1"></span><button class="btn small ghost" data-action="agent-close">Close</button></div></div>'
      + '<div class="runs"><div class="field"><label>Recent runs</label></div>' + (runs.length ? runs.map(r => '<div class="run' + (state.ui.openRun === r.id ? ' open' : '') + '" data-id="' + r.id + '"><div class="rh" data-action="run-open" data-id="' + r.id + '"><span class="tag' + (r.status === 'done' ? ' ok' : r.status === 'running' ? '' : r.status === 'failed' ? '' : ' mute') + '">' + esc(r.status) + '</span><span>' + esc(r.summary || (r.status === 'running' ? 'In progress' : 'No summary')) + '</span><span class="when">' + fmtDateTime(r.started_at) + '</span></div>' + (r.error ? '<div class="rs" style="color:var(--red)">' + esc(r.error) + '</div>' : '') + '<div class="log" id="log-' + r.id + '">' + (state.runEvents[r.id] ? renderLog(state.runEvents[r.id]) : '<div>Loading…</div>') + '</div></div>').join('') : '<div class="empty">No runs yet.</div>') + '</div></div>';
  }
  $('#floor').innerHTML = html;
}
function renderLog(evs) { return evs.length ? evs.map(e => '<div class="' + esc(e.kind) + '"><b>' + esc(e.kind) + '</b>' + esc(e.message) + ' <span style="color:var(--ink-3);font-size:11px">' + fmtTime(e.at) + '</span></div>').join('') : '<div>No log lines for this run.</div>'; }
async function loadRunEvents(runId) { const r = await sb.from('office_run_events').select('*').eq('run_id', runId).order('at'); if (!r.error) { state.runEvents[runId] = r.data; const el = $('#log-' + runId); if (el) el.innerHTML = renderLog(r.data); } }

function renderSettings() {
  const f = (key, path, label, type, hint) => '<div class="field"><label>' + label + '</label><input type="' + type + '" data-key="' + key + '" data-path="' + path + '" value="' + esc(Array.isArray(setting(key, path, '')) ? setting(key, path, []).join(', ') : setting(key, path, '')) + '">' + (hint ? '<small>' + hint + '</small>' : '') + '</div>';
  $('#settingsForm').innerHTML = f('notify', 'emails', 'Brief goes to', 'text', 'Comma-separated emails') + f('scout', 'radius_miles', 'Scout radius (miles)', 'number', 'from Bedford') + f('scout', 'months_ahead', 'Scout looks ahead (months)', 'number') + f('stock', 'low_stock_threshold', 'Low stock at or under', 'number') + f('parties', 'cap_per_weekend', 'Parties per weekend', 'number') + f('orders', 'christmas_ship_cutoff', 'Last Christmas ship date', 'date') + '<div class="field"><label>&nbsp;</label><button class="btn small" type="submit">Save settings</button></div>';
}

// ---------- actions ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return; const a = el.dataset.action; const id = el.dataset.id;
  if (a === 'go') { goTab(el.dataset.tab); window.scrollTo({ top: 0 }); return; }
  if (a === 'brief-view') { state.viewingBrief = state.briefs.find(b => b.id === id) || null; renderToday(); $('#briefBox').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (a === 'brief-latest') { state.viewingBrief = null; renderToday(); return; }
  if (a === 'decide') {
    const d = state.decisions.find(x => x.id === id); if (!d) return; const noteEl = document.querySelector('input[data-note-for="' + id + '"]'); const note = noteEl ? noteEl.value.trim() : '';
    el.disabled = true;
    try { await dbWrite(() => sb.from('office_decisions').update({ chosen: el.dataset.key, answer_note: note || null, answered_at: new Date().toISOString(), answered_by: me(), status: 'answered' }).eq('id', id), 'Could not save your answer'); d.chosen = el.dataset.key; d.answer_note = note; d.answered_at = new Date().toISOString(); d.status = 'answered'; renderToday(); renderNav(); toast('Got it. The team will pick that up on its next run.'); } catch (err) { el.disabled = false; }
    return;
  }
  if (a === 'order-chip') { state.ui.orderChip = el.dataset.k; renderOrders(); return; }
  if (a === 'event-chip') { state.ui.eventChip = el.dataset.k; renderEvents(); return; }
  if (a === 'event-toggle') { state.ui.openEvent = state.ui.openEvent === id ? null : id; renderEvents(); return; }
  if (a === 'event-jump') { state.ui.eventView = 'board'; const ev = state.events.find(x => x.id === id); if (ev) state.ui.eventChip = ev.status; state.ui.openEvent = id; renderEvents(); const card = $('#ev-' + id); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (a === 'event-status') {
    const ev = state.events.find(x => x.id === id); if (!ev) return; const to = el.dataset.to;
    try { await dbWrite(() => sb.from('office_events').update({ status: to, updated_at: new Date().toISOString() }).eq('id', id), 'Could not update the event'); ev.status = to; renderEvents(); renderNav(); toast(ev.name + ' → ' + EV_LABEL[to]); } catch (err) {}
    return;
  }
  if (a === 'event-ics') {
    const ev = state.events.find(x => x.id === id); if (!ev || !ev.start_date) return;
    const blob = new Blob([icsFor(ev)], { type: 'text/calendar' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = ev.name.replace(/[^\w]+/g, '-').toLowerCase() + '.ics'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (!ev.on_calendar) { try { await dbWrite(() => sb.from('office_events').update({ on_calendar: true, updated_at: new Date().toISOString() }).eq('id', id)); ev.on_calendar = true; renderEvents(); } catch (err) {} }
    return;
  }
  if (a === 'cal-prev') { const m = state.ui.calMonth; state.ui.calMonth = new Date(m.getFullYear(), m.getMonth() - 1, 1); renderCalendar(); return; }
  if (a === 'cal-next') { const m = state.ui.calMonth; state.ui.calMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1); renderCalendar(); return; }
  if (a === 'cal-today') { const n = new Date(); state.ui.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); renderCalendar(); return; }
  if (a === 'agent-open') { state.ui.openAgent = state.ui.openAgent === id ? null : id; state.ui.openRun = null; renderOffice(); if (state.ui.openAgent) { const p = $('#agentPanel'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } return; }
  if (a === 'agent-close') { state.ui.openAgent = null; renderOffice(); return; }
  if (a === 'agent-save') {
    const ta = $('#agentInstr'); if (!ta) return; const text = ta.value;
    try { await dbWrite(() => sb.from('office_agents').update({ instructions: text, updated_at: new Date().toISOString() }).eq('id', id), 'Could not save'); const ag = state.agents.find(x => x.id === id); if (ag) ag.instructions = text; toast('Saved. It takes effect on the next run.'); } catch (err) {}
    return;
  }
  if (a === 'agent-toggle') {
    const ag = state.agents.find(x => x.id === id); if (!ag) return; const next = !ag.enabled;
    try { await dbWrite(() => sb.from('office_agents').update({ enabled: next, status: next ? 'idle' : 'paused', updated_at: new Date().toISOString() }).eq('id', id), 'Could not change that'); ag.enabled = next; ag.status = next ? 'idle' : 'paused'; renderOffice(); toast(next ? ag.name + ' is back on shift.' : ag.name + ' is paused. Its scheduled runs will skip until you resume.'); } catch (err) {}
    return;
  }
  if (a === 'run-open') { state.ui.openRun = state.ui.openRun === id ? null : id; renderOffice(); if (state.ui.openRun && !state.runEvents[id]) loadRunEvents(id); return; }
});
document.addEventListener('change', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return; const a = el.dataset.action; const id = el.dataset.id;
  if (a === 'task-done') {
    const t = state.tasks.find(x => x.id === id); if (!t) return; const done = el.checked;
    try { await dbWrite(() => sb.from('office_tasks').update({ done, done_at: done ? new Date().toISOString() : null, done_by: done ? me() : null }).eq('id', id), 'Could not update the reminder'); t.done = done; t.done_at = done ? new Date().toISOString() : null; renderToday(); renderNav(); } catch (err) { el.checked = !done; }
    return;
  }
  if (a === 'event-reserved') {
    const ev = state.events.find(x => x.id === id); if (!ev) return;
    try { await dbWrite(() => sb.from('office_events').update({ reserved: el.checked, updated_at: new Date().toISOString() }).eq('id', id)); ev.reserved = el.checked; toast(el.checked ? 'Marked reserved.' : 'Reservation cleared.'); } catch (err) { el.checked = !el.checked; }
    return;
  }
});
document.addEventListener('focusout', async e => {
  const el = e.target; if (!el.dataset || el.dataset.action !== 'event-notes') return; const id = el.dataset.id; const ev = state.events.find(x => x.id === id); if (!ev) return;
  const v = el.value; if ((ev.notes || '') === v) return;
  try { await dbWrite(() => sb.from('office_events').update({ notes: v, updated_at: new Date().toISOString() }).eq('id', id), 'Could not save the note'); ev.notes = v; toast('Note saved.'); } catch (err) {}
});
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const inputs = $$('#settingsForm input[data-key]'); const groups = {};
  for (const i of inputs) { const key = i.dataset.key, path = i.dataset.path; let v = i.value.trim(); if (path === 'emails') v = v.split(/[,;\s]+/).filter(Boolean).map(s => s.toLowerCase()); else if (i.type === 'number') v = Number(v); groups[key] = Object.assign({}, state.settings[key] || {}, groups[key] || {}, { [path]: v }); }
  try { for (const key of Object.keys(groups)) await dbWrite(() => sb.from('office_settings').upsert({ key, value: groups[key], updated_at: new Date().toISOString() }), 'Could not save settings'); Object.assign(state.settings, groups); toast('Settings saved.'); renderParties(); } catch (err) {}
});
$$('#eventView button').forEach(b => b.addEventListener('click', () => { state.ui.eventView = b.dataset.view; renderEvents(); }));
$$('nav.steps a[data-tab]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); goTab(a.dataset.tab); }));
window.addEventListener('hashchange', () => { const t = location.hash.replace('#', ''); if (TABS[t] && t !== state.ui.tab) { state.ui.tab = t; applyTab(); } });
(function () { const t = location.hash.replace('#', ''); if (TABS[t]) state.ui.tab = t; })();
$('#refresh').addEventListener('click', async () => { setStatus('saving', 'Refreshing'); try { await loadAll(); renderAll(); setStatus('live'); } catch (e) { setStatus('error', 'Could not refresh'); } });

// ---------- auth (same list as the shop app) ----------
let authMode = 'signin';
function showAuth(msg, bad) { $('#auth').hidden = false; $('#app').hidden = true; const m = $('#authMsg'); m.textContent = msg || ''; m.className = 'msg' + (bad ? ' bad' : ''); }
function showApp() { $('#auth').hidden = true; $('#app').hidden = false; }
function setAuthMode(mode) {
  authMode = mode; const sub = $('#authSubmit'); const pf = $('#authPassField'); const pw = $('#authPass');
  $('#authSignup').hidden = false; $('#authForgot').hidden = false; $('#authEmail').closest('.field').hidden = false;
  $('#authSignup').textContent = mode === 'signup' ? 'Back to sign in' : 'Create an account';
  if (mode === 'signin') { sub.textContent = 'Sign in'; pf.hidden = false; pw.autocomplete = 'current-password'; }
  if (mode === 'signup') { sub.textContent = 'Create account'; pf.hidden = false; pw.autocomplete = 'new-password'; }
  if (mode === 'forgot') { sub.textContent = 'Send reset link'; pf.hidden = true; }
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
async function enter() {
  const { data } = await sb.auth.getSession(); state.session = data.session;
  if (!state.session) { setAuthMode('signin'); showAuth(''); return; }
  if (state.ui.recovery) { setAuthMode('recovery'); showAuth('Choose a new password for ' + state.session.user.email); return; }
  const allowed = await sb.rpc('is_allowed'); state.allowed = !!allowed.data;
  if (!state.allowed) { setAuthMode('signin'); showAuth(state.session.user.email + ' is not on the shop\'s sign-in list yet. Add it under Settings in the shop app, then sign in again.', true); return; }
  showApp(); setStatus('saving', 'Opening');
  try { await loadAll(); renderAll(); subscribe(); setStatus('live'); } catch (e) { console.error(e); setStatus('error', 'Could not load'); toast('Could not load the office: ' + (e.message || e), true); }
}
sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') { state.ui.recovery = true; enter(); } });
enter();
window.__brief = state;
