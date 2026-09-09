import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof drizzlePglite<typeof schema>> | ReturnType<typeof drizzlePg<typeof schema>>;
export type Sql = PGlite | ReturnType<typeof postgres>;

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createDb(opts?: { url?: string; max?: number }): Promise<{
  db: Db;
  sql: Sql;
  kind: "pglite" | "postgres";
}> {
  const url = opts?.url ?? process.env.DATABASE_URL;
  if (url && url.startsWith("postgres")) {
    const sql = postgres(url, { max: opts?.max ?? 8 });
    const db = drizzlePg(sql, { schema });
    return { db, sql, kind: "postgres" };
  }
  const sql = new PGlite();
  const db = drizzlePglite(sql, { schema });
  return { db, sql, kind: "pglite" };
}

export async function migrate(sql: Sql) {
  const migDir = join(__dirname, "../../migrations");
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sqlText = readFileSync(join(migDir, f), "utf8");
    if ("exec" in sql && typeof sql.exec === "function") {
      await (sql as PGlite).exec(sqlText);
    } else {
      await (sql as ReturnType<typeof postgres>).unsafe(sqlText);
    }
  }
}

export async function resetData(sql: Sql) {
  const stmt = `
    TRUNCATE TABLE
      reminder_delivery_events,
      reminder_attempts,
      reminders,
      reminder_rules,
      activity_events,
      payments,
      receivables,
      customers,
      sessions,
      memberships,
      businesses,
      users
    CASCADE
  `;
  if ("exec" in sql && typeof sql.exec === "function") {
    await (sql as PGlite).exec(stmt);
  } else {
    await (sql as ReturnType<typeof postgres>).unsafe(stmt);
  }
}

export async function closeDb(sql: Sql) {
  if ("close" in sql && typeof sql.close === "function") {
    await (sql as PGlite).close();
  } else {
    await (sql as ReturnType<typeof postgres>).end({ timeout: 5 });
  }
}
