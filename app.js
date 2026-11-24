import * as L from './logic.js';
import { connect, isConfigured } from './sync.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const store = {
  get(k, d, s = localStorage) { try { const v = s.getItem('pocketchips:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v, s = localStorage) { try { s.setItem('pocketchips:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// Your player id lives on this device. In demo mode each tab is its own player.
const idStore = isConfigured ? localStorage : sessionStorage;
let myId = store.get('id', null, idStore);
if (!myId) { myId = L.makeId(); store.set('id', myId, idStore); }
let myName = store.get('name', '');

let backend = null, code = null, table = null, unsub = null;
let raiseTo = null, raiseOpen = false, picks = {}, picksHand = 0;
let wasMyTurn = false, lastBoard = 0, armed = null, armTimer = 0, toastTimer = 0;

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function show(screen) {
  $('#home').hidden = screen !== 'home';
  $('#tableScreen').hidden = screen !== 'table';
}

// ---------- boot ----------
(async function boot() {
  $('#demo').hidden = isConfigured;
  $('#joinName').value = myName;
  $('#createName').value = myName;
  const c = (new URLSearchParams(location.search).get('t') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (c) $('#joinCode').value = c;
  try {
    backend = await connect();
  } catch (e) {
    toast('Couldn’t connect to the database. Check firebase-config.js');
    console.error(e);
    return;
  }
  if (c && myName && store.get('joined:' + c, false, idStore)) enterTable(c, myName);
  else show('home');
})();

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $('#joinCode').value.toUpperCase().replace(/[^A-Z]/g, '');
  const n = $('#joinName').value.trim();
  if (c.length !== 4) return toast('Table codes are 4 letters');
  enterTable(c, n);
});

$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!backend) return toast('Still connecting…');
  const f = new FormData(e.target);
  const n = String(f.get('name')).trim();
  try {
    for (let i = 0; i < 6; i++) {
      const c = L.makeCode();
      const t = L.newTable({ code: c, hostId: myId, hostName: n, startStack: f.get('stack'), sb: f.get('sb'), bb: f.get('bb') });
      if (await backend.create(c, t)) { saveName(n); return openTable(c); }
    }
    toast('Couldn’t find a free table code, try again');
  } catch (err) { toast(err.message); }
});

function saveName(n) { myName = n; store.set('name', n); }

async function enterTable(c, n) {
  if (!backend) return toast('Still connecting…');
  try {
    if (!(await backend.exists(c))) { show('home'); return toast(`No table called ${c}`); }
    await backend.transact(c, (t) => L.addPlayer(t, myId, n));
    saveName(n);
    openTable(c);
  } catch (err) { show('home'); toast(err.message); }
}

function openTable(c) {
  code = c;
  store.set('joined:' + c, true, idStore);
  history.replaceState(null, '', '?t=' + c);
  $('#codeText').textContent = c;
  show('table');
  unsub && unsub();
  unsub = backend.subscribe(c, (t, err) => {
    if (err) return toast('Lost connection to the table');
    if (!t) { leaveScreen('This table was closed'); return; }
    table = L.normalize(t);
    if (!table.players[myId]) { leaveScreen('You left the table'); return; }
    render();
  });
}

function leaveScreen(msg) {
  unsub && unsub();
  unsub = null;
  if (code) store.set('joined:' + code, false, idStore);
  code = null; table = null;
  history.replaceState(null, '', location.pathname);
  show('home');
  if (msg) toast(msg);
}

async function run(fn, undoable = true) {
  try {
    await backend.transact(code, (t) => (undoable ? L.withUndo(t, fn) : fn(t)));
  } catch (err) {
    toast(err.message || 'Something went wrong');
  }
}

// ---------- render ----------
const BOARD = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5, done: 0 };

