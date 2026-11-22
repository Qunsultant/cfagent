/**
 * #6164 (parent #945) — Security Hub / IAAA Admin coherent fix.
 * Governing rule: CONSISTENT INFORMATION EVERYWHERE — every surface shows the
 * same entity the same way (login, internal id, membership id, tenant, roles,
 * status with dates). The join is resolved SERVER-side via the alias record
 * (lookupLoginByUserId), never invented by the client; a user with no alias
 * reads "not recorded" on the client, never a fabricated login.
 *
 * Server-side coverage: the login-resolution helper, the admin-overview
 * enrichment (membership login + audit actor/initiating logins), and the
 * logged-in-users membership-id threading (F9).
 */
import { describe, it, expect } from "vitest";
import { resolveLogins } from "../src/security/identityDisplay";
import {
  buildAdminOverview,
  type AdminOverviewDeps,
} from "../src/security/iaaaAdminOverview";
import { createMemoryMembershipStore } from "../src/security/authorization";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import type { IaaaAuditEvent, AuditStore } from "../src/security/iaaaAudit";
import type { Membership } from "../src/security/authorization";
import type { KvLike } from "../src/security/kvResilience";
import {
  buildLoggedInUserRows,
  type MembershipInput,
} from "../src/security/iaaaLoggedInUsers";

const NOW = 1792660000000;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

