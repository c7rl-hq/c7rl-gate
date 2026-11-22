// GitHub App webhook: on pull_request activity, decide the "C7RL / scope-check" check run
// for the PR and post it on the head SHA. Fails closed: no contract, bad contract, or an API
// error ⇒ failure.
//
// Directory-only contracts are judged exactly as before (policy globs vs. the PR's files).
// Repositories whose base-branch contract sets "taskGrants": "required" are judged per
// operation against the approved task grant that names the PR (lib/reevaluate.ts).
//
// Re-evaluation triggers, all through reevaluatePr:
//  - pull_request opened/synchronize/reopened/ready_for_review/edited → that PR;
//  - a merged PR that added grant files → the work PR each grant names;
//  - a merged PR that changed .c7rl/contract.json → every open PR into that base;
//  - pull_request_review (submitted/edited/dismissed) on a merged issuance PR → the work PRs
//    it names (a dismissal can withdraw an approval); on an open PR → that PR.
//    Handled here, but the App must subscribe to the event for it to arrive.

import { getPull, installationToken, listPrFiles, verifySignature } from "../lib/app.js";
import { reevaluatePr, workPrsNamedBy, type ReevaluateOutcome } from "../lib/reevaluate.js";
import { reconcile } from "../lib/reconcile.js";

const ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "edited", "closed"]);
const REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);

interface PrEvent {
  action: string;
  installation?: { id: number };
  repository: { id: number; full_name: string };
  pull_request: { number: number; merged?: boolean; head: { sha: string }; base: { ref: string } };
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  if (!verifySignature(body, req.headers.get("x-hub-signature-256"))) {
    return new Response("bad signature", { status: 401 });
  }
  const event = req.headers.get("x-github-event");
  if (event === "ping") return Response.json({ ok: true });
  if (event !== "pull_request" && event !== "pull_request_review") return Response.json({ ok: true, ignored: event });

  const p = JSON.parse(body) as PrEvent;
  const allowed = event === "pull_request" ? ACTIONS : REVIEW_ACTIONS;
  if (!allowed.has(p.action) || !p.installation) return Response.json({ ok: true, ignored: `${event}.${p.action}` });

  const repo = { id: p.repository.id, fullName: p.repository.full_name };
  const token = await installationToken(p.installation.id);

  if (event === "pull_request_review") {
    const pr = await getPull(token, repo.fullName, p.pull_request.number);
    if (!pr) return Response.json({ ok: true, ignored: "PR not found" });
    if (pr.merged_at) {
      const outcomes: ReevaluateOutcome[] = [];
      for (const n of await workPrsNamedBy(token, repo, pr)) outcomes.push(await reevaluatePr(token, repo, n));
      return Response.json({ ok: true, reevaluated: outcomes.map(summarize) });
    }
    return Response.json({ ok: true, ...summarize(await reevaluatePr(token, repo, pr.number)) });
  }

  if (p.action === "closed") {
    if (!p.pull_request.merged) return Response.json({ ok: true, ignored: "closed without merge" });
    const merged = await getPull(token, repo.fullName, p.pull_request.number);
    if (!merged) return Response.json({ ok: true, ignored: "PR not found" });
    // A policy change can alter every open PR's decision.
    if ((await listPrFiles(token, repo.fullName, merged.number)).some((f) => f.filename === ".c7rl/contract.json" || f.previous_filename === ".c7rl/contract.json")) {
      const rows = await reconcile(token, repo.fullName, { base: merged.base.ref });
      return Response.json({ ok: true, policyChanged: true, reconciled: rows });
    }
    // A merged grant issuance changes which revision is active for the work PR it names.
    const outcomes: ReevaluateOutcome[] = [];
    for (const n of await workPrsNamedBy(token, repo, merged)) outcomes.push(await reevaluatePr(token, repo, n));
    return Response.json({ ok: true, reevaluated: outcomes.map(summarize) });
  }

  const outcome = await reevaluatePr(token, repo, p.pull_request.number);
  return Response.json({ ok: true, ...summarize(outcome), violations: outcome.decision?.scope?.operations.filter((o) => o.decision !== "allow").length ?? 0 });
}

function summarize(o: ReevaluateOutcome) {
  return { pr: o.pr, head: o.headSha, policyRev: o.policyRev, posted: o.posted, skipped: o.skipped, conclusion: o.decision?.conclusion, title: o.decision?.title };
}
