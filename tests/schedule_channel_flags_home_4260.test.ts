// @vitest-environment node
/**
 * Issue #4260 ([3121] surface the scheduling-channel flags in the
 * schedules home): the schedules home shows schedule_chat, schedule_nlq
 * and the schedules flag with live state read through the existing
 * FeatureFlagPort, and a platform admin can toggle the two channel
 * flags from the home through the port — the one-on invariant enforced
 * (both-off refused with SCHEDULE_CHANNELS_BOTH_OFF), non-admins
 * read-only, no second flag store.
 *
 * Red-first pins: the port write, the toggle orchestration, the flags
 * view model, the GET/POST /api/schedules/flags routes and the home
 * panel render must all fail before the implementation lands.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { InMemoryFeatureFlagAdapter } from "../src/features/inMemoryFeatureFlagAdapter";
import { EnvFeatureFlagAdapter } from "../src/features/envFeatureFlagAdapter";
import { CfFlagshipAdapter, type FlagshipBindingLike } from "../src/features/cfFlagshipAdapter";
import {
  SCHEDULE_CHANNELS,
  SCHEDULE_CHAT_FLAG,
  SCHEDULE_HOME_FLAGS,
  SCHEDULE_NLQ_FLAG,
  SCHEDULES_FLAG,
  applyScheduleChannelToggle,
  resolveScheduleChannelFlagsView,
} from "../src/features/scheduleChannelFlags";
import { handleSchedulesRoutes } from "../src/agents/routes/schedules";
import { MockSqlStorage } from "./mock-sql";
import {
  ScheduleChannelFlagsPanel,
  fetchScheduleChannelFlags,
  type ScheduleChannelFlagsViewResponse,
} from "../src/client/ScheduleChannelFlagsPanel";

const ADMIN_LOGIN = "owner-admin";
const ADMIN_USER_ID = "user-admin-1";
const PLAIN_LOGIN = "plain-user";
const PLAIN_USER_ID = "user-plain-1";

function stubKv(logins: Record<string, string>) {
  const store = new Map<string, string>();
  for (const [login, userId] of Object.entries(logins)) {
    store.set(`iaaa-alias:login:${login}`, JSON.stringify({ internalUserId: userId }));
  }
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function stubMembershipStore(adminUserIds: string[]) {
  return {
    getMembershipsByUser: async (internalUserId: string) =>
      adminUserIds.includes(internalUserId)
        ? [
            {
              membershipId: "m-admin-1",
              internalUserId,
              tenantId: "platform",
              roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test" }],
              createdBy: "test",
              createdAtMs: 1,
            },
          ]
        : [],
    put: async () => {},
    revokeMembership: async () => false,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const audit = vi.fn();
  return {
    ctx: {
      env: {},
      agentCtx: { storage: { sql: new MockSqlStorage() } },
      audit,
      listSchedules: async () => [],
      cancelSchedule: async () => false,
      getScheduleById: async () => undefined,
      schedule: async () => {
        throw new Error("not used");
      },
      scheduleEvery: async () => {
        throw new Error("not used");
      },
      getScreenerExecutionContext: async () => ({ userLogin: "venus", environment: "PROD" }),
      getOrm: () => ({}),
      autonomousMarketScreen: async () => {},
      autoRenewETradeTokens: async () => {},
      creatableScheduleCallbacks: [],
      accountScopedScheduleCallbacks: new Set<string>(),
      runScheduleCallback: async () => {},
      ...overrides,
    } as any,
    audit,
  };
}

function flagsRequest(method: string, body?: unknown, login?: string) {
  return new Request("https://agent.test/api/schedules/flags", {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(login ? { "x-user-login": login } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readJson(res: Response) {
  return (await res.json()) as Record<string, any>;
}

describe("port write (#4260): setEnabled on the one FeatureFlagPort", () => {
  it("InMemory adapter toggles a channel flag and the change takes effect", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
    const res = await port.setEnabled("schedule_nlq", true);
    expect(res.ok).toBe(true);
    expect(await port.isEnabled("schedule_nlq")).toBe(true);
  });

  it("InMemory adapter refuses an unknown flag without changing state", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const res = await port.setEnabled("no_such_flag", true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("UNKNOWN_FLAG");
    expect(await port.isEnabled("schedule_chat")).toBe(true);
  });

  it("Env and Flagship adapters expose no write — their source is operator-owned", async () => {
    const envPort = new EnvFeatureFlagAdapter({});
    expect(typeof (envPort as any).setEnabled).toBe("undefined");
    const getBooleanValue = vi
      .fn()
      .mockImplementation((_flag: string, defaultVal: boolean) => Promise.resolve(defaultVal));
    const flagshipPort = new CfFlagshipAdapter({ getBooleanValue } as unknown as FlagshipBindingLike);
    expect(typeof (flagshipPort as any).setEnabled).toBe("undefined");
  });
});

describe("home flags view model (#4260)", () => {
  it("surfaces chat, NLQ and the schedules flag — chat first, schedules read-only", () => {
    expect([...SCHEDULE_HOME_FLAGS.map((f) => f.flag)]).toEqual([
      "schedule_chat",
      "schedule_nlq",
      "schedules",
    ]);
    expect(SCHEDULE_CHAT_FLAG).toBe("schedule_chat");
    expect(SCHEDULE_NLQ_FLAG).toBe("schedule_nlq");
    expect(SCHEDULES_FLAG).toBe("schedules");
    expect(SCHEDULE_HOME_FLAGS[0]).toMatchObject({
      channel: "chat",
      defaultValue: true,
      toggleable: true,
    });
    expect(SCHEDULE_HOME_FLAGS[1]).toMatchObject({
      channel: "nlq",
      defaultValue: false,
      toggleable: true,
    });
    expect(SCHEDULE_HOME_FLAGS[2]).toMatchObject({
      channel: null,
      defaultValue: null,
      toggleable: false,
    });
    expect([...SCHEDULE_CHANNELS]).toEqual(["chat", "nlq"]);
  });

  it("resolves live state through the port and reports writability", async () => {
    const writable = new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: true });
    const view = await resolveScheduleChannelFlagsView(writable);
    expect(view.channels).toEqual({ chatEnabled: false, nlqEnabled: true });
    expect(view.writable).toBe(true);
    expect(view.flags.map((f) => [f.flag, f.enabled])).toEqual([
      ["schedule_chat", false],
      ["schedule_nlq", true],
      ["schedules", false],
    ]);
    const readOnly = new EnvFeatureFlagAdapter({});
    expect((await resolveScheduleChannelFlagsView(readOnly)).writable).toBe(false);
  });
});

describe("channel toggle orchestration (#4260)", () => {
  it("toggling NLQ on while chat is on takes effect", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const res = await applyScheduleChannelToggle(port, "schedule_nlq", true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toEqual({ chatEnabled: true, nlqEnabled: true });
    expect(await port.isEnabled("schedule_nlq")).toBe(true);
  });

  it("toggling chat off while NLQ is on takes effect", async () => {
    const port = new InMemoryFeatureFlagAdapter({ schedule_nlq: true });
    const res = await applyScheduleChannelToggle(port, "schedule_chat", false);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.state).toEqual({ chatEnabled: false, nlqEnabled: true });
  });

  it("turning the last channel off is refused with SCHEDULE_CHANNELS_BOTH_OFF and changes nothing", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const chatOff = await applyScheduleChannelToggle(port, "schedule_chat", false);
    expect(chatOff.ok).toBe(false);
    if (!chatOff.ok) expect(chatOff.code).toBe("SCHEDULE_CHANNELS_BOTH_OFF");
    expect(await port.isEnabled("schedule_chat")).toBe(true);
    const nlqOnly = new InMemoryFeatureFlagAdapter({ schedule_chat: false, schedule_nlq: true });
    const nlqOff = await applyScheduleChannelToggle(nlqOnly, "schedule_nlq", false);
    expect(nlqOff.ok).toBe(false);
    if (!nlqOff.ok) expect(nlqOff.code).toBe("SCHEDULE_CHANNELS_BOTH_OFF");
    expect(await nlqOnly.isEnabled("schedule_nlq")).toBe(true);
  });

  it("the schedules surface flag is not toggleable from the home", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const res = await applyScheduleChannelToggle(port, "schedules", false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("FLAG_NOT_TOGGLEABLE");
  });

  it("an unknown flag is refused without touching state", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const res = await applyScheduleChannelToggle(port, "no_such_flag", true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("UNKNOWN_FLAG");
    expect(await port.isEnabled("schedule_chat")).toBe(true);
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
  });

  it("a port with no write reports FLAG_WRITE_UNSUPPORTED and changes nothing", async () => {
    const port = new EnvFeatureFlagAdapter({});
    const res = await applyScheduleChannelToggle(port, "schedule_nlq", true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("FLAG_WRITE_UNSUPPORTED");
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
  });

  it("an evaluation failure refuses with FEATURE_DISABLED, never unguarded", async () => {
    const failing = {
      isEnabled: async () => {
        throw new Error("flagship down");
      },
      getAllFlags: async () => {
        throw new Error("flagship down");
      },
    } as any;
    const res = await applyScheduleChannelToggle(failing, "schedule_nlq", true);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("FEATURE_DISABLED");
  });
});

describe("GET /api/schedules/flags (#4260)", () => {
  it("returns the three flags with live state for an anonymous caller, read-only", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const { ctx } = makeCtx({ featureFlagPort: port });
    const res = await handleSchedulesRoutes(flagsRequest("GET"), new URL("https://agent.test/api/schedules/flags"), "/api/schedules/flags", "s", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await readJson(res!);
    expect(body.flags.map((f: any) => f.flag)).toEqual(["schedule_chat", "schedule_nlq", "schedules"]);
    expect(body.channels).toEqual({ chatEnabled: true, nlqEnabled: false });
    expect(body.canToggle).toBe(false);
    expect(body.writable).toBe(true);
    expect(body.managedBy).toBe("in-memory");
  });

  it("reports canToggle for a platform admin and not for a plain user", async () => {
    const kv = stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID, [PLAIN_LOGIN]: PLAIN_USER_ID });
    const store = stubMembershipStore([ADMIN_USER_ID]);
    const { ctx } = makeCtx({
      featureFlagPort: new InMemoryFeatureFlagAdapter(),
      flagAliasKv: kv,
      flagMembershipStore: store,
    });
    const adminRes = await handleSchedulesRoutes(
      flagsRequest("GET", undefined, ADMIN_LOGIN),
      new URL("https://agent.test/api/schedules/flags"),
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect((await readJson(adminRes!)).canToggle).toBe(true);
    const plainRes = await handleSchedulesRoutes(
      flagsRequest("GET", undefined, PLAIN_LOGIN),
      new URL("https://agent.test/api/schedules/flags"),
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect((await readJson(plainRes!)).canToggle).toBe(false);
  });
});

describe("POST /api/schedules/flags (#4260)", () => {
  function adminCtx(port: any) {
    const kv = stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID, [PLAIN_LOGIN]: PLAIN_USER_ID });
    const store = stubMembershipStore([ADMIN_USER_ID]);
    return makeCtx({ featureFlagPort: port, flagAliasKv: kv, flagMembershipStore: store });
  }

  it("a platform admin toggle takes effect and is audited; a later GET shows it", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const { ctx, audit } = adminCtx(port);
    const url = new URL("https://agent.test/api/schedules/flags");
    const res = await handleSchedulesRoutes(
      flagsRequest("POST", { flag: "schedule_nlq", enabled: true }, ADMIN_LOGIN),
      url,
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await readJson(res!);
    expect(body.channels).toEqual({ chatEnabled: true, nlqEnabled: true });
    expect(body.flags.find((f: any) => f.flag === "schedule_nlq").enabled).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      "schedule.channel-flag-changed",
      "orchestrator",
      expect.objectContaining({ flag: "schedule_nlq", enabled: true, changedBy: ADMIN_LOGIN }),
    );
    const after = await handleSchedulesRoutes(flagsRequest("GET"), url, "/api/schedules/flags", "s", ctx);
    expect((await readJson(after!)).channels).toEqual({ chatEnabled: true, nlqEnabled: true });
  });

  it("refuses the last-channel-off toggle with SCHEDULE_CHANNELS_BOTH_OFF", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const { ctx } = adminCtx(port);
    const res = await handleSchedulesRoutes(
      flagsRequest("POST", { flag: "schedule_chat", enabled: false }, ADMIN_LOGIN),
      new URL("https://agent.test/api/schedules/flags"),
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect(res!.status).toBe(409);
    expect((await readJson(res!)).code).toBe("SCHEDULE_CHANNELS_BOTH_OFF");
    expect(await port.isEnabled("schedule_chat")).toBe(true);
  });

  it("refuses without a signed-in session (401) and for a non-admin (403)", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const { ctx } = adminCtx(port);
    const url = new URL("https://agent.test/api/schedules/flags");
    const anon = await handleSchedulesRoutes(
      flagsRequest("POST", { flag: "schedule_nlq", enabled: true }),
      url,
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect(anon!.status).toBe(401);
    const plain = await handleSchedulesRoutes(
      flagsRequest("POST", { flag: "schedule_nlq", enabled: true }, PLAIN_LOGIN),
      url,
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect(plain!.status).toBe(403);
    expect(await port.isEnabled("schedule_nlq")).toBe(false);
  });

  it("refuses the schedules surface flag and unknown flags", async () => {
    const port = new InMemoryFeatureFlagAdapter();
    const { ctx } = adminCtx(port);
    const url = new URL("https://agent.test/api/schedules/flags");
    const surface = await handleSchedulesRoutes(
      flagsRequest("POST", { flag: "schedules", enabled: false }, ADMIN_LOGIN),
      url,
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect(surface!.status).toBe(409);
    expect((await readJson(surface!)).code).toBe("FLAG_NOT_TOGGLEABLE");
    const unknown = await handleSchedulesRoutes(
      flagsRequest("POST", { flag: "no_such_flag", enabled: true }, ADMIN_LOGIN),
      url,
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect(unknown!.status).toBe(400);
    expect((await readJson(unknown!)).code).toBe("UNKNOWN_FLAG");
  });

  it("reports FLAG_WRITE_UNSUPPORTED on a read-only (env) runtime", async () => {
    const { ctx } = makeCtx({
      flagAliasKv: stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID }),
      flagMembershipStore: stubMembershipStore([ADMIN_USER_ID]),
    });
    const res = await handleSchedulesRoutes(
      flagsRequest("POST", { flag: "schedule_nlq", enabled: true }, ADMIN_LOGIN),
      new URL("https://agent.test/api/schedules/flags"),
      "/api/schedules/flags",
      "s",
      ctx,
    );
    expect(res!.status).toBe(409);
    const body = await readJson(res!);
    expect(body.code).toBe("FLAG_WRITE_UNSUPPORTED");
    expect(body.error).toMatch(/environment/i);
  });
});

describe("ScheduleChannelFlagsPanel render (#4260)", () => {
  const view: ScheduleChannelFlagsViewResponse = {
    flags: [
      { flag: "schedule_chat", channel: "chat", label: "Chat", enabled: true, defaultValue: true, toggleable: true },
      { flag: "schedule_nlq", channel: "nlq", label: "NLQ", enabled: false, defaultValue: false, toggleable: true },
      { flag: "schedules", channel: null, label: "Schedules", enabled: true, defaultValue: null, toggleable: false },
    ],
    channels: { chatEnabled: true, nlqEnabled: false },
    writable: true,
    canToggle: true,
    managedBy: "environment",
  };

  it("renders every flag with live state and the admin toggle", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(ScheduleChannelFlagsPanel, { initialView: view }),
    );
    expect(html).toContain("schedule_chat");
    expect(html).toContain("schedule_nlq");
    expect(html).toContain("schedules");
    expect(html).toContain("Chat");
    expect(html).toContain("NLQ");
    expect(html).toContain("Turn off");
    expect(html).toContain("Turn on");
    expect(html).toContain("aria-pressed");
  });

  it("is read-only for non-admins and names the managing source", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(ScheduleChannelFlagsPanel, {
        initialView: { ...view, canToggle: false },
      }),
    );
    // The toggles still render so the affordance is visible, but both
    // are disabled — a non-admin cannot toggle.
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).toMatch(/read-only|Read-only/);
    expect(html).toMatch(/environment/);
  });

  it("fetches live state through the flags endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => view,
    });
    const loaded = await fetchScheduleChannelFlags(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/api/schedules/flags");
    expect(loaded.channels).toEqual({ chatEnabled: true, nlqEnabled: false });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
