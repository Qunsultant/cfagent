/**
 * S7 (consolidation, umbrella #958): THE payload-construction path
 * for screening schedules in the client — one builder per kind,
 * used by the one schedule UI's create/update submit and by the
 * hero Run Now. Since S8 the StrategyDiscoveryPanel's "schedule
 * this view" capture (buildDiscoveryCaptureSubmission) builds here
 * too — no client code hand-assembles a schedule create body.
 * Before S7 the same construction lived inline in the
 * options manager's submit handler while the nav panel's create form
 * posted raw user-typed JSON for the same callbacks — two builders
 * for one kind. The nav form is gone; this module is the only path.
 *
 * The construction below is the legacy manager's, extracted
 * verbatim (same field order, same conditional keys, same error
 * strings) and golden-pinned byte-for-byte against bodies the
 * legacy component submitted (tests/schedule_ui_s7.test.tsx).
 *
 * New since the extraction: before a body is submitted, the payload
 * is validated client-side through the S1 schedule criteria schemas
 * (src/trading/screeningSchemas.ts) — the same strict schemas the
 * create route validates with server-side, so a mis-shaped payload
 * fails in the form with the field named instead of at the route.
 */
import {
  marketScreenScheduleCriteriaSchema,
  optionsAnalysisScheduleCriteriaSchema,
  strategyDiscoveryScheduleCriteriaSchema,
} from "../../trading";
import type { ScheduleFormState } from "./types";
import { JOB_CALLBACKS } from "./systemJobs";
import { buildDiscoveryRequests } from "./discoveryRequests";
import { buildProfileDerivedPayload } from "./profileDerived";
import { buildNoViewPayload } from "./noView";

/** Comma-separated tickers → the payload's symbols array (the legacy
 *  form's parse: trimmed, uppercased, blanks dropped). */
export function parseSymbolsText(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

const SCHEDULE_CRITERIA_SCHEMAS = {
  autonomousMarketScreen: marketScreenScheduleCriteriaSchema,
  autonomousOptionsAnalysis: optionsAnalysisScheduleCriteriaSchema,
  autonomousStrategyDiscovery: strategyDiscoveryScheduleCriteriaSchema,
} as const;

/**
 * Validate a built schedule payload against the S1 criteria schema
 * for its callback, mirroring the server assembly in
 * buildSchedulePayload: maxItems is range-checked separately (the
 * route's rule and message), and identity fields (environment,
 * userLogin — stamped from the caller's context by the server) are
 * not criteria. Returns a user-facing error naming the field, or
 * null when the payload is schema-clean. Non-screening callbacks
 * are out of this module's scope and pass.
 */
export function validateScheduleCriteriaClient(
  callback: string,
  payload: Record<string, any>
): string | null {
  const schema =
    SCHEDULE_CRITERIA_SCHEMAS[callback as keyof typeof SCHEDULE_CRITERIA_SCHEMAS];
  if (!schema) return null;
  const { maxItems, environment, userLogin, ...criteria } = payload ?? {};
  if (
    maxItems !== undefined &&
    (typeof maxItems !== "number" ||
      !Number.isSafeInteger(maxItems) ||
      maxItems < 0 ||
      maxItems > 10000)
  ) {
    return "maxItems must be a whole number from 0 to 10000.";
  }
  const result = schema.safeParse(criteria);
  if (result.success) return null;
  // Same rendering as screeningSchemas' formatIssues ("schedule payload").
  const parts = result.error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.join(".");
    const prefix = path ? `${path}: ` : "";
    if (issue.code === "unrecognized_keys") {
      const keys = (issue as unknown as { keys?: string[] }).keys ?? [];
      return `${prefix}unknown field(s): ${keys.join(", ")}`;
    }
    return `${prefix}${issue.message}`;
  });
  return `Invalid schedule payload: ${parts.join("; ")}`;
}

/**
 * Build the POST /api/schedules/create body for the form state —
 * { requestBody } ready to submit, or { error } with the first
 * problem found (the kind builders' own checks first, then the S1
 * schema validation). Used for both create and update (update
 * cancels the prior schedule first, in the caller).
 */
