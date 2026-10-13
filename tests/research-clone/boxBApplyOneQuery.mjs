// Sends a SQL file to a local scratch PostgreSQL as ONE simple-protocol Query (multi-statement batch =
// one implicit transaction), the way a project-bound migration API would. Test helper; never targets a real DB.
// Usage: node boxBApplyOneQuery.mjs <unix-socket-dir> <database> <sql-file> [searchValue replaceValue]
import postgres from "postgres";
import { readFileSync } from "node:fs";

const [dir, database, file, find, repl] = process.argv.slice(2);
let sql = readFileSync(file, "utf8");
if (find !== undefined) {
  if (!sql.includes(find)) { console.error("MUTATION_TARGET_NOT_FOUND"); process.exit(3); }
  sql = sql.replace(find, repl ?? "");
}
const db = postgres({ host: dir, user: "postgres", database, max: 1, onnotice: () => {} });
try {
  await db.unsafe(sql).simple();
  console.log("APPLY_OK");
} catch (e) {
  console.log(`APPLY_ERROR ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
