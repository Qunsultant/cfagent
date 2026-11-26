/**
 * Issue #6503 — the #1096 Phase 6 autonomous screening steps that rode
 * the retired POST /research/scheduled-tick route.
 *
 * The route is gone; the steps are not. They are the nightly research
 * job's work, so they now run from the stored nightly-research
 * schedule's callback (`OrchestratorAgent.runResearchSchedule`), after
 * a successful research run — the same ordering the route had (a failed
 * run never ran them). Nothing about the steps changed: discovery is
 * advisory and never fails the firing; re-selection is proposal-only
 * (promotion stays behind Phase 5's gate); the weights-v2 job enforces
 * its own kill switch and budget; channel delivery fires only for a
 * fired discovery when the channels flag is on; the screening pause
 * flag gates every autonomous step and records the skip. All
 * best-effort, recorded in the screening activity log.
 *
 * The `scheduled-tick` actor string is kept on the activity rows: it
 * names the scheduled research firing, now via the stored schedule —
 * existing rows and queries keep reading the same value.
 */
import { resolveResearchJobConfig } from "../config/researchJobConfig";
import {
  isScreeningChannelsEnabled,
  isScreeningScheduledPaused,
  type ScreeningSettingRead,
} from "./screeningFlags";
import type { DatabaseORM } from "../orm";
import { researchTickDateKey } from "./researchScheduleGuard";
import type { ResearchAgent } from "../agents/research-agent";
import type { ResearchConfig } from "./researchConfig";

export interface ScheduledScreeningStepsDeps {
  userLogin: string;
  /** The research agent for this login, or null when none is bound. */
  agent: ResearchAgent | null;
  /** The ORM/store the steps write through (mas_settings-adjacent tables). */
  orm: DatabaseORM;
  readSetting: ScreeningSettingRead;
  writeSetting: (key: string, value: string) => void;
  env: Record<string, string | undefined>;
  /** Clock for the fire decisions; defaults to now. */
  now?: Date;
}

export interface ScheduledScreeningStepsResult {
  screeningPaused: boolean;
  discoveryFired?: boolean;
  discoveryPersisted?: number;
  discoverySkipped?: string;
  screeningSteps?: Record<string, unknown>;
}

