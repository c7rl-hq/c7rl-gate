import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash, resolveGrant } from "./grants.js";
import { reevaluatePr } from "./reevaluate.js";

const REPO = { id: 4242, fullName: "acme/app" };
const P_OLD = "a".repeat(40);
const P_NEW = "b".repeat(40);
const ISS_HEAD = "c".repeat(40);
const GRANT_COMMIT = "d".repeat(40);
const WORK_HEAD = "e".repeat(40);
const GRANT_PATH = ".c7rl/grants/wo-A/1.json";
const MERGED_AT = "2026-11-20T12:00:00Z";
const BEFORE_MERGE = "2026-11-20T11:00:00Z";

const grant = {
  version: 1,
  kind: "grant",
  repository: REPO,
  workOrderId: "wo-A",
  workPr: 1,
  revision: 1,
  supersedes: null,
  task: "t",
  operations: [{ op: "modify", path: "src/ui/title.ts", origin: { kind: "authorization", witness: "explicit-path" } }],
  tests: { run: [] },
  notRequested: [],
};
const grantBytes = Buffer.from(`${JSON.stringify(grant, null, 2)}\n`);
const policy = Buffer.from(JSON.stringify({ version: 1, allowed: ["src/ui/**"], protected: [], taskGrants: "required", approvers: ["lead"] }));

interface World {
  author: string;
  reviews: { user: { login: string }; state: string; commit_id: string; submitted_at: string }[];
  tip: string;
  checks: { external_id: string; conclusion: string; output: { title: string } }[];
  posted: { conclusion: string; external_id?: string; output: { title: string } }[];
}
let w: World;

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const file = (b: Buffer) => ({ type: "file", encoding: "base64", content: b.toString("base64") });

beforeEach(() => {
  w = { author: "dev", reviews: [{ user: { login: "lead" }, state: "APPROVED", commit_id: ISS_HEAD, submitted_at: BEFORE_MERGE }], tip: P_NEW, checks: [], posted: [] };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const ref = u.searchParams.get("ref");
    if (init?.method === "POST" && p === "/repos/acme/app/check-runs") {
      w.posted.push(JSON.parse(String(init.body)));
      return respond({}, 201);
    }
    if (p === "/repos/acme/app/contents/.c7rl/contract.json") return respond(file(policy));
    if (p === "/repos/acme/app/contents/.c7rl/grants/wo-A") return respond([{ type: "file", name: "1.json", path: GRANT_PATH }]);
    if (p === `/repos/acme/app/contents/${GRANT_PATH}` && (ref === P_NEW || ref === P_OLD || ref === ISS_HEAD)) return respond(file(grantBytes));
    if (p === "/repos/acme/app/commits") return respond([{ sha: GRANT_COMMIT }]);
    if (p === `/repos/acme/app/commits/${GRANT_COMMIT}/pulls`) return respond([{ number: 2, merged_at: MERGED_AT }]);
    if (p === "/repos/acme/app/pulls/2") return respond({ number: 2, state: "closed", merged_at: MERGED_AT, user: { login: w.author }, head: { sha: ISS_HEAD, ref: "c7rl/grant/wo-A-1", repo: null }, base: { ref: "main", sha: P_NEW } });
    if (p === "/repos/acme/app/pulls/2/files") return respond([{ filename: GRANT_PATH, status: "added" }]);
    if (p === "/repos/acme/app/pulls/2/reviews") return respond(w.reviews);
    if (p === "/repos/acme/app/pulls/1") return respond({ number: 1, state: "open", merged_at: null, changed_files: 1, body: "", user: { login: "dev" }, head: { sha: WORK_HEAD, ref: "c7rl/wo/wo-A", repo: { id: 4242, full_name: "acme/app" } }, base: { ref: "main", sha: P_OLD } });
    if (p === "/repos/acme/app/pulls/1/files") return respond([{ filename: "src/ui/title.ts", status: "modified" }]);
    if (p === "/repos/acme/app/branches/main") return respond({ commit: { sha: w.tip } });
    if (p === `/repos/acme/app/commits/${WORK_HEAD}/check-runs`) return respond({ check_runs: w.checks });
    if (p === `/repos/acme/app/compare/${P_OLD}...${P_NEW}`) return respond({ status: "ahead" });
    if (p === `/repos/acme/app/compare/${P_NEW}...${P_OLD}`) return respond({ status: "behind" });
    return respond({ message: "Not Found" }, 404);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("resolveGrant — github-review evidence", () => {
  it("activates on an approver's approval of the final issuance commit", async () => {
    const r = await resolveGrant("t", REPO, P_NEW, "main", "wo-A", ["lead"]);
    expect(r).toMatchObject({ state: "active", evidence: { reviewer: "lead", issuancePr: 2, grantSha256: hash(grantBytes) } });
  });
  it("rejects self-approval by the issuance author", async () => {
    w.author = "lead";
    expect(await resolveGrant("t", REPO, P_NEW, "main", "wo-A", ["lead"])).toMatchObject({ state: "unverified", label: "approval-not-verified" });
  });
  it("rejects an approval of an earlier commit", async () => {
    w.reviews = [{ user: { login: "lead" }, state: "APPROVED", commit_id: "f".repeat(40), submitted_at: BEFORE_MERGE }];
    expect(await resolveGrant("t", REPO, P_NEW, "main", "wo-A", ["lead"])).toMatchObject({ state: "unverified", label: "approval-not-verified" });
  });
});

describe("reevaluatePr ordering", () => {
  it("posts the decision with the policy revision it used", async () => {
    const out = await reevaluatePr("t", REPO, 1);
    expect(out.posted).toBe(true);
    expect(w.posted[0]).toMatchObject({ conclusion: "success", external_id: `c7rl:${P_NEW}` });
  });
  it("never replaces a decision made against a newer policy revision", async () => {
    w.tip = P_OLD; // this evaluation reads an older base tip
    w.checks = [{ external_id: `c7rl:${P_NEW}`, conclusion: "failure", output: { title: "newer" } }];
    const out = await reevaluatePr("t", REPO, 1);
    expect(out.posted).toBe(false);
    expect(out.skipped).toMatch(/newer decision/);
    expect(w.posted).toHaveLength(0);
  });
  it("replaces a decision made against an older policy revision", async () => {
    w.checks = [{ external_id: `c7rl:${P_OLD}`, conclusion: "success", output: { title: "older" } }];
    const out = await reevaluatePr("t", REPO, 1);
    expect(out.posted).toBe(true);
  });
});
