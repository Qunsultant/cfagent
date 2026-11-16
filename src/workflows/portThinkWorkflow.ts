/**
 * Issue #4924 — the workflow-side port: the single seam between the
 * repo's workflow classes and the SDK's ThinkWorkflow base.
 *
 * The five workflow classes (TradingTradeWorkflow, ScreenerScreenWorkflow,
 * JobPipelineWorkflow, PaymentWorkflow, CrossDomainSagaWorkflow) extend
 * this base, never ThinkWorkflow directly — the workflow-side mirror of
 * the PortThink discipline on the agent side (src/actors/thinkAdapter.ts).
 * This module is the SOLE "@cloudflare/think/workflows" import site in
 * src/ (pinned by tests/workflow_port_4924.test.ts and the
 * agent-conformance import-site pin): an SDK upgrade touches one module.
 *
 * The base carries no behavior by design (#4924 scope): it forwards the
 * SDK base's generic parameters unchanged, so each subclass keeps its
 * exact type arguments (agent type `any` per ADR 0004 W13, its params,
 * DefaultProgress, Env). Shared behavior, if any is ever identified,
 * gets its own sub-issue with grounds — it is not smuggled in here.
 *
 * Supersession: ADR 0004 W13's per-class "foundation adapter" shape is
 * superseded by this single seam (see the W13 supersession note in
 * docs/architecture/adr/0004-screener-workflows.md). W13's `any`
 * agent-type prescription and the thin-adapter shape of each class
 * stand unchanged.
 *
 * Under tests the "@cloudflare/think/workflows" specifier resolves to
 * the stub (tests/stubs/cloudflareThinkWorkflows.ts, aliased in
 * vite.config.ts), so the `instanceof ThinkWorkflow` assertions keep
 * passing through this base.
 */
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { DefaultProgress } from "agents/workflows";
import type { Think } from "../actors/thinkAdapter";

export class PortThinkWorkflow<
  AgentType extends Think = Think,
  Params = unknown,
  ProgressType = DefaultProgress,
  Env extends Cloudflare.Env = Cloudflare.Env
> extends ThinkWorkflow<AgentType, Params, ProgressType, Env> {
  // No behavior: the seam only. See the header.
}
