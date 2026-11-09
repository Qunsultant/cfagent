# Deploy failure #3789 — wrangler rejects `image` on Durable Object-managed containers

Parent incident: #3781. Slice issue: #3789. Fix PR: (see #3789).

## What broke

Deploy NextGenTP ("Build & Deploy [PROD]") failed on every main commit from
bb24be82 ("feat(3779): SandboxAgent container enablement", #CAIO-quns,
2026-11-08T15:29:19Z) through 807a85a1 (#3784 merge). The failing step was
"Ensure Vectorize index for VectorMemory (PR #6)" (deploy.yml:132) — 2s,
exit 1, annotation only "Process completed with exit code 1." All earlier
steps succeeded; "Deploy Worker" and later steps were skipped. Production
was not updated, so the #3782 and #3784 fixes sat merged but undeployed.

## Named error (proven by local reproduction)

With the repo's wrangler 4.156.0, `npx wrangler deploy --dry-run` against
current main fails in ~2s with:

```
Processing wrangler.jsonc configuration:
    - Unsupported fields for Durable Object-managed Containers in containers:
      "image". Only "name", "class_name", "scheduling_policy", "images",
      "observability", "ssh", "authorized_keys", and restricted "unsafe"
      settings are supported.
```

## Root cause

bb24be82 added a top-level `containers` entry for SandboxAgent:

```jsonc
"containers": [
  {
    "class_name": "SandboxAgent",
    "image": "cloudflare/debian-trixie",
    "scheduling_policy": "durable_object"
  }
]
```

Wrangler 4.156.0 rejects the `image` field on a containers entry whose
`scheduling_policy` is `"durable_object"`. The `containers` key itself is
valid in 4.156.0 (it is in the bundled config schema); only the `image`
field on a DO-managed entry is rejected. Because config processing fails
for EVERY wrangler command, the Deploy job died at its first wrangler
invocation — the Vectorize step, whose KV-namespace predecessor uses raw
curl, not wrangler. `vectorize get` failed (stderr suppressed), the
`vectorize create` fallback failed the same way, exit 1. Nothing in
bb24be82 touched Vectorize, and no deploy.yml or package.json change was
involved — the breakage is purely the new config field.

## Fix

Remove the `"image"` field from the `containers` entry in wrangler.jsonc.
Nothing else changes. The capability is preserved, not deleted:

- The container binding stays: `class_name: "SandboxAgent"` +
  `scheduling_policy: "durable_object"`, so `this.ctx.container` is still
  bound in SandboxAgent.
- The image is supplied at runtime, not by config:
  `ETradeSandboxService.runCommand` calls
  `container.start({ image: "cloudflare/debian-trixie", entrypoint:
  ["sleep", "infinity"], enableInternet: false })`
  (`src/services/sandboxAgent.ts`). The config field carried nothing the
  code uses.

The `images` map (named, digest-pinned images in the account registry)
was not used instead: the code never reads `ctx.container.images`, and
`cloudflare/debian-trixie` is a public image tag, not a digest-pinned
image in the account's managed registry.

## Rule (pinned by test)

`tests/wrangler_containers_3789.test.ts` pins three things:

1. The SandboxAgent DO-managed entry exists (the capability cannot be
   silently deleted to "fix" a deploy).
2. No DO-managed containers entry carries an `image` field.
3. DO-managed entries use only the field set wrangler 4.156.0 names as
   supported (`name`, `class_name`, `scheduling_policy`, `images`,
   `observability`, `ssh`, `authorized_keys`, `unsafe`).

When wrangler is upgraded, re-check the supported set against the new
version's error/schema before adding a field to a DO-managed entry.

## Verification

- Local reproduction on current main: `wrangler deploy --dry-run` exit 1
  with the named error (~2s).
- After the fix: `wrangler deploy --dry-run` exit 0; output lists
  `SandboxAgent (durable_object)` among available containers.
- Test evidence: Red on pristine main (the test fails while the `image`
  field is present), Green on the fix branch; `tsc --noEmit` clean.
- Delivery proof: green Deploy + Post-deploy QA on the merge head. That
  deploy also carries the #3782 and #3784 fixes to production; their
  production live checks (sweep tick, stuck-alert firing) become provable
  only after it.
