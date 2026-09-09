import { createDb, closeDb, migrate } from "../db/client.ts";
import { ReminderWorker } from "./worker.ts";
import { createMessagingProvider } from "../messaging/factory.ts";

const provider = createMessagingProvider();
const { db, sql } = await createDb();
await migrate(sql);
const worker = new ReminderWorker(db, sql, provider, { now: () => new Date() }, {
  batchSize: Number(process.env.DUE_REMINDER_BATCH || 25),
});
const result = await worker.run();
console.log(JSON.stringify({
  ...result,
  provider: provider.name,
  channel: provider.channel,
  note: provider.channel === "demo" ? "DEMO / NOT ACTUALLY SENT" : "EMAIL — provider accepted is not inbox delivery",
}));
await closeDb(sql);
