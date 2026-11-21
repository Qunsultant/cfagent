/**
 * Issue #4741 (BizCopilot, umbrella #4514) — MCP tool for tenant
 * administration through BizCopilot chat as the primary path via the
 * LLM, with the deterministic branch (src/services/bizCopilotTenants.ts)
 * staying as an option for exact commands (Mars's decision 2026-11-15:
 * MCP primary; deterministic is not removed).
 *
 * The executors are separable from the regex parsers: the tool builds
 * the same intent object from validated arguments and calls the same
 * executor, so the route calls, store-operator gate, session-scoped
 * identity, and audit are reused verbatim. No new server capability,
 * no second copilot, no gate/audit/route changes.
 *
 * Identity (S5 discipline): the acting login comes ONLY from
 * `context.actingLogin` — the resolver the chat turn populates from
 * its turn stash (the loopback carrier stamps it onto tools/call as
 * `x-user-login` and refuses unidentified calls). No fallback to
 * `sessionId`: a session identifier is not a login. Unset login
 * reaches the executor as "" and the executor answers the 401 ERROR
 * outcome — fail closed, exactly as the branch path behaves.
 *
 * The membership-write shape stays a deterministic refusal inside
 * the tool (no route call), as today. The `needs-identifier` outcome
 * is NOT a tool action: the schema requires `tenantId` for every
 * action except `list` (field description + steering + the
 * execute-time validation error below), so the model asks for the
 * id on the tool path instead of denying — the #4706 behavior, on
 * both paths. The flat schema follows the ManageReferralsCommand
 * precedent: a flat `required: ["action"]` cannot express the
 * conditional requirement, so it is carried by the field
 * description, the steering line, and the validation error.
 *
 * Audit parity: the tool emits `bizcopilot.tenant_action_executed`
 * when the executor returns (any outcome — the branch audits
 * `executed` for ERROR outcomes too) and
 * `bizcopilot.tenant_action_failed` only when the executor throws.
 * One event per executed action, from whichever path executed it.
 *
 * Scope: `mcp:admin` (MCP_TOOL_SCOPES) — platform administration;
 * under the GAP-4 correspondence it derives from the
 * platform-privilege permissions (audit:read / audit:export /
 * role:assign). The correspondence is a CISO proposal, not a
 * decision (#5350).
 *
 * Synchronous: answered in the turn, never a queued job receipt
 * (SYNCHRONOUS_MCP_TOOLS) — the executor calls the Tenants page's
 * routes in-process, bounded, no polling.
 */
import { z } from "zod";
import {
  executeBizCopilotTenantIntent,
  type BizCopilotTenantIntent,
  type BizCopilotTenantSettingsPatch,
} from "../../services/bizCopilotTenants";
import type { CommercialStore } from "../../data/commercialPorts";
import type { TenantDirectory } from "../../data/tenantDirectoryPorts";
import type { StoreOperators } from "../../data/storeOperatorsPorts";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { axisIds, resolveValue } from "../../config/vocabulary";

/** The known values, rendered once for the schema descriptions. */
const PROVIDER_IDS = axisIds("provider").join(", ");
const BROKER_IDS = axisIds("broker").join(", ");

export const BIZCOPILOT_TENANT_TOOL_ACTIONS = [
  "list",
  "create",
  "detail",
  "settings-read",
  "settings-update",
  "membership-write-refused",
] as const;

export type BizCopilotTenantToolAction = (typeof BIZCOPILOT_TENANT_TOOL_ACTIONS)[number];

const ManageTenantsInputSchema = z.object({
  action: z
    .enum(BIZCOPILOT_TENANT_TOOL_ACTIONS)
    .describe("Tenant administration operation (the six BizCopilot tenant activities)"),
  tenantId: z
    .string()
    .optional()
    .describe(
      "Tenant id — required for every action except list. When it is missing, ask the user for it instead of calling without it.",
    ),
  userId: z
    .string()
    .optional()
    .describe("User id for membership-write-refused (the member the write names)."),
  adsEnabled: z.boolean().optional().describe("Settings-update: turn ads on/off for the tenant."),
  autoRefreshEnabled: z
    .boolean()
    .optional()
    .describe("Settings-update: turn auto-refresh on/off for the tenant."),
  autoRefreshIntervalS: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Settings-update: auto-refresh interval in seconds."),
  dataProviderId: z
    .string()
    .optional()
    .describe(`Settings-update: data provider id. Known: ${PROVIDER_IDS}. An unknown id refuses by name.`),
  brokerId: z
    .string()
    .optional()
    .describe(`Settings-update: broker id. Known: ${BROKER_IDS}. An unknown id refuses by name.`),
});

type ManageTenantsInput = z.infer<typeof ManageTenantsInputSchema>;

/**
 * Test seams: the route handler's own seams (commercial / directory /
 * operators), forwarded to the executor. Production constructs with
 * no args — the executor then composes the adapters from env exactly
 * as the HTTP dispatch does. Precedent for constructor-carried seams
 * on a command: DeprecatedToolAlias.
 */
export interface ManageTenantsCommandSeams {
  commercial?: CommercialStore | null;
  directory?: TenantDirectory | null;
  operators?: Pick<StoreOperators, "listOperators"> | null;
}

