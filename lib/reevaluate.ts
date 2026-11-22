// The one operation that decides and posts the C7RL check for a pull request.
//
//   reevaluatePr(token, repo, prNumber)
//
// Every input is read fresh at call time: the PR (head, base, files), the base branch's
// CURRENT tip (the policy revision), the policy, the grant chain and its review evidence.
// Nothing is taken from a webhook payload except the PR number and repository identity, so
// a repeated or delayed call computes today's decision, never the decision of the event.
//
// Ordering: each posted check carries external_id "c7rl:<policy revision>". A call skips
// posting if a check on the same head already reflects a NEWER policy revision (GitHub
// compare: theirs is ahead of ours). After posting it re-reads the base tip and, if the tip
// moved meanwhile, evaluates again (bounded), so the last post converges on the current tip.
//
// Used by the webhook for opened/synchronize/reopened/ready_for_review/edited, after a
// merged issuance PR (for the work PR each grant names), and as the recovery call for a
// missed notification.

import path from "node:path";
import { branchTip, compareStatus, createCheckRun, getPull, listCheckRuns, listPrFiles, readFileAt, type Pull } from "./app.js";
import { BODY_HINT, GRANT_FILE, GrantRecordSchema, hash, POLICY_FILE, readChain, recordProblems, resolveGrant, TaskPolicyFileSchema, toGrant, WORK_BRANCH, type GrantRecord, type Resolution, type TaskPolicyFile } from "./grants.js";
import { ContractSchema, evaluateScope, renderSummary } from "./scopeCheck.js";
import { checkTaskScope, TaskPolicySchema, type PrFile, type TaskScopeResult } from "./taskScope.js";

export interface RepoRef {
  id: number;
  fullName: string;
}

export interface Decision {
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  kind: "legacy" | "work" | "issuance" | "mixed" | "fail-closed";
  scope?: TaskScopeResult;
}

export interface ReevaluateOutcome {
  pr: number;
  headSha: string | null;
  policyRev: string | null;
  posted: boolean;
  skipped?: string;
  decision?: Decision;
  attempts: number;
}

const BUILT_IN_PROTECTED = [".c7rl/**", ".github/workflows/**", ".github/CODEOWNERS"];
const short = (s: string) => s.slice(0, 12);

function failClosed(reason: string, detail = ""): Decision {
  return { conclusion: "failure", title: `Blocked: ${reason}`, summary: detail, kind: "fail-closed" };
}

