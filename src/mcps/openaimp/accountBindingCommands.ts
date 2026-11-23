/**
 * Issue #5111 (Sub-issue 2 of #5094) — Chat & Copilot tool to inspect, bind,
 * and clear `{ broker, mode, accountType, accountId }` bindings.
 */
import { z } from "zod";
import { ACCOUNT_BINDING_SCOPES, ACCOUNT_TYPES, maskAccountId } from "../../config/accountBindings";
import {
  getBrokerAssetAccountRegistry,
  listAccountBindings,
  listBrokerAccountsForMode,
  migrateTenantAccountBinding,
  removeAccountBinding,
  resolveUserAccountBinding,
  updateBrokerAssetAccountRegistry,
  validateAndUpsertAccountBinding,
  type ListBrokerAccountsDeps,
} from "../../services/accountBindings";
import {
  isAccountBindingBroker,
  maskAccountBinding,
  maskBrokerAccount,
  resolveAccountByLabel,
  validateAccountAgainstBroker,
  type BrokerAccountRecordLike,
} from "../../trading";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";

/**
 * Issue #5101 (F4 of #5094): injectable enumeration for the tool's
 * validated `set` — production reads the broker's platform; tests pass
 * a stub so no live broker credentials are needed. Absent in production.
 */
export interface BrokerAccountBindingCommandDeps {
  listAccounts?: ListBrokerAccountsDeps["enumerate"];
}

/**
 * Issue #5101: validation errors quote the requested account id back.
 * The model supplied that id, but the result contract is "never a full
 * id in a tool result" — scrub it to its masked form (only for ids long
 * enough that a substring replace cannot corrupt the message).
 */
function scrubAccountId(error: string, accountId?: string): string {
  if (!accountId || accountId.length < 4) return error;
  return error.split(accountId).join(maskAccountId(accountId));
}

const BrokerAccountBindingInputSchema = z.object({
  action: z
    .enum(["list", "get", "set", "clear", "validate", "migrate", "registry_get", "registry_update"])
    .default("list"),
  broker: z.string().optional(),
  mode: z.enum(["paper", "live"]).optional(),
  accountType: z.string().optional(),
  scope: z.enum(ACCOUNT_BINDING_SCOPES).optional(),
  accountId: z.string().optional(),
  accountName: z.string().optional(),
  availableAccounts: z.array(z.record(z.string(), z.unknown())).optional(),
  registryPatch: z
    .object({
      upsertBroker: z
        .object({
          id: z.string(),
          label: z.string().optional(),
          icon: z.string().optional(),
          enabled: z.boolean().optional(),
          modes: z.array(z.enum(["paper", "live"])).optional(),
          assetTypes: z.array(z.string()).optional(),
        })
        .optional(),
      removeBrokerId: z.string().optional(),
      addAssetType: z.string().optional(),
      removeAssetType: z.string().optional(),
      addAccountType: z.string().optional(),
      removeAccountType: z.string().optional(),
    })
    .optional(),
});

