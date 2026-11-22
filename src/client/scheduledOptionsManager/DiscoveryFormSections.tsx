import React from "react";
import { Select, TextInput, Button } from "../components/ui";
import type { StrategyProfile } from "../../trading";
import type {
  CreatableJob,
  DiscoveryInputModel,
  DiscoveryRequestDraft,
  NoViewConstraintsDraft,
} from "./types";
import {
  DISCOVERY_REQUEST_LIMIT,
  blankDiscoveryRequestDraft,
} from "./discoveryRequests";
import { profileDerivationBlockReason } from "./profileDerived";

export interface DiscoveryFormSectionsProps {
  jobType: CreatableJob;
  discoveryInputModel: DiscoveryInputModel;
  setDiscoveryInputModel: React.Dispatch<React.SetStateAction<DiscoveryInputModel>>;
  discoveryRequests: DiscoveryRequestDraft[];
  setDiscoveryRequests: React.Dispatch<React.SetStateAction<DiscoveryRequestDraft[]>>;
  updateDiscoveryRequest: (idx: number, patch: Partial<DiscoveryRequestDraft>) => void;
  derivedSource: "symbols" | "watchlist";
  setDerivedSource: React.Dispatch<React.SetStateAction<"symbols" | "watchlist">>;
  derivedSymbolsText: string;
  setDerivedSymbolsText: React.Dispatch<React.SetStateAction<string>>;
  derivedWatchlistName: string;
  setDerivedWatchlistName: React.Dispatch<React.SetStateAction<string>>;
  derivedProfileId: string;
  setDerivedProfileId: React.Dispatch<React.SetStateAction<string>>;
  profiles: StrategyProfile[];
  profilesError: string | null;
  selectedDerivedProfileReason: string | null;
  noViewDraft: NoViewConstraintsDraft;
  updateNoViewDraft: (patch: Partial<NoViewConstraintsDraft>) => void;
  noViewDivergent: boolean;
}