export async function runScheduledScreeningSteps(
  deps: ScheduledScreeningStepsDeps,
): Promise<ScheduledScreeningStepsResult> {
  const { userLogin, agent, orm, readSetting, writeSetting, env } = deps;
  const now = deps.now ?? new Date();
  const dateKey = researchTickDateKey(now);

  // Issue #1162 (epic #1096 Phase 6): the screening pause flag is
  // read once per firing and gates every #1096 autonomous step below
  // (discovery, re-selection, weights-v2, tick delivery). The #319
  // research run itself is NOT gated — it predates the screening
  // system and has its own controls. A settings read failure reads
  // as paused (fail-closed, the #756 kill-switch idiom).
  const screeningPaused = isScreeningScheduledPaused(readSetting);

  // Discovery is advisory and never fails the firing. Portfolio
  // state is not supplied on this path, so portfolio discovery
  // triggers skip with the limitation recorded by the engine.
  // Issue #1162: the screening pause flag skips discovery too.
  const out: ScheduledScreeningStepsResult = { screeningPaused };
  try {
    if (agent && screeningPaused) {
      out.discoverySkipped = "screening_paused";
    } else if (agent) {
      const disc = await agent.runDiscoveryIfDue(now, { userLogin });
      out.discoveryFired = disc.fired;
      if (disc.fired) {
        out.discoveryPersisted = disc.result?.persisted ?? 0;
      }
    }
  } catch {
    // Discovery is advisory; the research run already succeeded.
  }

  // Issue #1162 (epic #1096 Phase 6): the remaining #1096
  // autonomous steps get their production caller on this same
  // firing (no new cron trigger — the Workers ceiling): strategy-
  // bank re-selection (Phase 3, proposals only — promotion stays
  // behind Phase 5's gate) and the strategy-weights v2 job
  // (Phase 5; kill switch and budget are enforced inside the
  // job), plus channel delivery of a fired discovery when the
  // channels flag is on. All best-effort, recorded in the
  // screening activity log; none of it can fail the firing.
  try {
    const { recordScreeningActivity } = await import("./screeningActivity");
    if (screeningPaused) {
      out.screeningPaused = true;
      recordScreeningActivity(orm as never, {
        userLogin,
        kind: "schedule_control",
        summary:
          "Scheduled screening steps skipped — screening is paused (screening.scheduledPaused=on). Discovery, re-selection, weights-v2, and tick delivery did not run.",
        actor: "scheduled-tick",
      });
    } else {
      const steps: Record<string, unknown> = {};
      const track = agent ? await agent.getTrackRecord().catch(() => null) : null;
      const researchConfig: ResearchConfig | null = agent
        ? await agent.getResearchConfig().catch(() => null)
        : null;
      if (agent && track) {
        try {
          const {
            shouldFireStrategyBankTick,
            STRATEGY_BANK_LAST_RUN_KEY,
            buildStrategyRegimeEvidence,
            reselectStrategyBank,
            recordReselectionProposal,
          } = await import("./strategyBankReselection");
          // Consolidation C5 (#1361, #1257): reselection reads
          // v2 weights for the run's regime (proposal-only; the
          // informational weight field now carries the regime's
          // v2 value). Proposal shape unchanged.
          const { getStrategyWeightsV2ForRegime } = await import("./strategyWeightsV2");
          const sbDecision = shouldFireStrategyBankTick(
            now,
            readSetting(STRATEGY_BANK_LAST_RUN_KEY),
            resolveResearchJobConfig(env),
          );
          if (sbDecision.fire) {
            const evidence = buildStrategyRegimeEvidence(track.ideas);
            const regimes = [...new Set(evidence.map((e) => e.regime))];
            let proposals = 0;
            for (const regime of regimes) {
              const proposal = reselectStrategyBank({
                evidence,
                weights: getStrategyWeightsV2ForRegime(orm, regime),
                regime,
                overallWinRate: track.winRate,
                now,
              });
              recordReselectionProposal(orm, userLogin, proposal);
              proposals++;
            }
            if (proposals > 0) {
              writeSetting(STRATEGY_BANK_LAST_RUN_KEY, sbDecision.dateKey);
            }
            steps.reselection = { fired: true, proposals, regimes };
          } else {
            steps.reselection = { fired: false, reason: sbDecision.reason };
          }
        } catch (err) {
          steps.reselection = {
            fired: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        try {
          const { buildWeightsV2Slices, runWeightsV2Adjustment } = await import(
            "./strategyWeightsV2"
          );
          const { RESEARCH_CONFIG_DEFAULTS } = await import("./researchConfig");
          const costs = {
            feePerContract:
              researchConfig?.feePerContract ?? RESEARCH_CONFIG_DEFAULTS.feePerContract,
            slippagePerContract:
              researchConfig?.slippagePerContract ?? RESEARCH_CONFIG_DEFAULTS.slippagePerContract,
          };
          const slices = buildWeightsV2Slices(
            track.ideas.map((idea) => ({
              structure: idea.structure,
              regime: idea.regime,
              contractsPerUnit: idea.contractsPerUnit,
              evaluation: idea.evaluation
                ? {
                    pnlEstimatePerUnit: idea.evaluation.pnlEstimatePerUnit,
                    rMultiple: idea.evaluation.rMultiple,
                    evaluatedAt: idea.evaluation.evaluatedAt,
                  }
                : null,
            })),
            costs,
          );
          const wres = runWeightsV2Adjustment(orm, slices, { now });
          steps.weightsV2 = {
            considered: wres.considered,
            adjusted: wres.adjusted.length,
            blocked: wres.blocked.length,
            halted: wres.halted ?? false,
          };
          recordScreeningActivity(orm as never, {
            userLogin,
            kind: "weights_adjustment",
            summary:
              `Weights-v2 job on the scheduled tick: ${wres.considered} slice(s) considered, ` +
              `${wres.adjusted.length} adjusted, ${wres.blocked.length} blocked` +
              `${wres.halted ? " — halted by the adaptation kill switch" : ""}.`,
            detail: steps.weightsV2,
            actor: "scheduled-tick",
          });
        } catch (err) {
          steps.weightsV2 = {
            error: err instanceof Error ? err.message : String(err),
          };
        }
        if (out.discoveryFired) {
          recordScreeningActivity(orm as never, {
            userLogin,
            kind: "discovery_run",
            summary: `Scheduled discovery run: ${out.discoveryPersisted ?? 0} proposed goal(s) persisted (proposed-only; nothing activates without confirmation).`,
            actor: "scheduled-tick",
          });
          if (isScreeningChannelsEnabled(readSetting)) {
            try {
              const { deliverScreeningContent, createScreeningDeliverySenders } =
                await import("./screeningDelivery");
              const { resolveTenantChannelGate } = await import("./tenantChannelGate");
              const channels: Array<"slack" | "email" | "webhook"> = ["slack", "webhook"];
              const emailTo =
                researchConfig?.autoEmail && researchConfig?.emailTo
                  ? researchConfig.emailTo
                  : undefined;
              if (emailTo) channels.push("email");
              const text =
                `Goal/scenario discovery (scheduled): ${out.discoveryPersisted ?? 0} new proposed goal(s) are waiting in the dashboard for review. ` +
                `Proposals never activate or trade on their own.`;
              // Issue #3169: the tenant channel gate, resolved
              // best-effort (null = ungated, prior behavior).
              const channelGate = await resolveTenantChannelGate(env, userLogin);
              await deliverScreeningContent({
                channels,
                subject: "Screening discovery: new proposed goals",
                text,
                event: "screening.discovery",
                data: { persisted: out.discoveryPersisted ?? 0, dateKey },
                emailTo,
                senders: createScreeningDeliverySenders(env, orm, userLogin),
                sql: orm as never,
                userLogin,
                actor: "scheduled-tick",
                ...(channelGate ? { channelGate } : {}),
              });
              steps.delivery = true;
            } catch (err) {
              steps.delivery = {
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        }
      }
      out.screeningSteps = steps;
    }
  } catch {
    // Phase 6 steps are best-effort; the research run already succeeded.
  }
  return out;
}
