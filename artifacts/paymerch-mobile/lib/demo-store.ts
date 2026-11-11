// Demo-mode local API for Paymerch Mobile.
//
// Powers the explicit, opt-in demo experience for builds that run without a
// pilot backend (for example the static demo deploy). It implements the same
// functions as the generated API client, entirely on device, with prepared
// dummy profiles only:
//
// - No registration, and no real names, phones, PINs or bank details are
//   collected. The demo PIN is a fixed public constant shown in the UI.
// - Storage is fully isolated under one demo key; server-mode storage keys
//   are never read or written here.
// - It is never entered automatically: the wallet context only enables it
//   from an explicit user action while signed out, and a live server session
//   can never be downgraded into it.
import type {
  AmountRequest,
  AuthSession,
  CompletePaymentBody,
  CompletePaymentResponse,
  LoginRequest,
  OkResponse,
  PaymentRequest,
  PaymentRequestDetail,
  Profile,
  RegisterRequest,
  VerifyPinRequest,
  VerifyPinResult,
  WalletState,
  WalletTransaction,
} from '@workspace/api-client-react';

export const DEMO_PIN = '123456';
export const DEMO_STORE_KEY = 'paymerch-demo-store-v1';

const REAUTH_TTL_MS = 60_000;
const REQUEST_TTL_MS = 60_000;
const BUYER_SEED_CENTS = 42_550;
const MERCHANT_SEED_CENTS = 128_075;

export type DemoKeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type DemoAuthTokenGetter = () => Promise<string | null> | string | null;

export const DEMO_PROFILES: { buyer: Profile; trader: Profile } = {
  buyer: { accountType: 'individual', name: 'Demo Buyer', phone: '0000000001' },
  trader: {
    accountType: 'business',
    name: 'Demo Trader',
    phone: '0000000002',
    businessCategory: 'Spaza shop',
  },
};

type DemoUserRecord = {
  profile: Profile;
  buyerBalanceCents: number;
  merchantBalanceCents: number;
  transactions: WalletTransaction[];
};

type DemoPaymentRequest = {
  token: string;
  amountCents: number;
  expiresAt: number;
  payerPhone: string;
  payerName: string;
  status: 'OPEN' | 'COMPLETED';
};

type DemoReauthEntry = { phone: string; action: string; expiresAt: number };

type DemoData = {
  users: Record<string, DemoUserRecord>;
  sessions: Record<string, string>;
  requests: Record<string, DemoPaymentRequest>;
  reauth: Record<string, DemoReauthEntry>;
};

function apiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function randomToken(bytes: number): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    const buffer = new Uint8Array(bytes);
    cryptoApi.getRandomValues(buffer);
    return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < bytes * 2; i += 1) {
    out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  }
  return out;
}

function seedUser(profile: Profile): DemoUserRecord {
  return {
    profile,
    buyerBalanceCents: BUYER_SEED_CENTS,
    merchantBalanceCents: MERCHANT_SEED_CENTS,
    transactions: [],
  };
}

function seed(): DemoData {
  return {
    users: {
      [DEMO_PROFILES.buyer.phone]: seedUser(DEMO_PROFILES.buyer),
      [DEMO_PROFILES.trader.phone]: seedUser(DEMO_PROFILES.trader),
    },
    sessions: {},
    requests: {},
    reauth: {},
  };
}

function walletOf(user: DemoUserRecord): WalletState {
  return {
    buyerBalance: user.buyerBalanceCents / 100,
    merchantBalance: user.merchantBalanceCents / 100,
    transactions: [...user.transactions].sort((a, b) => b.createdAt - a.createdAt),
  };
}

export type DemoApi = ReturnType<typeof createDemoApi>;

