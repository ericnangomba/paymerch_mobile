import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPaymentRequest, getPaymentRequestByToken, completePaymentRequest, requestStatus } from "../lib/store";
import {
  ALICE,
  BOB,
  apiFor,
  createTestDb,
  reauthFor,
  registerUser,
  startServer,
  type Api,
  type RunningServer,
} from "./helpers";
import { usersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import type { Db } from "../lib/store";

// Settlement-semantics tests for the two-person QR payment path. Fully
// isolated: PGlite in-memory database, throwaway server, test-only users.
// These prove exactly-once settlement and document status-read semantics;
// they are not evidence about real physical devices.

let db: Db;
let server: RunningServer;
let api: Api;

const CAROL = {
  accountType: "business",
  name: "Carol's Carwash",
  phone: "0765558899",
  businessCategory: "Carwash",
  pin: "999888",
};

before(async () => {
  db = await createTestDb();
  server = await startServer(db);
  api = apiFor(server.url);
});

after(async () => {
  await server.close();
});

async function makeRequest(payerToken: string, amount: number): Promise<string> {
  const reauth = await reauthFor(api, payerToken, ALICE.pin, "create-payment-request");
  const res = await api.post("/payment-requests", { amount, reauthToken: reauth }, payerToken);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function completeAs(merchantToken: string, merchantPin: string, token: string) {
  const reauth = await reauthFor(api, merchantToken, merchantPin, "complete-payment");
  const res = await api.post(`/payment-requests/${token}/complete`, { reauthToken: reauth }, merchantToken);
  return { status: res.status, body: (await res.json()) as { result: string; wallet: { merchantBalance: number; transactions: Array<{ reference: string | null; amount: number }> } } };
}

test("concurrent claims by two merchants settle exactly once", async () => {
  const payer = await registerUser(api, ALICE);
  const bob = await registerUser(api, BOB);
  const carol = await registerUser(api, CAROL);
  const token = await makeRequest(payer.token!, 50);

  const [first, second] = await Promise.all([
    completeAs(bob.token!, BOB.pin, token),
    completeAs(carol.token!, CAROL.pin, token),
  ]);
  const results = [first.body.result, second.body.result].sort();
  assert.deepEqual(results, ["ALREADY_USED", "SUCCESS"]);

  // The payer was debited exactly once.
  const payerWallet = await (await api.get("/wallet", payer.token!)).json() as { buyerBalance: number };
  assert.equal(payerWallet.buyerBalance, 425.5 - 50);

  // Exactly one merchant was credited; the other's wallet is untouched.
  const winner = first.body.result === "SUCCESS" ? first : second;
  const loser = first.body.result === "SUCCESS" ? second : first;
  assert.equal(winner.body.wallet.merchantBalance, 1280.75 + 50);
  assert.equal(loser.body.wallet.merchantBalance, 1280.75);
  assert.equal(winner.body.wallet.transactions.some((t) => t.reference === token && t.amount > 0), true);
  assert.equal(loser.body.wallet.transactions.some((t) => t.reference === token), false);
});

test("double-click retry by the same merchant settles exactly once", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0721112244" });
  const bob = await registerUser(api, { ...BOB, phone: "0734445577" });
  const token = await makeRequest(payer.token!, 50);

  const [first, second] = await Promise.all([
    completeAs(bob.token!, BOB.pin, token),
    completeAs(bob.token!, BOB.pin, token),
  ]);
  const results = [first.body.result, second.body.result].sort();
  assert.deepEqual(results, ["ALREADY_USED", "SUCCESS"]);

  const winner = first.body.result === "SUCCESS" ? first : second;
  assert.equal(winner.body.wallet.merchantBalance, 1280.75 + 50);
  assert.equal(winner.body.wallet.transactions.filter((t) => t.reference === token).length, 1);
});

test("a complete attempt after expiry is EXPIRED and stays unsettleable", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0721112255" });
  const bob = await registerUser(api, { ...BOB, phone: "0734445588" });
  const [payerRow] = await db.select().from(usersTable).where(eq(usersTable.phone, "0721112255"));
  const [bobRow] = await db.select().from(usersTable).where(eq(usersTable.phone, "0734445588"));

  // Store-level so the TTL can be made tiny without touching route defaults.
  const created = await createPaymentRequest(db, payerRow, 10_00, 5);
  assert.notEqual(created, "INSUFFICIENT_BALANCE");
  if (created === "INSUFFICIENT_BALANCE") return;
  await new Promise((resolve) => setTimeout(resolve, 20));

  const first = await completePaymentRequest(db, created.token, bobRow);
  assert.equal(first, "EXPIRED");
  const retry = await completePaymentRequest(db, created.token, bobRow);
  assert.equal(retry, "EXPIRED");

  const row = await getPaymentRequestByToken(db, created.token);
  assert.equal(row && requestStatus(row), "EXPIRED");
  // No balance moved for the expired request.
  const bobWallet = await (await api.get("/wallet", bob.token!)).json() as { merchantBalance: number };
  assert.equal(bobWallet.merchantBalance, 1280.75);
});

test("balance checked again at settle time: second full-balance request is rejected", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0721112266" });
  const bob = await registerUser(api, { ...BOB, phone: "0734445599" });
  const big = await makeRequest(payer.token!, 400);
  const small = await makeRequest(payer.token!, 100);

  const first = await completeAs(bob.token!, BOB.pin, big);
  assert.equal(first.body.result, "SUCCESS");
  const second = await completeAs(bob.token!, BOB.pin, small);
  assert.equal(second.body.result, "INSUFFICIENT_BALANCE");

  const payerWallet = await (await api.get("/wallet", payer.token!)).json() as { buyerBalance: number };
  assert.equal(payerWallet.buyerBalance, 25.5);
});

test("status read requires auth and never identifies the receiving merchant", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0721112277" });
  const bob = await registerUser(api, { ...BOB, phone: "0734445500" });
  const carol = await registerUser(api, { ...CAROL, phone: "0765558800" });
  const token = await makeRequest(payer.token!, 50);

  const anon = await api.get(`/payment-requests/${token}`);
  assert.equal(anon.status, 401);

  const settled = await completeAs(bob.token!, BOB.pin, token);
  assert.equal(settled.body.result, "SUCCESS");

  // A different merchant reading the status learns COMPLETED but cannot tell
  // from this response whether their own wallet received anything.
  const read = await api.get(`/payment-requests/${token}`, carol.token!);
  assert.equal(read.status, 200);
  const body = (await read.json()) as Record<string, unknown>;
  assert.equal(body.status, "COMPLETED");
  assert.equal("merchantId" in body, false);
  assert.equal("merchantName" in body, false);
  assert.equal("recipient" in body, false);

  // Receipt proof exists only in the recipient's own authenticated wallet.
  const carolWallet = await (await api.get("/wallet", carol.token!)).json() as { transactions: Array<{ reference: string | null }> };
  assert.equal(carolWallet.transactions.some((t) => t.reference === token), false);
});
