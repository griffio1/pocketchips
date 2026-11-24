// Run with: node tests/logic.test.mjs
import assert from 'node:assert/strict';
import * as L from '../logic.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };
// Simulate a Firebase round trip (drops empties) between every action.
const rt = (t) => L.normalize(stripEmpty(JSON.parse(JSON.stringify(t))));
function stripEmpty(v) {
  if (Array.isArray(v)) { const a = v.map(stripEmpty).filter((x) => x !== undefined); return a.length ? a : undefined; }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const y = stripEmpty(x); if (y !== undefined && y !== null) o[k] = y; }
    return Object.keys(o).length ? o : undefined;
  }
  return v;
}
const total = (t) => Object.values(t.players).reduce((a, p) => a + p.stack, 0) + (t.hand ? t.hand.pot + Object.values(t.hand.bets).reduce((a, b) => a + b, 0) : 0);

function table(names, stack = 1000, sb = 5, bb = 10) {
  let t = L.newTable({ code: 'TEST', hostId: names[0], hostName: names[0], startStack: stack, sb, bb });
  for (const n of names.slice(1)) L.addPlayer(t, n, n);
  return rt(t);
}
const A = (t, pid, type, amt) => rt(L.withUndo(t, (x) => L.act(x, pid, type, amt)));

test('3-handed blinds and first to act', () => {
  let t = L.startHand(table(['a', 'b', 'c']));
  assert.equal(t.dealerPid, 'a');
  assert.equal(t.hand.sbPid, 'b');
  assert.equal(t.hand.bbPid, 'c');
  assert.equal(t.hand.toAct, 'a');
  assert.equal(t.players.b.stack, 995);
  assert.equal(t.players.c.stack, 990);
});

test('heads-up: dealer is small blind and acts first preflop, last postflop', () => {
  let t = rt(L.startHand(table(['a', 'b'])));
  assert.equal(t.hand.sbPid, 'a');
  assert.equal(t.hand.toAct, 'a');
  t = A(t, 'a', 'call');
  assert.equal(t.hand.toAct, 'b'); // BB option
  t = A(t, 'b', 'check');
  assert.equal(t.hand.street, 'flop');
  assert.equal(t.hand.pot, 20);
  assert.equal(t.hand.toAct, 'b');
});

test('fold out awards pot', () => {
  let t = rt(L.startHand(table(['a', 'b', 'c'])));
  t = A(t, 'a', 'raise', 30);
  t = A(t, 'b', 'fold');
  t = A(t, 'c', 'fold');
  assert.equal(t.hand.street, 'done');
  assert.equal(t.players.a.stack, 1015);
  assert.equal(total(t), 3000);
});

test('min raise and not-your-turn are enforced', () => {
  let t = rt(L.startHand(table(['a', 'b', 'c'])));
  assert.throws(() => L.act(t, 'b', 'call'), /not your turn/);
  assert.throws(() => L.act(t, 'a', 'raise', 15), /smallest raise is to 20/);
  assert.throws(() => L.act(t, 'a', 'check'), /call 10/);
});

test('raise reopens action; full street flow to showdown', () => {
  let t = rt(L.startHand(table(['a', 'b', 'c'])));
  t = A(t, 'a', 'call');
  t = A(t, 'b', 'call');
  t = A(t, 'c', 'raise', 40);
  assert.equal(t.hand.toAct, 'a');
  t = A(t, 'a', 'call');
  t = A(t, 'b', 'call');
  assert.equal(t.hand.street, 'flop');
  assert.equal(t.hand.pot, 120);
  assert.equal(t.hand.toAct, 'b'); // first after dealer
  for (const s of ['flop', 'turn', 'river']) {
    assert.equal(t.hand.street, s);
    t = A(t, 'b', 'check'); t = A(t, 'c', 'check'); t = A(t, 'a', 'check');
  }
  assert.equal(t.hand.street, 'showdown');
  const pots = L.computePots(t.hand);
  assert.deepEqual(pots, [{ amount: 120, eligible: ['a', 'b', 'c'] }]);
  t = rt(L.awardPots(t, [['c']]));
  assert.equal(t.players.c.stack, 1080);
  assert.equal(total(t), 3000);
});

test('side pots with short all-in and uncalled excess returned', () => {
  let t = table(['a', 'b', 'c']);
  t.players.a.stack = 100; t.players.b.stack = 300; t.players.c.stack = 1000;
  t = rt(L.startHand(t)); // a deals, b sb, c bb
  t = A(t, 'a', 'allin');            // a 100
  t = A(t, 'b', 'allin');            // b 300
  t = A(t, 'c', 'call');             // c calls 300
  assert.equal(t.hand.street, 'showdown');
  const pots = L.computePots(t.hand);
  assert.deepEqual(pots, [{ amount: 300, eligible: ['a', 'b', 'c'] }, { amount: 400, eligible: ['b', 'c'] }]);
  t = rt(L.awardPots(t, [['a'], ['c']]));
  assert.equal(t.players.a.stack, 300);
  assert.equal(t.players.c.stack, 700 + 400);
  assert.equal(total(t), 1400);
});

