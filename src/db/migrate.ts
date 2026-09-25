import 'dotenv/config';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './client';

// Applies every SQL file under /drizzle (generated via `npm run db:generate`)
// that hasn't already been applied, tracked in a local __drizzle_migrations
// table. Safe to run repeatedly (idempotent) — this is what backs the
// single reproducible setup command in README.md.
function run() {
  migrate(db, { migrationsFolder: './drizzle' });
  // eslint-disable-next-line no-console
  console.log('Migrations applied successfully.');
  sqlite.close();
}

run();
