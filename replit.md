# Paymerch Mobile

Paymerch Mobile is a local-first digital wallet prototype for informal merchants, with PIN access, dynamic QR payments, VAS vending, and offline sync states.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/paymerch-mobile/app/index.tsx` — the mobile experience and all primary prototype screens.
- `artifacts/paymerch-mobile/state/paymerch-context.tsx` — persisted demo wallet state, ledger actions, QR requests, and offline sync behavior.
- `artifacts/paymerch-mobile/constants/colors.ts` — Paymerch light and dark semantic theme tokens.
- `artifacts/paymerch-mobile/assets/images/paymerch-icon.png` — supplied Paymerch shield mark used by the app.
- `artifacts/api-server` — shared API scaffold, intentionally not required for the first local-first prototype.

## Architecture decisions

- The first build is Expo/frontend-only and uses AsyncStorage so the entire demo works without external accounts or provider credentials.
- The payment flow uses buyer-generated dynamic QR requests and a merchant scan simulation, with a local double-entry-style balance shift.
- Offline mode marks new payment and VAS activity as `PENDING SYNC`; reconnecting can promote pending activity to `SUCCESS`.
- The generated QR is a deterministic visual mock for the signed token flow; production should replace it with a server-signed QR payload and native camera scanning.

## Product

Paymerch Mobile lets a merchant unlock a wallet, view a balance, receive payments by scanning a buyer's one-time QR, sell airtime or electricity tokens, cash out, review activity, and simulate offline transaction caching. A buyer pay mode is included for generating a 60-second payment QR.

## User preferences

No additional preferences recorded.

## Gotchas

- The demo PIN is `0426`.
- The first build intentionally keeps balances local; do not treat it as a production ledger or real payment rail.
- Expo's local React Native DevTools binary may report a missing `libglib-2.0.so.0` warning in this environment while Metro continues to serve the app.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
