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
  commit by a policy approver who is not its author. A pending amendment changes nothing; an
  approved amendment replaces it; an approved revocation blocks the work PR.
- Each changed operation must be allowed by policy and granted; protected paths always win.
  Missing assignment, unverifiable approval, or an incomplete file list ⇒ `Unverified`
  (failure). A branch name or `C7RL-Work-Order:` body line only helps find the grant.
- After an issuance PR merges, the work PR it names is re-evaluated at its current head.
  `lib/reevaluate.ts#reevaluatePr` is the same operation for recovering a missed delivery;
  it never replaces a check that reflects a newer base-branch revision.

Directory-only contracts behave as before; their summary now states that only policy globs
were checked.

- `api/webhook.ts` — webhook handler (Vercel Function)
- `lib/reevaluate.ts` — decide + post for one PR (webhook and recovery entry point)
- `lib/grants.ts` — grant records, active-revision resolution, review evidence
- `lib/taskScope.ts` — pure per-operation evaluator (shared parity vectors)
- `lib/scopeCheck.ts` — pure directory-only verdict logic (tested)
- `lib/app.ts` — GitHub App auth + REST calls

Env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`. Optional
`GITHUB_API_URL` overrides the REST base (tests and the local end-to-end harness only).
