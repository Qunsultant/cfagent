/**
 * Issue #5895 — quick-create schedules for each job with defaults, then edit.
 *
 * The bulk-create plan for the Schedules home: the jobs the create form
 * offers (the catalogue's form jobs, in catalogue order — see
 * `creatableJobCatalogueEntries` in `src/config/jobCatalogue.ts`), each
 * with its default schedule / universe / delivery; all creatable jobs
 * ticked by default; one action creates them through the existing
 * POST /api/schedules/create route, via the form's single
 * payload-construction path (`buildScheduleSubmission` — the same
 * builder the form submit and the Track 1 recreate plan use). No new
 * create route, no second defaults list, no second job list.
 *
 * Why the plan is the 3 form jobs, not all 38 catalogue jobs: the
 * create route's allow-list accepts only 5 callbacks, and of those
 * only the form jobs have complete defaults. autonomousGoalScreen
 * needs a goalKind or scenarioId and runPipelineJobSchedule needs a
 * pipeline job id — neither has a catalogue default, so neither can
 * be quick-created; goal operations are created as goals (addGoal,
 * not the create route); system duties are platform-owned, not
 * quick-created; internal callbacks are allow-list-rejected. Listing those
 * would post guaranteed failures.
 *
 * Why strategy discovery is listed but blocked: a discovery schedule
 * re-runs saved views, and a view needs a symbol, target price,
 * target date and max planned loss (`buildDiscoveryRequests`). There
 * is no default view — inventing one would arm a fake trade thesis.
 * The row is unticked and disabled, and names its reason.
 *
 * Why the default cadence is a cron, not the form's default interval:
 * the form opens on interval 3600s, but the owner's daily-defaults
 * directive says defaults are daily, nothing more frequent, and a
 * sub-daily cadence needs an explicit per-schedule opt-in (#4235).
 * The quick-create default is the form's own default cron (weekdays
 * 9:30 AM ET, converted to UTC like the form converts it), so the
 * created schedules need no opt-in. A catalogue defaultCron, when a
 * form job carries one, wins over the form default — a config change
 * moves the default with no code change.
 *
 * Per-row edit after creation is the existing Edit control (the full
 * form, cadence included) — nothing new is built for it; the created
 * rows are ordinary rows in the one list.
 */
import { creatableJobCatalogueEntries, type JobCatalogueEntry } from "../../config/jobCatalogue";
import { etToUtcCron } from "../options/cronTime";
import type { CreateScheduleBody } from "../jobsApi";
import { buildScheduleSubmission } from "./payloadBuilders";
import { blankDiscoveryRequestDraft } from "./discoveryRequests";
import { blankNoViewConstraintsDraft } from "./noView";
import type { CreatableJob, ScheduleFormState } from "./types";

/** The form's default cron for a quick-created job: weekdays 9:30 AM ET. */
export function quickCreateDefaultCron(referenceDate: Date = new Date()): string {
  return etToUtcCron({ hour: 9, minute: 30, daysOfWeek: "1-5" }, referenceDate);
}

/** One row of the quick-create plan: a form job, its defaults, and whether it can be created with them. */
export interface QuickCreateJob {
  entry: JobCatalogueEntry;
  formJob: CreatableJob;
  /** Ticked by default; false for the blocked discovery job. */
  selected: boolean;
  /** Set when the job cannot be created with defaults (discovery: needs a saved view). */
  blockedReason?: string;
  /** The catalogue defaultCron when the entry carries one, else the form's default cron. */
  defaultCron: string;
  defaultUniverse: string;
  defaultSlackChannel: string;
}

/** The quick-create plan, from the one catalogue, in catalogue order. */
export function quickCreateJobs(referenceDate: Date = new Date()): QuickCreateJob[] {
  return creatableJobCatalogueEntries().map((entry) => {
    const formJob = entry.formJob as CreatableJob;
    const blockedReason =
      formJob === "strategyDiscovery"
        ? "Needs a saved discovery view — create it in the form."
        : undefined;
    return {
      entry,
      formJob,
      selected: blockedReason === undefined,
      ...(blockedReason ? { blockedReason } : {}),
      defaultCron: entry.defaultCron ?? quickCreateDefaultCron(referenceDate),
      // The form's create defaults (ScheduledOptionsManager's create
      // reset): the screens default to NASDAQ100 with Slack delivery.
      // Discovery carries no universe — it is blocked, never submitted.
      defaultUniverse: formJob === "strategyDiscovery" ? "" : "NASDAQ100",
      defaultSlackChannel: "#options-alerts",
    };
  });
}

