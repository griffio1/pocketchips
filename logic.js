// PocketChips — pure game logic.
// Every exported action takes the table state, mutates it in place and returns it.
// A GameError is a message meant for the player ("It's not your turn").

export class GameError extends Error {}
const fail = (m) => { throw new GameError(m); };

export const STREETS = ['preflop', 'flop', 'turn', 'river'];
const NEXT = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
export const STREET_LABEL = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown', done: 'Hand over' };

export function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
export const makeId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const whole = (v, label) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) fail(`${label} must be a whole number`);
  return n;
};
const nameOf = (t, pid) => (t.players[pid] && t.players[pid].name) || 'Someone';
function pushLog(t, msg) {
  t.log.push(msg);
  if (t.log.length > 40) t.log = t.log.slice(-40);
}

// Firebase drops empty objects, empty arrays and nulls, so fill them back in after every read.
export function normalize(t) {
  if (!t) return t;
  t.players ||= {};
  t.log ||= [];
  t.undo ||= [];
  t.hand ??= null;
  t.dealerPid ??= null;
  t.handNum ||= 0;
  for (const p of Object.values(t.players)) {
    p.out = !!p.out;
    p.stack ||= 0;
    p.bought ||= 0;
  }
  const h = t.hand;
  if (h) {
    for (const k of ['bets', 'contrib', 'folded', 'allin', 'acted']) h[k] ||= {};
    h.order ||= [];
    h.pot ||= 0;
    h.currentBet ||= 0;
    h.minRaise ||= t.settings.bb;
    h.toAct ??= null;
    h.result ??= null;
  }
  return t;
}

export function newTable({ code, hostId, hostName, startStack, sb, bb }) {
  startStack = whole(startStack, 'Starting stack');
  sb = whole(sb, 'Small blind');
  bb = whole(bb, 'Big blind');
  if (startStack <= 0) fail('Starting stack must be more than 0');
  if (bb <= 0) fail('Big blind must be more than 0');
  if (sb > bb) fail('Small blind can’t be bigger than the big blind');
  if (bb > startStack) fail('Big blind can’t be bigger than the starting stack');
  const t = { code, hostId, createdAt: Date.now(), settings: { startStack, sb, bb }, players: {}, dealerPid: null, handNum: 0, hand: null, log: [], undo: [] };
  addPlayer(t, hostId, hostName);
  return t;
}

export const seated = (t) => Object.keys(t.players).sort((a, b) => t.players[a].seat - t.players[b].seat);
export const handLive = (t) => !!t.hand && t.hand.street !== 'done';
const liveIn = (t, pid) => handLive(t) && t.hand.order.includes(pid) && !t.hand.folded[pid];

function nextFrom(order, pid, pred = () => true) {
  const n = order.length;
  const i = order.indexOf(pid);
  for (let k = 1; k <= n; k++) {
    const q = order[(((i + k) % n) + n) % n];
    if (pred(q)) return q;
  }
  return null;
}

export function addPlayer(t, pid, name) {
  name = String(name || '').trim().slice(0, 16);
  if (!name) fail('Enter your name');
  if (t.players[pid]) { t.players[pid].name = name; return t; }
  if (Object.keys(t.players).length >= 10) fail('This table is full (10 players)');
  const seat = Object.values(t.players).reduce((m, p) => Math.max(m, p.seat + 1), 0);
  const s = t.settings.startStack;
  t.players[pid] = { name, stack: s, seat, out: false, bought: s };
  pushLog(t, `${name} sat down with ${s}`);
  return t;
}

function pay(t, pid, amt) {
  const p = t.players[pid], h = t.hand;
  const x = Math.max(0, Math.min(amt, p.stack));
  p.stack -= x;
  h.bets[pid] = (h.bets[pid] || 0) + x;
  h.contrib[pid] = (h.contrib[pid] || 0) + x;
  if (p.stack === 0) h.allin[pid] = true;
  return x;
}

