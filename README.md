# C7RL Gate (GitHub App)

Deterministic PR scope gate for AI coding agents. On every pull request it reads
`.c7rl/contract.json` from the **base** branch, compares the PR's changed files to the
contract's `allowed` / `protected` globs, and posts a `C7RL / scope-check` check run on the
head commit. Missing or invalid contract ⇒ failure (fail closed).

## Task grants (opt-in, default off)

A contract with `"taskGrants": "required"` and an `approvers` list switches the check from
"any file under an allowed glob" to "exactly the operations a human approved for this PR":

- A grant is `.c7rl/grants/<work-order>/<revision>.json` on the base branch. It names the
  repository id and the exact work PR, and lists `create` / `modify` / `delete` operations;
  tests listed under `tests.run` may be run, not edited.
- It is issued in a **grant-only** PR (it may add exactly one grant file and nothing else).
  That PR gets a `neutral` check — well-formed, not an approval.
- It takes effect when that issuance PR merges with an `APPROVED` latest review of its final
  commit by a policy approver who is not its author, submitted **before** the merge. The
  active revision is the newest one with that evidence: a pending or rejected amendment never
  reaches the base branch, and one merged without qualifying approval is *ineffective* (listed
  with a reason code such as `self-approval-only` or `approval-after-merge`) and changes
  nothing. An approved revocation blocks the work PR without reviving older grants. If any
  needed evidence cannot be read, the result is `Unverified: evidence-unavailable`.
- Each changed operation must be allowed by policy and granted; protected paths always win.
  Missing assignment, unverifiable approval, or an incomplete file list ⇒ `Unverified`
  (failure). A branch name or `C7RL-Work-Order:` body line only helps find the grant.
- Re-evaluation (all through `lib/reevaluate.ts#reevaluatePr`, which never replaces a check
  that reflects a newer base-branch revision): PR activity; a merged issuance PR → the work PR
  it names; a merged `.c7rl/contract.json` change → every open PR; a `pull_request_review`
  event on a merged issuance PR → the work PRs it names (handled, but the App must subscribe
  to `pull_request_review` for it to arrive).
- Operator recovery for missed or unsubscribed notifications:

  ```bash
  pnpm reconcile --repo <owner/name> --installation <id> [--pr <n> | --work-order <id>] [--base <branch>]
  ```

  It discovers the affected open PRs (one PR, the work PR of a work order, or all open PRs),
  re-decides each through the webhook's own path, and prints the check before and after.

Directory-only contracts behave as before; their summary now states that only policy globs
were checked.

- `api/webhook.ts` — webhook handler (Vercel Function)
- `lib/reevaluate.ts` — decide + post for one PR (webhook and recovery entry point)
- `lib/reconcile.ts`, `scripts/reconcile.ts` — operator reconciliation command
- `lib/grants.ts` — grant records, active-revision resolution, review evidence
- `lib/taskScope.ts` — pure per-operation evaluator (shared parity vectors)
- `lib/scopeCheck.ts` — pure directory-only verdict logic (tested)
- `lib/app.ts` — GitHub App auth + REST calls

Env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`. Optional
`GITHUB_API_URL` overrides the REST base (tests and the local end-to-end harness only).