/**
 * The create form's state for a quick-create job: the form's create
 * defaults (universe, maxItems, sector, thesis, risk, delivery) with
 * the plan's daily cron cadence. Built through the same defaults the
 * form's create reset applies — the only deliberate difference is the
 * cadence: cron (daily) instead of the form's interval 3600s, per the
 * daily-defaults directive (see the module header).
 */
export function quickCreateFormState(
  job: QuickCreateJob,
  environment: string,
  referenceDate: Date = new Date(),
): ScheduleFormState {
  return {
    jobType: job.formJob,
    targetSymbols: "",
    maxItems: 100,
    targetUniverse: job.defaultUniverse,
    sector: "Technology",
    minPrice: "",
    maxPrice: "",
    minMarketCap: "",
    maxPe: "",
    trendFilter: "",
    presetId: undefined,
    scheduleType: "cron",
    intervalSeconds: 0,
    cronExpression: job.defaultCron || quickCreateDefaultCron(referenceDate),
    delaySeconds: 0,
    scheduledDate: "",
    subDailyOptIn: false,
    thesis: "bullish",
    riskProfile: "balanced",
    pushToSlack: true,
    slackChannel: job.defaultSlackChannel,
    emailTo: "",
    webhookUrl: "",
    discoveryRequests: [blankDiscoveryRequestDraft()],
    discoveryInputModel: "saved-request",
    derivedSource: "symbols",
    derivedSymbolsText: "",
    derivedWatchlistName: "",
    derivedProfileId: "",
    noViewDraft: blankNoViewConstraintsDraft(),
    environment,
    brokerId: "",
    mode: "",
    accountId: "",
  };
}

/**
 * The POST /api/schedules/create body for one quick-create job, built
 * through the form's single payload-construction path — or { error }
 * for a blocked job (never a body: a blocked job is never posted).
 * The body is narrowed to the create client's shape (the builder
 * always sets callback, scheduleType and payload; anything else is a
 * loud error, never a malformed post).
 */
export function buildQuickCreateSubmission(
  job: QuickCreateJob,
  environment: string,
  referenceDate: Date = new Date(),
): { requestBody: CreateScheduleBody } | { error: string } {
  if (job.blockedReason) return { error: job.blockedReason };
  const built = buildScheduleSubmission(quickCreateFormState(job, environment, referenceDate));
  if ("error" in built) return { error: built.error };
  const body = built.requestBody;
  if (
    typeof body.callback !== "string" ||
    (body.scheduleType !== "cron" && body.scheduleType !== "interval") ||
    typeof body.payload !== "object" ||
    body.payload === null ||
    Array.isArray(body.payload)
  ) {
    return { error: "Quick create built an incomplete schedule body." };
  }
  return { requestBody: body as CreateScheduleBody };
}

/** One quick-created row: created (with its new id), duplicate-suppressed, or failed with the reason. */
export interface QuickCreateResultItem {
  label: string;
  ok: boolean;
  scheduleId?: string;
  duplicate?: boolean;
  error?: string;
}

/** The create call the runner posts through — `createSchedule` from jobsApi in the UI. */
export type QuickCreateFn = (body: CreateScheduleBody) => Promise<{
  success?: boolean;
  schedule?: { id?: string };
  duplicate?: boolean;
  error?: string;
}>;

/**
 * Create each selected job in plan order through the injected create
 * call (the existing POST /api/schedules/create wrapper). A failure
 * — a build error, a { success: false } answer, or a throw — is
 * reported on that job's result and never stops the rest of the
 * batch; an unselected or blocked job is never posted. Returns one
 * result per job the batch attempted, in plan order.
 */
export async function runQuickCreate(
  jobs: readonly QuickCreateJob[],
  create: QuickCreateFn,
  environment: string,
  referenceDate: Date = new Date(),
): Promise<QuickCreateResultItem[]> {
  const results: QuickCreateResultItem[] = [];
  for (const job of jobs) {
    if (!job.selected) continue;
    const label = job.entry.label;
    if (job.blockedReason) {
      results.push({ label, ok: false, error: job.blockedReason });
      continue;
    }
    const built = buildQuickCreateSubmission(job, environment, referenceDate);
    if ("error" in built) {
      results.push({ label, ok: false, error: built.error });
      continue;
    }
    try {
      const data = await create(built.requestBody);
      if (data && data.success) {
        results.push({
          label,
          ok: true,
          ...(typeof data.schedule?.id === "string" ? { scheduleId: data.schedule.id } : {}),
          ...(data.duplicate === true ? { duplicate: true } : {}),
        });
      } else {
        results.push({
          label,
          ok: false,
          error:
            data && typeof data.error === "string" && data.error !== ""
              ? data.error
              : "Create failed",
        });
      }
    } catch (err) {
      results.push({
        label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
