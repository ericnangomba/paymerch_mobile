import { bigserial, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Append-only test ledger. Every completed payment writes a balanced pair
// (payer debit + merchant credit) inside the same database transaction.
export const ledgerEntriesTable = pgTable("ledger_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle").notNull(),
  amountCents: integer("amount_cents").notNull(),
  reference: text("reference"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LedgerEntry = typeof ledgerEntriesTable.$inferSelect;
