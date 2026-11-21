// Task-grant records and their resolution, for the Gate. Written independently of C7RL's
// resolver; both follow the same rules:
//
//  * A grant lives at .c7rl/grants/<workOrderId>/<revision>.json on the base branch.
//  * The active revision is the highest one there. Its chain must be intact (supersedes =
//    sha256 of the previous revision's bytes; repository id and work PR never change).
//  * It counts only with github-review evidence: added once by a commit of exactly one merged,
//    grant-only issuance PR (not the work PR) whose final head carries identical bytes, and
//    whose final head was APPROVED (latest review) by a policy approver other than its author.
//  * A pending amendment is not on the base branch, so it changes nothing. An approved
//    revocation revokes. Anything that cannot be established is "unverified".

import { createHash } from "node:crypto";
import { z } from "zod";
import { commitsTouching, getPull, listDirAt, listPrFiles, listReviews, pullsForCommit, readFileAt } from "./app.js";
import type { Grant } from "./taskScope.js";

export const GRANT_FILE = /^\.c7rl\/grants\/([A-Za-z0-9._-]{1,64})\/([1-9]\d{0,5})\.json$/;
export const POLICY_FILE = ".c7rl/contract.json";
export const WORK_BRANCH = /^c7rl\/wo\/([A-Za-z0-9._-]{1,64})$/;
export const BODY_HINT = /^C7RL-Work-Order:\s*([A-Za-z0-9._-]{1,64})\s*$/im;

export const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export const GrantRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["grant", "revocation"]),
    repository: z.object({ id: z.number().int().positive(), fullName: z.string().min(3) }),
    workOrderId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    workPr: z.number().int().positive(),
    revision: z.number().int().positive(),
    supersedes: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
    task: z.string(),
    operations: z.array(
      z.object({
        op: z.enum(["create", "modify", "delete"]),
        path: z.string().min(1),
        origin: z.object({ kind: z.enum(["authorization", "companion-test", "approver-added"]), witness: z.string().optional(), of: z.string().optional() }),
      }),
    ),
    tests: z.object({ run: z.array(z.string()) }),
    notRequested: z.array(z.object({ path: z.string(), reason: z.string() })),
  })
  .strict();
export type GrantRecord = z.infer<typeof GrantRecordSchema>;

export const TaskPolicyFileSchema = z.object({
  version: z.literal(1),
  allowed: z.array(z.string().min(1)).min(1),
  protected: z.array(z.string().min(1)).default([]),
  taskGrants: z.literal("required"),
  approvers: z.array(z.string().min(1)).min(1),
});
export type TaskPolicyFile = z.infer<typeof TaskPolicyFileSchema>;

/** Record → the checkpoint evaluator's grant shape. */
export function toGrant(r: GrantRecord, base: string, head: string): Grant {
  return {
    version: 1,
    repository: r.repository.fullName,
    workOrderId: r.workOrderId,
    revision: r.revision,
    supersedes: r.supersedes,
    assignment: { base, head },
    task: r.task,
    operations: r.operations,
    tests: r.tests,
    notRequested: r.notRequested,
  };
}

export function recordProblems(r: GrantRecord): string[] {
  const out: string[] = [];
  if (r.kind === "revocation" && (r.operations.length || r.tests.run.length)) out.push("a revocation grants no operations");
  if ((r.revision === 1) !== (r.supersedes === null)) out.push("revision 1 supersedes nothing; later revisions must name their predecessor");
  return out;
}

export interface Evidence {
  reviewer: string;
  issuancePr: number;
  issuanceAuthor: string;
  issuanceHead: string;
  grantSha256: string;
}

export type Resolution =
  | { state: "active" | "revoked"; record: GrantRecord; path: string; evidence: Evidence }
  | { state: "no-grant"; detail: string }
  | { state: "unverified"; label: "approval-not-verified" | "grant-malformed" | "evidence-unavailable"; detail: string };

export interface Chain {
  ok: true;
  revisions: { record: GrantRecord; bytes: Buffer; path: string }[];
}

