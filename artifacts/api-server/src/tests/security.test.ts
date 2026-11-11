import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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

test("creating a payment request without PIN re-auth is rejected", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0750001122" });
  const res = await api.post("/payment-requests", { amount: 20 }, token);
  assert.equal(res.status, 400);
});

test("a reauth token bound to a different action is rejected", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0750002233" });
  const wrongAction = await reauthFor(api, token!, ALICE.pin, "cash-out");
  const res = await api.post("/payment-requests", { amount: 20, reauthToken: wrongAction }, token);
  assert.equal(res.status, 403);
});

test("a reauth token is single-use", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0750003344" });
  const rt = await reauthFor(api, token!, ALICE.pin, "create-payment-request");
  const first = await api.post("/payment-requests", { amount: 20, reauthToken: rt }, token);
  assert.equal(first.status, 201);
  const second = await api.post("/payment-requests", { amount: 20, reauthToken: rt }, token);
  assert.equal(second.status, 403);
});

test("a reauth token cannot be used by another user", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0750004455" });
  const other = await registerUser(api, { ...ALICE, phone: "0750005566" });
  const rt = await reauthFor(api, payer.token!, ALICE.pin, "create-payment-request");
  const res = await api.post("/payment-requests", { amount: 20, reauthToken: rt }, other.token);
  assert.equal(res.status, 403);
});

test("completing a payment without PIN re-auth is rejected", async () => {
  const payer = await registerUser(api, { ...ALICE, phone: "0750006677" });
  const merchant = await registerUser(api, { ...BOB, phone: "0750007788" });
  const created = (await (
    await api.post(
      "/payment-requests",
      { amount: 20, reauthToken: await reauthFor(api, payer.token!, ALICE.pin, "create-payment-request") },
      payer.token,
    )
  ).json()) as any;
  const res = await api.post(`/payment-requests/${created.token}/complete`, {}, merchant.token);
  assert.equal(res.status, 400);
});

test("cash-out without PIN re-auth is rejected", async () => {
  const { token } = await registerUser(api, { ...BOB, phone: "0750008899" });
  const res = await api.post("/wallet/cash-out", { amount: 10 }, token);
  assert.equal(res.status, 400);
});

test("repeated wrong login PINs lock the account out", async () => {
  await registerUser(api, { ...ALICE, phone: "0750009900" });
  for (let i = 0; i < 5; i++) {
    const res = await api.post("/auth/login", { phone: "0750009900", pin: "000000" });
    assert.equal(res.status, 401);
  }
  const locked = await api.post("/auth/login", { phone: "0750009900", pin: ALICE.pin });
  assert.equal(locked.status, 429);
});

test("repeated wrong verify-pin attempts lock out", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0750010011" });
  for (let i = 0; i < 5; i++) {
    const res = await api.post("/auth/verify-pin", { pin: "000000", action: "cash-out" }, token);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false });
  }
  const locked = await api.post("/auth/verify-pin", { pin: ALICE.pin, action: "cash-out" }, token);
  assert.equal(locked.status, 429);
});

test("stolen bearer token cannot be replayed after logout", async () => {
  const { token } = await registerUser(api, { ...ALICE, phone: "0750011122" });
  await api.post("/auth/logout", {}, token);
  const res = await api.post("/payment-requests", { amount: 5 }, token);
  assert.equal(res.status, 401);
});
