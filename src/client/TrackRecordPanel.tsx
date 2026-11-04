import { CalibrationDashboard } from "./CalibrationDashboard";
import { EnrichmentDashboard } from "./EnrichmentDashboard";
import { ErrorBoundary } from "./ErrorBoundary";
import { ScreeningOutcomesPanel } from "./ScreeningOutcomesPanel";
import { PageShell, PageSection } from "./components/ui/PageShell";

/**
 * TrackRecordPanel — shell-conforming composition for the trading hub's
 * track-record sub-tab (issue #3050, epic #3046). The three dashboards
 * previously rendered directly in the hub branch; they now sit inside
 * one PageShell so the sub-tab has page chrome like every other route.
 * Each dashboard keeps its own loading / error / empty states — the
 * shell's loading / error props are deliberately not used.
 */
export function TrackRecordPanel({ userLogin }: { userLogin?: string }) {
  return (
    <PageShell title="Track record">
      <PageSection title="Calibration dashboard">
        <ErrorBoundary label="Calibration dashboard">
          <CalibrationDashboard userLogin={userLogin} />
        </ErrorBoundary>
      </PageSection>
      <PageSection title="Daily enrichment + minute bars">
        {/* Issue #1888: enrichment dashboard panel — provider, coverage,
            breaker state, killswitch state, recent runs. */}
        <ErrorBoundary label="Enrichment dashboard">
          <EnrichmentDashboard userLogin={userLogin} />
        </ErrorBoundary>
      </PageSection>
      <PageSection title="Recommendation track record">
        <ErrorBoundary label="Track Record panel">
          <ScreeningOutcomesPanel userLogin={userLogin} />
        </ErrorBoundary>
      </PageSection>
    </PageShell>
  );
}
