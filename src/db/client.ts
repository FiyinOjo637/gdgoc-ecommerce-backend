import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import * as schema from './schema';
import { env } from '../config/env';

const dbFile = env.DATABASE_URL.replace('file:', '');
const resolvedPath = path.isAbsolute(dbFile) ? dbFile : path.join(process.cwd(), dbFile);

export const sqlite = new Database(resolvedPath);

// WAL mode + a busy timeout let multiple connections/transactions interleave
// safely instead of failing immediately on "database is locked" - this is
// what stands in for Postgres row-level locking in the SQLite dev setup.
// See DESIGN.md Scenario A for how correctness is still guaranteed even
// without SELECT ... FOR UPDATE.
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
