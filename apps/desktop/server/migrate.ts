import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { splitSqlStatements } from "./sql-statements.js";

/**
 * Applies the bundled Prisma migrations to the app's own database. It keeps Prisma's
 * `_prisma_migrations` bookkeeping, so a database moved here from a Compose stack, or later
 * moved back, is recognised as already migrated.
 */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

export async function migrationNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** A fresh cluster only has the `postgres` database; create the app's own one next to it. */
export async function ensureDatabase(databaseUrl: string): Promise<boolean> {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  url.pathname = "/postgres";
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (found.rowCount !== 0) return false;
    await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
    return true;
  } finally {
    await client.end();
  }
}

export async function migrate(databaseUrl: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(MIGRATIONS_TABLE);
    const finished = await client.query<{ migration_name: string }>(
      `SELECT "migration_name" FROM "_prisma_migrations"
       WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`,
    );
    const done = new Set(finished.rows.map((row) => row.migration_name));
    const applied: string[] = [];
    for (const name of await migrationNames(dir)) {
      if (done.has(name)) continue;
      const script = await readFile(path.join(dir, name, "migration.sql"), "utf8");
      const id = randomUUID();
      await client.query(
        `INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name") VALUES ($1, $2, $3)`,
        [id, createHash("sha256").update(script).digest("hex"), name],
      );
      const statements = splitSqlStatements(script);
      for (const statement of statements) await client.query(statement);
      await client.query(
        `UPDATE "_prisma_migrations" SET "finished_at" = now(), "applied_steps_count" = $2 WHERE "id" = $1`,
        [id, statements.length],
      );
      applied.push(name);
    }
    return applied;
  } finally {
    await client.end();
  }
}

/**
 * Lines a plain `pg_dump` adds for psql (`\\restrict`, `\\connect`) and the schema the new
 * database already has; everything else runs as the dump wrote it.
 */
export function dumpStatements(dump: string): string[] {
  const script = dump
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
  return splitSqlStatements(script).filter(
    (statement) => !/^(?:--[^\n]*\n\s*)*CREATE SCHEMA public$/i.test(statement),
  );
}

/** Replaces the database's contents with a dump from the Docker stack of an earlier version. */
export async function importDump(databaseUrl: string, dump: string): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // A failed earlier attempt may have left part of the dump behind.
    await client.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    const statements = dumpStatements(dump);
    for (const statement of statements) await client.query(statement);
    return statements.length;
  } finally {
    // The dump empties the session's search_path, so this client is not reused.
    await client.end();
  }
}

/**
 * Entry point when bundled: `migrate.mjs <migrations dir> [--import <dump>]`, with DATABASE_URL
 * in the environment.
 */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const [dir, flag, dumpFile] = argv;
  const databaseUrl = env.DATABASE_URL;
  if (!dir || !databaseUrl || (flag !== undefined && (flag !== "--import" || !dumpFile))) {
    throw new Error("Usage: migrate <migrations dir> [--import <dump>] with DATABASE_URL set");
  }
  await ensureDatabase(databaseUrl);
  if (dumpFile) {
    const count = await importDump(databaseUrl, await readFile(dumpFile, "utf8"));
    process.stdout.write(`${count} statements moved from Docker\n`);
  }
  const applied = await migrate(databaseUrl, dir);
  process.stdout.write(`${applied.length} migrations applied\n`);
}
