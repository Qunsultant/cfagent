/**
 * Issue #5111 (Sub-issue 2 of #5094) — Chat & Copilot tool to inspect, bind,
 * and clear `{ broker, mode, accountType, accountId }` bindings.
 */
import { z } from "zod";
import { ACCOUNT_BINDING_SCOPES, ACCOUNT_TYPES } from "../../config/accountBindings";
import {
  listAccountBindings,
  removeAccountBinding,
  resolveUserAccountBinding,
  upsertAccountBinding,
} from "../../services/accountBindings";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";

const BrokerAccountBindingInputSchema = z.object({
  action: z.enum(["list", "get", "set", "clear"]).default("list"),
  broker: z.string().optional(),
  mode: z.enum(["paper", "live"]).optional(),
  accountType: z.enum(ACCOUNT_TYPES).optional(),
  scope: z.enum(ACCOUNT_BINDING_SCOPES).optional(),
  accountId: z.string().optional(),
  accountName: z.string().optional(),
});

export class BrokerAccountBindingCommand implements IMcpToolCommand {
  readonly name = "broker_account_binding";
  readonly description =
    "Inspect, bind, or clear the active { broker, mode, accountType, accountId } account binding for the signed-in user across tenant, autopilot, copilot, or schedule scopes.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "get", "set", "clear"], description: "Operation to perform (default: list)." },
      broker: { type: "string", description: "Configured broker identifier." },
      mode: { type: "string", enum: ["paper", "live"], description: "Trading mode." },
      accountType: { type: "string", enum: [...ACCOUNT_TYPES], description: "Account asset class/type." },
      scope: { type: "string", enum: [...ACCOUNT_BINDING_SCOPES], description: "Binding scope." },
      accountId: { type: "string", description: "Specific account ID at the broker (required for action='set')." },
      accountName: { type: "string", description: "Optional human-readable account label." },
    },
  };
  readonly zodSchema = BrokerAccountBindingInputSchema;

  async execute(input: unknown, context: McpToolContext) {
    if (!context.sessionId || !context.sessionId.trim()) {
      throw new Error("Authenticated user session is required for broker_account_binding.");
    }

    const parsed = BrokerAccountBindingInputSchema.parse(input ?? {});
    const userLogin = context.sessionId;

    if (parsed.action === "list") {
      const all = await listAccountBindings(context.env, userLogin);
      const filtered = all.filter((b) => {
        if (parsed.broker && b.broker !== parsed.broker.trim().toLowerCase()) return false;
        if (parsed.mode && b.mode !== parsed.mode) return false;
        if (parsed.accountType && b.accountType !== parsed.accountType) return false;
        if (parsed.scope && b.scope !== parsed.scope) return false;
        return true;
      });
      return {
        ok: true,
        action: "list",
        bindings: filtered,
        supportedAccountTypes: ACCOUNT_TYPES,
        supportedScopes: ACCOUNT_BINDING_SCOPES,
      };
    }

    if (parsed.action === "get") {
      if (!parsed.broker || !parsed.mode) {
        throw new Error("broker and mode are required for action='get'.");
      }
      const { isAccountBindingBroker } = await import("../../trading");
      const normBroker = parsed.broker.trim().toLowerCase();
      if (!isAccountBindingBroker(normBroker)) {
        throw new Error(`Unsupported broker "${parsed.broker}".`);
      }
      const res = await resolveUserAccountBinding(context.env, userLogin, {
        broker: normBroker,
        mode: parsed.mode,
        accountType: parsed.accountType ?? "stock",
        scope: parsed.scope ?? "tenant",
      });
      return {
        ok: true,
        action: "get",
        found: res.found,
        binding: res.binding,
        resolvedFromScope: res.resolvedFromScope,
      };
    }

    if (parsed.action === "set") {
      const result = await upsertAccountBinding(context.env, userLogin, {
        broker: parsed.broker,
        mode: parsed.mode,
        accountType: parsed.accountType,
        scope: parsed.scope,
        accountId: parsed.accountId,
        accountName: parsed.accountName,
      });
      if (!result.ok) {
        return { ok: false, action: "set", error: result.error };
      }
      return { ok: true, action: "set", binding: result.binding };
    }

    // action === "clear"
    if (!parsed.broker || !parsed.mode) {
      throw new Error("broker and mode are required for action='clear'.");
    }
    const { isAccountBindingBroker } = await import("../../trading");
    const normBroker = parsed.broker.trim().toLowerCase();
    if (!isAccountBindingBroker(normBroker)) {
      throw new Error(`Unsupported broker "${parsed.broker}".`);
    }
    const removed = await removeAccountBinding(context.env, userLogin, {
      broker: normBroker,
      mode: parsed.mode,
      accountType: parsed.accountType ?? "stock",
      scope: parsed.scope ?? "tenant",
    });
    return { ok: true, action: "clear", removed };
  }
}
