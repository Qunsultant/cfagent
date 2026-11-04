/**
 * Issue #2991 (#2770 Phase A) — ONE planner port, per-asset-class
 * plan Blocks behind it. There is no options planner in the repo
 * today (only stockScreenPlanner.ts; zero "planner" mentions in
 * options code) — options planning inputs become the options plan
 * Block, NOT a second planner. The port and the plan shape are
 * generic over asset class: no stock-only assumptions anywhere.
 *
 * Common plan fields (owner directive): run identity, trigger,
 * provider, idempotency, delivery. Bonds/forex/futures/
 * commodities plan Blocks are named follow-ups: planning one
 * fails closed with a coded error, never a silent fallback.
 *
 * The stock Block adapts the existing planners (planFromSpec for
 * REST specs, planGoalStockLeg for goal specs). The options Block
 * normalizes the three inline options planning sites (route
 * parsing, goal planning, strategy engine inputs) into one plan
 * shape, reusing the existing zod validation — it does not move
 * the engines.
 */

import { parseOptionScreenerFilter } from "../../trading";
import { planGoalStockLeg } from "../goalStockScreenSpec";
import { planFromSpec } from "../stockScreenPlanner";
import type { StockScreenRunSpec } from "../stockScreenRunSpec";

export interface PlanDelivery {
  deliver?: boolean;
  emailTo?: string;
  pushToSlack?: boolean;
  slackChannel?: string;
}

export interface PlannerInput {
  assetClass: string;
  runIdentity: { runId?: string; jobId?: string };
  trigger: "manual" | "scheduled";
  /** Rich provenance (goal | nlq | mesh | research); rides the command. */
  provenanceTrigger?: string;
  provider?: string;
  idempotencyKey?: string;
  delivery?: PlanDelivery;
  /** StockScreenRunSpec | options request/goal-plan | future class input. */
  classInput: unknown;
  timestamp?: string;
}

export interface Plan {
  assetClass: string;
  runIdentity: { runId?: string; jobId?: string };
  trigger: "manual" | "scheduled";
  provenanceTrigger?: string;
  provider?: string;
  idempotencyKey: string;
  delivery: PlanDelivery;
  classPlan: Record<string, unknown>;
}

export interface PlanBlock {
  assetClass: string;
  plan: (input: PlannerInput) => Plan;
}

export interface PlannerPort {
  supportedClasses: string[];
  plan: (input: PlannerInput) => Plan;
}

function defined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function mergeDelivery(
  base: PlanDelivery,
  override?: PlanDelivery,
): PlanDelivery {
  return defined({ ...base, ...defined(override ?? {}) });
}

/** Stock plan Block: adapts the existing stock planners. */
export function stockPlanBlock(): PlanBlock {
  return {
    assetClass: "stock",
    plan: (input: PlannerInput): Plan => {
      const spec = input.classInput as StockScreenRunSpec;
      const timestamp = input.timestamp ?? new Date().toISOString();
      const stockPlan =
        spec.source === "goal"
          ? planGoalStockLeg(spec, input.trigger, timestamp)
          : planFromSpec(spec, input.trigger, timestamp);
      return {
        assetClass: "stock",
        runIdentity: input.runIdentity,
        trigger: input.trigger,
        ...(input.provenanceTrigger
          ? { provenanceTrigger: input.provenanceTrigger }
          : {}),
        provider: input.provider ?? stockPlan.provider,
        idempotencyKey: input.idempotencyKey ?? stockPlan.idempotencyKey,
        delivery: mergeDelivery(
          {
            deliver: spec.deliver,
            ...(spec.delivery
              ? defined({
                  emailTo: (spec.delivery as Record<string, unknown>)["emailTo"],
                  pushToSlack: (spec.delivery as Record<string, unknown>)["pushToSlack"],
                  slackChannel: (spec.delivery as Record<string, unknown>)["slackChannel"],
                } as PlanDelivery)
              : {}),
          },
          input.delivery,
        ),
        classPlan: defined({
          sector: stockPlan.sector,
          universe: stockPlan.universe,
          providerFallback: stockPlan.providerFallback,
          scheduledClaimKey: stockPlan.scheduledClaimKey,
        }),
      };
    },
  };
}

