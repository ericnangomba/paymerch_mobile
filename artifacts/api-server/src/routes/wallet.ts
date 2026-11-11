import { Router } from "express";
import {
  CashOutBody,
  CashOutResponse,
  GetWalletResponse,
} from "@workspace/api-zod";
import type { LedgerEntry, Wallet } from "@workspace/db/schema";
import {
  consumeReauthToken,
  cashOut,
  getWalletRow,
  listRecentEntries,
  randsToCents,
  type Db,
  type DbResolver,
} from "../lib/store";
import { fixedWindowLimiter } from "../lib/limiter";
import { currentUser, requireAuth } from "../lib/session";

export type Profile = {
  accountType: "individual" | "business";
  name: string;
  phone: string;
  businessCategory?: string;
  bankName?: string;
  bankAccountHolder?: string;
  bankAccountNumber?: string;
  bankAccountType?: string;
  bankBranchCode?: string;
};

export type WalletTransaction = {
  id: string;
  kind: "MERCHANT_PAY" | "VAS_ELEC" | "VAS_AIRTIME" | "CASH_OUT";
  title: string;
  subtitle: string;
  amount: number;
  status: "SUCCESS" | "FAILED";
  createdAt: number;
  direction: "in" | "out";
  reference?: string;
};

export type WalletState = {
  buyerBalance: number;
  merchantBalance: number;
  transactions: WalletTransaction[];
};

function toTransaction(entry: LedgerEntry): WalletTransaction {
  return {
    id: `le-${entry.id}`,
    kind: entry.kind as WalletTransaction["kind"],
    title: entry.title,
    subtitle: entry.subtitle,
    amount: Math.abs(entry.amountCents) / 100,
    status: "SUCCESS",
    createdAt: entry.createdAt.getTime(),
    direction: entry.amountCents >= 0 ? "in" : "out",
    ...(entry.reference ? { reference: entry.reference } : {}),
  };
}

export async function buildWalletState(db: Db, userId: string): Promise<WalletState> {
  const [wallet, entries] = await Promise.all([
    getWalletRow(db, userId),
    listRecentEntries(db, userId),
  ]);
  return {
    buyerBalance: wallet.buyerBalanceCents / 100,
    merchantBalance: wallet.merchantBalanceCents / 100,
    transactions: entries.map(toTransaction),
  };
}

const WALLET_RATE_MAX = Number(process.env.PAYMERCH_WALLET_RATE_MAX ?? 60);

export function createWalletRouter(resolveDb: DbResolver): Router {
  const router = Router();

  router.use(
    "/wallet",
    fixedWindowLimiter({
      windowMs: 5 * 60 * 1000,
      max: WALLET_RATE_MAX,
      message: "Too many requests. Please wait a few minutes and try again.",
    }),
  );

  router.get("/wallet", requireAuth(resolveDb), async (_req, res, next) => {
    try {
      const db = await resolveDb();
      res.json(GetWalletResponse.parse(await buildWalletState(db, currentUser(res).id)));
    } catch (err) {
      next(err);
    }
  });

  router.post("/wallet/cash-out", requireAuth(resolveDb), async (req, res, next) => {
    try {
      const parsed = CashOutBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid amount" });
        return;
      }
      const body = parsed.data;
      const amountCents = randsToCents(body.amount);
      if (amountCents === null) {
        res.status(400).json({ message: "Invalid amount" });
        return;
      }
      const db = await resolveDb();
      const user = currentUser(res);
      if (user.accountType !== "business") {
        res.status(403).json({ message: "A business account is required to cash out" });
        return;
      }
      const reauth = await consumeReauthToken(db, user.id, "cash-out", body.reauthToken);
      if (!reauth) {
        res.status(403).json({ message: "PIN confirmation required for this action" });
        return;
      }
      const ok = await cashOut(db, user.id, amountCents);
      if (!ok) {
        res.status(400).json({ message: "Insufficient test balance" });
        return;
      }
      res.json(CashOutResponse.parse(await buildWalletState(db, currentUser(res).id)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
