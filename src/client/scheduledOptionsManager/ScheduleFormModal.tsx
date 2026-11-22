import React, { useEffect, useState } from "react";
import { CardHeader, Select, TextInput, Modal, Button } from "../components/ui";
import { useTenantProviders } from "../tenantProviders";
import { brokerPresentation } from "../../trading";
import { ActiveBindingBadge } from "../ActiveBindingBadge";
import { universeOptions, withLegacyValue } from "../vocabularyOptions";
import { useBrokerEnvironment } from "../brokerEnvironment";
import { listPresets, type ScreenerPreset } from "../ScreenerPresetManager";
import type { CreatableJob } from "./types";
import { creatableJobCatalogueEntries } from "../../config/jobCatalogue";
import {
  DiscoveryFormSections,
  type DiscoveryFormSectionsProps,
} from "./DiscoveryFormSections";
import { CadenceFields, type CadenceFieldsProps } from "./CadenceFields";
import { RunTargetFields, type RunTargetFieldsProps } from "./RunTargetFields";
import {
  ThesisRiskFields,
  type ThesisRiskFieldsProps,
} from "./ThesisRiskFields";
import {
  NotificationFields,
  type NotificationFieldsProps,
} from "./NotificationFields";

export interface ScheduleFormModalProps
  extends DiscoveryFormSectionsProps,
    CadenceFieldsProps,
    ThesisRiskFieldsProps,
    RunTargetFieldsProps,
    NotificationFieldsProps {
  editingScheduleId: string | null;
  submitting: boolean;
  setModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleCreateSchedule: (e: React.FormEvent) => Promise<void>;
  setJobType: React.Dispatch<React.SetStateAction<CreatableJob>>;
  targetUniverse: string;
  setTargetUniverse: React.Dispatch<React.SetStateAction<string>>;
  targetSymbols: string;
  setTargetSymbols: React.Dispatch<React.SetStateAction<string>>;
  maxItems: number;
  setMaxItems: React.Dispatch<React.SetStateAction<number>>;
  sector: string;
  setSector: React.Dispatch<React.SetStateAction<string>>;
  minPrice: string;
  setMinPrice: React.Dispatch<React.SetStateAction<string>>;
  maxPrice: string;
  setMaxPrice: React.Dispatch<React.SetStateAction<string>>;
  minMarketCap: string;
  setMinMarketCap: React.Dispatch<React.SetStateAction<string>>;
  maxPe: string;
  setMaxPe: React.Dispatch<React.SetStateAction<string>>;
  trendFilter: string;
  setTrendFilter: React.Dispatch<React.SetStateAction<string>>;
  /** Issue #1499 (#940-E): stored stocks preset for market-screen schedules. */
  presetId: string;
  setPresetId: React.Dispatch<React.SetStateAction<string>>;
  userLogin?: string;
}

