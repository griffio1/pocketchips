# PocketChips

Virtual poker chips for when you have a real deck of cards but no chip set.
Everyone opens the same link on their phone, and bets, the pot and stacks stay in sync live.

- Create a table → share the link or 4-letter code → friends join with their name
- Blinds and the dealer button move automatically; it tells you which street to deal (flop/turn/river)
- Fold / Check / Call / Raise with Min, ½ pot, Pot and All-in shortcuts
- Showdown: tap who won; tap several names to split. Side pots for all-ins are calculated for you
- Undo, rebuy, sit out, seat order, change blinds, host can fix stacks
- "Tonight" tracks each person's net +/- for settling up at the end

Plain HTML/CSS/JS, no build step. Firebase Realtime Database (free tier) does the syncing.

## Try it first (no setup)

```bash
python3 -m http.server 8000
```
Open http://localhost:8000 in two browser tabs. With no Firebase config it runs in demo mode,
where each tab is a separate player on the same device.

## 1. Set up Firebase (free, about 5 minutes)

1. Go to https://console.firebase.google.com → **Add project** (Google Analytics can be off).
2. In the left menu: **Build → Realtime Database → Create database**. Pick a location, start in **locked mode**.
3. Open the **Rules** tab, replace everything with the contents of `database.rules.json`, then **Publish**.
4. Go to **Project settings** (gear icon) → **Your apps** → the **</>** (Web) icon → register an app (no hosting needed).
5. Copy the `firebaseConfig` values it shows into `firebase-config.js`. Make sure `databaseURL` is included.
   If it's missing, copy the URL from the top of the Realtime Database page.

The Firebase web config isn't a secret. It's meant to live in front-end code.

## 2. Deploy to Vercel (free)

**Option A: GitHub (recommended)**
1. Push this folder to a GitHub repo.
2. On https://vercel.com → **Add New → Project** → import the repo.
3. Framework preset: **Other**. Leave the build command empty. Click **Deploy**.

**Option B: CLI**
```bash
npm i -g vercel
vercel        # follow prompts, then:
vercel --prod
```

Netlify, Cloudflare Pages or GitHub Pages also work, since it's just static files.

On iPhone, open the site in Safari → Share → **Add to Home Screen** to get an app icon.

## Files

| File | What it does |
|---|---|
| `index.html`, `style.css` | Screens and styling |
| `app.js` | UI: rendering, buttons, menu |
| `logic.js` | All poker rules (pure functions): blinds, betting rounds, side pots, splits, undo |
| `sync.js` | Firebase transactions so two people tapping at once can't corrupt the table; localStorage demo fallback |
| `firebase-config.js` | Your Firebase keys |
| `database.rules.json` | Database rules to paste into Firebase |
| `tests/logic.test.mjs` | `npm test`: rule tests plus 300 random simulated games checking that no chips appear or vanish |

## Good to know

- Anyone who knows a table code can join and act on that table. That's fine for friends, but this isn't built for strangers or real-money security.
- Your identity is stored on your phone. Reopening the link puts you back in your seat.
- Simplifications: a short all-in raise doesn't technically re-open betting, and the uncalled part of a bet is returned at showdown rather than right away. The chip counts still come out correct.
- Free Firebase (Spark plan) allows 100 simultaneous connections, far more than a poker night needs.
