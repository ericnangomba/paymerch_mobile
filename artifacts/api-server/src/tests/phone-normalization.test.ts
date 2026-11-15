import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { usersTable, walletsTable } from "@workspace/db/schema";
import { hashPin } from "../lib/pins";
import { normalizePhone, phoneLookupVariants, type Db } from "../lib/store";
import {
  apiFor,
  createTestDb,
  registerUser,
  startServer,
  type Api,
  type RunningServer,
} from "./helpers";

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

// Inserts an account the way pre-canonicalization registrations left them:
// the raw digits of whatever was typed, with no canonical form applied.
async function insertLegacyUser(phone: string, name: string, pin: string) {
  const [user] = await db
    .insert(usersTable)
    .values({ phone, name, accountType: "individual", pinHash: hashPin(pin) })
    .returning();
  await db.insert(walletsTable).values({ userId: user.id });
  return user;
}

test("normalizePhone canonicalizes South African spellings to the local form", () => {
  assert.equal(normalizePhone("0798567196"), "0798567196");
  assert.equal(normalizePhone("+27798567196"), "0798567196");
  assert.equal(normalizePhone("27798567196"), "0798567196");
  assert.equal(normalizePhone("0027 79 856 7196"), "0798567196");
  assert.equal(normalizePhone("079 856 7196"), "0798567196");
  assert.equal(normalizePhone("+27 79 856 7196"), "0798567196");
  // Non-SA inputs keep the old digits-only behavior.
  assert.equal(normalizePhone("+1 (202) 555-0100"), "12025550100");
  assert.deepEqual(phoneLookupVariants("0798567196"), ["0798567196", "27798567196"]);
  assert.deepEqual(phoneLookupVariants("12025550100"), ["12025550100"]);
});

test("login accepts every spelling of the registered number", async () => {
  await registerUser(api, { accountType: "individual", name: "Format Tester", phone: "0712345678", pin: "112233" });
  for (const spelling of ["0712345678", "+27712345678", "27712345678", "071 234 5678"]) {
    const res = await api.post("/auth/login", { phone: spelling, pin: "112233" });
    assert.equal(res.status, 200, spelling);
    const body = (await res.json()) as any;
    assert.equal(body.profile.phone, "0712345678");
  }
});

test("login reaches an account stored in the legacy international spelling", async () => {
  await insertLegacyUser("27615550199", "Legacy Trader", "445566");
  const local = await api.post("/auth/login", { phone: "0615550199", pin: "445566" });
  assert.equal(local.status, 200);
  const international = await api.post("/auth/login", { phone: "+27 61 555 0199", pin: "445566" });
  assert.equal(international.status, 200);
});

test("duplicate stored spellings of one number fail closed on login", async () => {
  await insertLegacyUser("0625550188", "Dup One", "778899");
  await insertLegacyUser("27625550188", "Dup Two", "778899");
  for (const spelling of ["0625550188", "+27625550188", "27625550188"]) {
    const res = await api.post("/auth/login", { phone: spelling, pin: "778899" });
    assert.equal(res.status, 401, spelling);
  }
});

test("registering a spelling variant of an existing number is rejected", async () => {
  await registerUser(api, { accountType: "individual", name: "First Holder", phone: "0635550177", pin: "990011" });
  const res = await api.post("/auth/register", {
    accountType: "individual",
    name: "Second Holder",
    phone: "+27 63 555 0177",
    pin: "990011",
  });
  assert.equal(res.status, 409);
});

test("registering against a duplicated number is rejected", async () => {
  await insertLegacyUser("0645550166", "Dup Three", "778899");
  await insertLegacyUser("27645550166", "Dup Four", "778899");
  const res = await api.post("/auth/register", {
    accountType: "individual",
    name: "Late Joiner",
    phone: "0645550166",
    pin: "123123",
  });
  assert.equal(res.status, 409);
});

test("PIN lockout counts mixed spellings against one canonical key", async () => {
  await registerUser(api, { accountType: "individual", name: "Lockout Tester", phone: "0655550155", pin: "102938" });
  const spellings = ["0655550155", "+27655550155"];
  for (let i = 0; i < 5; i++) {
    const res = await api.post("/auth/login", { phone: spellings[i % 2], pin: "000000" });
    assert.equal(res.status, 401);
  }
  const locked = await api.post("/auth/login", { phone: spellings[1], pin: "102938" });
  assert.equal(locked.status, 429);
});

test("the PIN pad login path canonicalizes the stored profile phone too", async () => {
  // The welcome-back PIN pad sends the locally stored profile phone verbatim;
  // a profile cached from a legacy-spelled registration must still resolve.
  await insertLegacyUser("27665550144", "Legacy Pad User", "334455");
  const res = await api.post("/auth/login", { phone: "27665550144", pin: "334455" });
  assert.equal(res.status, 200);
  const local = await api.post("/auth/login", { phone: "0665550144", pin: "334455" });
  assert.equal(local.status, 200);
});
