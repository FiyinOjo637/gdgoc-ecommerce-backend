import type { Config } from 'drizzle-kit';
import 'dotenv/config';

// Points drizzle-kit at the SQLite schema for migration generation.
// Swapping to Postgres in production only requires changing the schema
// file's column helpers (see DESIGN.md "Database & portability") and this
// config's `dialect`.
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: (process.env.DATABASE_URL || 'file:./dev.db').replace('file:', ''),
  },
} satisfies Config;
