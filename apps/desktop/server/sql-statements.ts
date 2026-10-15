/**
 * Splits a migration script into the statements Postgres runs one at a time, the way
 * `prisma migrate deploy` does. Running them separately matters: `CREATE INDEX CONCURRENTLY`
 * fails inside the implicit transaction a multi-statement query opens.
 *
 * Semicolons inside quoted strings, quoted identifiers, dollar-quoted bodies and comments
 * do not end a statement. Statements that are only comments are dropped.
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let meaningful = false;

  const finish = (end: number) => {
    const text = script.slice(start, end).trim();
    if (meaningful && text !== "") statements.push(text);
    start = end + 1;
    meaningful = false;
  };

  while (index < script.length) {
    const char = script[index];
    const next = script[index + 1];

    if (char === "-" && next === "-") {
      const lineEnd = script.indexOf("\n", index);
      index = lineEnd === -1 ? script.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < script.length && depth > 0) {
        if (script[index] === "/" && script[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (script[index] === "*" && script[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      meaningful = true;
      index += 1;
      while (index < script.length) {
        if (script[index] === char) {
          // A doubled quote is an escaped quote, not the end.
          if (script[index + 1] === char) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(script.slice(index, index + 64))?.[0];
      if (tag !== undefined) {
        meaningful = true;
        const close = script.indexOf(tag, index + tag.length);
        index = close === -1 ? script.length : close + tag.length;
        continue;
      }
    }
    if (char === ";") {
      finish(index);
      index += 1;
      continue;
    }
    if (char !== undefined && !/\s/.test(char)) meaningful = true;
    index += 1;
  }
  finish(script.length);
  return statements;
}
