// Keeps one table object in sync for everyone.
// Firebase Realtime Database when configured, otherwise a same-device demo using localStorage.
import { firebaseConfig } from './firebase-config.js';
import { normalize } from './logic.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const clean = (t) => JSON.parse(JSON.stringify(t)); // Firebase refuses undefined values

export const isConfigured = !!(firebaseConfig && firebaseConfig.databaseURL && !firebaseConfig.databaseURL.includes('YOUR-PROJECT'));

export async function connect() {
  return isConfigured ? firebaseBackend() : localBackend();
}

async function firebaseBackend() {
  const [{ initializeApp }, { getDatabase, ref, onValue, runTransaction, get }] = await Promise.all([
    import(FB + 'firebase-app.js'),
    import(FB + 'firebase-database.js'),
  ]);
  const db = getDatabase(initializeApp(firebaseConfig));
  const tref = (code) => ref(db, 'tables/' + code);
  return {
    mode: 'firebase',
    subscribe(code, cb) {
      return onValue(tref(code), (s) => cb(s.val()), (e) => cb(null, e));
    },
    async exists(code) {
      return (await get(tref(code))).exists();
    },
    async create(code, table) {
      const res = await runTransaction(tref(code), (cur) => (cur ? undefined : clean(table)));
      return res.committed;
    },
    async transact(code, fn) {
      let err = null;
      const res = await runTransaction(tref(code), (cur) => {
        if (cur === null) return cur; // local cache empty: Firebase retries with the server copy
        try {
          const t = normalize(cur);
          fn(t);
          err = null;
          return clean(t);
        } catch (e) {
          err = e;
          return undefined; // abort
        }
      });
      if (err) throw err;
      if (!res.committed || !res.snapshot.exists()) throw new Error('Couldn’t reach the table, try again');
    },
  };
}

function localBackend() {
  const PREFIX = 'pocketchips:table:';
  const subs = new Map();
  const read = (c) => { try { return JSON.parse(localStorage.getItem(PREFIX + c)); } catch { return null; } };
  const notify = (c) => (subs.get(c) || []).forEach((f) => f(read(c)));
  const write = (c, t) => { localStorage.setItem(PREFIX + c, JSON.stringify(clean(t))); notify(c); };
  window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith(PREFIX)) notify(e.key.slice(PREFIX.length)); });
  return {
    mode: 'local',
    subscribe(c, cb) {
      const list = subs.get(c) || [];
      list.push(cb);
      subs.set(c, list);
      setTimeout(() => cb(read(c)), 0);
      return () => subs.set(c, (subs.get(c) || []).filter((f) => f !== cb));
    },
    async exists(c) { return !!read(c); },
    async create(c, t) { if (read(c)) return false; write(c, t); return true; },
    async transact(c, fn) {
      const cur = read(c);
      if (!cur) throw new Error('That table doesn’t exist any more');
      const t = normalize(cur);
      fn(t);
      write(c, t);
    },
  };
}
