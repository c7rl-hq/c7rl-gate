// Deterministic PR scope check for the C7RL GitHub App. Pure: same contract + same
// changed-file list ⇒ same verdict. No LLM, no network. Fails closed on a missing or
// malformed contract.

import path from "node:path";
import { z } from "zod";

export const ContractSchema = z.object({
  version: z.literal(1),
  task: z.string().min(1),
  approvedBy: z.string().min(1),
  allowed: z.array(z.string().min(1)).min(1),
  protected: z.array(z.string().min(1)).default([]),
});
export type ScopeContract = z.infer<typeof ContractSchema>;

/** Always protected, whatever the contract says: the guardrails themselves. */
export const ALWAYS_PROTECTED = [".c7rl/**", ".github/workflows/**", ".github/CODEOWNERS"];

export interface ChangedFile {
  filename: string;
  status: string; // added | modified | removed | renamed | copied | changed | unchanged
  previous_filename?: string;
}

export type FileVerdict = "allowed" | "protected" | "out-of-scope";

export interface ScopeResult {
  conclusion: "success" | "failure";
  title: string;
  files: { path: string; status: string; verdict: FileVerdict; rule?: string }[];
  violations: number;
}

const matches = (p: string, glob: string) => path.posix.matchesGlob(p, glob);

function classify(p: string, contract: ScopeContract): { verdict: FileVerdict; rule?: string } {
  for (const g of [...ALWAYS_PROTECTED, ...contract.protected]) {
    if (matches(p, g)) return { verdict: "protected", rule: g };
  }
  for (const g of contract.allowed) {
    if (matches(p, g)) return { verdict: "allowed", rule: g };
  }
  return { verdict: "out-of-scope" };
}

export function failClosed(reason: string): ScopeResult {
  return { conclusion: "failure", title: `Blocked: ${reason}`, files: [], violations: 0 };
}

export function evaluateScope(changed: ChangedFile[], contract: ScopeContract): ScopeResult {
  const files: ScopeResult["files"] = [];
  for (const f of changed) {
    // A rename touches both paths; judge the worst of the two.
    const paths = f.previous_filename ? [f.previous_filename, f.filename] : [f.filename];
    let worst: { verdict: FileVerdict; rule?: string } = { verdict: "allowed" };
    for (const p of paths) {
      const c = classify(p, contract);
      if (c.verdict !== "allowed") worst = c;
    }
    files.push({ path: f.filename, status: f.status, ...worst });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const violations = files.filter((f) => f.verdict !== "allowed").length;
  return {
    conclusion: violations === 0 ? "success" : "failure",
    title:
      violations === 0
        ? `In scope: ${files.length} file(s) match the approved contract`
        : `Blocked: ${violations} file(s) outside the approved contract`,
    files,
    violations,
  };
}

export function renderSummary(result: ScopeResult, contract?: ScopeContract): string {
  const lines: string[] = [];
  if (contract) {
    lines.push(`**Task:** ${contract.task}  `, `**Approved by:** ${contract.approvedBy}`, "");
  }
  if (result.files.length) {
    lines.push("| File | Change | Verdict | Rule |", "|---|---|---|---|");
    for (const f of result.files) {
      const icon = f.verdict === "allowed" ? "✅" : "❌";
      lines.push(`| \`${f.path}\` | ${f.status} | ${icon} ${f.verdict} | ${f.rule ? `\`${f.rule}\`` : "—"} |`);
    }
    lines.push("");
  }
  if (result.conclusion === "failure") {
    lines.push("Revert the flagged files or get the contract widened by a human approver on the base branch.");
  }
  return lines.join("\n");
}
