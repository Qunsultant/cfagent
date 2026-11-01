/**
 * Issue #2545: the Options Research panel's full-parameter one-shot
 * run — the scheduled "Options Market Screen" job's parameter set
 * (universe / maxItems / thesis / risk profile, plus its delivery
 * fields) as a single immediate run.
 *
 * Nothing here invents a second construction or execution path: the
 * payload is built by the schedule builders module
 * (buildOptionsRunNowPayload — the Schedules hero "Run Now" builder),
 * validated client-side through the same shared criteria check the
 * schedule form uses (validateScheduleCriteriaClient), and submitted
 * to the schedule's own trigger route
 * (TRIGGER_ROUTES.autonomousOptionsAnalysis), whose handler validates
 * through buildSchedulePayload and runs
 * ScheduledTasksService.autonomousOptionsAnalysis — the exact path a
 * scheduled fire takes, stamped trigger:"manual" server-side.
 *
 * Defaults are the production job's parameters: NASDAQ100 universe,
 * maxItems 100, bullish thesis, balanced risk profile.
 */
import { useState } from "react";
import { Button, Notice, Select, TextInput } from "../components/ui";
import { apiFetch as fetch } from "../apiFetch";
import {
  buildOptionsRunNowPayload,
  parseSymbolsText,
  validateScheduleCriteriaClient,
} from "../scheduledOptionsManager/payloadBuilders";
import { TRIGGER_ROUTES } from "../scheduledOptionsManager/systemJobs";
import { ThesisRiskFields } from "../scheduledOptionsManager/ThesisRiskFields";
import { NotificationFields } from "../scheduledOptionsManager/NotificationFields";
import { blankDiscoveryRequestDraft } from "../scheduledOptionsManager/discoveryRequests";
import { blankNoViewConstraintsDraft } from "../scheduledOptionsManager/noView";
import type { ScheduleFormState } from "../scheduledOptionsManager/types";

export interface ScheduledOptionsRunFormProps {
  activeEnv: "TEST" | "PROD";
  userLogin?: string;
}