function opsTable(scope: TaskScopeResult): string[] {
  const rows = ["| Op | Path | Decision | Reason | Policy rule | Grant entry |", "|---|---|---|---|---|---|"];
  for (const o of scope.operations) {
    const mark = o.decision === "allow" ? "✅" : o.decision === "deny" ? "❌" : "❔";
    rows.push(`| ${o.op} | \`${o.path}\` | ${mark} ${o.decision} | ${o.reason} | ${o.policyRule ? `\`${o.policyRule}\`` : "—"} | ${o.grantEntry ?? "—"} |`);
  }
  return [...rows, "", ...scope.operations.map((o) => `- ${o.explanation}`)];
}

function hintsFor(pr: Pull): { id: string; from: string }[] {
  const out: { id: string; from: string }[] = [];
  const b = WORK_BRANCH.exec(pr.head.ref)?.[1];
  if (b) out.push({ id: b, from: `branch ${pr.head.ref}` });
  const body = BODY_HINT.exec(pr.body ?? "")?.[1];
  if (body && body !== b) out.push({ id: body, from: "PR body" });
  return out;
}

async function decideWork(token: string, repo: RepoRef, pr: Pull, policyRev: string, policy: TaskPolicyFile, files: PrFile[], complete: boolean, listed: number): Promise<Decision> {
  const evalPolicy = TaskPolicySchema.parse({ allowed: policy.allowed, protected: policy.protected, taskGrants: "required", approvers: policy.approvers });
  const head = [`**Work PR:** #${pr.number} (head \`${pr.head.ref}\`${pr.draft ? ", draft" : ""})`, `**Policy revision:** ${pr.base.ref}@\`${short(policyRev)}\` (base branch tip at evaluation) · **Evaluated head:** \`${short(pr.head.sha)}\``, `**Change list:** ${complete ? "complete" : "INCOMPLETE"} (${listed} file(s) listed${pr.changed_files !== undefined ? ` of ${pr.changed_files} reported` : ""})`];
  const notes: string[] = [];
  let assigned: { res: Extract<Resolution, { state: "active" | "revoked" }>; from: string } | null = null;
  let unverified: Extract<Resolution, { state: "unverified" }> | null = null;
  for (const h of hintsFor(pr)) {
    const res = await resolveGrant(token, repo, policyRev, pr.base.ref, h.id, policy.approvers);
    if (res.state === "active" || res.state === "revoked") {
      if (res.record.workPr === pr.number) {
        assigned = { res, from: h.from };
        break;
      }
      notes.push(`${h.from} → ${h.id}, but ${h.id}@${res.record.revision} is assigned to PR #${res.record.workPr}, not #${pr.number} (hint ignored)`);
    } else if (res.state === "no-grant") {
      notes.push(`${h.from} → ${h.id}: ${res.detail}`);
    } else if (res.state === "unverified") {
      notes.push(`${h.from} → ${h.id}: ${res.label} — ${res.detail}`);
      for (const x of res.ineffective) notes.push(`${h.id}@${x.revision} is ineffective: ${x.reason} — ${x.detail}`);
      unverified ??= res;
    }
  }
  if (!hintsFor(pr).length) notes.push("no work-order hint (branch c7rl/wo/<id> or a `C7RL-Work-Order:` body line)");

  if (!assigned) {
    const label = unverified?.label ?? (notes.some((n) => n.includes("assigned to PR")) ? "no-assignment" : hintsFor(pr).length ? "no-grant" : "no-assignment");
    const scope = checkTaskScope(evalPolicy, null, { assignment: "missing", policyRevision: "current", approval: null, changeList: complete ? "complete" : "incomplete" }, files);
    const relabeled: TaskScopeResult = { ...scope, labels: [label] };
    return {
      conclusion: "failure",
      title: `Unverified: ${label} — no verified task grant for PR #${pr.number}`,
      summary: [...head, "", "**Resolution:**", ...notes.map((n) => `- ${n}`), "", ...opsTable(relabeled), "", "Only a verified task grant naming this PR can pass. Scope only: tests are not run by this check."].join("\n"),
      kind: "work",
      scope: relabeled,
    };
  }

  const { res } = assigned;
  const r = res.record;
  const ev = res.evidence;
  let scope = checkTaskScope(
    evalPolicy,
    toGrant(r, pr.base.ref, pr.head.ref),
    { assignment: "exact", policyRevision: "current", approval: { kind: "github-review", status: "verified", reviewer: ev.reviewer, issuancePr: ev.issuancePr }, changeList: complete ? "complete" : "incomplete" },
    files,
  );
  if (res.state === "revoked") scope = { ...scope, scope: "fail", previewOf: null, labels: ["grant-revoked"] };
  const denied = scope.operations.filter((o) => o.decision !== "allow").length;
  const title =
    scope.scope === "pass"
      ? `Task scope pass: ${r.workOrderId}@${r.revision} grants all ${scope.operations.length} operation(s) of PR #${pr.number}`
      : scope.scope === "unverified"
        ? `Unverified: ${scope.labels.join(", ")} — ${r.workOrderId}@${r.revision} for PR #${pr.number}`
        : res.state === "revoked"
          ? `Task scope fail: ${r.workOrderId}@${r.revision} revokes the grant for PR #${pr.number}`
          : `Task scope fail: ${denied} of ${scope.operations.length} operation(s) not granted by ${r.workOrderId}@${r.revision}`;
  const summary = [
    ...head,
    `**Work order:** ${r.workOrderId} (found via ${assigned.from}) · **Active revision:** ${r.workOrderId}@${r.revision}${res.state === "revoked" ? " — REVOCATION" : ""} (\`${res.path}\`, sha256 \`${ev.grantSha256.slice(0, 16)}\`)`,
    `**Approved by:** @${ev.reviewer} on issuance PR #${ev.issuancePr} at \`${short(ev.issuanceHead)}\` (github-review; issuance author @${ev.issuanceAuthor})`,
    ...(res.ineffective.length
      ? ["", `**Ineffective revisions (known not approved; they change nothing):**`, ...res.ineffective.map((x) => `- ${r.workOrderId}@${x.revision}: \`${x.reason}\` — ${x.detail}`)]
      : []),
    ...(notes.length ? ["", "**Other hints:**", ...notes.map((n) => `- ${n}`)] : []),
    "",
    ...opsTable(scope),
    "",
    "Scope only: tests are not run by this check.",
  ].join("\n");
  return { conclusion: scope.scope === "pass" ? "success" : "failure", title, summary, kind: "work", scope };
}

async function decideIssuance(token: string, repo: RepoRef, pr: Pull, policyRev: string, policy: TaskPolicyFile, grantFiles: PrFile[]): Promise<Decision> {
  const problems: string[] = [];
  const lines: string[] = [];
  if (grantFiles.length !== 1) problems.push(`an issuance PR adds exactly one grant revision (found ${grantFiles.length})`);
  let record: GrantRecord | null = null;
  const f = grantFiles[0];
  const m = GRANT_FILE.exec(f.path)!;
  const bytes = await readFileAt(token, repo.fullName, f.path, pr.head.sha);
  if (!bytes) problems.push(`${f.path} unreadable at ${short(pr.head.sha)}`);
  else {
    try {
      const parsed = GrantRecordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (!parsed.success) problems.push(`${f.path}: ${parsed.error.issues[0]?.message}`);
      else record = parsed.data;
    } catch {
      problems.push(`${f.path} is not JSON`);
    }
  }
  if (record) {
    problems.push(...recordProblems(record));
    if (record.workOrderId !== m[1] || record.revision !== Number(m[2])) problems.push(`${f.path} contains ${record.workOrderId}@${record.revision}`);
    if (record.repository.id !== repo.id) problems.push(`bound to repository id ${record.repository.id}; this repository is ${repo.id}`);
    if (record.workPr === pr.number) problems.push("the issuance PR cannot be the work PR");
    const chain = await readChain(token, repo, record.workOrderId, policyRev);
    if (!chain.ok && !chain.missing) problems.push(`existing chain is malformed: ${chain.detail}`);
    const top = chain.ok ? chain.revisions[chain.revisions.length - 1] : null;
    const wantRev = top ? top.record.revision + 1 : 1;
    const wantSup = top ? `sha256:${hash(top.bytes)}` : null;
    if (record.revision !== wantRev) problems.push(`expected revision ${wantRev} at ${pr.base.ref}@${short(policyRev)}, got ${record.revision}`);
    if (record.supersedes !== wantSup) problems.push(`supersedes must be ${wantSup ?? "null"}`);
    if (top && top.record.workPr !== record.workPr) problems.push(`${record.workOrderId} is bound to PR #${top.record.workPr}`);
    const work = await getPull(token, repo.fullName, record.workPr);
    if (!work) problems.push(`work PR #${record.workPr} does not exist`);
    for (const o of record.operations) {
      const prot = [...BUILT_IN_PROTECTED, ...policy.protected].find((g) => path.posix.matchesGlob(o.path, g));
      if (prot) problems.push(`${o.op} ${o.path} is protected by ${prot}`);
      else if (!policy.allowed.some((g) => path.posix.matchesGlob(o.path, g))) problems.push(`${o.op} ${o.path} is outside repository policy`);
    }
    lines.push(
      `**Grant:** ${record.kind === "revocation" ? "REVOCATION of " : ""}${record.workOrderId}@${record.revision} for work PR #${record.workPr} · sha256 \`${bytes ? hash(bytes).slice(0, 16) : "?"}\``,
      `**Policy revision:** ${pr.base.ref}@\`${short(policyRev)}\` · **Approvers (policy):** ${policy.approvers.map((a) => `@${a}`).join(", ")}`,
      "",
      ...(record.operations.length ? ["| Op | Path | Origin |", "|---|---|---|", ...record.operations.map((o) => `| ${o.op} | \`${o.path}\` | ${o.origin.kind}${o.origin.witness ? `:${o.origin.witness}` : ""}${o.origin.of ? ` of \`${o.origin.of}\`` : ""} |`)] : ["Grants no operations."]),
      ...(record.tests.run.length ? ["", `Run only (no write): ${record.tests.run.map((t) => `\`${t}\``).join(", ")}`] : []),
    );
  }
  if (problems.length) {
    return { conclusion: "failure", title: `Blocked: malformed grant issuance (${problems.length} problem(s))`, summary: [...lines, "", ...problems.map((p) => `- ❌ ${p}`)].join("\n"), kind: "issuance" };
  }
  return {
    conclusion: "neutral",
    title: `Grant issuance ${record!.workOrderId}@${record!.revision} for PR #${record!.workPr} — well-formed; this check is not an approval`,
    summary: [...lines, "", `It takes effect only when merged with an approving review of the final commit by a policy approver other than @${pr.user.login}.`].join("\n"),
    kind: "issuance",
  };
}

/** Decide (but do not post) the check for one PR at one policy revision. */
export async function decide(token: string, repo: RepoRef, pr: Pull, policyRev: string): Promise<Decision> {
  try {
    const raw = await readFileAt(token, repo.fullName, POLICY_FILE, policyRev);
    if (!raw) return failClosed(`no ${POLICY_FILE} on ${pr.base.ref}@${short(policyRev)}`);
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      return failClosed("contract is not valid JSON");
    }
    const listed = await listPrFiles(token, repo.fullName, pr.number);

    if ((json as { taskGrants?: unknown })?.taskGrants !== "required") {
      // Directory-only (legacy) contract: unchanged verdict; the summary says what was checked.
      const parsed = ContractSchema.safeParse(json);
      if (!parsed.success) return failClosed("contract is invalid");
      const result = evaluateScope(listed, parsed.data);
      const checked = `**Checked:** repository policy globs only (\`${POLICY_FILE}\` at ${pr.base.ref}@\`${short(policyRev)}\`, head \`${short(pr.head.sha)}\`). No task grant, work order, or approval was evaluated — this repository has not opted into taskGrants.`;
      return { conclusion: result.conclusion, title: result.title, summary: `${checked}\n\n${renderSummary(result, parsed.data)}`, kind: "legacy" };
    }

    const policy = TaskPolicyFileSchema.safeParse(json);
    if (!policy.success) return failClosed("task-scoped contract is invalid");
    const files: PrFile[] = listed.map((f) => ({ status: f.status, path: f.filename, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}) }));
    const complete = pr.changed_files === undefined || listed.length === pr.changed_files;
    const grantFiles = files.filter((f) => f.path.startsWith(".c7rl/grants/") || f.previousPath?.startsWith(".c7rl/grants/"));
    const onlyAddedGrants = grantFiles.length > 0 && grantFiles.length === files.length && files.every((f) => f.status === "added" && GRANT_FILE.test(f.path));
    if (onlyAddedGrants) return await decideIssuance(token, repo, pr, policyRev, policy.data, grantFiles);
    if (grantFiles.length) {
      return {
        conclusion: "failure",
        title: "Blocked: grant issuance must be a grant-only PR",
        summary: [`This PR touches grant files and other paths (or modifies/deletes a grant). Issue grants in a separate PR that only adds \`.c7rl/grants/<work-order>/<revision>.json\`.`, "", ...files.map((f) => `- ${f.status} \`${f.path}\``)].join("\n"),
        kind: "mixed",
      };
    }
    return await decideWork(token, repo, pr, policyRev, policy.data, files, complete, listed.length);
  } catch (e) {
    return { conclusion: "failure", title: "Unverified: evidence-unavailable — could not read GitHub evidence", summary: e instanceof Error ? e.message : String(e), kind: "fail-closed" };
  }
}

export const externalIdFor = (policyRev: string) => `c7rl:${policyRev}`;

export async function reevaluatePr(token: string, repo: RepoRef, prNumber: number, maxAttempts = 3): Promise<ReevaluateOutcome> {
  let attempts = 0;
  let last: ReevaluateOutcome = { pr: prNumber, headSha: null, policyRev: null, posted: false, attempts: 0 };
  while (attempts < maxAttempts) {
    attempts++;
    const pr = await getPull(token, repo.fullName, prNumber);
    if (!pr) return { ...last, skipped: `PR #${prNumber} not found`, attempts };
    if (pr.state !== "open") return { ...last, headSha: pr.head.sha, skipped: `PR #${prNumber} is ${pr.state}`, attempts };
    const policyRev = await branchTip(token, repo.fullName, pr.base.ref);
    if (!policyRev) return { ...last, headSha: pr.head.sha, skipped: `base ${pr.base.ref} not found`, attempts };
    const decision = await decide(token, repo, pr, policyRev);

    // Never replace a decision made against a newer policy revision on this head.
    for (const cr of await listCheckRuns(token, repo.fullName, pr.head.sha)) {
      const theirs = /^c7rl:([0-9a-f]{40})$/.exec(cr.external_id ?? "")?.[1];
      if (!theirs || theirs === policyRev) continue;
      if ((await compareStatus(token, repo.fullName, policyRev, theirs)) === "ahead") {
        return { pr: prNumber, headSha: pr.head.sha, policyRev, posted: false, skipped: `a newer decision (policy ${short(theirs)}) is already posted`, decision, attempts };
      }
    }
    await createCheckRun(token, repo.fullName, pr.head.sha, decision.conclusion, decision.title, decision.summary, externalIdFor(policyRev));
    last = { pr: prNumber, headSha: pr.head.sha, policyRev, posted: true, decision, attempts };
    // Converge: if the base moved while we decided, decide again against the new tip.
    if ((await branchTip(token, repo.fullName, pr.base.ref)) === policyRev) return last;
  }
  return last;
}

/** The work PRs named by grant files a merged issuance PR added (read at its final head). */
export async function workPrsNamedBy(token: string, repo: RepoRef, pr: Pull): Promise<number[]> {
  const out = new Set<number>();
  for (const f of await listPrFiles(token, repo.fullName, pr.number)) {
    if (f.status !== "added" || !GRANT_FILE.test(f.filename)) continue;
    const bytes = await readFileAt(token, repo.fullName, f.filename, pr.head.sha);
    const parsed = bytes ? GrantRecordSchema.safeParse(JSON.parse(bytes.toString("utf8"))) : null;
    if (parsed?.success) out.add(parsed.data.workPr);
  }
  return [...out];
}
