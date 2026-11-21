// GitHub App webhook: on pull_request activity, decide the "C7RL / scope-check" check run
// for the PR and post it on the head SHA. Fails closed: no contract, bad contract, or an API
// error ⇒ failure.
//
// Directory-only contracts are judged exactly as before (policy globs vs. the PR's files).
// Repositories whose base-branch contract sets "taskGrants": "required" are judged per
// operation against the approved task grant that names the PR (lib/reevaluate.ts). When a
// grant issuance PR merges, the work PR it names is re-evaluated at its current head.

import { getPull, installationToken, verifySignature } from "../lib/app.js";
import { reevaluatePr, workPrsNamedBy, type ReevaluateOutcome } from "../lib/reevaluate.js";

const ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "edited", "closed"]);

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
  if (event !== "pull_request") return Response.json({ ok: true, ignored: event });

  const p = JSON.parse(body) as PrEvent;
  if (!ACTIONS.has(p.action) || !p.installation) return Response.json({ ok: true, ignored: p.action });

  const repo = { id: p.repository.id, fullName: p.repository.full_name };
  const token = await installationToken(p.installation.id);

  if (p.action === "closed") {
    if (!p.pull_request.merged) return Response.json({ ok: true, ignored: "closed without merge" });
    // A merged grant issuance changes which revision is active for the work PR it names.
    const merged = await getPull(token, repo.fullName, p.pull_request.number);
    const named = merged ? await workPrsNamedBy(token, repo, merged) : [];
    const outcomes: ReevaluateOutcome[] = [];
    for (const n of named) outcomes.push(await reevaluatePr(token, repo, n));
    return Response.json({ ok: true, reevaluated: outcomes.map(summarize) });
  }

  const outcome = await reevaluatePr(token, repo, p.pull_request.number);
  return Response.json({ ok: true, ...summarize(outcome), violations: outcome.decision?.scope?.operations.filter((o) => o.decision !== "allow").length ?? 0 });
}

function summarize(o: ReevaluateOutcome) {
  return { pr: o.pr, head: o.headSha, policyRev: o.policyRev, posted: o.posted, skipped: o.skipped, conclusion: o.decision?.conclusion, title: o.decision?.title };
}
