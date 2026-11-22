/**
 * Issue #5189 — the schedule's run target: broker, mode, account.
 *
 * A broker is a property of the run, not of the job (programme #5187), so a
 * schedule must be able to say which broker it executes against. The controls
 * are deliberately explicit:
 *   - the empty value reads "Tenant default (…)" — every pre-existing schedule
 *     stays exactly as it was, and the row says so;
 *   - only brokers whose catalogue declares `optionChains` are offered (the
 *     options screen cannot run on one that does not);
 *   - "Paper" is disabled for a broker with no paper mode (Public), so the form
 *     cannot submit a combination the run would refuse.
 *
 * Issue #5879 — this is the form's ONE broker/mode/account selection, kept
 * ONLY where #5187/#5189 require it (options schedules) and labelled as an
 * override of the tenant default shown above it, not a second copy of the
 * same choice. The display-only #3655 pair that used to sit above it is
 * gone; the tenant default line is the selection, these fields are the
 * override. tenantBrokerId is a plain string: the tenant broker id is a
 * string at the boundary, and brokerPresentation is total over unknown ids.
 */
import React from "react";
import { Grid, Select, TextInput } from "../components/ui";
import { BROKER_CATALOG, brokerPresentation, type BrokerId } from "../../trading";
import type { CreatableJob, ScheduleFormState } from "./types";

export interface RunTargetFieldsProps {
  jobType: CreatableJob;
  brokerId: ScheduleFormState["brokerId"];
  setBrokerId: React.Dispatch<React.SetStateAction<ScheduleFormState["brokerId"]>>;
  mode: ScheduleFormState["mode"];
  setMode: React.Dispatch<React.SetStateAction<ScheduleFormState["mode"]>>;
  accountId: ScheduleFormState["accountId"];
  setAccountId: React.Dispatch<React.SetStateAction<ScheduleFormState["accountId"]>>;
  /** The tenant's broker, shown as the meaning of the empty selection. */
  tenantBrokerId?: string;
}

const CHAIN_BROKERS = (Object.keys(BROKER_CATALOG) as BrokerId[]).filter(
  (id) => BROKER_CATALOG[id].supports.optionChains === true,
);

export function RunTargetFields(props: RunTargetFieldsProps) {
  const { jobType, brokerId, setBrokerId, mode, setMode, accountId, setAccountId, tenantBrokerId } = props;
  if (jobType !== "optionsAnalysis") return null;

  const selected = brokerId ? (brokerId as BrokerId) : null;
  const paperSupported = selected ? BROKER_CATALOG[selected].paperMode === true : true;
  const tenantLabel = tenantBrokerId ? brokerPresentation(tenantBrokerId).label : "tenant default";

  return (
    <Grid columns={3} gap="4">
      <div className="sched-form-group">
        <Select
          label="Broker override"
          hint={`Override the tenant default above — leave as Tenant default (${tenantLabel}) to run against the tenant selection.`}
          id="sched-run-broker"
          value={brokerId}
          onChange={(e) => {
            const next = e.target.value;
            setBrokerId(next);
            // A broker without paper cannot run paper: drop an incompatible mode
            // rather than submitting a pair the run refuses.
            if (next && BROKER_CATALOG[next as BrokerId].paperMode !== true && mode === "paper") {
              setMode("");
            }
          }}
        >
          <option value="">Tenant default ({tenantLabel})</option>
          {CHAIN_BROKERS.map((id) => (
            <option key={id} value={id}>
              {brokerPresentation(id).label}
            </option>
          ))}
        </Select>
      </div>

      <div className="sched-form-group">
        <Select
          label="Mode override"
          hint={`Leave blank to resolve for the broker. The effective mode is re-resolved at fire time, so a later change applies to future runs.`}
          id="sched-run-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as ScheduleFormState["mode"])}
        >
          <option value="">Resolved for the broker</option>
          <option value="paper" disabled={!paperSupported}>
            Paper
          </option>
          <option value="live">Live</option>
        </Select>
      </div>

      <div className="sched-form-group">
        <TextInput
          label="Account (optional)"
          id="sched-run-account"
          type="text"
          value={accountId}
          placeholder="Broker's default account"
          onChange={(e) => setAccountId(e.target.value)}
        />
      </div>
    </Grid>
  );
}
