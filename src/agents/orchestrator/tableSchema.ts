/**
 * Issue #2942 (orchestrator split, under #2764) — the orchestrator's
 * table-schema ensure, moved verbatim from OrchestratorAgent.ensureTables
 * (moves only, no behaviour change). The class keeps a thin wrapper so
 * every existing call site (contexts, routes, getOrm) is untouched.
 *
 * One owner per table (ADR 0022 D-A): shared mas_* tables come from the
 * canonical DDL in src/orm/schema; orchestrator-owned families compose
 * through the orchestrator-table ports; async-job tables through the
 * async-job ports. The ensure order below is the legacy order and is
 * load-bearing (retention indexes need mas_messages/mas_events first).
 */
import { ensureSharedTable, ensureTransactionTenantColumn } from "../../orm/schema";
import { ensureAsyncJobTables } from "./asyncJobs";
import { ensureMasRetentionIndexes } from "../../services/masRetentionIndexes";
import { createOrchestratorTablePorts } from "../../data/createOrchestratorTablePorts";
import { createOrmPorts } from "../../data/createOrmPorts";
import type { AgentContext } from "agents";

/** The Durable Object SQL handle, as the SDK types it. */
type SqlStorage = AgentContext["storage"]["sql"];

/** Ensure every table the orchestrator owns or shares; returns the SQL handle. */
export function ensureOrchestratorTables(sql: SqlStorage): SqlStorage {
  // Shared mas_* tables come from the canonical DDL in src/orm/schema
  // (issue #782) — do not re-add their DDL here.
  ensureSharedTable(sql, "mas_messages");
  // Issue #2358 (#1976 step 4a): mas_async_jobs' DDL moved behind
  // the async-job queue port (one owner per table, ADR 0022 D-A).
  // This one call runs the family's whole schema ensure: the base
  // table, the session index, the already-running gate's seek
  // index (issue #2280 slice 2 — created right after the table,
  // so no lazy-creation ordering issue), and the probed job-graph
  // migration (issue #1123: parent/sub-job tracking columns,
  // additive).
  ensureAsyncJobTables(sql);
  ensureSharedTable(sql, "mas_events");
  // Issue #2280 (slice 3): the nightly retention batches' covering indexes.
  // Both tables exist by now (mas_messages above, mas_events just created),
  // so no lazy-creation ordering issue.
  ensureMasRetentionIndexes(sql);
  ensureSharedTable(sql, "mas_memory");
  // Issue #2359 (#1976 step 4d): the four orchestrator-owned
  // tables' DDL moved behind the orchestrator-table ports (one
  // owner per table, ADR 0022 D-A). These calls run the four
  // families' schema ensures in the legacy order: autopilot
  // state, report confirmations (with the probed #308
  // report_id migration), screener presets, policy verdicts
  // (with its created-at index).
  const tablePorts = createOrchestratorTablePorts(sql);
  // Autopilot policy state (autopilot Phase 1): server-owned run state,
  // limits, kill switch, and daily order budget. Previously all four lived in
  // browser localStorage, so a reload cleared the kill switch and a second
  // browser ran its own envelope.
  tablePorts.autopilot.ensureSchema();
  // Server-owned settings (issue #277): per-key runtime flags readable by
  // the agent and writable through the /trading/settings routes.
  // Issue #2390 (step 4g, gate G-7 ruled): the mas_settings DDL
  // is owned by the dedicated settings port's adapter — this
  // composition invokes its ensureSchema() and the class file
  // no longer carries the CREATE. (Issue #2359 deliberately
  // left the DDL here pending exactly this ruling.)
  createOrmPorts(sql).settings.ensureSchema();
  // Issue #277: pending HITL confirmations for research-report dispatch.
  // Payloads are stored verbatim at creation time; the actual email or
  // webhook send happens only when a human approves via
  // POST /trading/reports/confirm. Mirrors the /payments/confirm flow.
  // Issue #308: payload_json carries delivery metadata only (recipient /
  // fileName / title); the report bytes themselves live once in
  // mas_reports, referenced by report_id. Legacy rows (pre-#308) carry
  // the full payload in payload_json and are read via a fallback.
  tablePorts.confirmations.ensureSchema();
  // Issue #1495 (#940-A): user-scoped screener presets (DO/SQLite, not KV per #415); criteria validated by the run path's strict parsers before storage.
  tablePorts.presets.ensureSchema();
  // Append-only verdict ledger: every policy decision, its inputs, and a
  // signature produced server-side where the decision is made.
  tablePorts.verdicts.ensureSchema();
  ensureSharedTable(sql, "mas_referrals");
  ensureSharedTable(sql, "mas_ads");

  ensureSharedTable(sql, "mas_watchlists");

  // Seed default sponsor offers if ads table is empty.
  // Issue #2359 (#1976 step 4d): the count + inserts serve
  // through the step-3a ads repository port (the table's port
  // home) instead of raw statements here. The count==0 gate
  // makes the port's insert-or-throw equivalent to the legacy
  // INSERT OR IGNORE: the loop only runs on an empty table,
  // so no conflicting row can exist.
  try {
    const ads = createOrmPorts(sql).ads;
    if (ads.count() === 0) {
      const now = new Date().toISOString();
      const seedAds = [
        {
          id: "ad_workers_ai",
          title: "Cloudflare Workers AI",
          tagline: "Run state-of-the-art models (GLM-4.7, Llama 3.3) on serverless GPUs with zero cold starts.",
          sponsor: "Cloudflare",
          badge: "FLAGSHIP PARTNER",
          url: "https://developers.cloudflare.com/workers-ai/",
          cta_text: "Deploy in 60s →",
          accent_color: "#f38020",
        },
        {
          id: "ad_ai_search",
          title: "Cloudflare AI Search",
          tagline: "Build enterprise RAG pipelines with native auto-chunking, Vectorize indexes, and real-time semantic retrieval.",
          sponsor: "Cloudflare AI",
          badge: "FEATURED TOOL",
          url: "https://developers.cloudflare.com/ai-search/",
          cta_text: "Explore Docs →",
          accent_color: "#38bdf8",
        },
        {
          id: "ad_durable_objects",
          title: "Durable Objects SQLite",
          tagline: "Strongly consistent transactional databases running natively at the edge for stateful AI agents.",
          sponsor: "Cloudflare Platform",
          badge: "INFRASTRUCTURE",
          url: "https://developers.cloudflare.com/durable-objects/",
          cta_text: "Learn More →",
          accent_color: "#a855f7",
        },
        {
          id: "ad_openaimp",
          title: "OpenAIMP Agent Studio",
          tagline: "Scale autonomous multi-agent workflows with real-time LLM Judge routing and persistent memory.",
          sponsor: "OpenAIMP",
          badge: "SPONSOR",
          url: "https://agent.openaimp.com",
          cta_text: "Join Program →",
          accent_color: "#10b981",
        },
      ];

      for (const ad of seedAds) {
        ads.create({
          id: ad.id,
          title: ad.title,
          tagline: ad.tagline,
          sponsor: ad.sponsor,
          badge: ad.badge,
          url: ad.url,
          ctaText: ad.cta_text,
          accentColor: ad.accent_color,
          impressions: 0,
          clicks: 0,
          createdAt: now,
        });
      }
    }
  } catch {
    // Ignore if seeding fails
  }

  ensureSharedTable(sql, "mas_transactions");
  // Issue #3182: tenant column on pre-existing tables.
  ensureTransactionTenantColumn(sql);

  // Issue #175: this store previously seeded two fabricated "default"
  // transactions on first use — completed charges carrying invented
  // proof signatures and live-shaped gateway references, stamped with
  // the user's own DID as authorizer and rendered by the payments
  // ledger (including its volume/completed summary) as real payments.
  // They are removed, not relabelled: nothing depends on them (wallet
  // status counts only x402/mpp rows; the confirm flow requires a
  // "previewed" draft, which these never were). Real draft ids are
  // `pay_` + 8 random hex characters, so the two seed ids can only
  // ever have come from that seeding — purge exactly those rows from
  // stores seeded before this fix.
  try {
    // Issue #2359 (#1976 step 4d): the purge serves through
    // the step-3a transaction-ledger port (the table's port
    // home) instead of raw DELETEs here.
    const transactions = createOrmPorts(sql).transactions;
    transactions.delete("pay_init_stripe");
    transactions.delete("pay_init_paypal");
  } catch {
    // Ignore if the purge fails
  }

  return sql;
}