export function startHand(t) {
  if (handLive(t)) fail('Finish the current hand first');
  const all = seated(t);
  const elig = all.filter((p) => !t.players[p].out && t.players[p].stack > 0);
  if (elig.length < 2) fail('Need at least 2 players with chips who aren’t sitting out');
  const dealer = t.dealerPid && all.includes(t.dealerPid) ? nextFrom(all, t.dealerPid, (p) => elig.includes(p)) : elig[0];
  const { sb, bb } = t.settings;
  const sbPid = elig.length === 2 ? dealer : nextFrom(elig, dealer);
  const bbPid = nextFrom(elig, sbPid);
  t.dealerPid = dealer;
  t.handNum += 1;
  t.hand = { order: elig, street: 'preflop', pot: 0, bets: {}, contrib: {}, folded: {}, allin: {}, acted: {}, currentBet: bb, minRaise: bb, toAct: null, sbPid, bbPid, result: null };
  pay(t, sbPid, sb);
  pay(t, bbPid, bb);
  pushLog(t, `Hand ${t.handNum}: ${nameOf(t, dealer)} deals, blinds ${sb}/${bb}`);
  progress(t, bbPid);
  return t;
}

function raiseTo(t, pid, total) {
  const h = t.hand;
  const prev = h.currentBet;
  pay(t, pid, total - (h.bets[pid] || 0));
  if (total - prev >= h.minRaise) {
    h.minRaise = total - prev;
    h.acted = {}; // a full raise reopens the action
  }
  h.currentBet = total;
}

export function act(t, pid, type, amount) {
  const h = t.hand;
  if (!handLive(t) || !STREETS.includes(h.street)) fail('There’s no betting right now');
  if (h.toAct !== pid) fail('It’s not your turn');
  const p = t.players[pid], n = p.name;
  const my = h.bets[pid] || 0;
  const toCall = Math.max(0, h.currentBet - my);
  if (type === 'call' && toCall === 0) type = 'check';
  if (type === 'raise') {
    amount = whole(amount, 'Amount');
    if (amount >= my + p.stack) type = 'allin';
  }
  const verb = h.currentBet === 0 ? 'bets' : 'raises to';
  switch (type) {
    case 'fold':
      h.folded[pid] = true;
      pushLog(t, `${n} folds`);
      break;
    case 'check':
      if (toCall > 0) fail(`You need to call ${toCall} or fold`);
      pushLog(t, `${n} checks`);
      break;
    case 'call': {
      const x = pay(t, pid, toCall);
      pushLog(t, h.allin[pid] ? `${n} calls ${x} and is all in` : `${n} calls ${x}`);
      break;
    }
    case 'raise': {
      const min = h.currentBet + h.minRaise;
      if (amount < min) fail(`The smallest ${h.currentBet ? 'raise' : 'bet'} is to ${min}`);
      raiseTo(t, pid, amount);
      pushLog(t, `${n} ${verb} ${amount}`);
      break;
    }
    case 'allin': {
      const total = my + p.stack;
      if (total <= h.currentBet) {
        const x = pay(t, pid, p.stack);
        pushLog(t, `${n} calls ${x} and is all in`);
      } else {
        raiseTo(t, pid, total);
        pushLog(t, `${n} ${verb} ${total}, all in`);
      }
      break;
    }
    default:
      fail('Unknown action');
  }
  h.acted[pid] = true;
  progress(t, pid);
  return t;
}

function collect(t) {
  const h = t.hand;
  for (const v of Object.values(h.bets)) h.pot += v;
  h.bets = {};
  h.acted = {};
  h.currentBet = 0;
  h.minRaise = t.settings.bb;
}

