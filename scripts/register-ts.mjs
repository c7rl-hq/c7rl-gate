// Lets `node --import ./scripts/register-ts.mjs <file>.ts` run this repo's TypeScript as-is:
// Node strips the types natively; this hook only maps the NodeNext-style "./x.js" imports in
// .ts files to the "./x.ts" files that exist on disk. No dependencies.
import { register } from "node:module";

register(
  `data:text/javascript,${encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, next) {
  if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
    const ts = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
}`)}`,
  import.meta.url,
);