function render() {
  const t = table, h = t.hand, me = t.players[myId];
  const isHost = t.hostId === myId;
  const live = L.handLive(t);
  const betting = live && L.STREETS.includes(h.street);
  const myTurn = betting && h.toAct === myId;

  // board
  const n = h ? BOARD[h.street] : 0;
  $('#board').innerHTML = [0, 1, 2, 3, 4].map((i) => `<span class="slot${i < n ? ' on' : ''}${i < n && i >= lastBoard ? ' new' : ''}"></span>`).join('');
  lastBoard = n;

  // pot + street
  const potTotal = h ? h.pot + Object.values(h.bets).reduce((a, b) => a + b, 0) : 0;
  $('#potAmt').textContent = fmt(potTotal);
  let st = '';
  if (!h) st = `Blinds ${t.settings.sb}/${t.settings.bb} · waiting to start`;
  else if (betting) st = `${L.STREET_LABEL[h.street]}${n ? ` · deal ${n} on the board` : ''}${h.currentBet ? ` · bet ${fmt(h.currentBet)}` : ''}`;
  else if (h.street === 'showdown') st = 'Showdown · flip your cards';
  else st = `Hand ${t.handNum} over · blinds ${t.settings.sb}/${t.settings.bb}`;
  $('#streetText').textContent = st;

  // seats
  const order = L.seated(t);
  $('#seats').innerHTML = order.map((pid, i) => {
    const p = t.players[pid];
    const inHand = h && h.order.includes(pid);
    const tags = [];
    if (h && live && pid === t.dealerPid) tags.push('<span class="tag d">D</span>');
    if (h && live && pid === h.sbPid) tags.push('<span class="tag">SB</span>');
    if (h && live && pid === h.bbPid) tags.push('<span class="tag">BB</span>');
    if (pid === t.hostId) tags.push('<span class="tag">Host</span>');
    let status = '';
    let dim = false;
    if (live && inHand && h.folded[pid]) { status = 'Folded'; dim = true; }
    else if (live && inHand && h.allin[pid]) status = 'All in';
    else if (betting && h.toAct === pid) status = pid === myId ? 'Your turn' : 'Thinking…';
    else if (p.out) { status = 'Sitting out'; dim = true; }
    else if (live && !inHand) { status = 'Next hand'; dim = true; }
    else if (p.stack === 0 && !inHand) { status = 'Out of chips'; dim = true; }
    const bet = h && live && h.bets[pid] ? `<span class="betchip"><span class="chip"></span>${fmt(h.bets[pid])}</span>` : '';
    const mv = isHost && !live && order.length > 1
      ? `<span class="mv"><button data-act="seat" data-pid="${esc(pid)}" data-dir="-1" aria-label="Move ${esc(p.name)} up" ${i === 0 ? 'disabled' : ''}>↑</button><button data-act="seat" data-pid="${esc(pid)}" data-dir="1" aria-label="Move ${esc(p.name)} down" ${i === order.length - 1 ? 'disabled' : ''}>↓</button></span>`
      : '';
    const cls = ['seat', pid === myId && 'you', betting && h.toAct === pid && 'turn', dim && 'dim'].filter(Boolean).join(' ');
    return `<li class="${cls}"><span class="nm">${esc(p.name)}${pid === myId ? ' (you)' : ''}</span><span class="st">${fmt(p.stack)}</span>
      <span class="info">${tags.join('')}${bet}${status ? `<span>${esc(status)}</span>` : ''}${mv}</span></li>`;
  }).join('');

  // my panel
  const net = me.stack + (h && live ? h.contrib[myId] || 0 : 0) - me.bought;
  let html = `<div class="mine"><div><div class="lbl">Your chips</div><b>${fmt(me.stack)}</b></div>
    <span class="net ${net > 0 ? 'up' : net < 0 ? 'down' : ''}">${net > 0 ? '+' : ''}${fmt(net)} tonight</span></div>`;

  if (myTurn) html += actionPanel(t, h, me, potTotal);
  else if (betting) {
    const who = t.players[h.toAct] ? t.players[h.toAct].name : 'someone';
    const mine = h.order.includes(myId);
    let note = `Waiting for <strong>${esc(who)}</strong>`;
    if (mine && h.folded[myId]) note += ' · you folded';
    else if (mine && h.allin[myId]) note += ' · you’re all in';
    else if (!mine) note += ' · you’re in next hand';
    else if (h.currentBet > (h.bets[myId] || 0)) note += ` · ${fmt(h.currentBet - (h.bets[myId] || 0))} to call when it’s you`;
    html += `<p class="msg">${note}</p>`;
  } else if (h && h.street === 'showdown') html += showdownPanel(t, h);
  else html += betweenHands(t, h, me);
  $('#me').innerHTML = html;
  bindRaise(t, h, me);

  // log
  $('#log').innerHTML = t.log.slice(-15).reverse().map((l) => `<li>${esc(l)}</li>`).join('');

  // undo
  $('#undoBtn').disabled = !t.undo.length;

  // turn alert
  if (myTurn && !wasMyTurn) {
    try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch { /* not supported */ }
    raiseOpen = false; raiseTo = null;
  }
  document.title = myTurn ? 'Your turn · PocketChips' : 'PocketChips';
  wasMyTurn = myTurn;
}

