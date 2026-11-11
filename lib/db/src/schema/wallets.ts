import { integer, pgTable, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Pilot test ledger only. Balances are labelled test money in the app; no real
// funds are held or moved by this table.
export const walletsTable = pgTable("wallets", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  buyerBalanceCents: integer("buyer_balance_cents").notNull().default(42550),
  merchantBalanceCents: integer("merchant_balance_cents").notNull().default(128075),
});

export type Wallet = typeof walletsTable.$inferSelect;
