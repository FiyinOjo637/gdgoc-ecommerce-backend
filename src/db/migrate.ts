import 'dotenv/config';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './client';


function run() {
  migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied successfully.');
  sqlite.close();
}

run();
