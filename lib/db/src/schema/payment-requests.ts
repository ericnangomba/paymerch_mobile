import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Status lifecycle: OPEN -> COMPLETED (exactly once, enforced by an atomic
// conditional UPDATE) or -> EXPIRED (lazy, on read/complete after expires_at).
export const paymentRequestsTable = pgTable("payment_requests", {
  token: text("token").primaryKey(),
  payerId: uuid("payer_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  payerName: text("payer_name").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull().default("OPEN"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type PaymentRequestRow = typeof paymentRequestsTable.$inferSelect;
