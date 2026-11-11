# Paymerch Pilot - Test-Money Server Backend

This change set turns the local-only demo into a two-device pilot: real
accounts, real QR scanning between two phones, and server-enforced payment
checks. **All balances are labelled test money. No real funds are held, moved
or paid out.**

## What changed

### New: pilot API server (`artifacts/api-server`)
The previously empty scaffold now implements:

- `POST /api/auth/register` - account creation (phone + 6-digit PIN). PINs are
  stored as salted scrypt hashes, never plaintext. New accounts get seeded
  test balances (customer R425.50, business R1 280.75).
- `POST /api/auth/login` - phone + PIN login, returns a 30-day session token.
- `POST /api/auth/verify-pin` - PIN re-check before any money action. On
  success it returns a **single-use, 60-second reauth token bound to one
  action** (`create-payment-request`, `complete-payment` or `cash-out`); the
  money endpoints require and consume it, so a PIN check can never authorize
  anything else server-side.
- `POST /api/auth/logout` - invalidates the session (lost-device revocation
  starts here; full account recovery flows are a later stage).
- `GET /api/wallet` - balances + last 50 ledger entries.
- `POST /api/wallet/cash-out` - test cash-out for business accounts (ledger
  debit, **no real payout**).
- `POST /api/payment-requests` - customer creates a one-time QR payment
  request (60-second expiry).
- `GET /api/payment-requests/:token` - merchant preview (payer name, amount,
  status).
- `POST /api/payment-requests/:token/complete` - merchant accepts a scanned QR.

### Payment safety properties (server-enforced)
- **Exactly once:** a token completes at most one time. The claim is an atomic
  conditional `UPDATE` inside a database transaction; concurrent scans have a
  single winner (tested).
- **Replay protection:** completed or expired tokens are rejected
  (`ALREADY_USED` / `EXPIRED`).
- **Amount/payee binding:** amount and payer are bound to the token when it is
  created on the server. A tampered QR payload cannot change what moves.
- **Atomic test ledger:** payer debit + merchant credit + balanced ledger pair
  happen in one transaction; insufficient funds roll everything back and the
  request stays open.
- **Self-payment rejected.**
- **Role authorization:** only business accounts can accept payments or cash
  out (403 otherwise). The home screen shows trader tools only to business
  accounts; customers get the "Pay with QR" flow.
- **PIN throttling:** fixed-window rate limits on auth/wallet/payment routes,
  and 5 failed PIN attempts lock login or verify-pin for 15 minutes (429).
- **Hashed sessions:** the database stores SHA-256 hashes of session tokens,
  so a database read cannot replay a live session.
- **Fail closed offline:** no connectivity means no payment is created or
  confirmed. The app shows a disconnected state; it never shows an
  unconfirmed payment as accepted. The old simulated "PENDING SYNC" offline
  flow is gone from the pilot path.

### App (`artifacts/paymerch-mobile`)
- Wallet state now comes from the API (`@workspace/api-client-react`), with
  AsyncStorage used only for the session token, profile and a read-only cache.
- PIN no longer stored on the device at all; transaction PIN checks call
  `/api/auth/verify-pin` and pass the returned reauth token to the money
  endpoint. Biometrics only unlock the app - they never authorize a payment.
- Registration collects **no bank details** (that section is removed): the
  pilot holds test money only, so there is nothing to pay out to.
- After scanning, the trader app fetches the server's preview of the request
  and shows the server's amount and payer name before the PIN step - the QR
  payload alone is never trusted.
- VAS (airtime/electricity) is disabled with a "later stage" note - it was
  fully simulated and is out of pilot scope.
- Copy updated: "Test payment received", "No real money moved", and the
  splash now says this is a test-money pilot.

### Demo mode (static deploys without a backend)
- The app can be explored without a pilot server through an **explicit,
  opt-in demo mode** ("Explore the demo" on the login and registration
  screens). It is never entered automatically, and never as a reaction to a
  network failure.
- Demo mode uses prepared dummy profiles only (Demo Buyer / Demo Trader) with
  a fixed public demo PIN (123456) shown in the UI. No registration, and no
  real names, phones, PINs or bank details are collected.
- Demo data lives under separate storage keys (`paymerch-demo-*`); server
  session/profile/wallet keys are never read or written in demo mode, and a
  live server session can never be downgraded into demo mode.
- When the pilot backend is unreachable the app stays in pilot mode and shows
  itself as disconnected: cached balances stay visible, no payment can be
  confirmed, and no demo data appears.
- Implementation: `lib/demo-store.ts` (pure, unit-tested on-device API with
  the same semantics as the server), `lib/demo-api.ts` (AsyncStorage wiring),
  `lib/api-dispatch.ts` (routes the app's API calls to server or demo).

### Database (`lib/db`)
New Drizzle schema: `users`, `sessions` (hashed tokens), `wallets`,
`payment_requests`, `ledger_entries`, `reauth_tokens`. SQL migrations
generated under `lib/db/drizzle/`.

## Run it

Quickest local run (no Postgres needed - in-memory test ledger, resets on
restart):

```bash
pnpm install
pnpm --filter @workspace/api-server run dev:local   # serves on :8401
```

Against a real Postgres:

```bash
export DATABASE_URL=postgres://...   # any Postgres (e.g. Neon free tier)
export PORT=5000
pnpm install
pnpm --filter @workspace/db run push        # create tables
pnpm --filter @workspace/api-server run dev
```

Point the app at the server with `EXPO_PUBLIC_API_URL`
(e.g. `EXPO_PUBLIC_API_URL=https://your-server pnpm --filter @workspace/paymerch-mobile run build:web`).
When unset, the app calls same-origin `/api`.

## Demo-mode tests
`artifacts/paymerch-mobile/lib/demo-store.test.ts` (7 tests: dummy seeding,
wrong-PIN rejection, registration disabled, single-use action-bound reauth,
buyer-to-trader payment both sides, expiry, cash-out role check, session
invalidation, storage isolation). Run from `artifacts/api-server`:
`node --import tsx --test ../paymerch-mobile/lib/demo-store.test.ts`

## Tests

```bash
pnpm --filter @workspace/api-server test
```

28 tests run the real Express app against an in-memory Postgres (PGlite):
auth, PIN verification, session revocation, balance validation, atomic
completion, replay rejection, concurrent-completion single-winner, expiry,
insufficient-funds rollback, self-payment rejection, role enforcement
(business-only accept/cash-out), cash-out limits, plus security tests for
reauth (required, single-use, action-bound, per-user), PIN lockout and
stolen-token replay after logout.

Rate limits are env-tunable (`PAYMERCH_AUTH_RATE_MAX`,
`PAYMERCH_WALLET_RATE_MAX`, `PAYMERCH_PAYMENTS_RATE_MAX`) so test runs and
demo sessions are not throttled; production defaults are conservative.

## Deliberately not in this pilot

- Real money movement, payment-provider integration, KYC, or custody.
- VAS vending (airtime/electricity).
- True offline payment acceptance (the app fails closed instead).
- Account recovery flows beyond session invalidation (recovery abuse needs
  its own design before real money).
- Production hardening beyond the basics already included: audit logging,
  real session device management, fraud monitoring.
- Merchant binding at QR creation time: the customer creates the code before
  knowing the trader, so any trader can accept it. Token theft is mitigated
  by the 60-second expiry, single use and server preview, but a shoulder-
  surfed code could be accepted by the wrong trader inside its lifetime.
  Acceptable for a test-money pilot; needs a decision before real money.
