import fs from 'node:fs';

const MIGRATIONS_URL = new URL('./migrations/', import.meta.url);

export function migrate(database, migrationsUrl = MIGRATIONS_URL) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at_ms INTEGER NOT NULL
    );
  `);

  const files = fs
    .readdirSync(migrationsUrl)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const applied = database
    .prepare('SELECT version FROM schema_migrations')
    .all()
    .map((row) => Number(row.version));
  const appliedVersions = new Set(applied);

  for (const filename of files) {
    const version = Number(filename.split('_', 1)[0]);
    if (appliedVersions.has(version)) continue;
    const sql = fs.readFileSync(new URL(filename, migrationsUrl), 'utf8');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(sql);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, filename, applied_at_ms) VALUES (?, ?, ?)',
        )
        .run(version, filename, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Migration ${filename} failed: ${error.message}`, {
        cause: error,
      });
    }
  }
}
