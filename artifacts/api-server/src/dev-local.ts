/**
 * Local pilot runner: starts the API against an in-memory PGlite database
 * with all migrations applied, so the pilot can be exercised without a
 * Postgres install. Data resets on every start; test money only.
 *
 *   pnpm exec tsx src/dev-local.ts   (PORT optional, default 8401)
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@workspace/db/schema";
import { createApp } from "./app";
import { logger } from "./lib/logger";
import type { Db } from "./lib/store";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../lib/db/drizzle");

const client = new PGlite();
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  await client.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
}
const db = drizzle(client, { schema }) as unknown as Db;

const port = Number(process.env.PORT ?? 8401);
createApp(db).listen(port, () => {
  logger.info({ port }, "Pilot API listening (in-memory test ledger)");
});