export function createDemoApi(kv: DemoKeyValueStore, now: () => number = () => Date.now()) {
  let data: DemoData | null = null;
  let authTokenGetter: DemoAuthTokenGetter | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op);
    queue = run.catch(() => undefined);
    return run;
  }

  async function load(): Promise<DemoData> {
    if (data) return data;
    const raw = await kv.getItem(DEMO_STORE_KEY);
    if (raw) {
      try {
        data = JSON.parse(raw) as DemoData;
        return data;
      } catch {
        await kv.removeItem(DEMO_STORE_KEY);
      }
    }
    data = seed();
    await kv.setItem(DEMO_STORE_KEY, JSON.stringify(data));
    return data;
  }

  async function save(): Promise<void> {
    if (data) await kv.setItem(DEMO_STORE_KEY, JSON.stringify(data));
  }

  async function currentUser(d: DemoData): Promise<DemoUserRecord> {
    const token = authTokenGetter ? await authTokenGetter() : null;
    const phone = token ? d.sessions[token] : undefined;
    const user = phone ? d.users[phone] : undefined;
    if (!user) throw apiError(401, 'Not signed in');
    return user;
  }

  function consumeReauth(d: DemoData, user: DemoUserRecord, action: string, token: string | undefined): void {
    if (!token) throw apiError(403, 'PIN confirmation required');
    const entry = d.reauth[token];
    if (!entry || entry.phone !== user.profile.phone || entry.action !== action || entry.expiresAt < now()) {
      throw apiError(403, 'PIN confirmation failed');
    }
    // Single-use: burned on successful validation, like the pilot server.
    delete d.reauth[token];
  }

  return {
    setAuthTokenGetter(getter: DemoAuthTokenGetter | null): void {
      authTokenGetter = getter;
    },

    // Seeds the demo store if needed and returns the profile demo mode starts on.
    async prepareDemo(): Promise<Profile> {
      const d = await load();
      return d.users[DEMO_PROFILES.buyer.phone].profile;
    },

    // Returns the other prepared demo profile, for switching sides in the demo.
    async otherDemoProfile(phone: string): Promise<Profile> {
      const d = await load();
      const next = phone === DEMO_PROFILES.buyer.phone ? DEMO_PROFILES.trader.phone : DEMO_PROFILES.buyer.phone;
      return d.users[next].profile;
    },

    register(_req: RegisterRequest): Promise<AuthSession> {
      return Promise.reject(
        apiError(403, 'Demo mode uses prepared demo profiles. Registration is disabled in demo mode.'),
      );
    },

    login(req: LoginRequest): Promise<AuthSession> {
      return enqueue(async () => {
        const d = await load();
        const user = d.users[req.phone];
        if (!user || req.pin !== DEMO_PIN) throw apiError(401, 'Incorrect demo PIN');
        const sessionToken = `demo-${randomToken(24)}`;
        d.sessions[sessionToken] = user.profile.phone;
        await save();
        return { sessionToken, profile: user.profile, wallet: walletOf(user) };
      });
    },

    logout(): Promise<OkResponse> {
      return enqueue(async () => {
        const d = await load();
        const token = authTokenGetter ? await authTokenGetter() : null;
        if (token && d.sessions[token]) {
          delete d.sessions[token];
          await save();
        }
        return { ok: true };
      });
    },

    verifyPin(req: VerifyPinRequest): Promise<VerifyPinResult> {
      return enqueue(async () => {
        const d = await load();
        const user = await currentUser(d);
        if (req.pin !== DEMO_PIN) throw apiError(401, 'Incorrect demo PIN');
        const reauthToken = randomToken(16);
        d.reauth[reauthToken] = { phone: user.profile.phone, action: req.action, expiresAt: now() + REAUTH_TTL_MS };
        await save();
        return { ok: true, reauthToken };
      });
    },

    getWallet(): Promise<WalletState> {
      return enqueue(async () => {
        const d = await load();
        return walletOf(await currentUser(d));
      });
    },

    createPaymentRequest(req: AmountRequest): Promise<PaymentRequest> {
      return enqueue(async () => {
        const d = await load();
        const user = await currentUser(d);
        consumeReauth(d, user, 'create-payment-request', req.reauthToken);
        const amountCents = Math.round(req.amount * 100);
        if (amountCents <= 0 || amountCents > user.buyerBalanceCents) {
          throw apiError(400, 'Amount exceeds the demo balance');
        }
        const token = `pm_${randomToken(24)}`;
        const expiresAt = now() + REQUEST_TTL_MS;
        d.requests[token] = {
          token,
          amountCents,
          expiresAt,
          payerPhone: user.profile.phone,
          payerName: user.profile.name,
          status: 'OPEN',
        };
        await save();
        return { token, amount: amountCents / 100, expiresAt };
      });
    },

    getPaymentRequest(token: string): Promise<PaymentRequestDetail> {
      return enqueue(async () => {
        const d = await load();
        await currentUser(d);
        const request = d.requests[token];
        if (!request) throw apiError(404, 'Unknown payment request');
        const status =
          request.status === 'COMPLETED' ? 'COMPLETED' : request.expiresAt < now() ? 'EXPIRED' : 'OPEN';
        return {
          token: request.token,
          amount: request.amountCents / 100,
          expiresAt: request.expiresAt,
          payerName: request.payerName,
          status,
        } as PaymentRequestDetail;
      });
    },

    completePaymentRequest(token: string, body: CompletePaymentBody): Promise<CompletePaymentResponse> {
      return enqueue(async () => {
        const d = await load();
        const merchant = await currentUser(d);
        if (merchant.profile.accountType !== 'business') {
          throw apiError(403, 'Only business accounts can accept payments');
        }
        consumeReauth(d, merchant, 'complete-payment', body.reauthToken);
        const request = d.requests[token];
        if (!request) return { result: 'INVALID_REQUEST', wallet: walletOf(merchant) };
        if (request.status === 'COMPLETED') return { result: 'ALREADY_USED', wallet: walletOf(merchant) };
        if (request.expiresAt < now()) return { result: 'EXPIRED', wallet: walletOf(merchant) };
        const payer = d.users[request.payerPhone];
        if (!payer || payer.profile.phone === merchant.profile.phone) {
          return { result: 'INVALID_REQUEST', wallet: walletOf(merchant) };
        }
        if (payer.buyerBalanceCents < request.amountCents) {
          return { result: 'INSUFFICIENT_BALANCE', wallet: walletOf(merchant) };
        }
        payer.buyerBalanceCents -= request.amountCents;
        merchant.merchantBalanceCents += request.amountCents;
        request.status = 'COMPLETED';
        const createdAt = now();
        payer.transactions.push({
          id: randomToken(8),
          kind: 'MERCHANT_PAY',
          title: 'QR payment sent',
          subtitle: `Test payment · to ${merchant.profile.name}`,
          amount: request.amountCents / 100,
          status: 'SUCCESS',
          createdAt,
          direction: 'out',
          reference: token,
        });
        merchant.transactions.push({
          id: randomToken(8),
          kind: 'MERCHANT_PAY',
          title: 'QR payment received',
          subtitle: `Test payment · from ${request.payerName}`,
          amount: request.amountCents / 100,
          status: 'SUCCESS',
          createdAt,
          direction: 'in',
          reference: token,
        });
        await save();
        return { result: 'SUCCESS', wallet: walletOf(merchant) };
      });
    },

    cashOut(req: AmountRequest): Promise<WalletState> {
      return enqueue(async () => {
        const d = await load();
        const user = await currentUser(d);
        if (user.profile.accountType !== 'business') {
          throw apiError(403, 'Only business accounts can cash out');
        }
        consumeReauth(d, user, 'cash-out', req.reauthToken);
        const amountCents = Math.round(req.amount * 100);
        if (amountCents <= 0 || amountCents > user.merchantBalanceCents) {
          throw apiError(400, 'Amount exceeds the demo balance');
        }
        user.merchantBalanceCents -= amountCents;
        user.transactions.push({
          id: randomToken(8),
          kind: 'CASH_OUT',
          title: 'Cash out',
          subtitle: 'Test cash-out · no real payout',
          amount: amountCents / 100,
          status: 'SUCCESS',
          createdAt: now(),
          direction: 'out',
        });
        await save();
        return walletOf(user);
      });
    },
  };
}
