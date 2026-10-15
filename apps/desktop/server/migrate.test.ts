import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dumpStatements, migrationNames } from "./migrate.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("migrationNames", () => {
  it("lists migration folders in the order Prisma applies them", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "migrations-"));
    for (const name of ["0002_b", "20260101_c", "0001_a"]) await mkdir(path.join(dir, name));
    await writeFile(path.join(dir, "migration_lock.toml"), "");
    expect(await migrationNames(dir)).toEqual(["0001_a", "0002_b", "20260101_c"]);
  });
});

describe("dumpStatements", () => {
  it("drops psql commands and the public schema the new database already has", () => {
    const dump = [
      "\\restrict abc",
      "SET statement_timeout = 0;",
      "--",
      "-- Name: public; Type: SCHEMA",
      "--",
      "",
      "CREATE SCHEMA public;",
      "CREATE SCHEMA graphile_worker;",
      "INSERT INTO public.t VALUES ('a;b');",
      "\\unrestrict abc",
      "",
    ].join("\n");
    expect(dumpStatements(dump)).toEqual([
      "SET statement_timeout = 0",
      "CREATE SCHEMA graphile_worker",
      "INSERT INTO public.t VALUES ('a;b')",
    ]);
  });
});
