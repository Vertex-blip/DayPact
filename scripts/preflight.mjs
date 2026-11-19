import { readFile } from 'node:fs/promises';
import { loadEnv } from 'vite';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env };
const failures = [];
const requireValue = (name, pattern) => {
  const value = env[name];
  if (typeof value !== 'string' || !pattern.test(value))
    failures.push(`${name} is missing or invalid.`);
};
requireValue('VITE_FIREBASE_API_KEY', /^AIza[\w-]{35}$/);
requireValue('VITE_FIREBASE_PROJECT_ID', /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
requireValue('VITE_FIREBASE_AUTH_DOMAIN', /^[a-z0-9.-]+$/);
requireValue('VITE_FIREBASE_APP_ID', /^1:\d+:web:[a-z0-9]+$/);
requireValue('VITE_FIREBASE_MESSAGING_SENDER_ID', /^\d{5,}$/);
requireValue('VITE_FIREBASE_VAPID_KEY', /^[\w-]{87}$/);
if (config.vars?.FIREBASE_PROJECT_ID !== env.VITE_FIREBASE_PROJECT_ID)
  failures.push('Frontend and backend Firebase project IDs must match.');
if (
  !config.vars?.FIREBASE_WEB_API_KEY ||
  config.vars.FIREBASE_WEB_API_KEY !== env.VITE_FIREBASE_API_KEY
)
  failures.push('Backend Firebase API key must match the web app.');
if (!/^[a-f0-9]{32}$/.test(config.account_id ?? ''))
  failures.push('Cloudflare account ID is missing.');
const database = config.d1_databases?.find((item) => item.binding === 'DB');
if (
  !database ||
  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(database.database_id) ||
  /^0+-0+-0+-0+-0+$/.test(database.database_id)
)
  failures.push('Create the production D1 database and set its real ID.');
try {
  const origin = new URL(config.vars?.APP_ORIGIN);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== config.vars.APP_ORIGIN ||
    origin.hostname === 'localhost' ||
    origin.username ||
    origin.password
  )
    failures.push('APP_ORIGIN must be the exact HTTPS production origin without a trailing slash.');
} catch {
  failures.push('APP_ORIGIN is missing or invalid.');
}
if (failures.length) {
  console.error('Deployment stopped before publishing. Complete these settings:');
  failures.forEach((message) => console.error(`- ${message}`));
  process.exitCode = 1;
} else {
  console.log(
    'Public configuration and database identifiers are consistent. Before first launch, verify Firebase providers, authorized domain, FCM secrets and D1 migrations as documented in docs/DEPLOYMENT.md.',
  );
}
