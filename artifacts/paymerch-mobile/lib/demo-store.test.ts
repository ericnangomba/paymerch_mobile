import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoApi, DEMO_PIN, DEMO_STORE_KEY, DEMO_PROFILES } from './demo-store';

function memoryKv() {
  const map = new Map<string, string>();
  return {
    map,
    async getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async setItem(key: string, value: string) {
      map.set(key, value);
    },
    async removeItem(key: string) {
      map.delete(key);
    },
  };
}

function makeApi(start = 1_700_000_000_000) {
  const kv = memoryKv();
  let clock = start;
  const api = createDemoApi(kv, () => clock);
  let token: string | null = null;
  api.setAuthTokenGetter(() => token);
  return {
    api,
    kv,
    advance: (ms: number) => {
      clock += ms;
    },
    setToken: (next: string | null) => {
      token = next;
    },
    login: async (profile: 'buyer' | 'trader') => {
      const session = await api.login({ phone: DEMO_PROFILES[profile].phone, pin: DEMO_PIN });
      token = session.sessionToken;
      return session;
    },
  };
}

test('seeds dummy profiles and rejects a wrong PIN without storing one', async () => {
  const { api, kv, login } = makeApi();
  await assert.rejects(() => api.login({ phone: DEMO_PROFILES.buyer.phone, pin: '999999' }), /Incorrect demo PIN/);
  const session = await login('buyer');
  assert.equal(session.profile.name, 'Demo Buyer');
  assert.equal(session.wallet.buyerBalance, 425.5);
  // Only the isolated demo key is ever written.
  assert.deepEqual([...kv.map.keys()], [DEMO_STORE_KEY]);
  assert.ok(!JSON.stringify([...kv.map.values()]).includes(DEMO_PIN), 'demo PIN must never be persisted');
});

test('registration is disabled in demo mode', async () => {
  const { api } = makeApi();
  await assert.rejects(
    () =>
      api.register({
        accountType: 'individual',
        name: 'Real Person',
        phone: '0821234567',
        pin: '112233',
      }),
    /disabled in demo mode/,
  );
});

test('reauth token is single-use and action-bound', async () => {
  const { api, login } = makeApi();
  await login('buyer');
  const { reauthToken } = await api.verifyPin({ pin: DEMO_PIN, action: 'create-payment-request' });
  assert.ok(reauthToken);
  await assert.rejects(
    () => api.cashOut({ amount: 10, reauthToken: reauthToken! }),
    /PIN confirmation failed|Only business/,
  );
  // Token survived the wrong-action attempt; correct action consumes it.
  const request = await api.createPaymentRequest({ amount: 50, reauthToken: reauthToken! });
  assert.equal(request.amount, 50);
  await assert.rejects(() => api.createPaymentRequest({ amount: 10, reauthToken: reauthToken! }), /PIN confirmation failed/);
  await assert.rejects(() => api.verifyPin({ pin: '000000', action: 'cash-out' }), /Incorrect demo PIN/);
});

test('full buyer-to-trader payment moves test money and records both sides', async () => {
  const { api, login, setToken } = makeApi();
  await login('buyer');
  const reauth = await api.verifyPin({ pin: DEMO_PIN, action: 'create-payment-request' });
  const request = await api.createPaymentRequest({ amount: 50, reauthToken: reauth.reauthToken! });

  const preview = await api.getPaymentRequest(request.token);
  assert.equal(preview.status, 'OPEN');
  assert.equal(preview.payerName, 'Demo Buyer');

  // Individuals cannot accept payments.
  await assert.rejects(
    () => api.completePaymentRequest(request.token, { reauthToken: 'whatever' }),
    /Only business accounts/,
  );

  setToken(null);
  await login('trader');
  const merchantReauth = await api.verifyPin({ pin: DEMO_PIN, action: 'complete-payment' });
  const completed = await api.completePaymentRequest(request.token, { reauthToken: merchantReauth.reauthToken! });
  assert.equal(completed.result, 'SUCCESS');
  assert.equal(completed.wallet.merchantBalance, 1330.75);
  assert.equal(completed.wallet.transactions[0].subtitle, 'Test payment · from Demo Buyer');

  const secondReauth = await api.verifyPin({ pin: DEMO_PIN, action: 'complete-payment' });
  const again = await api.completePaymentRequest(request.token, { reauthToken: secondReauth.reauthToken! });
  assert.equal(again.result, 'ALREADY_USED');

  setToken(null);
  const buyerBack = await login('buyer');
  assert.equal(buyerBack.wallet.buyerBalance, 375.5);
  assert.equal(buyerBack.wallet.transactions[0].subtitle, 'Test payment · to Demo Trader');
});

test('expired requests cannot complete', async () => {
  const { api, login, advance } = makeApi();
  await login('buyer');
  const reauth = await api.verifyPin({ pin: DEMO_PIN, action: 'create-payment-request' });
  const request = await api.createPaymentRequest({ amount: 50, reauthToken: reauth.reauthToken! });
  advance(61_000);
  const preview = await api.getPaymentRequest(request.token);
  assert.equal(preview.status, 'EXPIRED');
});

test('cash-out requires a business profile and moves merchant balance', async () => {
  const { api, login } = makeApi();
  await login('trader');
  const reauth = await api.verifyPin({ pin: DEMO_PIN, action: 'cash-out' });
  const wallet = await api.cashOut({ amount: 100, reauthToken: reauth.reauthToken! });
  assert.equal(wallet.merchantBalance, 1180.75);
  assert.equal(wallet.transactions[0].title, 'Cash out');
});

test('sessions are invalidated on logout', async () => {
  const { api, login, setToken } = makeApi();
  await login('buyer');
  await api.logout();
  await assert.rejects(() => api.getWallet(), /Not signed in/);
  setToken('demo-forged');
  await assert.rejects(() => api.getWallet(), /Not signed in/);
});