export function buildScheduleSubmission(
  form: ScheduleFormState
): { requestBody: Record<string, any> } | { error: string } {
  let callback: string;
  let payload: Record<string, any>;
  if (form.jobType === "strategyDiscovery" && form.discoveryInputModel === "no-view") {
    // No-view discovery (issue #534): constraint sets only — no
    // thesis, no target, nothing that could be read as a view.
    const built = buildNoViewPayload(form.noViewDraft);
    if ("error" in built) return { error: built.error };
    callback = JOB_CALLBACKS.strategyDiscovery;
    payload = { ...built.payload, ...discoveryDeliveryFields(form), environment: form.environment, trigger: "scheduled" };
  } else if (
    form.jobType === "strategyDiscovery" &&
    form.discoveryInputModel === "profile-derived"
  ) {
    // Profile-derived discovery (issue #533): a symbol set + a
    // Strategy Profile; no target is stored.
    const built = buildProfileDerivedPayload({
      source: form.derivedSource,
      symbolsText: form.derivedSymbolsText,
      watchlistName: form.derivedWatchlistName,
      profileId: form.derivedProfileId,
    });
    if ("error" in built) return { error: built.error };
    callback = JOB_CALLBACKS.strategyDiscovery;
    payload = { ...built.payload, ...discoveryDeliveryFields(form), environment: form.environment, trigger: "scheduled" };
  } else if (form.jobType === "strategyDiscovery") {
    // Saved-request discovery (issue #126): complete saved
    // StrategyRequests, re-run verbatim.
    const built = buildDiscoveryRequests(form.discoveryRequests);
    if ("error" in built) return { error: built.error };
    callback = JOB_CALLBACKS.strategyDiscovery;
    payload = { requests: built.requests, ...discoveryDeliveryFields(form), environment: form.environment, trigger: "scheduled" };
  } else {
    const symbols = parseSymbolsText(form.targetSymbols);
    if (!Number.isInteger(form.maxItems) || form.maxItems < 0) {
      return { error: "Max items must be a whole number greater than or equal to zero." };
    }
    if (!form.targetUniverse && symbols.length === 0) {
      return { error: "Choose a universe or enter at least one symbol." };
    }
    if (form.jobType === "marketScreen" && !form.targetUniverse) {
      return { error: "Stock screens require one live universe." };
    }

    if (form.jobType === "marketScreen") {
      callback = JOB_CALLBACKS.marketScreen;
      const customFilters: Record<string, any> = {};
      if (form.minPrice.trim()) customFilters.minPrice = Number(form.minPrice);
      if (form.maxPrice.trim()) customFilters.maxPrice = Number(form.maxPrice);
      if (form.minMarketCap.trim()) customFilters.minMarketCap = Number(form.minMarketCap);
      if (form.maxPe.trim()) customFilters.maxPeRatio = Number(form.maxPe);
      if (form.trendFilter.trim()) customFilters.momentum = form.trendFilter;

      payload = {
        ...(form.targetUniverse ? { universe: form.targetUniverse } : { symbols }),
        maxItems: form.maxItems,
        sector: form.sector || "ALL",
        trigger: "scheduled",
        pushToSlack: form.pushToSlack,
        slackChannel: form.pushToSlack ? form.slackChannel : undefined,
        emailTo: form.emailTo.trim() || undefined,
        webhookUrl: form.webhookUrl.trim() || undefined,
        // Issue #1499 (#940-E): a chosen preset replaces the custom
        // thresholds — the run resolves the preset's CURRENT criteria at
        // run time, so the form never freezes criteria into the payload
        // alongside the preset id.
        ...(form.presetId
          ? { presetId: form.presetId }
          : Object.keys(customFilters).length > 0
            ? { filters: customFilters }
            : {}),
      };
    } else {
      callback = JOB_CALLBACKS.optionsAnalysis;
      payload = {
        ...(form.targetUniverse ? { universe: form.targetUniverse } : { symbols }),
        maxItems: form.maxItems,
        thesis: form.thesis,
        riskProfile: form.riskProfile,
        // Issue #2600: schedule strategy-choice controls, when set
        // (absent fields keep the golden-pinned legacy bodies intact).
        ...(form.optionsStrategyMode ? { strategyMode: form.optionsStrategyMode } : {}),
        ...(form.optionsFarDated !== undefined ? { farDated: form.optionsFarDated } : {}),
        ...(form.optionsCandidateLimit !== undefined ? { candidateLimit: form.optionsCandidateLimit } : {}),
        pushToSlack: form.pushToSlack,
        slackChannel: form.pushToSlack ? form.slackChannel : undefined,
        emailTo: form.emailTo.trim() || undefined,
        webhookUrl: form.webhookUrl.trim() || undefined,
        environment: form.environment,
        trigger: "scheduled",
        // Issue #5189: the schedule's own run target, only when chosen. An
        // absent field keeps the golden-pinned legacy payload byte-identical.
        ...(form.brokerId ? { brokerId: form.brokerId } : {}),
        ...(form.mode ? { mode: form.mode } : {}),
        // Issue #5099 (F2): the account's asset class rides with the
        // account id, so the display and the payload agree — the
        // server resolves the run target from {accountType, accountId}
        // at creation (schedules.ts). Only in the options branch: this
        // is the options account. Absent when no account is chosen.
        ...((form.accountId ?? "").trim()
          ? { accountType: "options", accountId: (form.accountId ?? "").trim() }
          : {}),
      };
    }
  }

  // S1 schemas, client-side: a payload the route would 400 never
  // leaves the form.
  const validationError = validateScheduleCriteriaClient(callback, payload);
  if (validationError) return { error: validationError };

  const requestBody: Record<string, any> = {
    callback,
    scheduleType: form.scheduleType,
    payload,
  };

  const cadenceError = applyScheduleCadence(requestBody, form);
  if (cadenceError) return { error: cadenceError };

  return { requestBody };
}

