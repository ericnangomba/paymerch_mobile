import type { NextFunction, Request, Response } from "express";
import type { User } from "@workspace/db/schema";
import { findUserByToken, type DbResolver } from "./store";

export function requireAuth(resolveDb: DbResolver) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    try {
      const db = await resolveDb();
      const user = await findUserByToken(db, token);
      if (!user) {
        res.status(401).json({ message: "Not authenticated" });
        return;
      }
      res.locals.user = user;
      res.locals.sessionToken = token;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function currentUser(res: Response): User {
  return res.locals.user as User;
}

export function currentSessionToken(res: Response): string {
  return res.locals.sessionToken as string;
}
