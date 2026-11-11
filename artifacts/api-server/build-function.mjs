import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { mkdir } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(artifactDir, "..", "..", "netlify", "functions", "api");
await mkdir(outDir, { recursive: true });

await esbuild({
  entryPoints: [path.resolve(artifactDir, "src/api.ts")],
  platform: "node",
  bundle: true,
  format: "cjs",
  outdir: outDir,
  outExtension: { ".js": ".js" },
  logLevel: "info",
  define: { "process.env.NODE_ENV": "\"production\"" },
    external: ["*.node", "fsevents", "better-sqlite3", "sqlite3", "sharp", "canvas", "bcrypt", "argon2", "re2", "farmhash"],
});
console.log("function bundle written to netlify/functions/api.mjs");