function mapKv(): { kv: KvLike; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv: KvLike = {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
  return { kv, store };
}

function seedAlias(store: Map<string, string>, login: string, internalUserId: string): void {
  store.set(
    `iaaa-alias:user:${internalUserId}`,
    JSON.stringify({
      githubLogin: login,
      internalUserId,
      recordedAtMs: NOW - 1000,
      source: "wired-login",
    }),
  );
}

let membershipSeq = 0;
function membership(overrides: Partial<Membership> & { internalUserId: string }): Membership {
  membershipSeq += 1;
  return {
    membershipId: `m-${overrides.internalUserId.slice(0, 8)}-${membershipSeq}`,
    internalUserId: overrides.internalUserId,
    tenantId: overrides.tenantId ?? "primary",
    roleBindings: overrides.roleBindings ?? [
      { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
    ],
    createdBy: "system:bootstrap",
    createdAtMs: NOW - 1000,
    ...overrides,
  };
}

const platformAdmin = (userId: string): Membership =>
  membership({
    internalUserId: userId,
    roleBindings: [
      { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" },
    ],
  });

function auditEvent(overrides: Partial<IaaaAuditEvent> & { timestamp: number }): IaaaAuditEvent {
  return {
    id: `evt-${overrides.timestamp}`,
    timestamp: overrides.timestamp,
    type: "auth.login.success",
    actorPrincipalId: ADMIN_ID,
    actorType: "user",
    initiatingPrincipalId: ADMIN_ID,
    tenantId: "primary",
    correlationId: `corr-${overrides.timestamp}`,
    action: "auth.login",
    decision: "allow",
    policyVersion: "iaaa-1",
    outcome: "success",
    previousEventHash: null,
    eventHash: "hash",
    ...overrides,
  };
}

async function depsWith(opts: {
  memberships?: Membership[];
  events?: IaaaAuditEvent[];
  aliases?: Array<{ login: string; internalUserId: string }>;
}): Promise<{ deps: AdminOverviewDeps; audit: AuditStore }> {
  const membershipStore = createMemoryMembershipStore();
  for (const m of opts.memberships ?? []) await membershipStore.put(m);
  const audit = createMemoryAuditStore();
  for (const e of opts.events ?? []) await audit.append(e);
  const { kv, store } = mapKv();
  for (const a of opts.aliases ?? []) seedAlias(store, a.login, a.internalUserId);
  store.set("iaaa-bootstrap:platform-genesis:primary", JSON.stringify({ grantedTo: ADMIN_ID }));
  return {
    deps: { membershipStore, auditStore: audit, kv, tenantId: "primary", nowMs: NOW },
    audit,
  };
}

describe("resolveLogins (identityDisplay)", () => {
  it("resolves the login for each aliased id, null for an unaliased id", async () => {
    const { kv, store } = mapKv();
    seedAlias(store, "OpenAIMP", ADMIN_ID);
    const result = await resolveLogins(kv, [ADMIN_ID, USER_ID]);
    expect(result.get(ADMIN_ID)).toBe("OpenAIMP");
    expect(result.get(USER_ID)).toBeNull();
  });

  it("dedupes ids and never looks up a non-id principal", async () => {
    const { kv, store } = mapKv();
    seedAlias(store, "OpenAIMP", ADMIN_ID);
    let gets = 0;
    const countingKv: KvLike = {
      ...kv,
      get: async (key) => {
        gets += 1;
        return kv.get(key);
      },
    };
    const result = await resolveLogins(countingKv, [
      ADMIN_ID,
      ADMIN_ID,
      "system:bootstrap",
      "system:bootstrap-genesis",
    ]);
    expect(result.get(ADMIN_ID)).toBe("OpenAIMP");
    expect(result.get("system:bootstrap")).toBeNull();
    expect(gets).toBe(1);
  });

  it("returns an empty map for an empty input", async () => {
    const { kv } = mapKv();
    expect((await resolveLogins(kv, [])).size).toBe(0);
  });
});

describe("buildAdminOverview identity enrichment (#6164)", () => {
  it("attaches the caller's login to each of their memberships, null when no alias exists", async () => {
    // The overview returns the CALLER's memberships only, so every
    // row shares the caller's login; the null case is a caller with
    // no alias at all.
    const { deps } = await depsWith({
      memberships: [
        platformAdmin(ADMIN_ID),
        membership({ internalUserId: ADMIN_ID, tenantId: "other" }),
      ],
      aliases: [{ login: "OpenAIMP", internalUserId: ADMIN_ID }],
    });
    const result = await buildAdminOverview(deps, { callerInternalUserId: ADMIN_ID });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.memberships).toHaveLength(2);
    for (const m of result.memberships) expect(m.login).toBe("OpenAIMP");

    const { deps: unaliased } = await depsWith({
      memberships: [platformAdmin(ADMIN_ID)],
    });
    const unaliasedResult = await buildAdminOverview(unaliased, {
      callerInternalUserId: ADMIN_ID,
    });
    expect(unaliasedResult.allowed).toBe(true);
    if (!unaliasedResult.allowed) return;
    expect(unaliasedResult.memberships).toHaveLength(1);
    expect(unaliasedResult.memberships[0].login).toBeNull();
  });

  it("attaches actor + initiating logins to audit events, resolved independently", async () => {
    const { deps } = await depsWith({
      memberships: [platformAdmin(ADMIN_ID)],
      events: [
        auditEvent({
          timestamp: NOW,
          actorPrincipalId: USER_ID,
          initiatingPrincipalId: OTHER_ID,
        }),
        auditEvent({
          timestamp: NOW - 1,
          actorPrincipalId: "system:bootstrap",
          initiatingPrincipalId: "system:bootstrap",
        }),
      ],
      aliases: [
        { login: "member-user", internalUserId: USER_ID },
        { login: "other-user", internalUserId: OTHER_ID },
      ],
    });
    const result = await buildAdminOverview(deps, { callerInternalUserId: ADMIN_ID });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    const byId = new Map(result.recentAuditEvents.map((e) => [e.id, e]));
    expect(byId.get(`evt-${NOW}`)?.actorLogin).toBe("member-user");
    expect(byId.get(`evt-${NOW}`)?.initiatingLogin).toBe("other-user");
    expect(byId.get(`evt-${NOW - 1}`)?.actorLogin).toBeNull();
    expect(byId.get(`evt-${NOW - 1}`)?.initiatingLogin).toBeNull();
  });
});

describe("buildLoggedInUserRows membership ids (F9)", () => {
  const resolveProvider = () => null;
  const base = {
    sessionEntries: [],
    loginEvents: [],
    aliases: [],
    scope: "platform" as const,
    nowMs: NOW,
    idleTimeoutMs: 60_000,
    resolveProvider,
  };

  it("threads active membership ids onto the row, sorted; revoked ids excluded", () => {
    const memberships: MembershipInput[] = [
      { internalUserId: USER_ID, tenantId: "primary", revoked: false, membershipId: "m-b" },
      { internalUserId: USER_ID, tenantId: "primary", revoked: false, membershipId: "m-a" },
      { internalUserId: USER_ID, tenantId: "primary", revoked: true, membershipId: "m-revoked" },
    ];
    const rows = buildLoggedInUserRows({
      ...base,
      memberships,
      sessionEntries: [],
    });
    // Rows are keyed off sessions; with no sessions there is no row.
    // A membership alone must not invent a row — assert that, then
    // re-check with a live session present.
    expect(rows).toHaveLength(0);
    const sessionEntries = [
      {
        key: "11111111-1111-4111-8111-111111111111",
        value: JSON.stringify({
          githubLogin: "member-user",
          githubName: "Member",
          createdAt: NOW - 1000,
          internalUserId: USER_ID,
          providerIssuer: "https://github.com",
          providerSubject: "999",
          authTimeMs: NOW - 1000,
          lastActivityMs: NOW - 100,
          sessionVersion: 1,
        }),
      },
    ];
    const rowsWithSession = buildLoggedInUserRows({ ...base, memberships, sessionEntries });
    expect(rowsWithSession).toHaveLength(1);
    expect(rowsWithSession[0].membershipIds).toEqual(["m-a", "m-b"]);
  });
});