test('big stack overbet all-in: uncalled part goes back automatically', () => {
  let t = table(['a', 'b']);
  t.players.b.stack = 200;
  t = rt(L.startHand(t)); // a dealer/sb, b bb
  t = A(t, 'a', 'allin'); // 1000
  t = A(t, 'b', 'call');  // calls 190 more, all in at 200
  assert.equal(t.hand.street, 'showdown');
  const pots = L.computePots(t.hand);
  assert.deepEqual(pots, [{ amount: 400, eligible: ['a', 'b'] }, { amount: 800, eligible: ['a'] }]);
  t = rt(L.awardPots(t, [['b']]));
  assert.equal(t.players.b.stack, 400);
  assert.equal(t.players.a.stack, 800);
});

test('split pot with odd chip goes left of dealer', () => {
  let t = table(['a', 'b', 'c'], 1000, 5, 10);
  t = rt(L.startHand(t));
  t = A(t, 'a', 'fold');
  t = A(t, 'b', 'raise', 25); // b total 25
  t = A(t, 'c', 'call');
  for (const s of ['flop', 'turn', 'river']) { t = A(t, 'b', 'check'); t = A(t, 'c', 'check'); }
  t = rt(L.awardPots(t, [['c', 'b']]));
  assert.equal(t.players.b.stack, 1000);
  assert.equal(t.players.c.stack, 1000);
  assert.equal(total(t), 3000);
});

test('short all-in blind; dealer button rotates and skips busted', () => {
  let t = table(['a', 'b', 'c']);
  t = rt(L.startHand(t));
  t = A(t, 'a', 'fold'); t = A(t, 'b', 'fold');
  assert.equal(t.hand.street, 'done');
  t = rt(L.startHand(t));
  assert.equal(t.dealerPid, 'b');
  t.players.c.stack = 0;
  t.hand.street = 'done';
  t = rt(L.startHand(t));
  assert.equal(t.dealerPid, 'a'); // c skipped
  assert.deepEqual(t.hand.order, ['a', 'b']);
});

test('blind puts player all in → runs out to showdown', () => {
  let t = table(['a', 'b']);
  t.players.a.stack = 4; // a is dealer/sb, posts 4 all in
  t = rt(L.startHand(t));
  assert.equal(t.hand.street, 'showdown');
  const pots = L.computePots(t.hand);
  assert.deepEqual(pots, [{ amount: 8, eligible: ['a', 'b'] }, { amount: 6, eligible: ['b'] }]);
});

test('undo restores previous state and keeps later joiners', () => {
  let t = rt(L.startHand(table(['a', 'b', 'c'])));
  t = A(t, 'a', 'raise', 50);
  L.addPlayer(t, 'd', 'd');
  t = rt(L.undo(t));
  assert.equal(t.hand.toAct, 'a');
  assert.equal(t.players.a.stack, 1000);
  assert.ok(t.players.d);
});

test('rebuy blocked mid-hand, allowed after fold', () => {
  let t = rt(L.startHand(table(['a', 'b', 'c'])));
  assert.throws(() => L.rebuy(t, 'a', 500), /out of this hand/);
  t = A(t, 'a', 'fold');
  t = rt(L.rebuy(t, 'a', 500));
  assert.equal(t.players.a.stack, 1500);
  assert.equal(t.players.a.bought, 1500);
});

test('random hands conserve chips', () => {
  for (let g = 0; g < 300; g++) {
    let t = table(['a', 'b', 'c', 'd', 'e'].slice(0, 2 + (g % 4)), 200 + g, 5, 10);
    const start = total(t);
    for (let hnd = 0; hnd < 15; hnd++) {
      try { t = rt(L.startHand(t)); } catch { break; }
      let guard = 0;
      while (L.STREETS.includes(t.hand.street) && guard++ < 200) {
        const pid = t.hand.toAct;
        const r = Math.random();
        const p = t.players[pid], h = t.hand;
        const min = h.currentBet + h.minRaise;
        try {
          if (r < 0.15) t = A(t, pid, 'fold');
          else if (r < 0.6) t = A(t, pid, 'call');
          else if (r < 0.9) t = A(t, pid, 'raise', Math.min(min + Math.floor(Math.random() * 50), (h.bets[pid] || 0) + p.stack));
          else t = A(t, pid, 'allin');
        } catch (e) { if (!(e instanceof L.GameError)) throw e; t = A(t, pid, 'call'); }
        assert.equal(total(t), start);
      }
      assert.ok(guard < 200, 'hand never ended');
      if (t.hand.street === 'showdown') {
        const pots = L.computePots(t.hand);
        assert.equal(pots.reduce((a, p) => a + p.amount, 0), t.hand.pot);
        t = rt(L.awardPots(t, pots.map((p) => [p.eligible[Math.floor(Math.random() * p.eligible.length)]])));
      }
      assert.equal(t.hand.street, 'done');
      assert.equal(total(t), start);
    }
  }
});

console.log(`\n${passed} tests passed`);
