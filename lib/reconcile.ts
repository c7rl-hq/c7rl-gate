// Operator reconciliation: discover the open PRs whose C7RL check may be stale and re-decide
// each through reevaluatePr — the exact path the webhook uses. Safe to run repeatedly: every
// decision is recomputed from current GitHub state, and reevaluatePr never replaces a check
// that reflects a newer base-branch revision.
//
// Scopes:
//   { pr: n }            one PR
//   { workOrderId: id }  the work PR named by that work order's grants (after an amendment or
//                        revocation); read from the grant chain at the base tip
//   {}                   every open PR (after a policy change, or a missed-delivery sweep)

import { getPull, listCheckRuns, listOpenPulls, branchTip, getRepository } from "./app.js";
import { readChain } from "./grants.js";
import { reevaluatePr, type ReevaluateOutcome } from "./reevaluate.js";

export interface ReconcileRow {
  pr: number;
  head: string | null;
  before: string | null;
  after: string | null;
  posted: boolean;
  skipped?: string;
}

export interface ReconcileScope {
  pr?: number;
  workOrderId?: string;
  base?: string;
}

async function latestTitle(token: string, repo: string, sha: string | null): Promise<string | null> {
  if (!sha) return null;
  const runs = await listCheckRuns(token, repo, sha);
  const top = runs[0];
  return top ? `${String(top.conclusion).toUpperCase()} — ${top.output.title}` : null;
}

export async function discover(token: string, fullName: string, scope: ReconcileScope): Promise<number[]> {
  if (scope.pr) return [scope.pr];
  const repo = await getRepository(token, fullName);
  if (!repo) throw new Error(`repository ${fullName} not found`);
  if (scope.workOrderId) {
    const base = scope.base ?? repo.default_branch;
    const tip = await branchTip(token, fullName, base);
    if (!tip) throw new Error(`base ${base} not found`);
    const chain = await readChain(token, { id: repo.id, fullName }, scope.workOrderId, tip);
    if (!chain.ok) throw new Error(`work order ${scope.workOrderId}: ${chain.detail}`);
    return [...new Set(chain.revisions.map((r) => r.record.workPr))];
  }
  return (await listOpenPulls(token, fullName, scope.base)).map((p) => p.number);
}

export async function reconcile(token: string, fullName: string, scope: ReconcileScope = {}): Promise<ReconcileRow[]> {
  const repo = await getRepository(token, fullName);
  if (!repo) throw new Error(`repository ${fullName} not found`);
  const rows: ReconcileRow[] = [];
  for (const n of await discover(token, fullName, scope)) {
    const pr = await getPull(token, fullName, n);
    const before = await latestTitle(token, fullName, pr?.head.sha ?? null);
    const out: ReevaluateOutcome = await reevaluatePr(token, { id: repo.id, fullName }, n);
    const after = await latestTitle(token, fullName, out.headSha);
    rows.push({ pr: n, head: out.headSha, before, after, posted: out.posted, skipped: out.skipped });
  }
  return rows;
}
