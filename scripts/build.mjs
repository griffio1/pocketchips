// Vercel build: copies the site into dist/ and writes firebase-config.js
// from environment variables, so the config never has to be in the repo.
// Locally (no env vars) it falls back to your own firebase-config.js.
import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';

const FILES = ['index.html', 'style.css', 'app.js', 'logic.js', 'sync.js'];
const ENV = {
  apiKey: 'FIREBASE_API_KEY',
  authDomain: 'FIREBASE_AUTH_DOMAIN',
  databaseURL: 'FIREBASE_DATABASE_URL',
  projectId: 'FIREBASE_PROJECT_ID',
  appId: 'FIREBASE_APP_ID',
};

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
for (const f of FILES) copyFileSync(f, `dist/${f}`);

const missing = Object.values(ENV).filter((k) => !process.env[k]);
if (missing.length === 0) {
  const cfg = Object.fromEntries(Object.entries(ENV).map(([key, env]) => [key, process.env[env].trim()]));
  writeFileSync('dist/firebase-config.js', `export const firebaseConfig = ${JSON.stringify(cfg, null, 2)};\n`);
  console.log('firebase-config.js written from environment variables');
} else if (existsSync('firebase-config.js')) {
  copyFileSync('firebase-config.js', 'dist/firebase-config.js');
  console.log('Using local firebase-config.js');
} else if (process.env.VERCEL) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
} else {
  copyFileSync('firebase-config.example.js', 'dist/firebase-config.js');
  console.log('No config found: building in demo mode');
}