function progress(t, fromPid) {
  const h = t.hand;
  const live = h.order.filter((p) => !h.folded[p]);
  if (live.length === 1) return winByFold(t, live[0]);
  const can = live.filter((p) => !h.allin[p]);
  const bet = (p) => h.bets[p] || 0;
  const need = (p) => !h.folded[p] && !h.allin[p] && (!h.acted[p] || bet(p) < h.currentBet);
  const maxBet = Math.max(0, ...live.map(bet));
  let done;
  if (can.length === 0) done = true;
  else if (can.length === 1) done = bet(can[0]) >= maxBet; // nobody left to bet against
  else done = !can.some(need);
  if (!done) {
    h.toAct = nextFrom(h.order, fromPid, (p) => need(p) || (can.length === 1 && p === can[0]));
    return t;
  }
  collect(t);
  for (;;) {
    const nxt = NEXT[h.street];
    if (nxt === 'showdown') {
      h.street = 'showdown';
      h.toAct = null;
      pushLog(t, 'Showdown: flip the cards and pick the winner');
      return t;
    }
    h.street = nxt;
    if (can.length >= 2) {
      h.toAct = nextFrom(h.order, t.dealerPid, (p) => !h.folded[p] && !h.allin[p]);
      pushLog(t, `Deal the ${STREET_LABEL[nxt].toLowerCase()}`);
      return t;
    }
    // Everyone (or all but one) is all in: run the board out with no more betting.
  }
}

function winByFold(t, w) {
  const h = t.hand;
  collect(t);
  const amt = h.pot;
  t.players[w].stack += amt;
  h.pot = 0;
  h.street = 'done';
  h.toAct = null;
  h.result = [`${nameOf(t, w)} wins ${amt}`];
  pushLog(t, `${nameOf(t, w)} wins ${amt}, everyone else folded`);
  return t;
}

// Main pot plus side pots, from what each player put in this hand.
export function computePots(h) {
  const live = h.order.filter((p) => !h.folded[p]);
  const c = (p) => h.contrib[p] || 0;
  const levels = [...new Set(live.map(c))].filter((x) => x > 0).sort((a, b) => a - b);
  const pots = [];
  let prev = 0, assigned = 0;
  for (const L of levels) {
    let amt = 0;
    for (const p of h.order) amt += Math.max(0, Math.min(c(p), L) - prev);
    const eligible = live.filter((p) => c(p) >= L);
    const last = pots[pots.length - 1];
    if (last && last.eligible.join() === eligible.join()) last.amount += amt;
    else if (amt > 0) pots.push({ amount: amt, eligible });
    assigned += amt;
    prev = L;
  }
  const total = h.pot + Object.values(h.bets).reduce((a, b) => a + b, 0);
  if (pots.length && total > assigned) pots[pots.length - 1].amount += total - assigned;
  return pots;
}
export const potName = (i, n) => (n === 1 ? 'the pot' : i === 0 ? 'the main pot' : `side pot ${i}`);

// picks[i] = list of winner ids for pot i (more than one = split)
export function awardPots(t, picks) {
  const h = t.hand;
  if (!h || h.street !== 'showdown') fail('There’s nothing to award right now');
  const pots = computePots(h);
  const winners = pots.map((pot, i) => {
    const w = pot.eligible.length === 1 ? pot.eligible : ((picks && picks[i]) || []).filter((p) => pot.eligible.includes(p));
    if (!w.length) fail(`Pick who won ${potName(i, pots.length)}`);
    return w;
  });
  const n = h.order.length, d = h.order.indexOf(t.dealerPid);
  const pos = (p) => (h.order.indexOf(p) - d - 1 + n) % n; // odd chips go left of the dealer first
  const lines = [];
  pots.forEach((pot, i) => {
    const w = [...new Set(winners[i])].sort((a, b) => pos(a) - pos(b));
    const share = Math.floor(pot.amount / w.length);
    let rem = pot.amount - share * w.length;
    for (const p of w) {
      t.players[p] && (t.players[p].stack += share + (rem > 0 ? 1 : 0));
      if (rem > 0) rem--;
    }
    const where = pots.length > 1 ? ` (${potName(i, pots.length)})` : '';
    lines.push(w.length === 1 ? `${nameOf(t, w[0])} wins ${pot.amount}${where}` : `${w.map((p) => nameOf(t, p)).join(' & ')} split ${pot.amount}${where}`);
  });
  h.pot = 0;
  h.bets = {};
  h.street = 'done';
  h.result = lines;
  lines.forEach((l) => pushLog(t, l));
  return t;
}

