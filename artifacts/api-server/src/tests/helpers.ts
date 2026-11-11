import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@workspace/db/schema";
import { createApp } from "../app";
import type { Db } from "../lib/store";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../../../lib/db/drizzle");

export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await client.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return drizzle(client, { schema }) as unknown as Db;
}

export type RunningServer = { url: string; close: () => Promise<void> };

export async function startServer(db: Db): Promise<RunningServer> {
  const app = createApp(db);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export type Api = {
  post: (path: string, body?: unknown, token?: string) => Promise<Response>;
  get: (path: string, token?: string) => Promise<Response>;
};

export function apiFor(url: string): Api {
  const request = (method: string, p: string, body?: unknown, token?: string) =>
    fetch(`${url}${p}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return {
    post: (p, body, token) => request("POST", p, body, token),
    get: (p, token) => request("GET", p, undefined, token),
  };
}

export const ALICE = {
  accountType: "individual",
  name: "Alice Customer",
  phone: "0721112233",
  pin: "246810",
};

export const BOB = {
  accountType: "business",
  name: "Bob's Spaza",
  phone: "0734445566",
  businessCategory: "Spaza shop",
  pin: "135791",
};

export async function registerUser(api: Api, over: Record<string, unknown> = ALICE) {
  const res = await api.post("/auth/register", over);
  const body = (await res.json()) as any;
  return { res, body, token: body.sessionToken as string | undefined };
}

export type ReauthAction = "create-payment-request" | "complete-payment" | "cash-out";

export async function reauthFor(api: Api, token: string, pin: string, action: ReauthAction): Promise<string> {
  const res = await api.post("/auth/verify-pin", { pin, action }, token);
  const body = (await res.json()) as any;
  if (!body.ok || !body.reauthToken) {
    throw new Error(`reauth failed for ${action}: ${JSON.stringify(body)}`);
  }
  return body.reauthToken as string;
}
