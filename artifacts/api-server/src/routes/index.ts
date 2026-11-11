import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { createAuthRouter } from "./auth";
import { createWalletRouter } from "./wallet";
import { createPaymentsRouter } from "./payment-requests";
import type { DbResolver } from "../lib/store";

export function createRouter(resolveDb: DbResolver): IRouter {
  const router: IRouter = Router();

  router.use(healthRouter);
  router.use(createAuthRouter(resolveDb));
  router.use(createWalletRouter(resolveDb));
  router.use(createPaymentsRouter(resolveDb));

  return router;
}
