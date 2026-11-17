import { describe, expect, it } from "vitest";
import { ContractSchema, evaluateScope } from "./scopeCheck.js";

const contract = ContractSchema.parse({
  version: 1,
  task: "Add password reset",
  approvedBy: "eng-lead",
  allowed: ["src/auth/**", "tests/auth/**"],
  protected: ["src/payments/**"],
});

describe("evaluateScope", () => {
  it("passes when every file is in scope", () => {
    const r = evaluateScope([{ filename: "src/auth/reset.ts", status: "added" }], contract);
    expect(r.conclusion).toBe("success");
  });

  it("blocks a protected file even if it also matches allowed", () => {
    const r = evaluateScope([{ filename: "src/payments/billing.ts", status: "modified" }], contract);
    expect(r.conclusion).toBe("failure");
    expect(r.files[0].verdict).toBe("protected");
  });

  it("blocks files outside allowed", () => {
    const r = evaluateScope([{ filename: "README.md", status: "modified" }], contract);
    expect(r.files[0].verdict).toBe("out-of-scope");
  });

  it("blocks edits to the contract and workflows", () => {
    const r = evaluateScope(
      [
        { filename: ".c7rl/contract.json", status: "modified" },
        { filename: ".github/workflows/ci.yml", status: "removed" },
      ],
      contract,
    );
    expect(r.violations).toBe(2);
  });

  it("judges both sides of a rename", () => {
    const r = evaluateScope(
      [{ filename: "src/auth/billing.ts", previous_filename: "src/payments/billing.ts", status: "renamed" }],
      contract,
    );
    expect(r.conclusion).toBe("failure");
  });
});
