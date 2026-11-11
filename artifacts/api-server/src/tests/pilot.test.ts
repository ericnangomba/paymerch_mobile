import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { usersTable, walletsTable } from "@workspace/db/schema";
import { createPaymentRequest, getPaymentRequestByToken, requestStatus } from "../lib/store";
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
import type { Db } from "../lib/store";

let db: Db;
let server: RunningServer;
let api: Api;

before(async () => {
  db = await createTestDb();
  server = await startServer(db);
  api = apiFor(server.url);
});

after(async () => {
  await server.close();
});

test("health check", async () => {
  const res = await api.get("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("register creates account with seeded test balances and a session", async () => {
  const { res, body } = await registerUser(api);
  assert.equal(res.status, 201);
  assert.ok(body.sessionToken.length > 20);
  assert.equal(body.profile.name, ALICE.name);
  assert.equal(body.profile.phone, "0721112233");
  assert.equal(body.wallet.buyerBalance, 425.5);
  assert.equal(body.wallet.merchantBalance, 1280.75);
  assert.deepEqual(body.wallet.transactions, []);
});

test("duplicate phone registration is rejected", async () => {
  const { res } = await registerUser(api);
  assert.equal(res.status, 409);
});

test("login rejects a wrong PIN and accepts the right one", async () => {
  const bad = await api.post("/auth/login", { phone: ALICE.phone, pin: "000000" });
  assert.equal(bad.status, 401);
  const good = await api.post("/auth/login", { phone: ALICE.phone, pin: ALICE.pin });
  assert.equal(good.status, 200);
  const body = (await good.json()) as any;
  assert.ok(body.sessionToken.length > 20);
});

test("verify-pin reports match and mismatch and issues an action-bound reauth token", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0740001122" });
  const ok = await api.post("/auth/verify-pin", { pin: ALICE.pin, action: "cash-out" }, token);
  const okBody = (await ok.json()) as any;
  assert.equal(okBody.ok, true);
  assert.ok(typeof okBody.reauthToken === "string" && okBody.reauthToken.length > 20);
  const no = await api.post("/auth/verify-pin", { pin: "999999", action: "cash-out" }, token);
  assert.deepEqual(await no.json(), { ok: false });
});

test("wallet requires authentication", async () => {
  const res = await api.get("/wallet");
  assert.equal(res.status, 401);
});

test("logout invalidates the session", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0740002233" });
  assert.equal((await api.get("/wallet", token)).status, 200);
  await api.post("/auth/logout", {}, token);
  assert.equal((await api.get("/wallet", token)).status, 401);
});

test("payment request creation validates balance and amount", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0740003344" });
  const tooBig = await api.post(
    "/payment-requests",
    { amount: 425.51, reauthToken: await reauthFor(api, token!, ALICE.pin, "create-payment-request") },
    token,
  );
  assert.equal(tooBig.status, 400);
  const invalid = await api.post(
    "/payment-requests",
    { amount: -5, reauthToken: await reauthFor(api, token!, ALICE.pin, "create-payment-request") },
    token,
  );
  assert.equal(invalid.status, 400);
  const ok = await api.post(
    "/payment-requests",
    { amount: 25, reauthToken: await reauthFor(api, token!, ALICE.pin, "create-payment-request") },
    token,
  );
  assert.equal(ok.status, 201);
  const body = (await ok.json()) as any;
  assert.ok(body.token.startsWith("pm_"));
  assert.equal(body.amount, 25);
  assert.ok(body.expiresAt - Date.now() <= 60_000 && body.expiresAt > Date.now());
});

test("merchant preview shows payer and OPEN status", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0740004455" });
  const merchant = await registerUser(api, { ...BOB, phone: "0740005566" });
  const created = (await (
    await api.post(
      "/payment-requests",
      { amount: 10, reauthToken: await reauthFor(api, payer.token!, ALICE.pin, "create-payment-request") },
      payer.token,
    )
  ).json()) as any;
  const preview = await api.get(`/payment-requests/${created.token}`, merchant.token);
  assert.equal(preview.status, 200);
  const body = (await preview.json()) as any;
  assert.equal(body.payerName, "Alice Customer");
  assert.equal(body.status, "OPEN");
  assert.equal(body.amount, 10);
});