export class BrokerAccountBindingCommand implements IMcpToolCommand {
  constructor(private readonly deps?: BrokerAccountBindingCommandDeps) {}
  readonly name = "broker_account_binding";
  readonly description =
    "Inspect, bind, or clear the active { broker, mode, accountType, accountId } account binding for the signed-in user across tenant, autopilot, copilot, or schedule scopes. Results never carry a full account id — bindings and accounts are masked. Set validates against the broker's real accounts (server-fetched); switch by account label (accountName) without holding an id.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "get", "set", "clear", "validate", "migrate", "registry_get", "registry_update"], description: "Operation to perform (default: list)." },
      broker: { type: "string", description: "Configured broker identifier." },
      mode: { type: "string", enum: ["paper", "live"], description: "Trading mode." },
      accountType: { type: "string", enum: [...ACCOUNT_TYPES], description: "Account asset class/type." },
      scope: { type: "string", enum: [...ACCOUNT_BINDING_SCOPES], description: "Binding scope." },
      accountId: { type: "string", description: "Specific account ID at the broker (required for action='set' unless accountName names the account)." },
      accountName: { type: "string", description: "Human-readable account label — switch by label without holding the account id (action='set')." },
    },
  };
  readonly zodSchema = BrokerAccountBindingInputSchema;

  async execute(input: unknown, context: McpToolContext) {
    if (!context.sessionId || !context.sessionId.trim()) {
      throw new Error("Authenticated user session is required for broker_account_binding.");
    }

    const parsed = BrokerAccountBindingInputSchema.parse(input ?? {});
    const userLogin = context.sessionId;

    if (parsed.action === "registry_get") {
      const registry = await getBrokerAssetAccountRegistry(context.env, userLogin);
      return { ok: true, action: "registry_get", registry };
    }

    if (parsed.action === "registry_update") {
      if (!parsed.registryPatch) {
        return { ok: false, action: "registry_update", error: "registryPatch is required for action='registry_update'." };
      }
      const res = await updateBrokerAssetAccountRegistry(context.env, userLogin, parsed.registryPatch);
      if (!res.ok) {
        return { ok: false, action: "registry_update", error: res.error };
      }
      return { ok: true, action: "registry_update", registry: res.registry };
    }

    if (parsed.action === "list") {
      const [all, registry] = await Promise.all([
        listAccountBindings(context.env, userLogin),
        getBrokerAssetAccountRegistry(context.env, userLogin),
      ]);
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
        // Issue #5101: bindings leave the server masked — never a full id.
        bindings: filtered.map((b) => maskAccountBinding(b)),
        registry,
        supportedAccountTypes: registry.accountTypes,
        supportedAssetTypes: registry.assetTypes,
        supportedScopes: ACCOUNT_BINDING_SCOPES,
      };
    }

    if (parsed.action === "get") {
      if (!parsed.broker || !parsed.mode) {
        throw new Error("broker and mode are required for action='get'.");
      }
      const { isAccountBindingBroker } = await import("../../trading");
      const registry = await getBrokerAssetAccountRegistry(context.env, userLogin);
      const normBroker = parsed.broker.trim().toLowerCase();
      if (!isAccountBindingBroker(normBroker, registry)) {
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
        // Issue #5101: the binding leaves the server masked — never a full id.
        binding: res.binding ? maskAccountBinding(res.binding) : res.binding,
        resolvedFromScope: res.resolvedFromScope,
      };
    }

    if (parsed.action === "validate") {
      const registry = await getBrokerAssetAccountRegistry(context.env, userLogin);
      const valRes = validateAccountAgainstBroker({
        broker: parsed.broker,
        mode: parsed.mode,
        accountType: parsed.accountType,
        scope: parsed.scope,
        accountId: parsed.accountId,
        accountName: parsed.accountName,
        availableAccounts: (parsed.availableAccounts ?? []) as unknown as BrokerAccountRecordLike[],
        registry,
        updatedBy: userLogin,
      });
      if (!valRes.ok) {
        // Issue #5101: the error quotes the requested id — scrub it masked.
        return { ok: false, action: "validate", code: valRes.code, error: scrubAccountId(valRes.error, parsed.accountId) };
      }
      return {
        ok: true,
        action: "validate",
        // Issue #5101: tuple, binding, and account leave masked.
        tuple: maskAccountBinding(valRes.tuple),
        binding: maskAccountBinding(valRes.binding),
        account: maskBrokerAccount(valRes.account),
      };
    }

    if (parsed.action === "migrate") {
      const migRes = await migrateTenantAccountBinding(context.env, userLogin, {
        broker: parsed.broker,
        mode: parsed.mode,
        targetAccountType: parsed.accountType,
        scope: parsed.scope,
        availableAccounts: (parsed.availableAccounts ?? []) as unknown as BrokerAccountRecordLike[],
      });
      if (!migRes.ok) {
        return {
          ok: false,
          action: "migrate",
          code: migRes.code,
          error: scrubAccountId(migRes.error, parsed.accountId),
          // Issue #5101: candidate ids leave masked — never in full.
          ...(migRes.candidateAccountIds ? { candidateAccountIds: migRes.candidateAccountIds.map((id) => maskAccountId(id)) } : {}),
        };
      }
      return {
        ok: true,
        action: "migrate",
        migrated: true,
        // Issue #5101: tuple, binding, and account leave masked.
        tuple: maskAccountBinding(migRes.tuple),
        binding: maskAccountBinding(migRes.binding),
        account: maskBrokerAccount(migRes.account),
      };
    }

    if (parsed.action === "set") {
      // Issue #5101 (F4 of #5094): `set` no longer upserts unvalidated.
      // The broker's accounts are enumerated server-side for the target
      // mode and the binding is validated against them (fail closed when
      // the enumeration is unavailable). The model switches by label
      // (`accountName`) or by id; the stored account name is the
      // enumerated account's own name, never a model-supplied string.
      if (!parsed.broker || !parsed.mode) {
        throw new Error("broker and mode are required for action='set'.");
      }
      const enumRes = await listBrokerAccountsForMode(
        context.env,
        userLogin,
        parsed.broker,
        parsed.mode,
        context.orm,
        this.deps?.listAccounts ? { enumerate: this.deps.listAccounts } : undefined,
      );
      if (!enumRes.ok) {
        return { ok: false, action: "set", code: enumRes.code, error: enumRes.error };
      }
      const byId = (id: string) =>
        enumRes.accounts.find((a) => {
          const wanted = id.trim().toLowerCase();
          const accId = typeof a.accountId === "string" ? a.accountId.trim().toLowerCase() : "";
          const accKey =
            typeof (a as { accountKey?: unknown }).accountKey === "string"
              ? String((a as { accountKey: string }).accountKey).trim().toLowerCase()
              : "";
          return accId === wanted || accKey === wanted;
        });
      let accountId = parsed.accountId?.trim() ? parsed.accountId.trim() : undefined;
      let accountName = parsed.accountName?.trim() ? parsed.accountName.trim() : undefined;
      if (!accountId && accountName) {
        const labelRes = resolveAccountByLabel({
          accountName,
          availableAccounts: enumRes.accounts,
        });
        if (!labelRes.ok) {
          return {
            ok: false,
            action: "set",
            code: labelRes.code,
            error: labelRes.error,
            ...(labelRes.candidateNames ? { candidateNames: labelRes.candidateNames } : {}),
          };
        }
        accountId = labelRes.account.accountId;
        accountName =
          labelRes.account.accountName?.trim() ||
          (labelRes.account as { accountDesc?: string }).accountDesc?.trim() ||
          accountName;
      }
      if (!accountId) {
        throw new Error("accountId or accountName is required for action='set'.");
      }
      // The stored name is the enumerated account's own name when the
      // account is known; a model-supplied name never overwrites it.
      const enumerated = byId(accountId);
      if (enumerated) {
        accountName =
          enumerated.accountName?.trim() ||
          (enumerated as { accountDesc?: string }).accountDesc?.trim() ||
          accountName;
      }
      const result = await validateAndUpsertAccountBinding(context.env, userLogin, {
        broker: parsed.broker,
        mode: parsed.mode,
        accountType: parsed.accountType,
        scope: parsed.scope,
        accountId,
        accountName,
        availableAccounts: enumRes.accounts,
      });
      if (!result.ok) {
        return { ok: false, action: "set", code: result.code, error: scrubAccountId(result.error, accountId) };
      }
      // Issue #5101: the binding leaves the server masked — never a full id.
      return {
        ok: true,
        action: "set",
        binding: maskAccountBinding(result.binding),
        maskedAccountId: maskAccountId(result.binding.accountId),
      };
    }

    // action === "clear"
    if (!parsed.broker || !parsed.mode) {
      throw new Error("broker and mode are required for action='clear'.");
    }
    const { isAccountBindingBroker } = await import("../../trading");
    const registry = await getBrokerAssetAccountRegistry(context.env, userLogin);
    const normBroker = parsed.broker.trim().toLowerCase();
    if (!isAccountBindingBroker(normBroker, registry)) {
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