/**
 * Consolidation #1236 (discovery notifications): the per-task
 * delivery recipients a discovery schedule payload carries — exactly
 * emailTo/slackChannel/webhookUrl (the discovery schema accepts
 * these three, NOT pushToSlack). slackChannel is gated by the push
 * checkbox, exactly as the marketScreen/optionsAnalysis branches
 * gate it; empty fields are omitted, never sent as empty strings.
 */
function discoveryDeliveryFields(form: ScheduleFormState): Record<string, string> {
  const fields: Record<string, string> = {};
  if (form.pushToSlack && form.slackChannel.trim()) fields.slackChannel = form.slackChannel.trim();
  if (form.emailTo.trim()) fields.emailTo = form.emailTo.trim();
  if (form.webhookUrl.trim()) fields.webhookUrl = form.webhookUrl.trim();
  return fields;
}

/** The cadence fields of a create body, shared by every builder in
 *  this module (the schedule form above and the discovery capture
 *  below): exactly one key is added, per scheduleType. Returns the
 *  one-shot date error string, or null. */
export interface ScheduleCadenceInput {
  scheduleType: ScheduleFormState["scheduleType"];
  intervalSeconds?: number;
  cronExpression?: string;
  delaySeconds?: number;
  scheduledDate?: string;
  /**
   * Issue #4235 — the owner's explicit opt-in to a sub-daily
   * cadence. Threaded only when true: an absent/false opt-in adds
   * no key, so golden bodies for daily-or-less schedules are
   * unchanged.
   */
  subDailyOptIn?: boolean;
}

function applyScheduleCadence(
  requestBody: Record<string, any>,
  cadence: ScheduleCadenceInput
): string | null {
  if (cadence.scheduleType === "interval") {
    requestBody.intervalSeconds = Number(cadence.intervalSeconds);
  } else if (cadence.scheduleType === "cron") {
    requestBody.cron = (cadence.cronExpression ?? "").trim();
  } else if (cadence.scheduleType === "delayed") {
    requestBody.delayInSeconds = Number(cadence.delaySeconds);
  } else if (cadence.scheduleType === "scheduled") {
    if (!cadence.scheduledDate) {
      return "Pick a date and time for the one-shot run.";
    }
    requestBody.date = new Date(cadence.scheduledDate).toISOString();
  }
  // Issue #4235 — only when set: the default form submits no
  // opt-in field, and the server stamps the recorded opt-in from
  // this key when the cadence needs it.
  if (cadence.subDailyOptIn === true) requestBody.subDailyOptIn = true;
  return null;
}

/**
 * S8 (consolidation, umbrella #958): the StrategyDiscoveryPanel
 * "schedule this view" capture (issue #126) builds its create body
 * HERE — the same builder module as the schedule form — instead of
 * hand-assembling it in the panel. The capture snapshots ONE already
 * built StrategyRequest (the exact view on screen), so this builder
 * takes the request as-is rather than form drafts: the payload is
 * the saved-request discovery payload ({ requests, environment,
 * trigger: "scheduled" }) the form builder above produces for the
 * saved-request model, validated through the same S1 schema check,
 * with the cadence applied by the same helper.
 *
 * Named correction vs the panel's legacy hand-assembled body: the
 * payload now carries `trigger: "scheduled"` — the value the create
 * route stamps server-side when it is absent
 * (src/agents/routes/schedules.ts), so the stored schedule is
 * identical; the client body gains the stamp the form path has
 * always sent. Golden-pinned in tests/screening_hub_s8.test.tsx.
 */
export function buildDiscoveryCaptureSubmission(input: {
  request: Record<string, any>;
  environment: string;
} & ScheduleCadenceInput): { requestBody: Record<string, any> } | { error: string } {
  const payload: Record<string, any> = {
    requests: [input.request],
    environment: input.environment,
    trigger: "scheduled",
  };
  const validationError = validateScheduleCriteriaClient(JOB_CALLBACKS.strategyDiscovery, payload);
  if (validationError) return { error: validationError };

  const requestBody: Record<string, any> = {
    callback: JOB_CALLBACKS.strategyDiscovery,
    scheduleType: input.scheduleType,
    payload,
  };
  const cadenceError = applyScheduleCadence(requestBody, input);
  if (cadenceError) return { error: cadenceError };
  return { requestBody };
}

