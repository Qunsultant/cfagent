import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveScheduledLogin } from "../src/agents/orchestrator/scheduleMaintenance";

describe("resolveScheduledLogin (#1965)", () => {
  it("payload login wins over a different saved login", () => {
    expect(resolveScheduledLogin("OpenAIMP", "stale-login")).toBe("OpenAIMP");
  });

  it("saved login is the fallback when the payload carries none", () => {
    expect(resolveScheduledLogin(undefined, "OpenAIMP")).toBe("OpenAIMP");
  });

  it("payload login wins when no saved context exists", () => {
    expect(resolveScheduledLogin("OpenAIMP", undefined)).toBe("OpenAIMP");
  });

  it("empty payload login falls through to the saved login", () => {
    expect(resolveScheduledLogin("", "OpenAIMP")).toBe("OpenAIMP");
  });

  it("no login anywhere resolves to undefined (callers keep the skip path)", () => {
    expect(resolveScheduledLogin(undefined, undefined)).toBeUndefined();
  });
});

describe("scheduled wrapper wiring (#1965)", () => {
  const callbacks = readFileSync(
    "src/agents/orchestrator/scheduledCallbacks.ts",
    "utf8",
  );
  const orchestrator = readFileSync("src/agents/orchestrator.ts", "utf8");

  it("all four scheduled wrappers resolve login through the helper, payload first", () => {
    const helperCall =
      "resolveScheduledLogin(payload?.userLogin, savedContext?.userLogin)";
    expect(callbacks.split(helperCall).length - 1).toBe(4);
    expect(orchestrator.split(helperCall).length - 1).toBe(1);
  });

  it("no wrapper keeps the old saved-context-first priority", () => {
    expect(callbacks).not.toContain(
      "savedContext?.userLogin || payload?.userLogin",
    );
    expect(orchestrator).not.toContain(
      "savedContext?.userLogin || payload?.userLogin",
    );
    expect(callbacks).not.toContain(
      "savedContext?.environment || payload?.environment",
    );
    expect(orchestrator).not.toContain(
      "savedContext?.environment || payload?.environment",
    );
  });
});
