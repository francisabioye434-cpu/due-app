import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
async function walk(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (/\.(ts|js|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const allowPglite = new Set([
  path.join(root, "src/db/client.ts"),
  path.join(root, "src/config.ts"),
]);
const files = await walk(path.join(root, "src"));
let issues = 0;
for (const f of files) {
  const t = await readFile(f, "utf8");
  if (/re_[A-Za-z0-9]{20,}/.test(t) || /whsec_[A-Za-z0-9]{10,}/.test(t)) {
    console.error("possible secret in", f);
    issues++;
  }
  if (/pglite/i.test(t) && !allowPglite.has(f) && !f.includes("client.ts")) {
    // comments mentioning pglite in worker/server are ok if not importing
    if (/from ["']@electric-sql\/pglite["']/.test(t) || /import.*PGlite/.test(t)) {
      console.error("unexpected pglite import", f);
      issues++;
    }
  }
}
if (issues) process.exit(1);
console.log("lint ok");