export function ScheduledOptionsRunForm({ activeEnv, userLogin }: ScheduledOptionsRunFormProps) {
  // The production "Options Market Screen" job's parameters.
  const [targetUniverse, setTargetUniverse] = useState("NASDAQ100");
  const [targetSymbols, setTargetSymbols] = useState("");
  const [maxItems, setMaxItems] = useState(100);
  const [thesis, setThesis] = useState<"bullish" | "bearish" | "neutral" | "directional">("bullish");
  const [riskProfile, setRiskProfile] = useState<"conservative" | "balanced" | "aggressive">("balanced");
  const [pushToSlack, setPushToSlack] = useState(true);
  const [slackChannel, setSlackChannel] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const handleRun = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running) return;
    setError("");
    setSuccessMsg("");

    // The builder takes the schedule form's whole state (its contract
    // since S7); the fields the options Run Now payload never reads
    // ride as the inert defaults the schedule form itself opens with.
    const form: ScheduleFormState = {
      jobType: "optionsAnalysis",
      targetSymbols,
      maxItems,
      targetUniverse,
      sector: "Technology",
      minPrice: "",
      maxPrice: "",
      minMarketCap: "",
      maxPe: "",
      trendFilter: "",
      scheduleType: "interval",
      intervalSeconds: 3600,
      cronExpression: "",
      delaySeconds: 0,
      scheduledDate: "",
      thesis,
      riskProfile,
      pushToSlack,
      slackChannel,
      emailTo,
      webhookUrl,
      discoveryRequests: [blankDiscoveryRequestDraft()],
      discoveryInputModel: "saved-request",
      derivedSource: "symbols",
      derivedSymbolsText: "",
      derivedWatchlistName: "",
      derivedProfileId: "",
      noViewDraft: blankNoViewConstraintsDraft(),
      environment: activeEnv,
    };

    // The hero Run Now's own guard, verbatim: a run needs a target.
    if (!targetUniverse && parseSymbolsText(targetSymbols).length === 0) {
      setError("Choose a universe or enter at least one symbol.");
      return;
    }
    const payload = buildOptionsRunNowPayload(form);
    // A payload the trigger route would 400 never leaves the form —
    // the same client-side mirror of the route's validation the
    // schedule form runs (it also enforces the maxItems rule).
    const validationError = validateScheduleCriteriaClient("autonomousOptionsAnalysis", payload);
    if (validationError) {
      setError(validationError);
      return;
    }

    setRunning(true);
    try {
      const res = await fetch(TRIGGER_ROUTES.autonomousOptionsAnalysis, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-environment": activeEnv,
          ...(userLogin ? { "x-user-login": userLogin } : {}),
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.success) {
        setSuccessMsg(`✓ Autonomous options analysis executed! Found ${data.data?.withTrades ?? 0} actionable setups.`);
      } else {
        setError(data.error || "Execution failed");
      }
    } catch (err: any) {
      setError(err?.message || "Failed to execute options analysis");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="options-comparison-note">
      <h4>▶ Run the Options Market Screen now</h4>
      <p>
        The scheduled job's full parameter set as a single run — same builder, same trigger path
        (the route stamps it <strong>manual</strong>), same delivery. Defaults are the production
        job's parameters.
      </p>
      <form className="options-request-form" onSubmit={(event) => void handleRun(event)}>
        <div className="sched-form-group">
          <Select label="Target Universe" hint="Screens all symbols in the universe" id="scheduled-options-run-universe"
            value={targetUniverse}
            onChange={(e) => setTargetUniverse(e.target.value)}
          >
            <option value="">Custom symbols (below)</option>
            <option value="TECH">Technology (keyword discovery)</option>
            <option value="NASDAQ100">Nasdaq-100</option>
            <option value="SP100">S&amp;P 100</option>
            <option value="SP500">S&amp;P 500</option>
            <option value="RUSSELL2000">Russell 2000</option>
            <option value="ETF">ETFs</option>
            <option value="LEV_ETF">Leveraged ETFs</option>
          </Select>
          {!targetUniverse && (
            <TextInput label="Target Equity Symbols" hint="Comma-separated tickers" id="scheduled-options-run-symbols"
              type="text"
              value={targetSymbols}
              onChange={(e) => setTargetSymbols(e.target.value)}
              placeholder="e.g. NVDA, AAPL, SPY, MSFT"
              required
            />
          )}
        </div>

        <div className="sched-form-group">
          <TextInput label="Max items" hint="Maximum live symbols scanned per run; 0 means all selected symbols." id="scheduled-options-run-max-items"
            type="number"
            min={0}
            step={1}
            value={maxItems}
            onChange={(e) => setMaxItems(Number(e.target.value))}
            required
          />
        </div>

        <ThesisRiskFields
          jobType="optionsAnalysis"
          thesis={thesis}
          setThesis={setThesis}
          riskProfile={riskProfile}
          setRiskProfile={setRiskProfile}
        />

        <NotificationFields
          jobType="optionsAnalysis"
          pushToSlack={pushToSlack}
          setPushToSlack={setPushToSlack}
          slackChannel={slackChannel}
          setSlackChannel={setSlackChannel}
          emailTo={emailTo}
          setEmailTo={setEmailTo}
          webhookUrl={webhookUrl}
          setWebhookUrl={setWebhookUrl}
        />

        <div>
          <Button type="submit" variant="primary" disabled={running} loading={running}>
            {"Run options screen now"}
          </Button>
        </div>
      </form>
      {error && (
        <Notice tone="danger" density="compact" onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}
      {successMsg && (
        <Notice tone="success" density="compact" onDismiss={() => setSuccessMsg("")}>
          {successMsg}
        </Notice>
      )}
    </div>
  );
}
