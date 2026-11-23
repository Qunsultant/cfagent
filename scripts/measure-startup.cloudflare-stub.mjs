/**
 * scripts/measure-startup.cloudflare-stub.mjs — workerd API stub (#6281).
 *
 * The worker bundle imports `cloudflare:workers` / `cloudflare:email`,
 * which do not exist in plain Node. The harness aliases those specifiers to
 * this stub at esbuild time so the bundle imports in Node for the import-CPU
 * measurement. The stub is measurement-only: it exports constructable
 * classes with the same names the bundle imports (DurableObject, RpcTarget,
 * WorkerEntrypoint, WorkflowEntrypoint, EmailMessage, exports). It is NEVER
 * part of the deploy bundle — the budget is enforced on the wrangler
 * dry-run bundle, which keeps the real externals.
 */
export class DurableObject {
  constructor(_ctx, _env) {}
}

export class RpcTarget {
  constructor() {}
}

export class WorkerEntrypoint {
  constructor(_ctx, _env) {}
}

export class WorkflowEntrypoint {
  constructor(_ctx, _env) {}
}

export class EmailMessage {
  constructor(_from, _to, _raw) {}
}

export const exports = {};
