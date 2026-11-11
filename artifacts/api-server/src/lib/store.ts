import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, gte, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgTransaction } from "drizzle-orm/pg-core";
import {
  ledgerEntriesTable,
  paymentRequestsTable,
  reauthTokensTable,
  sessionsTable,
  usersTable,
  walletsTable,
  type LedgerEntry,
  type PaymentRequestRow,
  type User,
  type Wallet,
} from "@workspace/db/schema";

// Both the production node-postgres database and the in-memory PGlite database
// used by tests satisfy this shape.
export type Db = PgDatabase<PgQueryResultHKT, any, any>;
type Tx = PgTransaction<any, any, any>;
type Q = Db | Tx;

export type DbResolver = () => Promise<Db>;

let prodDbPromise: Promise<Db> | null = null;

// Lazily import the production pool so tests can inject PGlite without a
// DATABASE_URL ever being set.
export function getProdDb(): Promise<Db> {
  if (!prodDbPromise) {
    prodDbPromise = import("@workspace/db").then((m) => m.db as unknown as Db);
  }
  return prodDbPromise;
}

export const PAYMENT_REQUEST_TTL_MS = 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REAUTH_TTL_MS = 60_000;
export const MAX_AMOUNT_RANDS = 1_000_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class InsufficientBalanceError extends Error {
  readonly name = "InsufficientBalanceError";
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function randsToCents(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  if (cents <= 0 || cents > MAX_AMOUNT_RANDS * 100) return null;
  return cents;
}

export async function findUserByPhone(q: Q, phone: string): Promise<User | null> {
  const rows = await q
    .select()
    .from(usersTable)
    .where(eq(usersTable.phone, normalizePhone(phone)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAccount(
  db: Db,
  input: {
    phone: string;
    name: string;
    accountType: string;
    businessCategory?: string;
    bankName?: string;
    bankAccountHolder?: string;
    bankAccountNumber?: string;
    bankAccountType?: string;
    bankBranchCode?: string;
    pinHash: string;
  },
): Promise<User> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(usersTable)
      .values({
        phone: normalizePhone(input.phone),
        name: input.name,
        accountType: input.accountType,
        businessCategory: input.businessCategory,
        bankName: input.bankName,
        bankAccountHolder: input.bankAccountHolder,
        bankAccountNumber: input.bankAccountNumber,
        bankAccountType: input.bankAccountType,
        bankBranchCode: input.bankBranchCode,
        pinHash: input.pinHash,
      })
      .returning();
    // Seeded pilot test-money balances come from the table defaults.
    await tx.insert(walletsTable).values({ userId: user.id });
    return user;
  });
}

export async function createSession(q: Q, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await q.insert(sessionsTable).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export async function findUserByToken(q: Q, token: string): Promise<User | null> {
  const rows = await q
    .select({ user: usersTable, session: sessionsTable })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(and(eq(sessionsTable.tokenHash, hashToken(token)), gt(sessionsTable.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.user ?? null;
}

export async function deleteSession(q: Q, token: string): Promise<void> {
  await q.delete(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
}

export type ReauthAction = "create-payment-request" | "complete-payment" | "cash-out";

export async function createReauthToken(q: Q, userId: string, action: ReauthAction): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await q.insert(reauthTokensTable).values({
    tokenHash: hashToken(token),
    userId,
    action,
    expiresAt: new Date(Date.now() + REAUTH_TTL_MS),
  });
  return token;
}

// Single-use: the token is deleted as it is consumed, so it can authorize
// exactly one call, for exactly one action, for exactly one user.
export async function consumeReauthToken(
  q: Q,
  userId: string,
  action: ReauthAction,
  token: string,
): Promise<boolean> {
  const deleted = await q
    .delete(reauthTokensTable)
    .where(
      and(
        eq(reauthTokensTable.tokenHash, hashToken(token)),
        eq(reauthTokensTable.userId, userId),
        eq(reauthTokensTable.action, action),
        gt(reauthTokensTable.expiresAt, new Date()),
      ),
    )
    .returning();
  return deleted.length > 0;
}

export async function getWalletRow(q: Q, userId: string): Promise<Wallet> {
  const rows = await q.select().from(walletsTable).where(eq(walletsTable.userId, userId)).limit(1);
  if (!rows[0]) throw new Error("Wallet missing for user");
  return rows[0];
}

export async function listRecentEntries(q: Q, userId: string, limit = 50): Promise<LedgerEntry[]> {
  return q
    .select()
    .from(ledgerEntriesTable)
    .where(eq(ledgerEntriesTable.userId, userId))
    .orderBy(desc(ledgerEntriesTable.id))
    .limit(limit);
}

export async function createPaymentRequest(
  q: Q,
  payer: User,
  amountCents: number,
  ttlMs: number = PAYMENT_REQUEST_TTL_MS,
): Promise<PaymentRequestRow | "INSUFFICIENT_BALANCE"> {
  const wallet = await getWalletRow(q, payer.id);
  if (amountCents > wallet.buyerBalanceCents) return "INSUFFICIENT_BALANCE";
  const token = `pm_${randomBytes(24).toString("base64url")}`;
  const [row] = await q
    .insert(paymentRequestsTable)
    .values({
      token,
      payerId: payer.id,
      payerName: payer.name,
      amountCents,
      expiresAt: new Date(Date.now() + ttlMs),
    })
    .returning();
  return row;
}

export async function getPaymentRequestByToken(q: Q, token: string): Promise<PaymentRequestRow | null> {
  const rows = await q
    .select()
    .from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.token, token))
    .limit(1);
  return rows[0] ?? null;
}

export function requestStatus(row: PaymentRequestRow): "OPEN" | "COMPLETED" | "EXPIRED" {
  if (row.status === "COMPLETED") return "COMPLETED";
  if (row.expiresAt.getTime() <= Date.now()) return "EXPIRED";
  return "OPEN";
}

export type CompleteResult =
  | "SUCCESS"
  | "INVALID_REQUEST"
  | "EXPIRED"
  | "INSUFFICIENT_BALANCE"
  | "ALREADY_USED";

// Atomically completes a payment request: exactly-once token claim, guarded
// payer debit (insufficient funds roll the whole transaction back), merchant
// credit, and a balanced ledger pair. Amount and payer are bound to the token
// server-side, so a tampered or replayed QR payload cannot move test money.
export async function completePaymentRequest(
  db: Db,
  token: string,
  merchant: User,
): Promise<CompleteResult> {
  try {
    return await db.transaction(async (tx) => {
      const existing = await getPaymentRequestByToken(tx, token);
      if (!existing) return "INVALID_REQUEST" as const;
      if (existing.payerId === merchant.id) return "INVALID_REQUEST" as const;
      if (existing.expiresAt.getTime() <= Date.now()) {
        if (existing.status === "OPEN") {
          await tx
            .update(paymentRequestsTable)
            .set({ status: "EXPIRED" })
            .where(eq(paymentRequestsTable.token, token));
        }
        return "EXPIRED" as const;
      }
      if (existing.status !== "OPEN") return "ALREADY_USED" as const;

      const claimed = await tx
        .update(paymentRequestsTable)
        .set({ status: "COMPLETED" })
        .where(
          and(
            eq(paymentRequestsTable.token, token),
            eq(paymentRequestsTable.status, "OPEN"),
            gt(paymentRequestsTable.expiresAt, new Date()),
          ),
        )
        .returning();
      if (claimed.length === 0) return "ALREADY_USED" as const;

      const debited = await tx
        .update(walletsTable)
        .set({ buyerBalanceCents: sql`${walletsTable.buyerBalanceCents} - ${existing.amountCents}` })
        .where(
          and(
            eq(walletsTable.userId, existing.payerId),
            gte(walletsTable.buyerBalanceCents, existing.amountCents),
          ),
        )
        .returning();
      if (debited.length === 0) {
        throw new InsufficientBalanceError();
      }

      await tx
        .update(walletsTable)
        .set({ merchantBalanceCents: sql`${walletsTable.merchantBalanceCents} + ${existing.amountCents}` })
        .where(eq(walletsTable.userId, merchant.id));

      await tx.insert(ledgerEntriesTable).values([
        {
          userId: existing.payerId,
          kind: "MERCHANT_PAY",
          title: "QR payment sent",
          subtitle: `Test payment · to ${merchant.name}`,
          amountCents: -existing.amountCents,
          reference: token,
        },
        {
          userId: merchant.id,
          kind: "MERCHANT_PAY",
          title: "QR payment received",
          subtitle: `Test payment · from ${existing.payerName}`,
          amountCents: existing.amountCents,
          reference: token,
        },
      ]);
      return "SUCCESS" as const;
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) return "INSUFFICIENT_BALANCE";
    throw err;
  }
}

// Test-money cash-out: debits the merchant test balance and records it. No
// real payout happens in the pilot.
export async function cashOut(db: Db, userId: string, amountCents: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const debited = await tx
      .update(walletsTable)
      .set({ merchantBalanceCents: sql`${walletsTable.merchantBalanceCents} - ${amountCents}` })
      .where(
        and(eq(walletsTable.userId, userId), gte(walletsTable.merchantBalanceCents, amountCents)),
      )
      .returning();
    if (debited.length === 0) return false;
    await tx.insert(ledgerEntriesTable).values({
      userId,
      kind: "CASH_OUT",
      title: "Cash out",
      subtitle: "Test cash-out · no real payout",
      amountCents: -amountCents,
    });
    return true;
  });
}
