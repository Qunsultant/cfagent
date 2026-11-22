/**
 * #6191 — explicit roles in the bootstrap list.
 *
 * The entry gains an explicit role list: `<role>[,<role>]*:<identity>`,
 * roles `platform` and/or `tenant`. A `platform:` prefix that silently
 * also grants tenant-admin is NOT good enough — the entry must SAY both
 * roles (`platform,tenant:`). A plain entry keeps its current meaning
 * (tenant-admin only) for backward compatibility. An unknown role is a
 * named rejection. A duplicate identity (same user twice, different
 * forms) is deduped by merging roles, with a named warning in `rejected`.
 */
import { describe, expect, it } from "vitest";
import {
  parseBootstrapListWithGenesis,
} from "../src/security/iaaaGithubEndToEnd";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("bootstrap list with explicit roles (#6191)", () => {
  it("parses platform,tenant: as both roles", () => {
    const parsed = parseBootstrapListWithGenesis(
      `platform,tenant:${UUID_A}`,
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toEqual({
      roles: ["platform", "tenant"],
      entry: { kind: "internalUserId", internalUserId: UUID_A },
    });
  });

  it("parses platform: as platform only — no silent tenant-admin", () => {
    const parsed = parseBootstrapListWithGenesis(`platform:${UUID_A}`);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toEqual([
      {
        roles: ["platform"],
        entry: { kind: "internalUserId", internalUserId: UUID_A },
      },
    ]);
  });

  it("parses tenant: as tenant only", () => {
    const parsed = parseBootstrapListWithGenesis(`tenant:${UUID_A}`);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toEqual([
      {
        roles: ["tenant"],
        entry: { kind: "internalUserId", internalUserId: UUID_A },
      },
    ]);
  });

  it("a plain entry keeps its meaning: tenant only (backward compat)", () => {
    const parsed = parseBootstrapListWithGenesis(UUID_A);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toEqual([
      {
        roles: ["tenant"],
        entry: { kind: "internalUserId", internalUserId: UUID_A },
      },
    ]);
  });

  it("a plain issuer:subject entry is not mistaken for a role prefix", () => {
    const parsed = parseBootstrapListWithGenesis(
      "https://github.com:82253453",
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toEqual([
      {
        roles: ["tenant"],
        entry: {
          kind: "providerSubject",
          providerIssuer: "https://github.com",
          providerSubject: "82253453",
        },
      },
    ]);
  });

  it("a platform,tenant: issuer:subject entry parses both roles", () => {
    const parsed = parseBootstrapListWithGenesis(
      "platform,tenant:https://accounts.google.com:116080816274398642624",
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toEqual([
      {
        roles: ["platform", "tenant"],
        entry: {
          kind: "providerSubject",
          providerIssuer: "https://accounts.google.com",
          providerSubject: "116080816274398642624",
        },
      },
    ]);
  });

  it("rejects an unknown role with a named error", () => {
    const parsed = parseBootstrapListWithGenesis(
      `platform,foo:${UUID_A}`,
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toMatch(/unknown bootstrap role 'foo'/);
  });

  it("rejects a duplicated role token in one list", () => {
    const parsed = parseBootstrapListWithGenesis(
      `platform,platform:${UUID_A}`,
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toMatch(/duplicate role 'platform'/);
  });

  it("dedupes the same identity twice (platform: + plain) by merging roles", () => {
    const parsed = parseBootstrapListWithGenesis(
      `platform:${UUID_A},${UUID_A}`,
    );
    // One entry per user, roles merged — no privilege silently lost.
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toEqual({
      roles: ["platform", "tenant"],
      entry: { kind: "internalUserId", internalUserId: UUID_A },
    });
    // The dropped duplicate is a named warning, not a silent drop.
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toMatch(/duplicate bootstrap entry/);
  });

  it("dedupes the same identity twice (plain + platform,tenant:) by merging roles", () => {
    const parsed = parseBootstrapListWithGenesis(
      `${UUID_A},platform,tenant:${UUID_A}`,
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].roles).toEqual(["platform", "tenant"]);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toMatch(/duplicate bootstrap entry/);
  });

  it("dedupes an identical platform,tenant: entry listed twice", () => {
    const parsed = parseBootstrapListWithGenesis(
      `platform,tenant:${UUID_A},platform,tenant:${UUID_A}`,
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].roles).toEqual(["platform", "tenant"]);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toMatch(/duplicate bootstrap entry/);
  });

  it("keeps two different users as two entries, one per user", () => {
    const parsed = parseBootstrapListWithGenesis(
      `platform,tenant:${UUID_A},platform,tenant:${UUID_B}`,
    );
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].roles).toEqual(["platform", "tenant"]);
    expect(parsed.entries[1].roles).toEqual(["platform", "tenant"]);
  });

  it("a derived v1: id is a plain identity, not a role prefix", () => {
    const derived = `v1:${"a".repeat(64)}`;
    const parsed = parseBootstrapListWithGenesis(derived);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toEqual([
      { roles: ["tenant"], entry: { kind: "internalUserId", internalUserId: derived } },
    ]);
  });
});
