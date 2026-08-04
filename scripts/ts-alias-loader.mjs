// Minimal ESM resolve hook so a one-off script can import the app's TypeScript
// modules directly: maps the "@/..." tsconfig alias to src/ and adds the .ts
// extension Node's type stripping still expects on relative imports.
//
//   node --experimental-strip-types --experimental-loader ./scripts/ts-alias-loader.mjs script.ts
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = new URL("../src/", import.meta.url).pathname;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const base = SRC + specifier.slice(2);
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(c)) return next(pathToFileURL(c).href, context);
    }
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const target = new URL(specifier, context.parentURL).pathname;
    if (!existsSync(target)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        if (existsSync(target + ext)) return next(specifier + ext, context);
      }
    }
  }
  return next(specifier, context);
}
