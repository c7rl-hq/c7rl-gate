// GitHub App webhook: on pull_request opened/synchronize/reopened, judge the PR's changed
// files against the contract on the base branch and post a "C7RL / scope-check" check run
// bound to the head SHA. Fails closed: no contract, bad contract, or API error ⇒ failure.

import {
  verifySignature,
  installationToken,
  readContractAtRef,
  listPrFiles,
  createCheckRun,
} from "../lib/app.js";
import { ContractSchema, evaluateScope, failClosed, renderSummary } from "../lib/scopeCheck.js";


const ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

interface PrEvent {
  action: string;
  installation?: { id: number };
  repository: { full_name: string };
  pull_request: { number: number; head: { sha: string }; base: { ref: string } };
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

  const repo = p.repository.full_name;
  const sha = p.pull_request.head.sha;
  const token = await installationToken(p.installation.id);

  let result;
  let contract;
  try {
    const raw = await readContractAtRef(token, repo, p.pull_request.base.ref);
    if (raw === null) {
      result = failClosed(`no .c7rl/contract.json on ${p.pull_request.base.ref}`);
    } else {
      const parsed = ContractSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        result = failClosed("contract is invalid");
      } else {
        contract = parsed.data;
        result = evaluateScope(await listPrFiles(token, repo, p.pull_request.number), contract);
      }
    }
  } catch (e) {
    result = failClosed(e instanceof SyntaxError ? "contract is not valid JSON" : "could not verify");
  }

  await createCheckRun(token, repo, sha, result.conclusion, result.title, renderSummary(result, contract));
  return Response.json({ ok: true, conclusion: result.conclusion, violations: result.violations });
}