test("complete moves test money atomically and writes a balanced ledger pair", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0740006677" });
  const merchant = await registerUser(api, { ...BOB, phone: "0740007788" });
  const created = (await (
    await api.post(
      "/payment-requests",
      { amount: 80, reauthToken: await reauthFor(api, payer.token!, ALICE.pin, "create-payment-request") },
      payer.token,
    )
  ).json()) as any;

  const done = await api.post(
    `/payment-requests/${created.token}/complete`,
    { reauthToken: await reauthFor(api, merchant.token!, BOB.pin, "complete-payment") },
    merchant.token,
  );
  assert.equal(done.status, 200);
  const doneBody = (await done.json()) as any;
  assert.equal(doneBody.result, "SUCCESS");
  assert.equal(doneBody.wallet.merchantBalance, 1280.75 + 80);
  assert.equal(doneBody.wallet.transactions.length, 1);
  assert.equal(doneBody.wallet.transactions[0].direction, "in");
  assert.equal(doneBody.wallet.transactions[0].amount, 80);

  const payerWallet = (await (await api.get("/wallet", payer.token)).json()) as any;
  assert.equal(payerWallet.wallet?.buyerBalance ?? payerWallet.buyerBalance, 425.5 - 80);
  const payerTx = (payerWallet.transactions ?? [])[0];
  assert.equal(payerTx.direction, "out");
  assert.equal(payerTx.amount, 80);
  assert.equal(payerTx.reference, created.token);
});

test("a token cannot be replayed", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0740008899" });
  const merchant = await registerUser(api, { ...BOB, phone: "0740009900" });
  const created = (await (
    await api.post(
      "/payment-requests",
      { amount: 15, reauthToken: await reauthFor(api, payer.token!, ALICE.pin, "create-payment-request") },
      payer.token,
    )
  ).json()) as any;

  const first = (await (
    await api.post(
      `/payment-requests/${created.token}/complete`,
      { reauthToken: await reauthFor(api, merchant.token!, BOB.pin, "complete-payment") },
      merchant.token,
    )
  ).json()) as any;
  assert.equal(first.result, "SUCCESS");
  const second = (await (
    await api.post(
      `/payment-requests/${created.token}/complete`,
      { reauthToken: await reauthFor(api, merchant.token!, BOB.pin, "complete-payment") },
      merchant.token,
    )
  ).json()) as any;
  assert.equal(second.result, "ALREADY_USED");
  assert.equal(second.wallet.merchantBalance, 1280.75 + 15);
});

test("concurrent completes have exactly one winner", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0740010011" });
  const merchant = await registerUser(api, { ...BOB, phone: "0740011122" });
  const created = (await (
    await api.post(
      "/payment-requests",
      { amount: 15, reauthToken: await reauthFor(api, payer.token!, ALICE.pin, "create-payment-request") },
      payer.token,
    )
  ).json()) as any;

  const reauthTokens = await Promise.all(
    Array.from({ length: 4 }, () => reauthFor(api, merchant.token!, BOB.pin, "complete-payment")),
  );
  const results = await Promise.all(
    reauthTokens.map((rt) =>
      api.post(`/payment-requests/${created.token}/complete`, { reauthToken: rt }, merchant.token).then((r) => r.json()),
    ),
  );
  const successes = results.filter((r: any) => r.result === "SUCCESS");
  assert.equal(successes.length, 1);
  const wallet = (await (await api.get("/wallet", merchant.token)).json()) as any;
  assert.equal(wallet.merchantBalance, 1280.75 + 15);
});

test("an individual account cannot complete requests (business role enforced)", async () => {
  const payer = await registerUser(api, { ...BOB, phone: "0740012200", businessCategory: "Street vendor" });
  const merchant = await registerUser(api, { ...ALICE, phone: "0740012233" });
  const created = (await (
    await api.post(
      "/payment-requests",
      { amount: 10, reauthToken: await reauthFor(api, payer.token!, BOB.pin, "create-payment-request") },
      payer.token,
    )
  ).json()) as any;
  const res = await api.post(
    `/payment-requests/${created.token}/complete`,
    { reauthToken: await reauthFor(api, merchant.token!, ALICE.pin, "complete-payment") },
    merchant.token,
  );
  assert.equal(res.status, 403);
});