/**
 * S4c (#4432): the Stock Hub "Schedule this screen" capture builds its
 * create body HERE — the same builder module as the schedule form and
 * the discovery capture — instead of hand-assembling it in the hub. The
 * capture snapshots the hub new-screen form's merged filter (the same
 * filter the manual run sends, minus minScore and limit — see the
 * caller's comment: minScore is a manual-path ranking threshold, not a
 * schedule criterion, and limit is represented by top-level maxItems;
 * the strict S1 schema below rejects any other unknown key loudly,
 * so this builder never silently drops a field), universe, sector, and
 * maxItems, plus the armed presetId when one is armed.
 *
 * Preset vs filters follows the form branch exactly (#1499): a chosen
 * preset replaces the custom thresholds — the run resolves the preset's
 * CURRENT criteria at run time, so the capture never freezes criteria
 * into the payload alongside the preset id. No preset means the
 * criteria exactly as captured ride as `filters`.
 *
 * Universe ALL is refused here as well as at the route: a scheduled
 * screen needs one specific universe (buildSchedulePayload's rule), and
 * the hub form allows ALL — the capture strip disables the button
 * there, and this builder is the loud backstop.
 *
 * Broker/mode/provider are NOT inputs: the create route strips caller
 * identity and stamps the server-resolved tenant selections, and the
 * caller sends the live environment on the x-environment header.
 * Delivery rides the form branch's conventions (slackChannel only when
 * Slack push is on, blank recipients omitted, values trimmed).
 */
export function buildMarketScreenCaptureSubmission(input: {
  universe: string;
  sector?: string;
  maxItems?: number;
  filters: Record<string, any>;
  presetId?: string;
  pushToSlack?: boolean;
  slackChannel?: string;
  emailTo?: string;
  webhookUrl?: string;
} & ScheduleCadenceInput): { requestBody: Record<string, any> } | { error: string } {
  if (!input.universe) {
    return { error: "Stock schedules require one explicit universe." };
  }
  if (input.universe === "ALL") {
    return {
      error:
        "Scheduled screens need one specific universe — pick a universe other than All before scheduling.",
    };
  }
  const payload: Record<string, any> = {
    universe: input.universe,
    sector: input.sector || "ALL",
    ...(input.maxItems !== undefined ? { maxItems: input.maxItems } : {}),
    trigger: "scheduled",
    pushToSlack: input.pushToSlack ?? false,
    slackChannel:
      input.pushToSlack && input.slackChannel?.trim()
        ? input.slackChannel.trim()
        : undefined,
    emailTo: input.emailTo?.trim() || undefined,
    webhookUrl: input.webhookUrl?.trim() || undefined,
    // Issue #1499 (#940-E): a chosen preset replaces the custom
    // thresholds — the run resolves the preset's CURRENT criteria at
    // run time, so the form never freezes criteria into the payload
    // alongside the preset id.
    ...(input.presetId
      ? { presetId: input.presetId }
      : Object.keys(input.filters).length > 0
        ? { filters: input.filters }
        : {}),
  };
  const validationError = validateScheduleCriteriaClient(
    JOB_CALLBACKS.marketScreen,
    payload,
  );
  if (validationError) return { error: validationError };

  const requestBody: Record<string, any> = {
    callback: JOB_CALLBACKS.marketScreen,
    scheduleType: input.scheduleType,
    payload,
  };
  const cadenceError = applyScheduleCadence(requestBody, input);
  if (cadenceError) return { error: cadenceError };
  return { requestBody };
}

/**
 * The hero Run Now payload: an immediate options analysis with the
 * form state. NOT a schedule payload — it carries no trigger stamp
 * (the legacy hero body's exact shape).
 */
export function buildOptionsRunNowPayload(form: ScheduleFormState): Record<string, any> {
  const symbols = parseSymbolsText(form.targetSymbols);
  return {
    ...(form.targetUniverse ? { universe: form.targetUniverse } : { symbols }),
    maxItems: form.maxItems,
    thesis: form.thesis,
    riskProfile: form.riskProfile,
    // Issue #2600: Run Now is the schedule's own trigger path, so it
    // carries the same strategy-choice controls when set.
    ...(form.optionsStrategyMode ? { strategyMode: form.optionsStrategyMode } : {}),
    ...(form.optionsFarDated !== undefined ? { farDated: form.optionsFarDated } : {}),
    ...(form.optionsCandidateLimit !== undefined ? { candidateLimit: form.optionsCandidateLimit } : {}),
    pushToSlack: form.pushToSlack,
    slackChannel: form.pushToSlack ? form.slackChannel : undefined,
    emailTo: form.emailTo.trim() || undefined,
    webhookUrl: form.webhookUrl.trim() || undefined,
    environment: form.environment,
  };
}
