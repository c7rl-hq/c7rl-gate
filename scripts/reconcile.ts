// Runnable reconciliation for operators:
//
//   pnpm reconcile --repo <owner/name> --installation <id> [--pr <n> | --work-order <id>] [--base <branch>]
//
// Uses the App credentials from the environment (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY;
// GITHUB_API_URL only for tests) and the same decide-and-post path as the webhook.
// Prints one line per PR: the check before and after. Exit 0 when every PR was processed,
// 1 on an error, 2 on bad usage.

import { installationToken } from "../lib/app.js";
import { reconcile } from "../lib/reconcile.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repo = flag("--repo");
const installation = Number(flag("--installation"));
const pr = flag("--pr") ? Number(flag("--pr")) : undefined;
const workOrderId = flag("--work-order");
const base = flag("--base");
if (!repo || !Number.isInteger(installation) || installation <= 0 || (pr !== undefined && !(pr > 0))) {
  console.error("usage: pnpm reconcile --repo <owner/name> --installation <id> [--pr <n> | --work-order <id>] [--base <branch>]");
  process.exit(2);
}

try {
  const token = await installationToken(installation);
  const rows = await reconcile(token, repo, { pr, workOrderId, base });
  const scope = pr ? `PR #${pr}` : workOrderId ? `work order ${workOrderId}` : `all open PRs${base ? ` into ${base}` : ""}`;
  console.log(`reconcile ${repo} (${scope}): ${rows.length} PR(s)`);
  for (const r of rows) {
    console.log(`  PR #${r.pr} @ ${r.head?.slice(0, 12) ?? "?"}`);
    console.log(`    before: ${r.before ?? "(no check)"}`);
    console.log(`    after:  ${r.after ?? "(no check)"}${r.posted ? "" : `   [not posted: ${r.skipped}]`}`);
  }
  process.exit(0);
} catch (e) {
  console.error(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