export function ScheduleFormModal(props: ScheduleFormModalProps) {
  const {
    editingScheduleId,
    submitting,
    setModalOpen,
    handleCreateSchedule,
    jobType,
    setJobType,
    targetUniverse,
    setTargetUniverse,
    targetSymbols,
    setTargetSymbols,
    maxItems,
    setMaxItems,
    sector,
    setSector,
    minPrice,
    setMinPrice,
    maxPrice,
    setMaxPrice,
    minMarketCap,
    setMinMarketCap,
    maxPe,
    setMaxPe,
    trendFilter,
    setTrendFilter,
    presetId,
    setPresetId,
    userLogin,
  } = props;
  // Issue #1499 (#940-E): the caller's stocks presets for the picker.
  // A failed fetch leaves only "No preset" — it never blocks creating
  // a schedule without one.
  const [stockPresets, setStockPresets] = useState<ScreenerPreset[]>([]);
  const [presetsError, setPresetsError] = useState("");
  // Issue #3655: the dialog shows the broker and the live/paper mode
  // at creation time. Issue #5879 dedupes them to the ONE persisted
  // selection, shown once (the tenant-default line below): the
  // display-only Broker/Mode pair this replaced duplicated the #5189
  // override pair for options schedules in the same form. The values
  // come from the tenant's server-resolved selections (Settings), and
  // the create route stamps them server-side — the form never submits
  // a broker/mode value of its own. Mode derives from the broker
  // environment (TEST → paper, PROD → live). Names come from
  // brokerPresentation (total over unknown ids), never a hardcoded
  // broker name.
  const [tenantProviders] = useTenantProviders();
  const brokerEnvironment = useBrokerEnvironment();
  const dialogBrokerId = tenantProviders.brokerId;
  const dialogMode = brokerEnvironment === "TEST" ? "paper" : "live";
  const dialogPresentation = brokerPresentation(dialogBrokerId);
  useEffect(() => {
    if (props.jobType !== "marketScreen") return;
    let cancelled = false;
    void listPresets(userLogin)
      .then((all) => {
        if (!cancelled) setStockPresets(all.filter((p) => p.assetClass === "stocks"));
      })
      .catch(() => {
        if (!cancelled) setPresetsError("Could not load presets.");
      });
    return () => {
      cancelled = true;
    };
  }, [props.jobType, userLogin]);
  return (
                <Modal open onClose={() => setModalOpen(false)} size="none" panelClassName="sched-modal-card" ariaLabel="Configure screening schedule">
      {/* Parent mounts this modal conditionally; open is always true here. */}
            <header className="sched-modal-header">
              <div>
        <CardHeader title={editingScheduleId ? "✏ Update Screening Schedule" : "⏰ Configure New Schedule"} />
                <p>Register an autonomous persistent timer to run in the background.</p>
              </div>
              <Button
                type="button"
                variant="secondary"
                className="btn-modal-close"
                onClick={() => setModalOpen(false)}
              >
                ✕
              </Button>
            </header>

            <form onSubmit={handleCreateSchedule} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
              {/* Job Picker — Issue #5880: the options come from the
                  one externalized job catalogue
                  (`config/job-catalogue.json`), not hardcoded
                  <option>s. Adding a job to the picker is one
                  catalogue entry with a formJob — no code change here. */}
              {!editingScheduleId && (
                <div className="sched-form-group">
                  <Select label="Job" hint={`What runs when this schedule fires`} id="sched-job-type"
                    value={jobType}
                    onChange={(e) => {
                      const nextJobType = e.target.value as CreatableJob;
                      setJobType(nextJobType);
                      if (nextJobType === "marketScreen" && !targetUniverse) setTargetUniverse("NASDAQ100");
                    }}
                  >
                    {creatableJobCatalogueEntries().map((job) => (
                      <option key={job.formJob} value={job.formJob}>
                        {job.label}
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              {/* Run target (Issue #5879) — ONE broker/mode/account
                  selection, shown once: the tenant default from
                  Settings, read from the one persisted selection.
                  This single line replaces the #3655 display-only
                  Broker + Mode pair, which duplicated the #5189
                  override pair below for options schedules (same
                  form, same values, no independent meaning). This is
                  the live default, not a pin (D1): the broker and
                  mode are re-resolved from Settings when the schedule
                  fires, so a later change in Settings applies to
                  future runs. At fire time the effective mode is
                  resolved again — deployment pin, tenant selection,
                  or base-URL inference (scheduledEffectiveMode.ts) —
                  and the run record states the mode that actually
                  governed the run. The per-schedule override lives
                  in RunTargetFields (options only, closed #5187 /
                  #5189). */}
              <div className="sched-form-group">
                <p className="hint" id="sched-tenant-default">
                  <strong>Run target (tenant default):</strong> {dialogPresentation.label} /{" "}
                  {dialogPresentation.modeShort[dialogMode]} ({tenantProviders.dataProviderId} feeds the data).
                  This is the live default, not a pin — the broker and mode are re-resolved from Settings
                  when the schedule fires, so a later change in Settings applies to future runs. At fire
                  time the effective mode is resolved again (deployment pin, tenant selection, or base-URL
                  inference) and the run record states the mode that actually governed the run.
                </p>
                {/* Issue #5099 (F2): the active account binding for this
                    job's account type. A per-schedule account override
                    (RunTargetFields, options only) replaces the stored
                    binding in the display, so the display and the
                    submitted payload agree. */}
                <ActiveBindingBadge
                  broker={dialogBrokerId}
                  mode={dialogMode}
                  accountType={props.jobType === "optionsAnalysis" ? "options" : "stock"}
                  scope="schedule"
                  override={
                    props.accountId?.trim()
                      ? { accountId: props.accountId.trim(), accountType: "options" }
                      : null
                  }
                />
              </div>

              {/* Target Universe or Symbols */}
              {jobType !== "strategyDiscovery" && (editingScheduleId || jobType === "optionsAnalysis" || jobType === "marketScreen") && (
                <div className="sched-form-group">
                  <Select label="Target Universe" hint={`Screens all symbols in the universe`} id="sched-target-universe"
                    value={targetUniverse}
                    onChange={(e) => setTargetUniverse(e.target.value)}
                  >
                    {jobType === "optionsAnalysis" && <option value="">Custom symbols (below)</option>}
                    {withLegacyValue(universeOptions("screener"), targetUniverse).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                  {!targetUniverse && jobType === "optionsAnalysis" && (
                    <>
                      <TextInput label="Target Equity Symbols" hint={`Comma-separated tickers`} id="sched-target-symbols"
                        type="text"
                        value={targetSymbols}
                        onChange={(e) => setTargetSymbols(e.target.value)}
                        placeholder="e.g. NVDA, AAPL, SPY, MSFT"
                        required
                      />
                    </>
                  )}
                </div>
              )}

              {jobType !== "strategyDiscovery" && (
                <div className="sched-form-group">
                  <TextInput label="Max items" hint={`Maximum live symbols scanned per run; 0 means all selected symbols.`} id="sched-max-items"
                    type="number"
                    min={0}
                    step={1}
                    value={maxItems}
                    onChange={(e) => setMaxItems(Number(e.target.value))}
                    required
                  />
                </div>
              )}

              {/* Sector Selection (Market Screen) */}
              {jobType === "marketScreen" && (
                <div className="sched-form-group">
                  <Select label="Sector" hint={`Filter stocks by sector or screen all sectors`} id="sched-sector"
                    value={sector}
                    onChange={(e) => setSector(e.target.value)}
                  >
                    <option value="Technology">Technology</option>
                    <option value="ALL">ALL (All Sectors — Recommended)</option>
                    <option value="Financials">Financials</option>
                    <option value="Healthcare">Healthcare</option>
                    <option value="Consumer Discretionary">Consumer Discretionary</option>
                    <option value="Industrials">Industrials</option>
                    <option value="Energy">Energy</option>
                    <option value="Communication Services">Communication Services</option>
                    <option value="Materials">Materials</option>
                    <option value="Utilities">Utilities</option>
                    <option value="Real Estate">Real Estate</option>
                  </Select>
                </div>
              )}

              {/* Saved preset (Market Screen, #1499) */}
              {jobType === "marketScreen" && (
                <div className="sched-form-group">
                  <Select label="Saved criteria preset" hint={`A preset replaces the custom thresholds below; its current criteria resolve at run time, so preset edits apply to future runs. A deleted preset fails the run loudly instead of running unfiltered.`} id="sched-preset"
                    value={presetId}
                    onChange={(e) => setPresetId(e.target.value)}
                  >
                    <option value="">No preset (custom thresholds)</option>
                    {stockPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    {presetId && !stockPresets.some((p) => p.id === presetId) && (
                      <option value={presetId}>
                        {presetId} (no longer exists)
                      </option>
                    )}
                  </Select>
                  {presetsError && <span className="hint">{presetsError}</span>}
                </div>
              )}

              {/* Optional Custom Criteria (Market Screen) */}
              {jobType === "marketScreen" && (
                <details style={{ marginTop: "0.25rem", padding: "var(--space-2) var(--space-3)", background: "var(--color-surface-sunken)", borderRadius: "6px", border: "1px solid var(--color-border-subtle)" }}>
                  <summary style={{ fontSize: "var(--font-size-body-sm)", cursor: "pointer", color: "var(--color-accent)", fontWeight: 600, userSelect: "none" }}>
                    ⚙️ Custom Screening Criteria &amp; Filters (Optional)
                  </summary>
                  {/* Issue #3655 S4b (E-13): these custom fields cover
                      five of the seven panel fields. Min/Max RSI and
                      Min Volume are only available through a saved
                      preset above — choose one to screen on them. */}
                  <p className="hint" id="sched-custom-criteria-note">
                    Min/Max RSI and Min Volume are only available through a saved preset above — these custom fields cover price, market cap, P/E and momentum.
                  </p>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)", marginTop: "0.6rem" }}>
                    <div className="sched-form-group">
                      <TextInput label="Min Price ($)" id="sched-filter-min-price"
                        type="number"
                        min={0}
                        step="0.5"
                        value={minPrice}
                        onChange={(e) => setMinPrice(e.target.value)}
                        placeholder="e.g. 5"
                      />
                    </div>
                    <div className="sched-form-group">
                      <TextInput label="Max Price ($)" id="sched-filter-max-price"
                        type="number"
                        min={0}
                        step="0.5"
                        value={maxPrice}
                        onChange={(e) => setMaxPrice(e.target.value)}
                        placeholder="e.g. 500"
                      />
                    </div>
                    <div className="sched-form-group">
                      <TextInput label="Min Mkt Cap ($B)" id="sched-filter-min-cap"
                        type="number"
                        min={0}
                        step="1"
                        value={minMarketCap}
                        onChange={(e) => setMinMarketCap(e.target.value)}
                        placeholder="e.g. 1"
                      />
                    </div>
                    <div className="sched-form-group">
                      <TextInput label="Max P/E Ratio" id="sched-filter-max-pe"
                        type="number"
                        min={0}
                        step="1"
                        value={maxPe}
                        onChange={(e) => setMaxPe(e.target.value)}
                        placeholder="e.g. 50"
                      />
                    </div>
                  </div>
                  <div className="sched-form-group" style={{ marginTop: "0.5rem" }}>
                    <Select label="Price Trend / Momentum" id="sched-filter-trend"
                      value={trendFilter}
                      onChange={(e) => setTrendFilter(e.target.value)}
                    >
                      <option value="">Any (Standard momentum)</option>
                      <option value="bullish_breakout">Bullish Breakout</option>
                      <option value="bearish_pullback">Bearish Pullback</option>
                      <option value="high_relative_volume">High Relative Volume</option>
                    </Select>
                  </div>
                </details>
              )}

              <DiscoveryFormSections
                jobType={props.jobType}
                discoveryInputModel={props.discoveryInputModel}
                setDiscoveryInputModel={props.setDiscoveryInputModel}
                discoveryRequests={props.discoveryRequests}
                setDiscoveryRequests={props.setDiscoveryRequests}
                updateDiscoveryRequest={props.updateDiscoveryRequest}
                derivedSource={props.derivedSource}
                setDerivedSource={props.setDerivedSource}
                derivedSymbolsText={props.derivedSymbolsText}
                setDerivedSymbolsText={props.setDerivedSymbolsText}
                derivedWatchlistName={props.derivedWatchlistName}
                setDerivedWatchlistName={props.setDerivedWatchlistName}
                derivedProfileId={props.derivedProfileId}
                setDerivedProfileId={props.setDerivedProfileId}
                profiles={props.profiles}
                profilesError={props.profilesError}
                selectedDerivedProfileReason={props.selectedDerivedProfileReason}
                noViewDraft={props.noViewDraft}
                updateNoViewDraft={props.updateNoViewDraft}
                noViewDivergent={props.noViewDivergent}
              />
              <CadenceFields
                scheduleType={props.scheduleType}
                setScheduleType={props.setScheduleType}
                intervalSeconds={props.intervalSeconds}
                setIntervalSeconds={props.setIntervalSeconds}
                cronExpression={props.cronExpression}
                setCronExpression={props.setCronExpression}
                delaySeconds={props.delaySeconds}
                setDelaySeconds={props.setDelaySeconds}
                scheduledDate={props.scheduledDate}
                setScheduledDate={props.setScheduledDate}
                subDailyOptIn={props.subDailyOptIn}
                setSubDailyOptIn={props.setSubDailyOptIn}
              />
              <ThesisRiskFields
                jobType={props.jobType}
                thesis={props.thesis}
                setThesis={props.setThesis}
                riskProfile={props.riskProfile}
                setRiskProfile={props.setRiskProfile}
              />
              <RunTargetFields
                jobType={props.jobType}
                brokerId={props.brokerId}
                setBrokerId={props.setBrokerId}
                mode={props.mode}
                setMode={props.setMode}
                accountId={props.accountId}
                setAccountId={props.setAccountId}
                tenantBrokerId={dialogBrokerId}
              />
              <NotificationFields
                jobType={props.jobType}
                pushToSlack={props.pushToSlack}
                setPushToSlack={props.setPushToSlack}
                slackChannel={props.slackChannel}
                setSlackChannel={props.setSlackChannel}
                emailTo={props.emailTo}
                setEmailTo={props.setEmailTo}
                webhookUrl={props.webhookUrl}
                setWebhookUrl={props.setWebhookUrl}
              />
              <footer className="sched-modal-footer">
                <Button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={submitting}
                 loading={submitting}>
                  {editingScheduleId
                    ? "✓ Save Updated Schedule"
                    : "✓ Register Durable Schedule"}
                </Button>
              </footer>
            </form>
                  </Modal>
  );
}
