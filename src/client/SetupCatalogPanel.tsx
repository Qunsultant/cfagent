import { useState, useEffect } from "react";
import { Button, CardHeader } from "./components/ui";

interface SetupSignature {
  description: string;
  indicators: string[];
  guardrails: Record<string, number>;
}

interface MarketSetup {
  id: string;
  label: string;
  description: string;
  assetClass: "stock" | "options" | "both";
  signature: SetupSignature;
  pairedStrategies: string[];
  riskNotes: string[];
}

/**
 * Issue #650: browse the market setup catalog (#435) in the UI.
 * Filter by family, see the defining rules, launch a screen from a setup.
 */
export function SetupCatalogPanel({ onLaunchScreen }: { onLaunchScreen?: (setupId: string) => void }) {
  const [setups, setSetups] = useState<MarketSetup[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/trading/setup-catalog")
      .then((r) => r.json())
      .then((d: any) => setSetups(d.setups || []))
      .finally(() => setLoading(false));
  }, []);

  const filtered = filter === "all" ? setups : setups.filter((s) => s.assetClass === filter || s.assetClass === "both");

  return (
    <div className="setup-catalog-panel">
      <CardHeader title="Setup Catalog" />
      <div className="review-filters">
        {["all", "stock", "options"].map((f) => (
          <Button
            key={f}
            className={`filter-chip ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f[0].toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>
      {loading && <div className="loading">Loading setups…</div>}
      {filtered.map((s) => (
        <div key={s.id} className="review-card">
          <div className="review-header">
            <span className="review-label">{s.label}</span>
            <span className={`quant-badge ${s.assetClass}`}>{s.assetClass}</span>
          </div>
          <div className="review-rationale">{s.description}</div>
          <div className="setup-signature">
            <strong>Signature:</strong> {s.signature.description}
            <div className="setup-indicators">
              {s.signature.indicators.map((i) => (
                <span key={i} className="indicator-chip">{i}</span>
              ))}
            </div>
          </div>
          {s.pairedStrategies.length > 0 && (
            <div className="setup-strategies">
              <strong>Pairs with:</strong> {s.pairedStrategies.join(", ")}
            </div>
          )}
          {s.riskNotes.length > 0 && (
            <div className="setup-risks">
              {s.riskNotes.map((n, i) => (
                <div key={i} className="risk-note">⚠️ {n}</div>
              ))}
            </div>
          )}
          {onLaunchScreen && (
            <div className="review-actions">
              <Button className="approve-btn" onClick={() => onLaunchScreen(s.id)}>
                ▶ Screen this setup
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
