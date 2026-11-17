// Minimal GitHub App client: webhook signature check, app JWT, installation token, and
// the three REST calls the scope check needs. node:crypto only, no SDK.

import { createHmac, createSign, timingSafeEqual } from "node:crypto";

const API = "https://api.github.com";

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
  const res = await fetch(url.startsWith("http") ? url : API + url, {
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

export async function createCheckRun(
  token: string,
  repo: string,
  headSha: string,
  conclusion: "success" | "failure",
  title: string,
  summary: string,
) {
  await gh(token, `/repos/${repo}/check-runs`, {
    method: "POST",
    body: JSON.stringify({
      name: "C7RL / scope-check",
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: { title: title.slice(0, 255), summary: summary.slice(0, 65000) },
    }),
  });
}
