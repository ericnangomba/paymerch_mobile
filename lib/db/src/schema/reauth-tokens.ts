import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// Single-use, short-lived tokens issued by /auth/verify-pin. Each is bound to
// one user and one action type, so a successful PIN check authorizes exactly
// one specific money action server-side (not a blanket UI boolean).
export const reauthTokensTable = pgTable("reauth_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type ReauthToken = typeof reauthTokensTable.$inferSelect;
