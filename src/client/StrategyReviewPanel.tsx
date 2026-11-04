import { useState, useEffect, useCallback } from "react";
import { Button } from "./components/ui";
import { csrfHeaders } from "./apiFetch";

interface StrategyReview {
  id: string;
  symbol: string;
  candidateId: string;
  label: string;
  rank: number;
  rationale: string;
  quantStatus: string;
  decision: string;
  decidedAt: string | null;
  createdAt: string;
}

/**
 * Issue #653: review UI for LLM-generated strategy candidates.
 * Shows each candidate with quant verification status, rank, and evidence;
 * approve/reject feeds back into the stored record.
 */
export function StrategyReviewPanel() {
  const [reviews, setReviews] = useState<StrategyReview[]>([]);
  const [filter, setFilter] = useState<string>("pending");
  const [loading, setLoading] = useState(true);

  const fetchReviews = useCallback(async () => {
    setLoading(true);
    try {
      const params = filter !== "all" ? `?decision=${filter}` : "";
      const res = await fetch(`/api/options/strategy-reviews${params}`);
      const data = (await res.json()) as any;
      setReviews(data.reviews || []);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchReviews(); }, [fetchReviews]);

  const decide = async (id: string, decision: "approved" | "rejected") => {
    await fetch("/api/options/strategy-reviews/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({ id, decision }),
    });
    fetchReviews();
  };

  return (
    <div className="strategy-review-panel">
      <h3>Strategy Candidates</h3>
      <div className="review-filters">
        {["pending", "approved", "rejected", "all"].map((f) => (
          <Button
            key={f}
            className={`filter-chip ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f[0].toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>
      {loading && <div className="loading">Loading candidates…</div>}
      {!loading && reviews.length === 0 && (
        <div className="empty">No {filter} candidates. Run an options analysis to generate some.</div>
      )}
      {reviews.map((r) => (
        <div key={r.id} className="review-card">
          <div className="review-header">
            <span className="review-symbol">{r.symbol}</span>
            <span className="review-rank">#{r.rank}</span>
            <span className={`quant-badge ${r.quantStatus}`}>{r.quantStatus}</span>
          </div>
          <div className="review-label">{r.label}</div>
          <div className="review-rationale">{r.rationale}</div>
          {r.decision === "pending" ? (
            <div className="review-actions">
              <Button className="approve-btn" onClick={() => decide(r.id, "approved")}>✓ Approve</Button>
              <Button className="reject-btn" onClick={() => decide(r.id, "rejected")}>✗ Reject</Button>
            </div>
          ) : (
            <div className={`review-decision ${r.decision}`}>{r.decision}</div>
          )}
        </div>
      ))}
    </div>
  );
}
