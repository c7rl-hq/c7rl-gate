# C7RL Change Guard (GitHub App)

Deterministic PR scope gate for AI coding agents. On every pull request it reads
`.c7rl/contract.json` from the **base** branch, compares the PR's changed files to the
contract's `allowed` / `protected` globs, and posts a `C7RL / scope-check` check run on the
head commit. Missing or invalid contract ⇒ failure (fail closed).

- `api/webhook.ts` — webhook handler (Vercel Function)
- `lib/scopeCheck.ts` — pure verdict logic (tested)
- `lib/app.ts` — GitHub App auth + REST calls

Env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`.
