// Minimal GitHub App client: webhook signature check, app JWT, installation token, and
// the three REST calls the scope check needs. node:crypto only, no SDK.

import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/** GitHub REST base. Overridable so tests and the local end-to-end harness can substitute
 *  the transport; production leaves it unset. */
const api = (): string => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function verifySignature(body: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", env("GITHUB_WEBHOOK_SECRET")).update(body).digest("hex"),
  );
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env("GITHUB_APP_ID") }));
  const key = env("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64url(sig)}`;
}

async function gh<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url.startsWith("http") ? url : api() + url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "c7rl-app",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} ${init.method ?? "GET"} ${url}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export async function installationToken(installationId: number): Promise<string> {
  const r = await gh<{ token: string }>(appJwt(), `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
  });
  return r.token;
}

/** Contract is read from the BASE ref, which the PR author cannot change in the PR. */
export async function readContractAtRef(token: string, repo: string, ref: string): Promise<string | null> {
  try {
    const r = await gh<{ content: string; encoding: string }>(
      token,
      `/repos/${repo}/contents/.c7rl/contract.json?ref=${encodeURIComponent(ref)}`,
    );
    return Buffer.from(r.content, r.encoding as BufferEncoding).toString("utf8");
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

export async function listPrFiles(token: string, repo: string, pr: number) {
  const out: { filename: string; status: string; previous_filename?: string }[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await gh<typeof out>(token, `/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  throw new Error("PR has more than 3000 files; refusing to judge a truncated list");
}

export const CHECK_NAME = "C7RL / scope-check";

export async function createCheckRun(
  token: string,
  repo: string,
  headSha: string,
  conclusion: "success" | "failure" | "neutral",
  title: string,
  summary: string,
  externalId?: string,
) {
  await gh(token, `/repos/${repo}/check-runs`, {
    method: "POST",
    body: JSON.stringify({
      name: CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      ...(externalId ? { external_id: externalId } : {}),
      output: { title: title.slice(0, 255), summary: summary.slice(0, 65000) },
    }),
  });
}

/** GET that maps 404 to null; any other failure throws (with `.status`). */
export async function ghGet<T>(token: string, url: string): Promise<T | null> {
  try {
    return await gh<T>(token, url);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** A file's bytes at a ref (branch name or commit sha), or null when absent. */
export async function readFileAt(token: string, repo: string, filePath: string, ref: string): Promise<Buffer | null> {
  const r = await ghGet<{ type?: string; content?: string; encoding?: string } | unknown[]>(
    token,
    `/repos/${repo}/contents/${encPath(filePath)}?ref=${encodeURIComponent(ref)}`,
  );
  if (!r || Array.isArray(r) || r.type !== "file" || typeof r.content !== "string") return null;
  return Buffer.from(r.content, (r.encoding ?? "base64") as BufferEncoding);
}

export async function listDirAt(token: string, repo: string, dirPath: string, ref: string) {
  const r = await ghGet<{ type: string; name: string; path: string }[] | { type: string }>(
    token,
    `/repos/${repo}/contents/${encPath(dirPath)}?ref=${encodeURIComponent(ref)}`,
  );
  if (r === null) return null;
  return Array.isArray(r) ? r : "not-a-directory";
}

export async function branchTip(token: string, repo: string, branch: string): Promise<string | null> {
  const r = await ghGet<{ commit: { sha: string } }>(token, `/repos/${repo}/branches/${encPath(branch)}`);
  return r?.commit.sha ?? null;
}

export interface Pull {
  number: number;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  changed_files?: number;
  body?: string | null;
  user: { login: string };
  head: { sha: string; ref: string; repo: { id: number; full_name: string } | null };
  base: { ref: string; sha: string };
}

export const getPull = (token: string, repo: string, n: number) => ghGet<Pull>(token, `/repos/${repo}/pulls/${n}`);

export async function commitsTouching(token: string, repo: string, filePath: string, ref: string) {
  return (await ghGet<{ sha: string }[]>(token, `/repos/${repo}/commits?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(ref)}&per_page=100`)) ?? [];
}

export async function pullsForCommit(token: string, repo: string, sha: string) {
  return (await ghGet<Pull[]>(token, `/repos/${repo}/commits/${sha}/pulls`)) ?? [];
}

export async function listReviews(token: string, repo: string, pr: number) {
  return (await ghGet<{ user: { login: string } | null; state: string; commit_id: string | null }[]>(token, `/repos/${repo}/pulls/${pr}/reviews?per_page=100`)) ?? [];
}

export async function listCheckRuns(token: string, repo: string, sha: string) {
  const r = await ghGet<{ check_runs: { id: number; external_id: string | null; conclusion: string | null; output: { title: string | null } }[] }>(
    token,
    `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`,
  );
  return r?.check_runs ?? [];
}

/** GitHub compare status of head relative to base: ahead | behind | identical | diverged. */
export async function compareStatus(token: string, repo: string, base: string, head: string): Promise<string | null> {
  const r = await ghGet<{ status: string }>(token, `/repos/${repo}/compare/${base}...${head}`);
  return r?.status ?? null;
}
