// Task-grant scope check for the C7RL Gate (checkpoint 1 of the local/Gate parity plan).
//
// Pure: same policy + grant + resolution + PR file list ⇒ same per-operation decisions.
// Written independently of C7RL's evaluator; both are held to the hand-authored
// `scope-parity.vectors.json`. Not wired into the webhook yet.

import path from "node:path";
import { z } from "zod";

const Op = z.enum(["create", "modify", "delete"]);

export const GrantSchema = z.object({
  version: z.literal(1),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  workOrderId: z.string().min(1),
  revision: z.number().int().positive(),
  supersedes: z.string().nullable(),
  assignment: z.object({ base: z.string().min(1), head: z.string().min(1) }),
  task: z.string().min(1),
  operations: z.array(
    z.object({
      op: Op,
      path: z.string().min(1),
      origin: z.object({
        kind: z.enum(["authorization", "companion-test", "approver-added"]),
        witness: z.string().optional(),
        of: z.string().optional(),
      }),
    }),
  ),
  tests: z.object({ run: z.array(z.string()) }),
  notRequested: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type Grant = z.infer<typeof GrantSchema>;

export const TaskPolicySchema = z.object({
  allowed: z.array(z.string().min(1)).min(1),
  protected: z.array(z.string().min(1)).default([]),
  taskGrants: z.literal("required").optional(),
  approvers: z.array(z.string()).optional(),
});
export type TaskPolicy = z.infer<typeof TaskPolicySchema>;

export interface Resolution {
  assignment: "exact" | "provisional" | "missing";
  policyRevision: "current" | "historical";
  approval: { kind: "github-review"; status: "verified" | "not-verified"; reviewer: string | null; issuancePr: number } | null;
  changeList: "complete" | "incomplete";
}

/** GitHub's PR-files entry, plus the git `deleted` / `untracked` spellings for parity. */
export interface PrFile {
  status: string;
  path: string;
  previousPath?: string;
}

export interface OpVerdict {
  op: z.infer<typeof Op>;
  path: string;
  decision: "allow" | "deny" | "undetermined";
  reason: string;
  policyRule: string | null;
  grantEntry: string | null;
  explanation: string;
}

export interface TaskScopeResult {
  mode: "task-scoped" | "policy-only";
  scope: "pass" | "fail" | "unverified" | "preview";
  previewOf: "pass" | "fail" | null;
  labels: string[];
  grant: string | null;
  approval: "github-review" | null;
  operations: OpVerdict[];
}

const GUARDRAILS = [".c7rl/**", ".github/workflows/**", ".github/CODEOWNERS"];

const STATUS_TO_OP: Record<string, "create" | "modify" | "delete"> = {
  added: "create",
  untracked: "create",
  copied: "create",
  modified: "modify",
  changed: "modify",
  removed: "delete",
  deleted: "delete",
};

function toOperations(files: PrFile[]): { op: "create" | "modify" | "delete"; path: string }[] {
  return files.flatMap((f) => {
    if (f.status === "renamed") {
      if (!f.previousPath) throw new Error(`renamed ${f.path} lacks previous path`);
      return [
        { op: "delete" as const, path: f.previousPath },
        { op: "create" as const, path: f.path },
      ];
    }
    const op = STATUS_TO_OP[f.status];
    if (!op) throw new Error(`unknown change status ${f.status} for ${f.path}`);
    return [{ op, path: f.path }];
  });
}

const firstMatch = (p: string, globs: string[]) => globs.find((g) => path.posix.matchesGlob(p, g)) ?? null;

export function checkTaskScope(policy: TaskPolicy, grant: Grant | null, res: Resolution, files: PrFile[]): TaskScopeResult {
  const ops = toOperations(files);

  // Stage 1 — repository policy, the same for every mode.
  const staged = ops.map(({ op, path: p }) => {
    const prot = firstMatch(p, [...GUARDRAILS, ...policy.protected]);
    if (prot) return { op, path: p, verdict: "deny" as const, reason: "protected", rule: prot };
    const allow = firstMatch(p, policy.allowed);
    if (!allow) return { op, path: p, verdict: "deny" as const, reason: "outside-repository-policy", rule: null };
    return { op, path: p, verdict: "policy-ok" as const, reason: "", rule: allow };
  });

  const say = (v: Omit<OpVerdict, "explanation">, who: string | null): OpVerdict => {
    const rule = v.policyRule ?? "(none)";
    const text: Record<string, string> = {
      granted: `allowed: policy ${rule} and ${who} grants ${v.op} (${v.grantEntry})`,
      "repository-policy-only": `allowed by policy ${rule}; task grant not checked`,
      protected: `denied: protected by ${rule}, which overrides any grant`,
      "outside-repository-policy": "denied: no allowed policy glob matches",
      "run-only-test": `denied: ${who} lists this test to run, not to edit`,
      "operation-not-granted": `denied: ${who} grants another operation on this path`,
      "not-in-task-grant": `denied: policy ${rule} allows it but ${who} does not grant ${v.op}`,
      "no-verified-grant": `undetermined: policy ${rule} allows it; no verified task grant`,
    };
    return { ...v, explanation: `${v.path} — ${text[v.reason]}` };
  };

  if (policy.taskGrants !== "required") {
    const operations = staged.map((s) =>
      say({ op: s.op, path: s.path, decision: s.verdict === "deny" ? "deny" : "allow", reason: s.verdict === "deny" ? s.reason : "repository-policy-only", policyRule: s.rule, grantEntry: null }, null),
    );
    const failed = operations.some((o) => o.decision === "deny");
    return { mode: "policy-only", scope: failed ? "fail" : "pass", previewOf: null, labels: ["no-task-grant-checked"], grant: null, approval: null, operations };
  }

  // Stage 2 — is there a verified grant to judge against?
  let missing: string | null = null;
  if (res.assignment === "missing") missing = "no-assignment";
  else if (!grant) missing = "no-grant";
  else if (!res.approval || res.approval.status !== "verified") missing = "approval-not-verified";
  if (missing || !grant) {
    const operations = staged.map((s) =>
      say({ op: s.op, path: s.path, decision: s.verdict === "deny" ? "deny" : "undetermined", reason: s.verdict === "deny" ? s.reason : "no-verified-grant", policyRule: s.rule, grantEntry: null }, null),
    );
    return { mode: "task-scoped", scope: "unverified", previewOf: null, labels: [missing ?? "no-grant"], grant: null, approval: null, operations };
  }

  // Stage 3 — the grant, by exact (operation, path).
  const who = `${grant.workOrderId}@${grant.revision}`;
  const operations = staged.map((s) => {
    if (s.verdict === "deny") return say({ op: s.op, path: s.path, decision: "deny", reason: s.reason, policyRule: s.rule, grantEntry: null }, who);
    const hit = grant.operations.find((g) => g.path === s.path && g.op === s.op);
    if (hit) {
      const o = hit.origin;
      const entry = o.kind === "authorization" ? `authorization:${o.witness}` : o.kind === "companion-test" ? `companion-test:${o.of}` : o.kind;
      return say({ op: s.op, path: s.path, decision: "allow", reason: "granted", policyRule: s.rule, grantEntry: entry }, who);
    }
    const reason = grant.tests.run.includes(s.path)
      ? "run-only-test"
      : grant.operations.some((g) => g.path === s.path)
        ? "operation-not-granted"
        : "not-in-task-grant";
    return say({ op: s.op, path: s.path, decision: "deny", reason, policyRule: s.rule, grantEntry: null }, who);
  });

  const outcome: "pass" | "fail" = operations.every((o) => o.decision === "allow") ? "pass" : "fail";
  const base = { mode: "task-scoped" as const, grant: who, approval: "github-review" as const, operations };
  if (res.changeList === "incomplete") return { ...base, scope: "unverified", previewOf: null, labels: ["incomplete-change-list"] };
  const labels: string[] = [];
  if (res.assignment === "provisional") labels.push("provisional-assignment");
  if (res.policyRevision === "historical") labels.push("historical-policy-revision");
  return labels.length ? { ...base, scope: "preview", previewOf: outcome, labels } : { ...base, scope: outcome, previewOf: null, labels };
}
