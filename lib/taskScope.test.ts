import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkTaskScope, GrantSchema, TaskPolicySchema, type PrFile, type Resolution } from "./taskScope.js";

// Byte-identical to C7RL's src/lib/grant/scope-parity.vectors.json; hand-authored there.
const VECTORS_SHA256 = "70df960c86c6b11bd7dec91ba4dd14e8c4524d24c2b0ad40a4d4c1066aaa7499";
const raw = readFileSync(new URL("./scope-parity.vectors.json", import.meta.url));
const v = JSON.parse(raw.toString("utf8")) as {
  policies: Record<string, unknown>;
  grants: Record<string, unknown>;
  contexts: Record<string, Resolution>;
  cases: { name: string; policy: string; grant: string | null; context: string; changes: PrFile[]; expected: { operations: Record<string, unknown>[] } & Record<string, unknown> }[];
};

describe("scope-parity vectors (Gate evaluator)", () => {
  it("is the pinned, shared vector file", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(VECTORS_SHA256);
  });

  it("every vector grant and policy passes the Gate's schemas", () => {
    for (const g of Object.values(v.grants)) expect(GrantSchema.safeParse(g).success).toBe(true);
    for (const p of Object.values(v.policies)) expect(TaskPolicySchema.safeParse(p).success).toBe(true);
  });

  for (const c of v.cases) {
    it(c.name, () => {
      const grant = c.grant ? GrantSchema.parse(v.grants[c.grant]) : null;
      const r = checkTaskScope(TaskPolicySchema.parse(v.policies[c.policy]), grant, v.contexts[c.context], c.changes);
      const { operations: expectedOps, ...expectedTop } = c.expected;
      const { operations, ...top } = r;
      expect(top).toEqual(expectedTop);
      expect(operations.map(({ explanation: _x, ...rest }) => rest)).toEqual(expectedOps);
    });
  }
});
