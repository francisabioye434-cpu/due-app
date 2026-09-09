import { createDb, migrate, closeDb } from "./client.ts";
const { sql } = await createDb();
await migrate(sql);
console.log("migrations applied");
await closeDb(sql);
