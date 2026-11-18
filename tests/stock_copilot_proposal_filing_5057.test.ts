/**
 * Issue #5057 (AG-3) — the governed RSI pathway files its issue.
 *
 * `synthesizeCapabilityProposals` produced a complete governed pathway
 * (target issue title, lane, actionable plan) and nothing dispatched it.
 * These tests pin the dispatch: the existing GitHub filer seam, an explicit
 * human approval before any network call, a §5-shaped issue built from the
 * proposal's own words, audit on success and on failure, and coded refusals
 * when the approval or the token is missing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  COPILOT_PROPOSAL_APPROVAL_REQUIRED,
  COPILOT_PROPOSAL_DEFAULT_REPO,
  COPILOT_PROPOSAL_FILER_UNAVAILABLE,
  CopilotProposalFilingError,
  buildGovernedProposalIssue,
  fileGovernedProposal,
  resolveCopilotProposalFiler,
} from "../src/services/stockCopilotProposalFiling";
import type { CapabilityImprovementProposal } from "../src/services/stockCopilotIntrospection";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import {
  fileStockCopilotProposalViaDoor,
  type StockCopilotDoorContext,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import type { MeshProposalFiler } from "../src/services/meshProposalPipeline";

function proposal(
  overrides: Partial<CapabilityImprovementProposal> = {},
): CapabilityImprovementProposal {
  return {
    gapId: "GAP_TEST_DYNAMIC_UNIVERSE",
    title: "Dynamic Momentum Universe Expansion (via ScreenerAgent)",
    diagnosis: "The watch universe is limited to a static symbol list.",
    neededCapabilities: ["Dynamic high-momentum screening"],
    leveragedTools: {
      domain: ["screenerAgent"],
      platform: ["thinkWorkflow"],
    },
    synthesisPath: "Invoke ScreenerAgent at the session open.",
    readiness: "suggestion",
    governedPathway: {
      targetIssueTitle: "[Stock Copilot] Dynamic Universe Ingestion from ScreenerAgent",
      lane: "lane:clo-arsi",
      actionablePlan: "Draft and publish a GitHub issue with TDD acceptance criteria.",
    },
    selfRsiPathway: {
      platformTool: "thinkWorkflow",
      autonomousAction: "Trigger ScreenerAgent on session start.",
    },
    ...overrides,
  };
}

function recordingFiler() {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const filer: MeshProposalFiler = {
    async file(issue) {
      calls.push(issue);
      return { number: 6001, url: "https://github.com/Qunsultant/cfagent/issues/6001" };
    },
  };
  return { filer, calls };
}

describe("Issue #5057 — governed proposal filing", () => {
  describe("1. The issue the pathway files", () => {
    it("renders the §5 task shape from the proposal's own fields", () => {
      const issue = buildGovernedProposalIssue(proposal(), {
        approvedBy: "trader1",
        approvedAt: "2026-11-18T12:00:00Z",
      });

      expect(issue.title).toBe(
        "[Stock Copilot] Dynamic Universe Ingestion from ScreenerAgent",
      );
      expect(issue.labels).toEqual(["lane:clo-arsi", "enhancement"]);
      expect(issue.body).toContain("## Agent");
      expect(issue.body).toContain(proposal().diagnosis);
      expect(issue.body).toContain(proposal().governedPathway.actionablePlan);
      expect(issue.body).toContain("GAP_TEST_DYNAMIC_UNIVERSE");
      expect(issue.body).toContain("trader1");
    });

    it("prefixes a title that carries no type marker", () => {
      const issue = buildGovernedProposalIssue(
        proposal({
          governedPathway: {
            ...proposal().governedPathway,
            targetIssueTitle: "Dynamic Universe Ingestion",
          },
        }),
        { approvedBy: "trader1" },
      );
      expect(issue.title).toBe("[Enhancement] - Dynamic Universe Ingestion");
    });
  });

  describe("2. The approval posture", () => {
    it("refuses to file without an explicit human approver", async () => {
      const { filer, calls } = recordingFiler();
      await expect(
        fileGovernedProposal({ proposal: proposal(), approvedBy: "  ", filer }),
      ).rejects.toMatchObject({ code: COPILOT_PROPOSAL_APPROVAL_REQUIRED });
      expect(calls).toHaveLength(0);
    });

    it("refuses to file without a filer, and says which variable is missing", async () => {
      await expect(
        fileGovernedProposal({
          proposal: proposal(),
          approvedBy: "trader1",
          filer: null,
        }),
      ).rejects.toMatchObject({ code: COPILOT_PROPOSAL_FILER_UNAVAILABLE });
    });
  });

  describe("3. Filing", () => {
    it("files the built issue and audits the dispatch", async () => {
      const { filer, calls } = recordingFiler();
      const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];

      const filed = await fileGovernedProposal({
        proposal: proposal(),
        approvedBy: "trader1",
        filer,
        audit: (type, _agent, payload) => audits.push({ type, payload }),
      });

      expect(filed.number).toBe(6001);
      expect(calls).toHaveLength(1);
      expect(calls[0].labels).toContain("lane:clo-arsi");
      expect(audits).toHaveLength(1);
      expect(audits[0].type).toBe("stock_copilot.proposal_filed");
      expect(audits[0].payload.issueNumber).toBe(6001);
      expect(audits[0].payload.approvedBy).toBe("trader1");
    });

    it("audits a failed filing and rethrows", async () => {
      const audits: string[] = [];
      const failing: MeshProposalFiler = {
        async file() {
          throw new Error("GitHub issue filing failed: 403");
        },
      };

      await expect(
        fileGovernedProposal({
          proposal: proposal(),
          approvedBy: "trader1",
          filer: failing,
          audit: (type) => audits.push(type),
        }),
      ).rejects.toThrow("403");

      expect(audits).toEqual(["stock_copilot.proposal_filing_failed"]);
    });
  });

  describe("4. The filer comes from the deployment env", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("is null when no token is configured", () => {
      expect(resolveCopilotProposalFiler({} as any)).toBeNull();
    });

    it("posts to the configured repository when a token is present", async () => {
      const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ number: 42, html_url: "u" }), {
          status: 201,
        });
      });

      const filer = resolveCopilotProposalFiler({
        GITHUB_ISSUE_TOKEN: "tok",
      } as any);
      expect(filer).not.toBeNull();
      const filed = await filer!.file({ title: "t", body: "b", labels: [] });

      expect(filed.number).toBe(42);
      expect(requests[0].url).toBe(
        `https://api.github.com/repos/${COPILOT_PROPOSAL_DEFAULT_REPO}/issues`,
      );
    });
  });

  describe("5. The door surface", () => {
    const ctx = (overrides: Partial<StockCopilotDoorContext> = {}) =>
      ({
        user: { login: "trader1", email: "trader@example.com" },
        env: {},
        sql: { exec: () => [] },
        readSettingRaw: () => null,
        ...overrides,
      }) as unknown as StockCopilotDoorContext;

    it("files an approved proposal and returns the issue", async () => {
      const { filer } = recordingFiler();
      const filed = await fileStockCopilotProposalViaDoor(
        ctx({ proposalFiler: filer }),
        "trader1",
        { gapId: "GAP_TEST_DYNAMIC_UNIVERSE", approve: true },
        [proposal()],
      );
      expect(filed.gapId).toBe("GAP_TEST_DYNAMIC_UNIVERSE");
      expect(filed.number).toBe(6001);
    });

    it("refuses without approval", async () => {
      const { filer } = recordingFiler();
      await expect(
        fileStockCopilotProposalViaDoor(
          ctx({ proposalFiler: filer }),
          "trader1",
          { gapId: "GAP_TEST_DYNAMIC_UNIVERSE", approve: false },
          [proposal()],
        ),
      ).rejects.toMatchObject({ code: "proposal_approval_required" });
    });

    it("refuses an unknown gap id", async () => {
      const { filer } = recordingFiler();
      await expect(
        fileStockCopilotProposalViaDoor(
          ctx({ proposalFiler: filer }),
          "trader1",
          { gapId: "GAP_DOES_NOT_EXIST", approve: true },
          [proposal()],
        ),
      ).rejects.toMatchObject({ code: "proposal_not_found" });
    });

    it("refuses with the filer code when no token is configured", async () => {
      await expect(
        fileStockCopilotProposalViaDoor(ctx(), "trader1", {
          gapId: "GAP_TEST_DYNAMIC_UNIVERSE",
          approve: true,
        }, [proposal()]),
      ).rejects.toBeInstanceOf(MeshDoorError);
    });
  });
});