export function rebuy(t, pid, amount) {
  amount = whole(amount, 'Amount');
  if (amount <= 0) fail('Amount must be more than 0');
  if (!t.players[pid]) fail('You’re not at this table');
  if (liveIn(t, pid)) fail('You can rebuy once you’re out of this hand');
  t.players[pid].stack += amount;
  t.players[pid].bought += amount;
  pushLog(t, `${nameOf(t, pid)} bought in for ${amount} more`);
  return t;
}

export function toggleSitOut(t, pid) {
  const p = t.players[pid];
  if (!p) fail('You’re not at this table');
  p.out = !p.out;
  pushLog(t, p.out ? `${p.name} is sitting out` : `${p.name} is back in`);
  return t;
}

export function leave(t, pid) {
  if (!t.players[pid]) return t;
  if (liveIn(t, pid)) fail('Fold or finish this hand before leaving');
  const n = nameOf(t, pid);
  delete t.players[pid];
  if (t.hostId === pid) t.hostId = seated(t)[0] || null;
  pushLog(t, `${n} left the table`);
  return t;
}

export function moveSeat(t, by, pid, dir) {
  if (by !== t.hostId) fail('Only the host can change seats');
  if (handLive(t)) fail('Change seats between hands');
  const s = seated(t), i = s.indexOf(pid), j = i + dir;
  if (i < 0 || j < 0 || j >= s.length) return t;
  const a = t.players[s[i]], b = t.players[s[j]];
  [a.seat, b.seat] = [b.seat, a.seat];
  return t;
}

export function updateSettings(t, by, { sb, bb, startStack }) {
  if (by !== t.hostId) fail('Only the host can change the blinds');
  if (handLive(t)) fail('Change the blinds between hands');
  sb = whole(sb, 'Small blind');
  bb = whole(bb, 'Big blind');
  startStack = whole(startStack, 'Starting stack');
  if (bb <= 0 || startStack <= 0) fail('Big blind and starting stack must be more than 0');
  if (sb > bb) fail('Small blind can’t be bigger than the big blind');
  const changed = sb !== t.settings.sb || bb !== t.settings.bb;
  t.settings = { sb, bb, startStack };
  if (changed) pushLog(t, `Blinds are now ${sb}/${bb}`);
  return t;
}

export function setStack(t, by, pid, value) {
  if (by !== t.hostId) fail('Only the host can fix stacks');
  if (handLive(t)) fail('Fix stacks between hands');
  value = whole(value, 'Stack');
  const p = t.players[pid];
  if (!p || p.stack === value) return t;
  pushLog(t, `Host set ${p.name}’s stack to ${value} (was ${p.stack})`);
  p.stack = value;
  return t;
}

const SNAP_KEYS = ['players', 'hand', 'dealerPid', 'handNum', 'settings', 'hostId'];

// Runs an action and keeps a snapshot so it can be undone.
export function withUndo(t, fn) {
  normalize(t);
  const snap = JSON.stringify(Object.fromEntries(SNAP_KEYS.map((k) => [k, t[k] ?? null])));
  fn(t);
  t.undo.push(snap);
  if (t.undo.length > 20) t.undo = t.undo.slice(-20);
  return t;
}

export function undo(t) {
  normalize(t);
  const s = t.undo.pop();
  if (!s) fail('Nothing to undo');
  const snap = JSON.parse(s);
  // People who joined after the snapshot keep their seat.
  for (const [pid, p] of Object.entries(t.players)) if (!snap.players[pid]) snap.players[pid] = p;
  Object.assign(t, snap);
  normalize(t);
  pushLog(t, 'Last action undone');
  return t;
}
