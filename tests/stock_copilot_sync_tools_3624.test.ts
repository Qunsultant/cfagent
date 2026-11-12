// @vitest-environment jsdom
/**
 * Issue #3624 (#3605) — Stock Copilot Synchronous MCP Execution & Clickable Job Links.
 *
 * Verifies:
 * 1. isSynchronousMcpTool identifies synchronous tools:
 *    - get_async_job, list_async_jobs
 *    - stock_copilot_status, stock_copilot_control, stock_copilot_introspect,
 *      stock_copilot_learnings, stock_copilot_evaluate.
 * 2. handleOpenaimpMcpHttpRequest executes Stock Copilot tools synchronously even when
 *    submitJob is present on the context (never wraps them into async jobs).
 * 3. renderInlineFormatted parses markdown links [text](url), bare /api/jobs/:id links,
 *    and URLs into clickable anchor elements.
 * 4. ScheduleRunLedgerPanel renders Job and Async job IDs as clickable links to /api/jobs/:id.
 */

import { describe, it, expect, vi } from "vitest";
import React from "react";
import {
  SYNCHRONOUS_MCP_TOOLS,
  isSynchronousMcpTool,
} from "../src/config/asyncJobModes";
import { renderInlineFormatted } from "../src/client/chat/renderInlineFormatted";
import { handleOpenaimpMcpHttpRequest } from "../src/mcps/openaimp/handler";
import type { OpenaimpMcpHandlerContext } from "../src/mcps/openaimp/handler";

describe("Issue #3624: Synchronous MCP tools classification", () => {
  it("classifies Stock Copilot tools as synchronous", () => {
    expect(isSynchronousMcpTool("stock_copilot_status")).toBe(true);
    expect(isSynchronousMcpTool("stock_copilot_control")).toBe(true);
    expect(isSynchronousMcpTool("stock_copilot_introspect")).toBe(true);
    expect(isSynchronousMcpTool("stock_copilot_learnings")).toBe(true);
    expect(isSynchronousMcpTool("stock_copilot_evaluate")).toBe(true);
  });

  it("classifies status/reader tools as synchronous", () => {
    expect(isSynchronousMcpTool("get_async_job")).toBe(true);
    expect(isSynchronousMcpTool("list_async_jobs")).toBe(true);
    expect(isSynchronousMcpTool("get_pipeline_chain_status")).toBe(true);
    expect(isSynchronousMcpTool("list_pipeline_chains")).toBe(true);
    expect(isSynchronousMcpTool("run_pipeline_chain")).toBe(true);
    expect(isSynchronousMcpTool("resume_pipeline_chain")).toBe(true);
    expect(isSynchronousMcpTool("get_feed_job_status")).toBe(true);
    expect(isSynchronousMcpTool("list_feed_jobs")).toBe(true);
    expect(isSynchronousMcpTool("get_enrich_job_status")).toBe(true);
    expect(isSynchronousMcpTool("list_enrich_jobs")).toBe(true);
    expect(isSynchronousMcpTool("get_analyze_job_status")).toBe(true);
    expect(isSynchronousMcpTool("list_analyze_jobs")).toBe(true);
    expect(isSynchronousMcpTool("get_generate_job_status")).toBe(true);
    expect(isSynchronousMcpTool("list_generate_jobs")).toBe(true);
    expect(isSynchronousMcpTool("get_deliver_job_status")).toBe(true);
    expect(isSynchronousMcpTool("list_deliver_jobs")).toBe(true);
    expect(isSynchronousMcpTool("stock_copilot_remediate_gaps")).toBe(true);
    expect(isSynchronousMcpTool("get_payment_budget")).toBe(true);
    expect(isSynchronousMcpTool("check_payment_budget")).toBe(true);
    expect(isSynchronousMcpTool("alpaca_place_order")).toBe(true);
    expect(isSynchronousMcpTool("alpaca_preview_order")).toBe(true);
    expect(isSynchronousMcpTool("alpaca_get_quote")).toBe(true);
    expect(isSynchronousMcpTool("alpaca_orders")).toBe(true);
    expect(isSynchronousMcpTool("alpaca_positions")).toBe(true);
  });

  it("keeps heavy/batch capabilities asynchronous", () => {
    expect(isSynchronousMcpTool("run_stock_screen")).toBe(false);
    expect(isSynchronousMcpTool("run_options_strategy_screen")).toBe(false);
    expect(isSynchronousMcpTool("execute_nlq")).toBe(false);
  });
});

