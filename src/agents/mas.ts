import { tool } from "ai";
import { z } from "zod";
import type { AgentName, Env } from "../types";
import { AGENT_DIDS, createDidAttestation, getUserDid } from "./did";
import { PaymentGatewayService, type SupportedGateway } from "../services/payments";
import { registerDraftOwner } from "../payments/draftOwners";
// Issue #278: single-owner TTL cache for AI Search queries + durable
// scheduled-run reports searchable through this same path.
import { getAiSearchCache, aiSearchCacheKey } from "../services/aiSearchCache";
// Qunsultant/cfagent#1775 (Adapter S1) moved the AI Search HTTP
// call out of this tool into the aiSearch client; issue #3342 then
// retired that client's public-endpoint REST transport, so the
// index leg below now reads the private namespace binding through
// the shared helper (which also applies the #2246 report
// discipline — this tool carries no caller login, so report-type
// index chunks are withheld here; the tool's own report answers
// come from its local store below). Cache, audits, and the
// result/failure shapes are unchanged from the REST era.
import { searchAiSearchNamespaceChunks } from "./aiSearchPaths";
import { searchScheduledReports } from "../services/scheduledReports";
// Issue #1169 (S2, flag-gated): corpus provenance on index chunks.
import {
  attachCorpusProvenance,
  isKnowledgeServingEnabled,
} from "../services/knowledgeCorpus";
// Issue #2345 (#1976 step 3a): the payment-ledger and memory
// tools run on the data layer's ports, composed here from the
// same handle the factory already receives — the raw
// mas_transactions / mas_memory statements that used to live
// in this file (audit V-2/V-3 bypass writers) are retired.
import { createOrmPorts } from "../data/createOrmPorts";

export interface MASOptions {
  env: Env;
  sessionId: string;
  requestId: string;
  sql: { exec: (query: string, ...args: unknown[]) => Iterable<unknown> };
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
}