export function DiscoveryFormSections(props: DiscoveryFormSectionsProps) {
  const {
    jobType,
    discoveryInputModel,
    setDiscoveryInputModel,
    discoveryRequests,
    setDiscoveryRequests,
    updateDiscoveryRequest,
    derivedSource,
    setDerivedSource,
    derivedSymbolsText,
    setDerivedSymbolsText,
    derivedWatchlistName,
    setDerivedWatchlistName,
    derivedProfileId,
    setDerivedProfileId,
    profiles,
    profilesError,
    selectedDerivedProfileReason,
    noViewDraft,
    updateNoViewDraft,
    noViewDivergent,
  } = props;
  return (
    <>
              {/* Discovery input model (issues #126/#533/#534) */}
              {jobType === "strategyDiscovery" && (
                <div className="sched-form-group">
                  <Select label="Input Model" hint={` Saved views re-run complete strategy requests verbatim. Symbol set + profile stores no targets — each symbol's target is derived from its live chain at run time under a saved Strategy Profile and labelled DERIVED on the run. No-view stores constraints only — no thesis and no target exist in that mode, and structures are ranked by the target-free no-view-v1 score model. `}
                    value={discoveryInputModel}
                    onChange={(e) => setDiscoveryInputModel(e.target.value as DiscoveryInputModel)}
                    aria-label="Discovery input model"
                  >
                    <option value="saved-request">Saved views</option>
                    <option value="profile-derived">Symbol set + profile (derived targets)</option>
                    <option value="no-view">No-view (constraints only)</option>
                  </Select>
                </div>
              )}

              {/* Saved discovery views (issue #126) */}
              {jobType === "strategyDiscovery" && discoveryInputModel === "saved-request" && (
                <div className="sched-form-group">
                  <div className="sched-form-label">
                    Saved Discovery Views
                    <span className="hint">
                      Each view is a complete strategy request, re-run verbatim when this schedule
                      fires — the same view the discovery panel runs interactively. Strategy ids are
                      validated by the server against the registry when you save.
                    </span>
                  </div>
                  {discoveryRequests.map((draft, idx) => (
                    <div className="discovery-request-card" key={idx}>
                      <div className="discovery-request-card-head">
                        <strong>
                          View {idx + 1}
                          {draft.symbol.trim() ? ` — ${draft.symbol.trim().toUpperCase()}` : ""}
                        </strong>
                        {discoveryRequests.length > 1 && (
                          <Button
                            type="button"
                            variant="danger"
                            tone="subtle"
                            size="sm"
                            onClick={() =>
                              setDiscoveryRequests((prev) => prev.filter((_, i) => i !== idx))
                            }
                          >
                            ✕ Remove
                          </Button>
                        )}
                      </div>
                      <div className="discovery-request-grid">
                        <div className="sched-form-group">
                          <TextInput label="Symbol" id={`sched-discovery-${idx}-symbol`}
                            type="text"
                            value={draft.symbol}
                            onChange={(e) => updateDiscoveryRequest(idx, { symbol: e.target.value })}
                            placeholder="e.g. NVDA"
                            aria-label={`View ${idx + 1} symbol`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <Select label="Thesis" id={`sched-discovery-${idx}-thesis`}
                            value={draft.thesis}
                            onChange={(e) =>
                              updateDiscoveryRequest(idx, { thesis: e.target.value as DiscoveryRequestDraft["thesis"] })
                            }
                            aria-label={`View ${idx + 1} thesis`}
                          >
                            <option value="bullish">Bullish</option>
                            <option value="bearish">Bearish</option>
                            <option value="range_bound">Range-bound</option>
                            <option value="large_move">Large move</option>
                          </Select>
                        </div>
                        <div className="sched-form-group">
                          <TextInput label="Target Price ($)" id={`sched-discovery-${idx}-target-price`}
                            type="number"
                            min={0}
                            step="0.01"
                            value={draft.targetPrice}
                            onChange={(e) => updateDiscoveryRequest(idx, { targetPrice: e.target.value })}
                            placeholder="e.g. 200"
                            aria-label={`View ${idx + 1} target price`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <TextInput label="Target Date" id={`sched-discovery-${idx}-target-date`}
                            type="date"
                            value={draft.targetDate}
                            onChange={(e) => updateDiscoveryRequest(idx, { targetDate: e.target.value })}
                            aria-label={`View ${idx + 1} target date`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <Select label="Expected IV Direction" id={`sched-discovery-${idx}-expected-iv-direction`}
                            value={draft.expectedIvDirection}
                            onChange={(e) =>
                              updateDiscoveryRequest(idx, {
                                expectedIvDirection: e.target.value as DiscoveryRequestDraft["expectedIvDirection"],
                              })
                            }
                            aria-label={`View ${idx + 1} expected IV direction`}
                          >
                            <option value="rise">Rise</option>
                            <option value="unchanged">Unchanged</option>
                            <option value="fall">Fall</option>
                          </Select>
                        </div>
                        <div className="sched-form-group">
                          <Select label="Data Mode" id={`sched-discovery-${idx}-data-mode`}
                            value={draft.dataMode}
                            onChange={(e) =>
                              updateDiscoveryRequest(idx, { dataMode: e.target.value as DiscoveryRequestDraft["dataMode"] })
                            }
                            aria-label={`View ${idx + 1} data mode`}
                          >
                            <option value="live">Live chain</option>
                            <option value="calibrated-demo">Calibrated demo (gate permitting)</option>
                          </Select>
                        </div>
                        <div className="sched-form-group">
                          <TextInput label="Max Planned Loss ($)" id={`sched-discovery-${idx}-max-planned-loss`}
                            type="number"
                            min={0}
                            step="1"
                            value={draft.maxPlannedLoss}
                            onChange={(e) => updateDiscoveryRequest(idx, { maxPlannedLoss: e.target.value })}
                            placeholder="e.g. 500"
                            aria-label={`View ${idx + 1} max planned loss`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <TextInput label="Min Reward / Risk" id={`sched-discovery-${idx}-min-reward-risk`}
                            type="number"
                            min={0}
                            step="0.1"
                            value={draft.minRewardRisk}
                            onChange={(e) => updateDiscoveryRequest(idx, { minRewardRisk: e.target.value })}
                            placeholder="e.g. 1"
                            aria-label={`View ${idx + 1} minimum reward risk`}
                            required
                          />
                        </div>
                        <div className="sched-form-group">
                          <TextInput label="Optimization Bias (0–100, optional)" id={`sched-discovery-${idx}-optimization-bias`}
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={draft.optimizationBias}
                            onChange={(e) => updateDiscoveryRequest(idx, { optimizationBias: e.target.value })}
                            placeholder="Blank = balanced"
                            aria-label={`View ${idx + 1} optimization bias`}
                          />
                        </div>
                        <div className="sched-form-group">
                          <TextInput label="Max DTE (optional)" id={`sched-discovery-${idx}-max-dte`}
                            type="number"
                            min={1}
                            step={1}
                            value={draft.maxDte}
                            onChange={(e) => updateDiscoveryRequest(idx, { maxDte: e.target.value })}
                            placeholder="e.g. 45"
                            aria-label={`View ${idx + 1} max DTE`}
                          />
                        </div>
                      </div>
                      <div className="sched-form-group ui-mt-2">
                        <TextInput label="Allowed Strategies" hint={`Comma-separated registry ids, or "all" for the full registry (the panel default)`} id={`sched-discovery-${idx}-allowed-strategies`}
                          type="text"
                          value={draft.allowedStrategies}
                          onChange={(e) => updateDiscoveryRequest(idx, { allowedStrategies: e.target.value })}
                          placeholder="all"
                          aria-label={`View ${idx + 1} allowed strategies`}
                          required
                        />
                      </div>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setDiscoveryRequests((prev) => [...prev, blankDiscoveryRequestDraft()])
                    }
                    disabled={discoveryRequests.length >= DISCOVERY_REQUEST_LIMIT}
                  >
                    + Add another saved view
                  </Button>
                </div>
              )}

              {/* Profile-derived discovery (issue #533) */}
              {jobType === "strategyDiscovery" && discoveryInputModel === "profile-derived" && (
                <div className="sched-form-group">
                  <div className="sched-form-label">
                    Symbol Set + Strategy Profile
                    <span className="hint">
                      No target is stored on this schedule. When it fires, each symbol&apos;s
                      target is derived from its live chain — spot ± the expected move under the
                      profile&apos;s thesis — and recorded as DERIVED on the run. A symbol whose
                      target cannot be derived honestly abstains, with the reason recorded.
                    </span>
                  </div>
                  <div className="sched-form-group">
                    <Select label="Symbol Source"
                      value={derivedSource}
                      onChange={(e) => setDerivedSource(e.target.value as "symbols" | "watchlist")}
                      aria-label="Derived symbol source"
                    >
                      <option value="symbols">Symbols</option>
                      <option value="watchlist">Watchlist name</option>
                    </Select>
                  </div>
                  {derivedSource === "symbols" ? (
                    <div className="sched-form-group">
                      <TextInput label="Symbols" hint={`Comma- or newline-separated tickers, up to ${DISCOVERY_REQUEST_LIMIT}`}
                        multiline
                        rows={3}
                        value={derivedSymbolsText}
                        onChange={(e) => setDerivedSymbolsText(e.target.value)}
                        placeholder="e.g. NVDA, AAPL, MSFT"
                        aria-label="Derived symbols"
                      />
                    </div>
                  ) : (
                    <div className="sched-form-group">
                      <TextInput label="Watchlist Name" hint={`Resolved against your stored watchlists when the schedule fires`}
                        type="text"
                        value={derivedWatchlistName}
                        onChange={(e) => setDerivedWatchlistName(e.target.value)}
                        placeholder="e.g. My List"
                        aria-label="Derived watchlist name"
                      />
                    </div>
                  )}
                  <div className="sched-form-group">
                    <Select label="Strategy Profile"
                      value={derivedProfileId}
                      onChange={(e) => setDerivedProfileId(e.target.value)}
                      aria-label="Derived strategy profile"
                    >
                      <option value="">Select a profile…</option>
                      {profiles.map((profile) => {
                        const reason = profileDerivationBlockReason(profile);
                        return (
                          <option key={profile.id} value={profile.id} disabled={reason !== null}>
                            {profile.name} (v{profile.version}){reason ? ` — ${reason}` : ""}
                          </option>
                        );
                      })}
                    </Select>
                    {profilesError && (
                      <p className="sched-preset-note" role="alert">
                        Could not load your strategy profiles: {profilesError}
                      </p>
                    )}
                    {!profilesError && profiles.length === 0 && (
                      <p className="sched-preset-note">
                        No saved strategy profiles found — create one in the opportunity scanner
                        first, then arm it here.
                      </p>
                    )}
                    {selectedDerivedProfileReason && (
                      <p className="sched-preset-note">
                        This profile cannot derive targets ({selectedDerivedProfileReason}) — pick
                        another profile, or update the profile first.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* No-view discovery (issue #534) */}
              {jobType === "strategyDiscovery" && discoveryInputModel === "no-view" && (
                <div className="sched-form-group">
                  <div className="sched-form-label">
                    No-View Constraint Sets
                    <span className="hint">
                      This mode sets NO thesis and NO target — targets are never set in this mode,
                      and no view is derived or assumed when the schedule fires. Each symbol below
                      gets a constraint set with the shared constraints; at run time its live chain
                      is ranked by the target-free score model (no-view-v1), the best-supported
                      structure is reported as research only (never a recommendation), and a
                      symbol where nothing qualifies abstains with its gate reasons recorded. The
                      IV assumption is fixed to &quot;unchanged&quot; and stamped on every run.
                    </span>
                  </div>
                  <div className="sched-form-group">
                    <TextInput label="Symbols" hint={`Comma- or newline-separated tickers, up to ${DISCOVERY_REQUEST_LIMIT} — one constraint set per symbol`} id="sched-discovery-noview-symbols"
                      multiline
                      rows={3}
                      value={noViewDraft.symbolsText}
                      onChange={(e) => updateNoViewDraft({ symbolsText: e.target.value })}
                      placeholder="e.g. NVDA, AAPL, MSFT"
                      aria-label="No-view symbols"
                    />
                  </div>
                  <div className="discovery-request-grid">
                    <div className="sched-form-group">
                      <TextInput label="Max Planned Loss ($)" id="sched-discovery-noview-max-planned-loss"
                        type="number"
                        min={0}
                        step="1"
                        value={noViewDraft.maxPlannedLoss}
                        onChange={(e) => updateNoViewDraft({ maxPlannedLoss: e.target.value })}
                        placeholder="e.g. 500"
                        aria-label="No-view max planned loss"
                        required
                      />
                    </div>
                    <div className="sched-form-group">
                      <TextInput label="Min Structure Reward / Risk" id="sched-discovery-noview-min-reward-risk"
                        type="number"
                        min={0}
                        step="0.1"
                        value={noViewDraft.minRewardRisk}
                        onChange={(e) => updateNoViewDraft({ minRewardRisk: e.target.value })}
                        placeholder="e.g. 1"
                        aria-label="No-view min reward risk"
                        required
                      />
                    </div>
                    <div className="sched-form-group">
                      <TextInput label="Min Probability of Profit (0–1)" id="sched-discovery-noview-min-pop"
                        type="number"
                        min={0}
                        max={1}
                        step="0.05"
                        value={noViewDraft.minProbabilityOfProfit}
                        onChange={(e) => updateNoViewDraft({ minProbabilityOfProfit: e.target.value })}
                        placeholder="0.35"
                        aria-label="No-view min probability of profit"
                      />
                    </div>
                    <div className="sched-form-group">
                      <Select label="Risk Profile" id="sched-discovery-noview-risk-profile"
                        value={noViewDraft.riskProfile}
                        onChange={(e) =>
                          updateNoViewDraft({ riskProfile: e.target.value as NoViewConstraintsDraft["riskProfile"] })
                        }
                        aria-label="No-view risk profile"
                      >
                        <option value="conservative">Conservative</option>
                        <option value="balanced">Balanced</option>
                        <option value="aggressive">Aggressive</option>
                      </Select>
                    </div>
                    <div className="sched-form-group">
                      <TextInput label="Min DTE (optional)" id="sched-discovery-noview-min-dte"
                        type="number"
                        min={1}
                        step={1}
                        value={noViewDraft.minDte}
                        onChange={(e) => updateNoViewDraft({ minDte: e.target.value })}
                        placeholder="e.g. 7"
                        aria-label="No-view min DTE"
                      />
                    </div>
                    <div className="sched-form-group">
                      <TextInput label="Max DTE (optional)" id="sched-discovery-noview-max-dte"
                        type="number"
                        min={1}
                        step={1}
                        value={noViewDraft.maxDte}
                        onChange={(e) => updateNoViewDraft({ maxDte: e.target.value })}
                        placeholder="e.g. 45"
                        aria-label="No-view max DTE"
                      />
                    </div>
                  </div>
                  {noViewDivergent && (
                    <p className="sched-preset-note" role="note">
                      This schedule was armed with different constraints per symbol. The editor
                      shows the first symbol&apos;s constraints; saving re-arms every symbol with
                      the values above.
                    </p>
                  )}
                </div>
              )}
    </>
  );
}