describe("Issue #3624: MCP handler synchronous execution under submitJob context", () => {
  it("executes stock_copilot_status synchronously without calling submitJob", async () => {
    const submitJob = vi.fn().mockResolvedValue({
      jobId: "mock-job-id",
      status: "queued",
      statusUrl: "/api/jobs/mock-job-id",
    });

    const mockSql = {
      exec: vi.fn().mockImplementation((query: string) => {
        const q = query.trim().toUpperCase();
        if (q.startsWith("SELECT") && q.includes("COPILOT_POSITIONS")) return [];
        if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_ACTIVITY")) return [];
        if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_CONTROL")) return [];
        return [];
      }),
    };

    const ctx: OpenaimpMcpHandlerContext = {
      env: {
        STOCK_COPILOT_PAPER_ENABLED: "1",
        HTTP_DELIVERY_MODE: "queued",
      } as any,
      orm: {} as any,
      sessionId: "session-123",
      actingLogin: () => "alice",
      submitJob,
      audit: vi.fn(),
      principal: { kind: "session", login: "alice" },
    };

    // Construct JSON-RPC tools/call for stock_copilot_status
    const req = new Request("https://agent.internal/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-login": "alice",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "stock_copilot_status",
          arguments: {},
        },
      }),
    });

    // Provide context with storage for DO SQLite
    (ctx as any).storage = { sql: mockSql };

    const res = await handleOpenaimpMcpHttpRequest(req, ctx);
    expect(res.status).toBe(200);

    // submitJob MUST NOT be invoked because stock_copilot_status is synchronous!
    expect(submitJob).not.toHaveBeenCalled();

    const data = await res.json() as any;
    expect(data.error).toBeUndefined();
    expect(data.result).toBeDefined();
    // Result contains live synchronous copilot telemetry
    expect(data.result.content).toBeDefined();
  });
});

