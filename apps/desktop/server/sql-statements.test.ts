import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./sql-statements.js";

describe("splitSqlStatements", () => {
  it("splits on top-level semicolons and drops comment-only pieces", () => {
    expect(splitSqlStatements("-- CreateTable\nCREATE TABLE a (id int);\n\n-- done\n")).toEqual([
      "-- CreateTable\nCREATE TABLE a (id int)",
    ]);
    expect(splitSqlStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps semicolons inside strings, identifiers, comments and dollar quotes", () => {
    const script = [
      "INSERT INTO t VALUES ('a;b', 'it''s; fine');",
      'ALTER TABLE "odd;name" ADD COLUMN x int;',
      "/* a; /* nested; */ still; */ SELECT 1;",
      "DO $$ BEGIN PERFORM 1; END $$;",
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;",
    ].join("\n");
    expect(splitSqlStatements(script)).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s; fine')",
      'ALTER TABLE "odd;name" ADD COLUMN x int',
      "/* a; /* nested; */ still; */ SELECT 1",
      "DO $$ BEGIN PERFORM 1; END $$",
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql",
    ]);
  });

  it("does not mistake a positional parameter for a dollar quote", () => {
    expect(splitSqlStatements("PREPARE p AS SELECT $1; EXECUTE p(1);")).toEqual([
      "PREPARE p AS SELECT $1",
      "EXECUTE p(1)",
    ]);
  });
});
