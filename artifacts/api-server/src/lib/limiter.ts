import type { NextFunction, Request, Response } from "express";

// In-memory fixed-window rate limiting and PIN lockout.
// Pilot limitation: state resets on restart and is per-process, so this is a
// single-instance control. Sufficient for a labelled test-money sandbox; a
// multi-instance deployment needs a shared store.

type WindowBucket = { count: number; resetAt: number };

export function fixedWindowLimiter(options: { windowMs: number; max: number; message: string }) {
  const buckets = new Map<string, WindowBucket>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      res.status(429).json({ message: options.message });
      return;
    }
    next();
  };
}

const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;

type PinAttempts = { fails: number; lockedUntil: number };
const pinAttempts = new Map<string, PinAttempts>();

export function pinLockRemainingMs(key: string): number {
  const entry = pinAttempts.get(key);
  if (!entry) return 0;
  return Math.max(0, entry.lockedUntil - Date.now());
}

export function recordPinFailure(key: string): void {
  const now = Date.now();
  const entry = pinAttempts.get(key) ?? { fails: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) return;
  entry.fails += 1;
  if (entry.fails >= PIN_MAX_FAILURES) {
    entry.lockedUntil = now + PIN_LOCK_MS;
    entry.fails = 0;
  }
  pinAttempts.set(key, entry);
}

export function recordPinSuccess(key: string): void {
  pinAttempts.delete(key);
}
