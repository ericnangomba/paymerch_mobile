import { Router } from "express";
import {
  LoginBody,
  LoginResponse,
  RegisterBody,
  RegisterResponse,
  VerifyPinBody,
  VerifyPinResponse,
} from "@workspace/api-zod";
import type { Profile, WalletState } from "./wallet";
import { buildWalletState } from "./wallet";
import { hashPin, verifyPinHash } from "../lib/pins";
import {
  createAccount,
  createReauthToken,
  createSession,
  deleteSession,
  findUserByPhone,
  normalizePhone,
  type DbResolver,
} from "../lib/store";
import { fixedWindowLimiter, pinLockRemainingMs, recordPinFailure, recordPinSuccess } from "../lib/limiter";
import { currentSessionToken, currentUser, requireAuth } from "../lib/session";
import type { User } from "@workspace/db/schema";

export function toProfile(user: User): Profile {
  return {
    accountType: user.accountType as Profile["accountType"],
    name: user.name,
    phone: user.phone,
    ...(user.businessCategory ? { businessCategory: user.businessCategory } : {}),
    ...(user.bankName ? { bankName: user.bankName } : {}),
    ...(user.bankAccountHolder ? { bankAccountHolder: user.bankAccountHolder } : {}),
    ...(user.bankAccountNumber ? { bankAccountNumber: user.bankAccountNumber } : {}),
    ...(user.bankAccountType ? { bankAccountType: user.bankAccountType } : {}),
    ...(user.bankBranchCode ? { bankBranchCode: user.bankBranchCode } : {}),
  };
}

async function toAuthSession(
  resolveDb: DbResolver,
  user: User,
  sessionToken: string,
): Promise<{ sessionToken: string; profile: Profile; wallet: WalletState }> {
  const db = await resolveDb();
  return {
    sessionToken,
    profile: toProfile(user),
    wallet: await buildWalletState(db, user.id),
  };
}

const AUTH_RATE_MAX = Number(process.env.PAYMERCH_AUTH_RATE_MAX ?? 20);

export function createAuthRouter(resolveDb: DbResolver): Router {
  const router = Router();

  router.use(
    "/auth",
    fixedWindowLimiter({
      windowMs: 5 * 60 * 1000,
      max: AUTH_RATE_MAX,
      message: "Too many attempts. Please wait a few minutes and try again.",
    }),
  );

  router.post("/auth/register", async (req, res, next) => {
    try {
      const parsed = RegisterBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid registration details" });
        return;
      }
      const body = parsed.data;
      const phone = normalizePhone(body.phone);
      if (
        phone.length < 9 ||
        phone.length > 15 ||
        body.name.trim().length < 2 ||
        body.name.trim().length > 100
      ) {
        res.status(400).json({ message: "Invalid registration details" });
        return;
      }
      const db = await resolveDb();
      if (await findUserByPhone(db, phone)) {
        res.status(409).json({ message: "This phone number is already registered" });
        return;
      }
      const user = await createAccount(db, {
        ...body,
        name: body.name.trim(),
        phone,
        pinHash: hashPin(body.pin),
      });
      const sessionToken = await createSession(db, user.id);
      res.status(201).json(RegisterResponse.parse(await toAuthSession(resolveDb, user, sessionToken)));
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/login", async (req, res, next) => {
    try {
      const parsed = LoginBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid login details" });
        return;
      }
      const phone = normalizePhone(parsed.data.phone);
      const lockedMs = pinLockRemainingMs(`login:${phone}`);
      if (lockedMs > 0) {
        res.status(429).json({ message: "Too many wrong PIN attempts. Try again in a few minutes." });
        return;
      }
      const db = await resolveDb();
      const user = await findUserByPhone(db, phone);
      if (!user || !verifyPinHash(parsed.data.pin, user.pinHash)) {
        recordPinFailure(`login:${phone}`);
        res.status(401).json({ message: "Invalid phone number or PIN" });
        return;
      }
      recordPinSuccess(`login:${phone}`);
      const sessionToken = await createSession(db, user.id);
      res.json(LoginResponse.parse(await toAuthSession(resolveDb, user, sessionToken)));
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/verify-pin", requireAuth(resolveDb), async (req, res, next) => {
    try {
      const parsed = VerifyPinBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid PIN" });
        return;
      }
      const user = currentUser(res);
      const lockKey = `verify:${user.id}`;
      const lockedMs = pinLockRemainingMs(lockKey);
      if (lockedMs > 0) {
        res.status(429).json({ message: "Too many wrong PIN attempts. Try again in a few minutes." });
        return;
      }
      if (!verifyPinHash(parsed.data.pin, user.pinHash)) {
        recordPinFailure(lockKey);
        res.json(VerifyPinResponse.parse({ ok: false }));
        return;
      }
      recordPinSuccess(lockKey);
      const db = await resolveDb();
      const reauthToken = await createReauthToken(db, user.id, parsed.data.action);
      res.json(VerifyPinResponse.parse({ ok: true, reauthToken }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/logout", requireAuth(resolveDb), async (_req, res, next) => {
    try {
      const db = await resolveDb();
      await deleteSession(db, currentSessionToken(res));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