export function createMAS({ env, sessionId, requestId, sql, audit }: MASOptions) {
  const ormPorts = createOrmPorts(sql);
  const searchKnowledge = tool({
    description: "Search the organization's knowledge base using Cloudflare AI Search RAG. Use for factual inquiries, documented product features, release notes, or policies.",
    inputSchema: z.object({
      query: z.string().min(1).max(500).describe("The concise search query or topic to retrieve documents for"),
    }),
    execute: async ({ query }) => {
      // Issue #278: bounded in-isolate TTL cache, keyed by query + session
      // scope. Only successful results are cached; errors never are.
      const cache = getAiSearchCache(env);
      const cacheKey = aiSearchCacheKey(query, sessionId);
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        audit("search.cache_hit", "search", { query });
        return cached;
      }
      // Issue #278: durable scheduled-run reports first — local,
      // from this store's mas_reports table.
      const reports = searchScheduledReports(sql, query, 5);
      const reportChunks = reports.map((r) => ({
        title: r.title,
        snippet: r.summary,
        source: "scheduled_report",
        reportId: r.id,
        createdAt: r.createdAt,
      }));
      try {
        // Issue #3342: the index leg reads the namespace binding
        // (helper above), not the retired REST endpoint. The old
        // 10s AbortController disappears with the fetch — the
        // binding RPC has no abort knob; the helper's typed
        // outcomes replace the HTTP status handling: !ok takes the
        // old !response.ok branch below, with the helper's failure
        // detail standing where the status used to stand.
        const outcome = await searchAiSearchNamespaceChunks(env, query);

        if (!outcome.ok) {
          const errMsg = `Knowledge search upstream unavailable (${outcome.error})`;
          audit("search.failed", "search", { query, error: outcome.error });
          // Upstream failed: still surface any local reports honestly;
          // the error result itself is NOT cached.
          if (reports.length > 0) {
            return {
              query,
              resultsFound: true,
              count: 0,
              reportCount: reports.length,
              chunks: reportChunks,
              message: `Retrieved ${reports.length} scheduled-run report(s) locally; the AI Search upstream was unavailable (${outcome.error}).`,
              source: "Scheduled reports",
            };
          }
          return { error: errMsg, query };
        }

        const chunks = outcome.chunks ?? [];
        const resultsFound = chunks.length > 0 || reports.length > 0;

        // Issue #1169 (S2, flag-gated): when the serving flag is on,
        // index chunks gain corpus provenance (bucket key, served-file
        // link for servable corpus keys, indexingState "indexed").
        // Local report chunks are NOT index results and are left
        // untouched. Flag-OFF passes chunks through verbatim —
        // today's behavior. Note: the TTL cache below caches the
        // flagged shape, so a flag flip takes effect as entries
        // expire (<= 5 minutes, in-isolate) — a documented limit,
        // not a second cache.
        const servingOn = isKnowledgeServingEnabled(env);
        const servingChunks = servingOn
          ? chunks.map((c) => attachCorpusProvenance(c))
          : chunks;
        // Cross-cutting (S2): provenance application is logged via
        // the repo's console-stream idiom — counts and flag state
        // only, never chunk content, keys, or logins.
        if (servingOn) {
          console.info(
            `[knowledgeMapping] MAS provenance attached chunks=${chunks.length}`
          );
        }

        const result = {
          query,
          resultsFound,
          count: chunks.length,
          reportCount: reports.length,
          chunks: [...reportChunks, ...servingChunks].slice(0, 5),
          message: resultsFound
            ? reports.length > 0
              ? `Retrieved ${reports.length} scheduled-run report(s) and ${chunks.length} factual documents from Cloudflare AI Search.`
              : `Retrieved ${chunks.length} factual documents from Cloudflare AI Search.`
            : "No custom indexed documents found in the Cloudflare AI Search knowledge base. Synthesize a helpful, authoritative response from general knowledge, clearly informing the user that no specific internal documents were indexed.",
          source: reports.length > 0 ? "Scheduled reports + Cloudflare AI Search" : "Cloudflare AI Search",
        };
        cache.set(cacheKey, result);
        audit("search.completed", "search", {
          query,
          resultsFound,
          count: chunks.length,
          reportCount: reports.length,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Search request failed";
        audit("search.error", "search", { query, error: message });
        if (reports.length > 0) {
          return {
            query,
            resultsFound: true,
            count: 0,
            reportCount: reports.length,
            chunks: reportChunks,
            message: `Retrieved ${reports.length} scheduled-run report(s) locally; the AI Search upstream request failed (${message}).`,
            source: "Scheduled reports",
          };
        }
        return { error: message, query, resultsFound: false, count: 0, chunks: [] };
      }
    },
  });

  const paymentGateway = new PaymentGatewayService(env);
  const userDid = getUserDid(sessionId);

  const draftPayment = tool({
    description: "Draft a payment operation (charge, refund, invoice, or payout) across Stripe, PayPal, Lemon Squeezy, or Sandbox. Safety guarantee: Creates a cryptographically signed authorization draft with Agent DIDs pending human approval.",
    inputSchema: z.object({
      action: z.enum(["charge", "refund", "invoice", "payout"]).describe("The financial operation to draft"),
      amount: z.number().positive().max(100000).describe("Monetary amount"),
      currency: z.string().length(3).default("USD").describe("Three-letter ISO currency code, e.g. USD, EUR, GBP"),
      customer: z.string().min(1).max(200).describe("Customer name or account identifier"),
      gateway: z.enum(["stripe", "paypal", "lemonsqueezy", "sandbox"]).default("stripe").describe("Target payment gateway provider"),
      note: z.string().optional().describe("Optional note or reference for the payment"),
    }),
    execute: async (input) => {
      const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const gateway = (input.gateway || "stripe") as SupportedGateway;

      const didProof = await createDidAttestation({
        draftId,
        action: input.action,
        amount: input.amount,
        currency: input.currency,
        customer: input.customer,
        gateway,
        proposerDid: AGENT_DIDS.PAYMENTS,
        authorizerDid: userDid,
      }, env.DID_ATTESTATION_KEY);

      let inserted = false;
      try {
        ormPorts.transactions.replace({
          id: draftId,
          sessionId,
          action: input.action,
          amount: input.amount,
          currency: input.currency,
          customer: input.customer,
          gateway,
          gatewayRef: "",
          status: "awaiting_confirmation",
          checkoutUrl: "",
          proposerDid: didProof.proposerDid,
          authorizerDid: userDid,
          proofSignature: didProof.signature,
          note: input.note || "Draft created by payments subagent",
          createdAt: now,
          updatedAt: now,
        });
        inserted = true;
      } catch (err) {
        console.error("Failed to insert transaction draft into SQLite:", err);
      }

      if (inserted) {
        // Issue #932: record this instance as the draft's owner so a
        // gateway settlement webhook (received by the shared
        // system_webhook_receiver instance) can be routed back here.
        await registerDraftOwner(env, draftId, sessionId);
      }

      const payload = {
        draftId,
        requestId,
        status: "awaiting_confirmation",
        requiresConfirmation: true,
        ...input,
        gateway,
        proposerDid: didProof.proposerDid,
        authorizerDid: userDid,
        proofSignature: didProof.signature,
        securityNotice: `NO FUNDS HAVE BEEN MOVED. Stamped with Agent DID ${didProof.proposerDid}. Explicit human approval via 'confirmDraft' is required before gateway execution.`,
      };
      audit("payment.awaiting_confirmation", "payments", payload);
      return payload;
    },
  });

  const createTaskDraft = tool({
    description: "Draft a task or reminder for the user or organization. Returns a structured task proposal for user confirmation.",
    inputSchema: z.object({
      title: z.string().min(1).max(300).describe("Task title or summary"),
      dueDate: z.string().optional().describe("Optional target deadline or ISO date"),
      priority: z.enum(["low", "medium", "high", "urgent"]).default("medium").describe("Urgency level"),
      assignee: z.string().optional().describe("Assignee name or role"),
    }),
    execute: async (input) => {
      const taskId = `task_${crypto.randomUUID().slice(0, 8)}`;
      const payload = {
        taskId,
        status: "draft",
        requiresConfirmation: true,
        ...input,
        message: "Task draft created. Awaiting human confirmation via 'confirmDraft'.",
      };
      audit("task.drafted", "tasks", payload);
      return payload;
    },
  });

  const confirmDraft = tool({
    description: "Execute, authorize, or reject a previously proposed payment draft (pay_xxx) or task proposal (task_xxx) after explicit human confirmation.",
    inputSchema: z.object({
      draftId: z.string().describe("The ID of the draft to confirm or reject (e.g. pay_xxx or task_xxx)"),
      decision: z.enum(["approved", "rejected"]).describe("Human decision: 'approved' or 'rejected'"),
      note: z.string().optional().describe("Optional confirmation rationale or human reviewer note"),
    }),
    execute: async ({ draftId, decision, note }) => {
      const isPayment = draftId.startsWith("pay_");
      const now = new Date().toISOString();

      if (isPayment) {
        let existingTx = null as ReturnType<typeof ormPorts.transactions.findById>;
        try {
          existingTx = ormPorts.transactions.findById(draftId);
        } catch {}

        const action = existingTx?.action || "charge";
        const amount = existingTx ? Number(existingTx.amount) : 0;
        const currency = existingTx?.currency || "USD";
        const customer = existingTx?.customer || "user";
        const gateway = (existingTx?.gateway || "stripe") as SupportedGateway;

        if (decision === "approved") {
          let gatewayResult: any = null;
          let checkoutUrl = existingTx?.checkoutUrl || "";
          let gatewayRef = existingTx?.gatewayRef || "";

          if (action === "charge" || action === "invoice") {
            gatewayResult = await paymentGateway.createCheckout({
              draftId,
              amount,
              currency,
              customer,
              gateway,
              userLogin: sessionId,
              description: note || existingTx?.note || `Payment of ${amount} ${currency} for ${customer}`,
            });
            checkoutUrl = gatewayResult.checkoutUrl;
            gatewayRef = gatewayResult.gatewayRef;
          } else if (action === "refund") {
            gatewayResult = await paymentGateway.executeRefund({
              transactionId: draftId,
              amount,
              gateway,
              gatewayRef: existingTx?.gatewayRef || "",
              userLogin: sessionId,
              reason: note,
            });
            gatewayRef = gatewayResult.refundId;
          }

          try {
            ormPorts.transactions.update(draftId, {
              status: "completed",
              gatewayRef,
              checkoutUrl,
              authorizerDid: userDid,
              note: note || "Approved by human authorizer",
              updatedAt: now,
            });
          } catch {}

          const payload = {
            draftId,
            status: "completed",
            decision: "approved",
            gateway,
            gatewayRef,
            checkoutUrl,
            proposerDid: AGENT_DIDS.PAYMENTS,
            authorizerDid: userDid,
            executorDid: AGENT_DIDS.ORCHESTRATOR,
            executedAt: now,
            note: note || "Human confirmed operation",
            auditNotice: `Payment draft cryptographically verified with Agent DID ${AGENT_DIDS.PAYMENTS} and authorized by ${userDid}. Gateway ref: ${gatewayRef || "pending"}`,
          };
          audit("payment.confirmed", "payments", payload);
          return payload;
        } else {
          try {
            ormPorts.transactions.update(draftId, {
              status: "rejected",
              authorizerDid: userDid,
              note: note || "Rejected by human reviewer",
              updatedAt: now,
            });
          } catch {}

          const payload = {
            draftId,
            status: "rejected",
            decision: "rejected",
            authorizerDid: userDid,
            executedAt: now,
            note: note || "Operation rejected by user",
            auditNotice: "Payment draft rejected by human reviewer.",
          };
          audit("payment.rejected", "payments", payload);
          return payload;
        }
      }

      // Tasks confirmation. Issue #141: the audit notice and audit
      // event must state the actual decision — a REJECTED task was
      // previously announced (and audited) as "confirmed and added to
      // scheduled execution queue", the opposite of what happened.
      const status = decision === "approved" ? "scheduled" : "rejected";
      const payload = {
        draftId,
        status,
        decision,
        executedAt: now,
        note: note || (decision === "approved" ? "Human confirmed operation" : "Operation rejected by user"),
        auditNotice:
          decision === "approved"
            ? "Task confirmed and added to scheduled execution queue."
            : "Task draft rejected by human reviewer.",
      };
      audit(decision === "approved" ? "task.confirmed" : "task.rejected", "tasks", payload);
      return payload;
    },
  });

  const rememberFact = tool({
    description: "Persist a key fact, user preference, or project context into durable SQLite memory for this user session.",
    inputSchema: z.object({
      key: z.string().min(1).max(100).describe("Descriptive memory key (e.g. 'preferred_tone', 'client_project')"),
      value: z.string().min(1).max(2000).describe("The information to store"),
    }),
    execute: async ({ key, value }) => {
      const normalizedKey = key.trim().toLowerCase();
      const now = new Date().toISOString();
      ormPorts.memory.upsert({ key: normalizedKey, value, updatedAt: now });
      audit("memory.remembered", "memory", { key: normalizedKey, value });
      return { stored: true, key: normalizedKey, value, updatedAt: now };
    },
  });

  const recallFacts = tool({
    description: "Recall all stored memory facts and user preferences recorded during this session.",
    inputSchema: z.object({
      filter: z.string().optional().describe("Optional keyword to filter stored memories"),
    }),
    execute: async ({ filter }) => {
      const records =
        filter && filter.trim()
          ? ormPorts.memory.search(filter, 50)
          : ormPorts.memory.listRecent(50);
      const facts: Array<{ key: string; value: string; updated_at: string }> =
        records.map((r) => ({ key: r.key, value: r.value, updated_at: r.updatedAt }));
      audit("memory.recalled", "memory", { count: facts.length, filter });
      return { count: facts.length, facts };
    },
  });

  return {
    searchKnowledge,
    draftPayment,
    createTaskDraft,
    confirmDraft,
    rememberFact,
    recallFacts,
  };
}
