import { Router } from "express";
import {
  CompletePaymentRequestBody,
  CompletePaymentRequestResponse,
  CreatePaymentRequestBody,
  CreatePaymentRequestResponse,
  GetPaymentRequestResponse,
} from "@workspace/api-zod";
import { buildWalletState } from "./wallet";
import {
  completePaymentRequest,
  consumeReauthToken,
  createPaymentRequest,
  getPaymentRequestByToken,
  randsToCents,
  requestStatus,
  type DbResolver,
} from "../lib/store";
import { fixedWindowLimiter } from "../lib/limiter";
import { currentUser, requireAuth } from "../lib/session";

const PAYMENTS_RATE_MAX = Number(process.env.PAYMERCH_PAYMENTS_RATE_MAX ?? 60);

export function createPaymentsRouter(resolveDb: DbResolver): Router {
  const router = Router();

  router.use(
    "/payment-requests",
    fixedWindowLimiter({
      windowMs: 5 * 60 * 1000,
      max: PAYMENTS_RATE_MAX,
      message: "Too many requests. Please wait a few minutes and try again.",
    }),
  );

  router.post("/payment-requests", requireAuth(resolveDb), async (req, res, next) => {
    try {
      const parsed = CreatePaymentRequestBody.safeParse(req.body);
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
      const reauth = await consumeReauthToken(db, user.id, "create-payment-request", body.reauthToken);
      if (!reauth) {
        res.status(403).json({ message: "PIN confirmation required for this action" });
        return;
      }
      const created = await createPaymentRequest(db, user, amountCents);
      if (created === "INSUFFICIENT_BALANCE") {
        res.status(400).json({ message: "Insufficient test balance" });
        return;
      }
      res.status(201).json(
        CreatePaymentRequestResponse.parse({
          token: created.token,
          amount: created.amountCents / 100,
          expiresAt: created.expiresAt.getTime(),
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/payment-requests/:token", requireAuth(resolveDb), async (req, res, next) => {
    try {
      const db = await resolveDb();
      const row = await getPaymentRequestByToken(db, String(req.params.token));
      if (!row) {
        res.status(404).json({ message: "Unknown payment request" });
        return;
      }
      res.json(
        GetPaymentRequestResponse.parse({
          token: row.token,
          amount: row.amountCents / 100,
          expiresAt: row.expiresAt.getTime(),
          payerName: row.payerName,
          status: requestStatus(row),
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/payment-requests/:token/complete", requireAuth(resolveDb), async (req, res, next) => {
    try {
      const db = await resolveDb();
      const merchant = currentUser(res);
      const parsed = CompletePaymentRequestBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "PIN confirmation required for this action" });
        return;
      }
      if (merchant.accountType !== "business") {
        res.status(403).json({ message: "A business account is required to accept payments" });
        return;
      }
      const reauth = await consumeReauthToken(db, merchant.id, "complete-payment", parsed.data.reauthToken);
      if (!reauth) {
        res.status(403).json({ message: "PIN confirmation required for this action" });
        return;
      }
      const result = await completePaymentRequest(db, String(req.params.token), merchant);
      res.json(
        CompletePaymentRequestResponse.parse({
          result,
          wallet: await buildWalletState(db, merchant.id),
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
