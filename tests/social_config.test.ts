import { describe, it, expect } from "vitest";
import {
  parseSocialConfig,
  enabledChannels,
  resolveChannelDisposition,
  canPublish,
} from "../src/agents/social/config";

describe("social config parsing", () => {
  // Phase 3 (#6550): the social settings moved to
  // environment.config.json (defaults.social). The file's autonomous
  // split is ["threads"] (production override per #1489), not the
  // code default ["threads", "x"] — an empty env now resolves to the
  // FILE split. Posting stays off (file "0").
  it("defaults to posting off with the file split when env is empty", () => {
    const cfg = parseSocialConfig({});
    expect(cfg.postingEnabled).toBe(false);
    expect(cfg.autonomousChannels).toEqual(["threads"]);
    expect(cfg.approvalChannels).toEqual(["facebook", "instagram", "linkedin"]);
  });

  it("defaults the same way for undefined env", () => {
    const cfg = parseSocialConfig(undefined);
    expect(cfg.postingEnabled).toBe(false);
    expect(cfg.autonomousChannels).toEqual(["threads"]);
  });

  it('treats "1" and "true" as posting enabled', () => {
    expect(parseSocialConfig({ SOCIAL_POSTING_ENABLED: "1" }).postingEnabled).toBe(true);
    expect(parseSocialConfig({ SOCIAL_POSTING_ENABLED: "true" }).postingEnabled).toBe(true);
  });

  it('treats "0", "false", and anything else as posting disabled', () => {
    for (const v of ["0", "false", "yes", ""]) {
      expect(parseSocialConfig({ SOCIAL_POSTING_ENABLED: v }).postingEnabled).toBe(false);
    }
  });

  it("splits, trims, lowercases, and dedupes channel lists", () => {
    const cfg = parseSocialConfig({
      SOCIAL_AUTONOMOUS_CHANNELS: " Threads, X, threads ,x",
    });
    expect(cfg.autonomousChannels).toEqual(["threads", "x"]);
  });

  it("treats an explicitly blank list as empty, not as the default", () => {
    const cfg = parseSocialConfig({ SOCIAL_AUTONOMOUS_CHANNELS: "   " });
    expect(cfg.autonomousChannels).toEqual([]);
    // But an unset list still yields the file split.
    const cfg2 = parseSocialConfig({});
    expect(cfg2.autonomousChannels).toEqual(["threads"]);
  });

  it("deduplicates enabled channels across both lists", () => {
    const cfg = parseSocialConfig({
      SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
      SOCIAL_APPROVAL_CHANNELS: "x,facebook",
    });
    expect(enabledChannels(cfg).sort()).toEqual(["facebook", "threads", "x"]);
  });
});

describe("channel disposition (fail-closed)", () => {
  const cfg = parseSocialConfig({});

  it("resolves the file-split autonomous channels to autonomous", () => {
    expect(resolveChannelDisposition("threads", cfg)).toBe("autonomous");
    // "x" is not in the file's autonomous split (threads only, #1489),
    // so it resolves to approval, never autonomous.
    expect(resolveChannelDisposition("x", cfg)).toBe("approval");
  });

  it("resolves default approval channels to approval", () => {
    for (const ch of ["facebook", "instagram", "linkedin"]) {
      expect(resolveChannelDisposition(ch, cfg)).toBe("approval");
    }
  });

  it("resolves a channel in both lists to approval", () => {
    const both = parseSocialConfig({
      SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
      SOCIAL_APPROVAL_CHANNELS: "x,facebook",
    });
    expect(resolveChannelDisposition("x", both)).toBe("approval");
  });

  it("resolves unknown channels to approval, never autonomous", () => {
    expect(resolveChannelDisposition("tiktok", cfg)).toBe("approval");
    expect(resolveChannelDisposition("constructor", cfg)).toBe("approval");
  });

  it("resolves a known channel in neither list to approval", () => {
    const neither = parseSocialConfig({
      SOCIAL_AUTONOMOUS_CHANNELS: "threads",
      SOCIAL_APPROVAL_CHANNELS: "facebook",
    });
    expect(resolveChannelDisposition("x", neither)).toBe("approval");
  });

  it("resolves everything to approval when the autonomous list is empty", () => {
    const empty = parseSocialConfig({ SOCIAL_AUTONOMOUS_CHANNELS: "" });
    for (const ch of ["threads", "x", "facebook"]) {
      expect(resolveChannelDisposition(ch, empty)).toBe("approval");
    }
  });
});

describe("publish token gate", () => {
  const cfg = parseSocialConfig({});

  it("never publishes without a token, regardless of list", () => {
    expect(canPublish("threads", false, cfg)).toBe(false);
    expect(canPublish("facebook", false, cfg)).toBe(false);
  });

  it("publishes a known channel only with a token", () => {
    expect(canPublish("threads", true, cfg)).toBe(true);
  });

  it("never publishes an unknown channel even with a token", () => {
    expect(canPublish("tiktok", true, cfg)).toBe(false);
    expect(canPublish("constructor", true, cfg)).toBe(false);
  });
});