describe("Issue #3605 & #3624: renderInlineFormatted clickable links", () => {
  it("formats markdown links [Label](url) as clickable anchors", () => {
    const rendered = renderInlineFormatted("Check out [Job Details](/api/jobs/371fc175-2446-445f-8aee-31c57677d5a2) now.");
    expect(Array.isArray(rendered)).toBe(true);

    const anchor = (rendered as any[]).find((el) => React.isValidElement(el) && el.type === "a");
    expect(anchor).toBeDefined();
    expect(anchor.props.href).toBe("/api/jobs/371fc175-2446-445f-8aee-31c57677d5a2");
    expect(anchor.props.children).toBe("Job Details");
    expect(anchor.props.target).toBe("_blank");
  });

  it("formats relative tab links [Label](?tab=workflow-runs) as clickable anchors without blank target", () => {
    const rendered = renderInlineFormatted("Check [Live Workflow Runs](?tab=workflow-runs) now.");
    expect(Array.isArray(rendered)).toBe(true);

    const anchor = (rendered as any[]).find((el) => React.isValidElement(el) && el.type === "a");
    expect(anchor).toBeDefined();
    expect(anchor.props.href).toBe("?tab=workflow-runs");
    expect(anchor.props.children).toBe("Live Workflow Runs");
    expect(anchor.props.target).toBeUndefined();
    expect(anchor.props.rel).toBeUndefined();
  });

  it("formats bare /api/jobs/:id paths as clickable anchors", () => {
    const rendered = renderInlineFormatted("Status URL: /api/jobs/82dded10-6669-4f24-ab89-4391b577a3b0 for your job.");
    const anchor = (rendered as any[]).find((el) => React.isValidElement(el) && el.type === "a" && el.props.href.startsWith("/api/jobs/"));
    expect(anchor).toBeDefined();
    expect(anchor.props.href).toBe("/api/jobs/82dded10-6669-4f24-ab89-4391b577a3b0");
    expect(anchor.props.children).toBe("/api/jobs/82dded10-6669-4f24-ab89-4391b577a3b0");
  });

  it("formats bare http/https URLs as clickable anchors", () => {
    const rendered = renderInlineFormatted("Visit https://paper-api.alpaca.markets for Alpaca Paper endpoint.");
    const anchor = (rendered as any[]).find((el) => React.isValidElement(el) && el.type === "a" && el.props.href.startsWith("https://"));
    expect(anchor).toBeDefined();
    expect(anchor.props.href).toBe("https://paper-api.alpaca.markets");
  });

  it("preserves bold and inline code formatting", () => {
    const rendered = renderInlineFormatted("This is **bold** and `code` formatting.");
    const boldEl = (rendered as any[]).find((el) => React.isValidElement(el) && el.type === "strong");
    const codeEl = (rendered as any[]).find((el) => React.isValidElement(el) && el.type === "code");
    expect(boldEl).toBeDefined();
    expect(boldEl.props.children).toBe("bold");
    expect(codeEl).toBeDefined();
    expect(codeEl.props.children).toBe("code");
  });
});

describe("Issue #3605 & #3624: ScheduleRunLedgerPanel and ToolResultView clickable links", () => {
  it("renders Job and Async job IDs as interactive controls in ScheduleRunLedgerPanel", async () => {
    const { ScheduleRunLedgerPanel } = await import("../src/client/ScheduleRunLedgerPanel");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const mockRun = {
      jobId: "job-12345",
      operation: "Test Run",
      system: "orchestrator",
      started: new Date().toISOString(),
      outcome: "success" as const,
      triggeredBy: "user",
      trigger: "manual",
      scheduleId: "sched-999",
      asyncJobId: "async-abc-777",
      workflowId: "wf-456",
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      // The one merged read (#3123): the panel reads runs only from
      // GET /api/ledger/runs now.
      if (url.includes("/api/ledger/runs")) {
        return Promise.resolve(new Response(JSON.stringify({ runs: [mockRun] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    });

    try {
      await act(async () => {
        root.render(React.createElement(ScheduleRunLedgerPanel));
      });
      // Settle promises
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const buttons = Array.from(container.querySelectorAll("button"));
      const jobBtn = buttons.find((b) => b.textContent?.includes("job-12345"));
      const asyncJobBtn = buttons.find((b) => b.textContent?.includes("async-abc-777"));

      expect(jobBtn).toBeDefined();
      expect(jobBtn?.getAttribute("title")).toContain("job-12345");
      expect(asyncJobBtn).toBeDefined();
      expect(asyncJobBtn?.getAttribute("title")).toContain("async-abc-777");
    } finally {
      globalThis.fetch = originalFetch;
      root.unmount();
      container.remove();
    }
  });

  it("renders clickable review job link in ToolResultView for async jobs", async () => {
    const { ToolResultView } = await import("../src/client/chat/ToolResultView");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(ToolResultView, {
            toolType: "async_job_runner",
            data: {
              jobId: "job-xyz-888",
              status: "queued",
              statusUrl: "/api/jobs/job-xyz-888",
            },
          })
        );
      });

      const link = container.querySelector("a.job-link-btn");
      expect(link).toBeDefined();
      expect(link?.getAttribute("href")).toBe("/api/jobs/job-xyz-888");
      expect(link?.textContent).toContain("job-xyz-888");
    } finally {
      root.unmount();
      container.remove();
    }
  });
});