function raiseBounds(h, me) {
  const my = h.bets[myId] || 0;
  const maxTo = my + me.stack;
  const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
  return { my, maxTo, minTo, canRaise: maxTo > h.currentBet };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function actionPanel(t, h, me, potTotal) {
  const { my, maxTo, minTo, canRaise } = raiseBounds(h, me);
  const toCall = Math.max(0, h.currentBet - my);
  const callAllIn = toCall >= me.stack;
  if (raiseTo === null || raiseTo < minTo || raiseTo > maxTo) raiseTo = minTo;
  const word = h.currentBet === 0 ? 'Bet' : 'Raise to';
  const label = raiseTo >= maxTo ? `All in ${fmt(maxTo)}` : `${word} ${fmt(raiseTo)}`;
  const call = toCall === 0 ? 'Check' : callAllIn ? `Call all in ${fmt(me.stack)}` : `Call ${fmt(toCall)}`;
  const half = clamp(h.currentBet + Math.round((potTotal + toCall) / 2), minTo, maxTo);
  const pot = clamp(h.currentBet + potTotal + toCall, minTo, maxTo);
  return `<p class="turnmsg">Your turn${toCall ? ` · ${fmt(toCall)} to call` : ''}</p>
    <div class="acts">
      <button class="btn red" data-act="fold">Fold</button>
      <button class="btn primary" data-act="${toCall === 0 ? 'check' : 'call'}">${call}</button>
    </div>
    ${canRaise && !callAllIn ? (raiseOpen ? `
    <div class="raise">
      <div class="raise-top">
        <input type="range" id="raiseRange" min="${minTo}" max="${maxTo}" step="1" value="${raiseTo}" aria-label="Raise amount">
        <input type="number" id="raiseNum" inputmode="numeric" min="${minTo}" max="${maxTo}" value="${raiseTo}" aria-label="Raise to">
      </div>
      <div class="presets">
        <button data-act="preset" data-v="${minTo}">Min</button>
        <button data-act="preset" data-v="${half}">½ pot</button>
        <button data-act="preset" data-v="${pot}">Pot</button>
        <button data-act="preset" data-v="${maxTo}">All in</button>
      </div>
      <button class="btn gold" data-act="raise" id="raiseBtn">${label}</button>
    </div>` : `<div class="acts" style="margin-top:8px"><button class="btn gold" data-act="openraise" style="grid-column:1/-1">${word}…</button></div>`) : ''}`;
}

function bindRaise(t, h, me) {
  const r = $('#raiseRange'), num = $('#raiseNum');
  if (!r) return;
  const { maxTo } = raiseBounds(h, me);
  const word = h.currentBet === 0 ? 'Bet' : 'Raise to';
  const sync = (v, from) => {
    raiseTo = v;
    if (from !== r) r.value = v;
    if (from !== num) num.value = v;
    $('#raiseBtn').textContent = v >= maxTo ? `All in ${fmt(maxTo)}` : `${word} ${fmt(v)}`;
  };
  r.addEventListener('input', () => sync(Number(r.value), r));
  num.addEventListener('input', () => { const v = Math.floor(Number(num.value)); if (Number.isFinite(v)) sync(v, num); });
}

function showdownPanel(t, h) {
  if (picksHand !== t.handNum) { picks = {}; picksHand = t.handNum; }
  const pots = L.computePots(h);
  const nm = (p) => (t.players[p] ? t.players[p].name : 'Someone');
  const body = pots.map((pot, i) => {
    const title = L.potName(i, pots.length);
    const cap = title.charAt(0).toUpperCase() + title.slice(1);
    if (pot.eligible.length === 1) return `<div class="pot-pick"><h3>${esc(cap)} <b>${fmt(pot.amount)}</b></h3><p class="hint">Goes back to ${esc(nm(pot.eligible[0]))} (nobody matched it)</p></div>`;
    const sel = picks[i] || [];
    return `<div class="pot-pick"><h3>Who won ${esc(title)}? <b>${fmt(pot.amount)}</b></h3>
      <div class="who">${pot.eligible.map((p) => `<button data-act="pick" data-pot="${i}" data-pid="${esc(p)}" aria-pressed="${sel.includes(p)}">${esc(nm(p))}</button>`).join('')}</div></div>`;
  }).join('');
  return `<p class="msg">Deal out any cards left, flip, then tap the winner. Tap two or more names to split.</p>${body}
    <button class="btn gold" data-act="award">Give chips to the winner</button>`;
}

function betweenHands(t, h, me) {
  const result = h && h.result ? `<div class="result">${h.result.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : '';
  const ready = L.seated(t).filter((p) => !t.players[p].out && t.players[p].stack > 0).length;
  return `${result}
    <button class="btn gold" data-act="deal" ${ready < 2 ? 'disabled' : ''}>${t.handNum ? 'Deal next hand' : 'Start the first hand'}</button>
    ${ready < 2 ? '<p class="hint">Waiting for at least 2 players with chips. Share the table code.</p>' : ''}
    <div class="side">
      <div class="rb"><input id="rebuyAmt" type="number" inputmode="numeric" min="1" value="${t.settings.startStack}" aria-label="Rebuy amount"><button class="btn" data-act="rebuy">Rebuy</button></div>
      <button class="btn" data-act="sitout">${me.out ? 'Sit back in' : 'Sit out'}</button>
    </div>`;
}

// ---------- menu ----------
function openMenu() {
  const t = table, isHost = t.hostId === myId, live = L.handLive(t);
  const order = L.seated(t);
  $('#menuBody').innerHTML = `
    <h2>Table ${esc(t.code)} <button class="ghost" value="close">Close</button></h2>
    <section>
      <h3>Invite friends</h3>
      <button class="btn primary" type="button" data-act="share">Share table link</button>
      <p class="hint">Or tell them the code <strong>${esc(t.code)}</strong>.</p>
    </section>
    ${isHost ? `
    <section>
      <h3>Blinds and buy-in${live ? ' (between hands only)' : ''}</h3>
      <div class="row3">
        <label>Small blind<input id="setSb" type="number" inputmode="numeric" min="0" value="${t.settings.sb}" ${live ? 'disabled' : ''}></label>
        <label>Big blind<input id="setBb" type="number" inputmode="numeric" min="1" value="${t.settings.bb}" ${live ? 'disabled' : ''}></label>
        <label>Buy-in<input id="setStart" type="number" inputmode="numeric" min="1" value="${t.settings.startStack}" ${live ? 'disabled' : ''}></label>
      </div>
      <button class="btn gold" type="button" data-act="savesettings" ${live ? 'disabled' : ''}>Save</button>
    </section>
    <section>
      <h3>Fix a stack${live ? ' (between hands only)' : ''}</h3>
      <div class="stack-list">${order.map((pid) => `<div class="stackrow"><span>${esc(t.players[pid].name)}</span><input type="number" inputmode="numeric" min="0" data-stack="${esc(pid)}" value="${t.players[pid].stack}" ${live ? 'disabled' : ''}></div>`).join('')}</div>
      <button class="btn" type="button" data-act="savestacks" ${live ? 'disabled' : ''}>Save stacks</button>
    </section>` : `<section><p class="hint">Blinds ${t.settings.sb}/${t.settings.bb}, buy-in ${fmt(t.settings.startStack)}. The host can change these.</p></section>`}
    <section>
      <h3>Tonight so far</h3>
      <div class="stack-list">${order.map((pid) => { const p = t.players[pid]; const inPot = t.hand && live ? t.hand.contrib[pid] || 0 : 0; const net = p.stack + inPot - p.bought; return `<div class="stackrow"><span>${esc(p.name)} <span class="hint">bought ${fmt(p.bought)}</span></span><span class="net ${net > 0 ? 'up' : net < 0 ? 'down' : ''}" style="text-align:right">${net > 0 ? '+' : ''}${fmt(net)}</span></div>`; }).join('')}</div>
    </section>
    <section>
      <button class="btn red" type="button" data-act="leave" id="leaveBtn">Leave table</button>
    </section>`;
  $('#menu').showModal();
}

function arm(id, el, label) {
  if (armed === id) { armed = null; clearTimeout(armTimer); return true; }
  armed = id;
  const old = el.textContent;
  el.textContent = label;
  el.classList.add('armed');
  clearTimeout(armTimer);
  armTimer = setTimeout(() => { armed = null; el.textContent = old; el.classList.remove('armed'); }, 3000);
  return false;
}

async function share() {
  const url = `${location.origin}${location.pathname}?t=${code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'PocketChips', text: `Join my poker table ${code}`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { toast(url); }
}

// ---------- clicks ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled || !table) return;
  const a = b.dataset.act;
  switch (a) {
    case 'share': return share();
    case 'menu': return openMenu();
    case 'undo': if (arm('undo', b, 'Tap to confirm')) { b.classList.remove('armed'); b.textContent = 'Undo'; run((t) => L.undo(t), false); } return;
    case 'fold': return run((t) => L.act(t, myId, 'fold'));
    case 'check': return run((t) => L.act(t, myId, 'check'));
    case 'call': return run((t) => L.act(t, myId, 'call'));
    case 'openraise': raiseOpen = true; return render();
    case 'preset': raiseTo = Number(b.dataset.v); return render();
    case 'raise': return run((t) => L.act(t, myId, 'raise', raiseTo));
    case 'pick': {
      const i = Number(b.dataset.pot), pid = b.dataset.pid;
      const s = new Set(picks[i] || []);
      s.has(pid) ? s.delete(pid) : s.add(pid);
      picks[i] = [...s];
      return render();
    }
    case 'award': {
      const pots = L.computePots(table.hand);
      const arr = pots.map((_, i) => picks[i] || []);
      return run((t) => L.awardPots(t, arr));
    }
    case 'deal': raiseOpen = false; raiseTo = null; return run((t) => L.startHand(t));
    case 'rebuy': { const v = $('#rebuyAmt').value; return run((t) => L.rebuy(t, myId, v)); }
    case 'sitout': return run((t) => L.toggleSitOut(t, myId), false);
    case 'seat': return run((t) => L.moveSeat(t, myId, b.dataset.pid, Number(b.dataset.dir)), false);
    case 'savesettings': {
      const s = { sb: $('#setSb').value, bb: $('#setBb').value, startStack: $('#setStart').value };
      await run((t) => L.updateSettings(t, myId, s));
      $('#menu').close();
      return toast('Saved');
    }
    case 'savestacks': {
      const vals = [...document.querySelectorAll('[data-stack]')].map((i) => [i.dataset.stack, i.value]);
      await run((t) => vals.forEach(([pid, v]) => L.setStack(t, myId, pid, v)));
      $('#menu').close();
      return toast('Stacks saved');
    }
    case 'leave':
      if (arm('leave', b, 'Tap again to leave')) {
        $('#menu').close();
        const c = code;
        try { await backend.transact(c, (t) => L.leave(t, myId)); } catch (err) { return toast(err.message); }
        leaveScreen('You left the table');
      }
      return;
  }
});

$('#menu').addEventListener('click', (e) => { if (e.target === $('#menu')) $('#menu').close(); });