test("a payer cannot complete their own request", async () => {
  const payer = await registerUser(api, { ...BOB, phone: "0740012299", businessCategory: "Street vendor" });
  const created = (await (
    await api.post(
      "/payment-requests",
      { amount: 10, reauthToken: await reauthFor(api, payer.token!, BOB.pin, "create-payment-request") },
      payer.token,
    )
  ).json()) as any;
  const done = (await (
    await api.post(
      `/payment-requests/${created.token}/complete`,
      { reauthToken: await reauthFor(api, payer.token!, BOB.pin, "complete-payment") },
      payer.token,
    )
  ).json()) as any;
  assert.equal(done.result, "INVALID_REQUEST");
});

test("an individual account cannot cash out (business role enforced)", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0740012300" });
  const res = await api.post(
    "/wallet/cash-out",
    { amount: 50, reauthToken: await reauthFor(api, token!, ALICE.pin, "cash-out") },
    token,
  );
  assert.equal(res.status, 403);
});

test("an unknown token is invalid", async () => {
  const merchant = await registerUser(api, { ...BOB, phone: "0740013344" });
  const done = (await (
    await api.post(
      `/payment-requests/pm_doesnotexist/complete`,
      { reauthToken: await reauthFor(api, merchant.token!, BOB.pin, "complete-payment") },
      merchant.token,
    )
  ).json()) as any;
  assert.equal(done.result, "INVALID_REQUEST");
});

test("an expired request cannot complete", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0740014455" });
  const merchant = await registerUser(api, { ...BOB, phone: "0740015566" });
  const payerRows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.phone, "0740014455"))
    .limit(1);
  // Store-level: create a request that expired 1s ago.
  const created = await createPaymentRequest(db, payerRows[0], 500, -1000);
  assert.notEqual(created, "INSUFFICIENT_BALANCE");
  const row = created as any;
  assert.equal(requestStatus(row), "EXPIRED");
  const done = (await (
    await api.post(
      `/payment-requests/${row.token}/complete`,
      { reauthToken: await reauthFor(api, merchant.token!, BOB.pin, "complete-payment") },
      merchant.token,
    )
  ).json()) as any;
  assert.equal(done.result, "EXPIRED");
});

test("insufficient payer funds at completion roll back and leave the request open", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0740016677" });
  const merchant = await registerUser(api, { ...BOB, phone: "0740017788" });
  const created = (await (
    await api.post(
      "/payment-requests",
      { amount: 100, reauthToken: await reauthFor(api, payer.token!, ALICE.pin, "create-payment-request") },
      payer.token,
    )
  ).json()) as any;

  const row = await getPaymentRequestByToken(db, created.token);
  await db
    .update(walletsTable)
    .set({ buyerBalanceCents: 5000 })
    .where(eq(walletsTable.userId, row!.payerId));

  const done = (await (
    await api.post(
      `/payment-requests/${created.token}/complete`,
      { reauthToken: await reauthFor(api, merchant.token!, BOB.pin, "complete-payment") },
      merchant.token,
    )
  ).json()) as any;
  assert.equal(done.result, "INSUFFICIENT_BALANCE");

  const after1 = await getPaymentRequestByToken(db, created.token);
  assert.equal(after1!.status, "OPEN");

  await db
    .update(walletsTable)
    .set({ buyerBalanceCents: 20000 })
    .where(eq(walletsTable.userId, row!.payerId));
  const retry = (await (
    await api.post(
      `/payment-requests/${created.token}/complete`,
      { reauthToken: await reauthFor(api, merchant.token!, BOB.pin, "complete-payment") },
      merchant.token,
    )
  ).json()) as any;
  assert.equal(retry.result, "SUCCESS");
  assert.equal(retry.wallet.merchantBalance, 1280.75 + 100);
});

test("cash-out debits the merchant test balance and rejects overdraw", async () => {
  const { token } = await registerUser(api, { ...BOB, phone: "0740018899" });
  const ok = await api.post(
    "/wallet/cash-out",
    { amount: 150, reauthToken: await reauthFor(api, token!, BOB.pin, "cash-out") },
    token,
  );
  assert.equal(ok.status, 200);
  const wallet = (await ok.json()) as any;
  assert.equal(wallet.merchantBalance, 1280.75 - 150);
  assert.equal(wallet.transactions[0].kind, "CASH_OUT");
  const tooBig = await api.post(
    "/wallet/cash-out",
    { amount: 99999, reauthToken: await reauthFor(api, token!, BOB.pin, "cash-out") },
    token,
  );
  assert.equal(tooBig.status, 400);
});
