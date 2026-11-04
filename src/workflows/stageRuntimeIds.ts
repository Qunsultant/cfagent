/**
 * Issue #3191 - runtime id declarations shared by the server flows and the
 * workflow catalog.
 *
 * Why this file exists (and why it holds no imports): the workflow catalog
 * is rendered in the BROWSER, so anything it imports ends up in the client
 * bundle. Importing `trading-trade-workflow` or the options route directly
 * from the catalog dragged the agents SDK (`cloudflare:workers`) into the
 * frontend build and broke it. These constants are therefore pure data with
 * zero dependencies: the server modules re-export them so there is one
 * declaration, and the pins scan the flow sources to prove the data still
 * matches the code.
 */

/**
 * The payment workflow's real `step.do` ids, in flow order.
 * Pinned against src/workflows/paymentWorkflowFlow.ts by
 * tests/payment_saga_stage_ids_3191.test.ts.
 */
export const PAYMENT_STEP_IDS = [
  "gate-check",
  "record-coverage-required",
  "consume-coverage",
  "record-checkout",
  "record-approval",
  "record-expiry",
  "record-rejection",
  "confirm-paid",
  "record-payment",
  "record-native-ledger",
  "record-usage",
  "issue-failure-credit",
  "start-screener",
] as const;

export type PaymentStepId = (typeof PAYMENT_STEP_IDS)[number];

/**
 * The saga workflow's real `step.do` ids (its polling waits are not steps).
 * Pinned against src/workflows/sagaWorkflowFlow.ts by
 * tests/payment_saga_stage_ids_3191.test.ts.
 */
export const SAGA_STEP_IDS = [
  "record-audit-saga-started",
  "start-payment-leg",
  "record-audit-payment-started",
  "record-audit-screen-completed",
  "compensate-failed-screen",
] as const;

export type SagaStepId = (typeof SAGA_STEP_IDS)[number];

/**
 * The trading leg's real durable step ids: the approval wait
 * (`step.waitForEvent("await-approval")`) and the settle (`step.do("settle-trade")`).
 * There is no fill or reconcile step - settlement happens inside `settle-trade`.
 * Pinned by tests/options_trading_stage_ids_3191.test.ts.
 */
export const TRADE_APPROVAL_STEP_IDS = ["await-approval", "settle-trade"] as const;

export type TradeApprovalStepId = (typeof TRADE_APPROVAL_STEP_IDS)[number];

/**
 * The options screen's real phases. Options is not a durable workflow: the
 * request handler IS the runtime, so `step.do` ids would be invention. Each
 * phase is pinned to a real call in src/agents/routes/etradeOptionsScreen.ts.
 */
export const OPTIONS_SCREEN_PHASES = ["provider-screen", "report-pipeline", "deliver"] as const;

export type OptionsScreenPhase = (typeof OPTIONS_SCREEN_PHASES)[number];