interface OptionsClassInput {
  request?: {
    filter?: Record<string, unknown>;
    pushToSlack?: boolean;
    slackChannel?: string;
    emailTo?: string;
  };
  goalPlan?: {
    structures?: string[];
    optionsFilter?: Record<string, unknown>;
  };
}

/** Options plan Block: normalizes the inline options planning sites. */
export function optionsPlanBlock(): PlanBlock {
  return {
    assetClass: "options",
    plan: (input: PlannerInput): Plan => {
      const raw = (input.classInput ?? {}) as OptionsClassInput;
      const filter = raw.request?.filter ?? raw.goalPlan?.optionsFilter;
      if (filter !== undefined) {
        const parsed = parseOptionScreenerFilter(filter);
        if (!parsed.ok) {
          throw new Error(
            `options plan: invalid filter: ${JSON.stringify(parsed.error)}`,
          );
        }
      }
      const f = (filter ?? {}) as Record<string, unknown>;
      const timestamp = input.timestamp ?? new Date().toISOString();
      const underlyings = f["underlyingSymbols"] as string[] | undefined;
      const dteWindow = defined({
        minDte: f["minDte"],
        maxDte: f["maxDte"],
        bands: f["expirationDteBands"],
      });
      const liquidityFloor = defined({
        minVolume: f["minVolume"],
        minOpenInterest: f["minOpenInterest"],
      });
      const classPlan = defined({
        underlyings,
        ...(Object.keys(dteWindow).length > 0 ? { dteWindow } : {}),
        spreadCap: f["maxSpreadPct"],
        ...(Object.keys(liquidityFloor).length > 0 ? { liquidityFloor } : {}),
        structures: raw.goalPlan?.structures,
        // Descriptor, not an engine: the chain-fetch strategy the
        // existing DynamicOptionsScreener path uses.
        chainFetch: { strategy: "dynamic-options-screener" },
      });
      const idempotencySubject =
        underlyings && underlyings.length > 0 ? underlyings.join(",") : "ALL";
      return {
        assetClass: "options",
        runIdentity: input.runIdentity,
        trigger: input.trigger,
        ...(input.provenanceTrigger
          ? { provenanceTrigger: input.provenanceTrigger }
          : {}),
        // Provider is recorded only when known — never fabricated.
        ...(input.provider ? { provider: input.provider } : {}),
        idempotencyKey:
          input.idempotencyKey ??
          `options:${input.trigger}:${idempotencySubject}:${timestamp}`,
        delivery: mergeDelivery(
          defined({
            pushToSlack: raw.request?.pushToSlack,
            slackChannel: raw.request?.slackChannel,
            emailTo: raw.request?.emailTo,
          }),
          input.delivery,
        ),
        classPlan,
      };
    },
  };
}

export function createPlannerPort(blocks: PlanBlock[]): PlannerPort {
  const byClass = new Map<string, PlanBlock>();
  for (const block of blocks) {
    if (byClass.has(block.assetClass)) {
      throw new Error(`Planner port: duplicate plan Block for ${block.assetClass}`);
    }
    byClass.set(block.assetClass, block);
  }
  return {
    supportedClasses: [...byClass.keys()].sort(),
    plan: (input: PlannerInput): Plan => {
      const block = byClass.get(input.assetClass);
      if (!block) {
        // Fail closed, never a silent fallback: bonds/forex/
        // futures/commodities plan Blocks are named follow-ups.
        throw new Error(`plan_block_not_registered: ${input.assetClass}`);
      }
      return block.plan(input);
    },
  };
}