/** Read every revision of a work order at `ref`. */
export async function readChain(token: string, repo: { id: number; fullName: string }, workOrderId: string, ref: string): Promise<Chain | { ok: false; missing: boolean; detail: string }> {
  const dir = await listDirAt(token, repo.fullName, `.c7rl/grants/${workOrderId}`, ref);
  if (dir === null) return { ok: false, missing: true, detail: `no .c7rl/grants/${workOrderId}/ at ${ref.slice(0, 12)}` };
  if (dir === "not-a-directory") return { ok: false, missing: false, detail: `.c7rl/grants/${workOrderId} is not a directory` };
  const nums: number[] = [];
  for (const e of dir) {
    const m = e.type === "file" ? GRANT_FILE.exec(e.path) : null;
    if (!m) return { ok: false, missing: false, detail: `unexpected entry ${e.path}` };
    nums.push(Number(m[2]));
  }
  nums.sort((a, b) => a - b);
  if (nums.some((n, i) => n !== i + 1)) return { ok: false, missing: false, detail: `revisions not contiguous from 1: ${nums.join(", ")}` };
  const revisions: Chain["revisions"] = [];
  for (const n of nums) {
    const p = `.c7rl/grants/${workOrderId}/${n}.json`;
    const bytes = await readFileAt(token, repo.fullName, p, ref);
    if (!bytes) return { ok: false, missing: false, detail: `${p} unreadable` };
    let record: GrantRecord;
    try {
      const parsed = GrantRecordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (!parsed.success) return { ok: false, missing: false, detail: `${p}: ${parsed.error.issues[0]?.message}` };
      record = parsed.data;
    } catch {
      return { ok: false, missing: false, detail: `${p} is not JSON` };
    }
    const problems = recordProblems(record);
    if (problems.length) return { ok: false, missing: false, detail: `${p}: ${problems[0]}` };
    const prev = revisions.at(-1);
    if (record.workOrderId !== workOrderId || record.revision !== n) return { ok: false, missing: false, detail: `${p} names ${record.workOrderId}@${record.revision}` };
    if (record.repository.id !== repo.id) return { ok: false, missing: false, detail: `${p} is bound to repository id ${record.repository.id}, not ${repo.id}` };
    if (prev && record.workPr !== prev.record.workPr) return { ok: false, missing: false, detail: `${p} moves the work PR from #${prev.record.workPr} to #${record.workPr}` };
    if (prev && record.supersedes !== `sha256:${hash(prev.bytes)}`) return { ok: false, missing: false, detail: `${p} does not supersede revision ${n - 1}'s bytes` };
    revisions.push({ record, bytes, path: p });
  }
  return { ok: true, revisions };
}

async function approvalEvidence(
  token: string,
  repo: { id: number; fullName: string },
  ref: string,
  baseRef: string,
  rev: Chain["revisions"][number],
  approvers: string[],
): Promise<Evidence | string> {
  const writes = await commitsTouching(token, repo.fullName, rev.path, ref);
  if (writes.length !== 1) return `${rev.path} was written by ${writes.length} commits; a grant is created once and never edited`;
  const merged = (await pullsForCommit(token, repo.fullName, writes[0].sha)).filter((p) => p.merged_at);
  if (merged.length !== 1) return `${rev.path} did not arrive through exactly one merged issuance PR (found ${merged.length})`;
  const issuance = await getPull(token, repo.fullName, merged[0].number);
  if (!issuance?.merged_at) return `issuance PR #${merged[0].number} is not merged`;
  if (issuance.base.ref !== baseRef) return `issuance PR #${issuance.number} merged into ${issuance.base.ref}, not ${baseRef}`;
  if (issuance.number === rev.record.workPr) return `issuance PR #${issuance.number} is the work PR itself`;
  const files = await listPrFiles(token, repo.fullName, issuance.number);
  const stray = files.filter((f) => f.status !== "added" || !GRANT_FILE.test(f.filename));
  if (stray.length || !files.some((f) => f.filename === rev.path)) return `issuance PR #${issuance.number} is not grant-only`;
  const reviewed = await readFileAt(token, repo.fullName, rev.path, issuance.head.sha);
  if (!reviewed?.equals(rev.bytes)) return `${rev.path} differs from the reviewed commit ${issuance.head.sha.slice(0, 12)}`;

  const latest = new Map<string, { state: string; commit_id: string | null }>();
  for (const r of await listReviews(token, repo.fullName, issuance.number)) {
    if (r.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.user.login, r);
  }
  for (const [who, r] of latest) if (r.state === "CHANGES_REQUESTED" && approvers.includes(who)) return `@${who} requested changes on issuance PR #${issuance.number}`;
  for (const [who, r] of latest) {
    if (r.state === "APPROVED" && r.commit_id === issuance.head.sha && approvers.includes(who) && who !== issuance.user.login) {
      return { reviewer: who, issuancePr: issuance.number, issuanceAuthor: issuance.user.login, issuanceHead: issuance.head.sha, grantSha256: hash(rev.bytes) };
    }
  }
  const seen = [...latest].map(([who, r]) => `@${who} ${r.state.toLowerCase()}${!approvers.includes(who) ? " (not an approver)" : who === issuance.user.login ? " (issuance author)" : r.commit_id !== issuance.head.sha ? " (not the final commit)" : ""}`);
  return `no qualifying approval on issuance PR #${issuance.number} at ${issuance.head.sha.slice(0, 12)}${seen.length ? `: ${seen.join("; ")}` : ""}`;
}

export async function resolveGrant(
  token: string,
  repo: { id: number; fullName: string },
  policyRev: string,
  baseRef: string,
  workOrderId: string,
  approvers: string[],
): Promise<Resolution> {
  try {
    const chain = await readChain(token, repo, workOrderId, policyRev);
    if (!chain.ok) return chain.missing ? { state: "no-grant", detail: chain.detail } : { state: "unverified", label: "grant-malformed", detail: chain.detail };
    const top = chain.revisions[chain.revisions.length - 1];
    const ev = await approvalEvidence(token, repo, policyRev, baseRef, top, approvers);
    if (typeof ev === "string") return { state: "unverified", label: "approval-not-verified", detail: `${workOrderId}@${top.record.revision}: ${ev}` };
    return { state: top.record.kind === "revocation" ? "revoked" : "active", record: top.record, path: top.path, evidence: ev };
  } catch (e) {
    const status = (e as { status?: number }).status;
    return { state: "unverified", label: "evidence-unavailable", detail: e instanceof Error ? e.message : `GitHub error ${status ?? ""}` };
  }
}