function requireTenantId(input: ManageTenantsInput): string {
  const tenantId = input.tenantId?.trim() ?? "";
  if (!tenantId) {
    throw new Error(`tenantId is required for action '${input.action}'`);
  }
  return tenantId;
}

/**
 * Issue #5500 — a settings axis resolves through the whole-set vocabulary
 * (#5515) before it reaches the route: an alias resolves to its canonical id,
 * and an unknown value refuses by name with the vocabulary's own code. A chat
 * turn therefore cannot write a provider (or broker) the engine would refuse,
 * and the refusal text is the one the UX and the API show.
 */
function resolveAxisValue(axis: "provider" | "broker", raw: string): string {
  const one = resolveValue(axis, raw);
  if (one.ok) return one.value;
  throw new Error(`${one.code}: ${one.message}`);
}


/** Exported for the #5500 pin — a pure function; no production caller changes. */
export function buildIntent(input: ManageTenantsInput): BizCopilotTenantIntent {
  switch (input.action) {
    case "list":
      return { action: "list" };
    case "create":
      return { action: "create", tenantId: requireTenantId(input) };
    case "detail":
      return { action: "detail", tenantId: requireTenantId(input) };
    case "settings-read":
      return { action: "settings-read", tenantId: requireTenantId(input) };
    case "settings-update": {
      const tenantId = requireTenantId(input);
      const patch: BizCopilotTenantSettingsPatch = {};
      if (input.adsEnabled !== undefined) patch.adsEnabled = input.adsEnabled;
      if (input.autoRefreshEnabled !== undefined) patch.autoRefreshEnabled = input.autoRefreshEnabled;
      if (input.autoRefreshIntervalS !== undefined) patch.autoRefreshIntervalS = input.autoRefreshIntervalS;
      if (input.dataProviderId !== undefined) {
        patch.dataProviderId = resolveAxisValue("provider", input.dataProviderId);
      }
      if (input.brokerId !== undefined) {
        patch.brokerId = resolveAxisValue("broker", input.brokerId);
      }
      if (Object.keys(patch).length === 0) {
        throw new Error("at least one settings field is required for action 'settings-update'");
      }
      return { action: "settings-update", tenantId, patch };
    }
    case "membership-write-refused": {
      const tenantId = requireTenantId(input);
      const userId = input.userId?.trim() ?? "";
      if (!userId) {
        throw new Error("userId is required for action 'membership-write-refused'");
      }
      return { action: "membership-write-refused", tenantId, userId };
    }
  }
}

export class ManageTenantsCommand implements IMcpToolCommand<ManageTenantsInput, string> {
  readonly name = "manage_tenants";
  readonly description =
    "Tenant administration through BizCopilot chat — list, create, detail, settings read/update; membership writes are read-only and refused — via the Tenants page's own routes, with the same store-operator gate, session-scoped identity, and audit as the page path. Every action except list needs a tenant id: ask the user for it when it is missing. Report the outcome with the Tenants page link from the result.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: [...BIZCOPILOT_TENANT_TOOL_ACTIONS],
        description: "Tenant administration operation (the six BizCopilot tenant activities)",
      },
      tenantId: {
        type: "string",
        description:
          "Tenant id — required for every action except list. When it is missing, ask the user for it instead of calling without it.",
      },
      userId: {
        type: "string",
        description: "User id for membership-write-refused (the member the write names).",
      },
      adsEnabled: { type: "boolean", description: "Settings-update: turn ads on/off for the tenant." },
      autoRefreshEnabled: {
        type: "boolean",
        description: "Settings-update: turn auto-refresh on/off for the tenant.",
      },
      autoRefreshIntervalS: {
        type: "number",
        description: "Settings-update: auto-refresh interval in seconds.",
      },
      dataProviderId: {
        type: "string",
        description: `Settings-update: data provider id. Known: ${PROVIDER_IDS}. An unknown id refuses by name (#5500).`,
      },
      brokerId: {
        type: "string",
        description: `Settings-update: broker id. Known: ${BROKER_IDS}. An unknown id refuses by name (#5500).`,
      },
    },
    required: ["action"],
  };
  readonly zodSchema = ManageTenantsInputSchema;

  constructor(private readonly seams: ManageTenantsCommandSeams = {}) {}

  async execute(input: unknown, context: McpToolContext): Promise<string> {
    const parsed = ManageTenantsInputSchema.parse(input ?? {});
    const intent = buildIntent(parsed);
    const userLogin = context.actingLogin?.()?.trim() ?? "";
    const tenantId = "tenantId" in intent ? intent.tenantId : null;
    try {
      const outcome = await executeBizCopilotTenantIntent(intent, {
        env: context.env,
        userLogin,
        commercial: this.seams.commercial ?? null,
        directory: this.seams.directory ?? null,
        operators: this.seams.operators ?? null,
      });
      context.audit("bizcopilot.tenant_action_executed", "orchestrator", {
        action: intent.action,
        tenantId,
        via: "mcp_tool",
      });
      return outcome;
    } catch (error) {
      context.audit("bizcopilot.tenant_action_failed", "orchestrator", {
        action: intent.action,
        tenantId,
        via: "mcp_tool",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
