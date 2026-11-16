import { describe, it, expect } from "vitest";
import { resolvePayerWalletIdentity } from "../src/security/payerWalletIdentity";

describe("x402 payer-wallet fallback identity policy (#4621)", () => {
  it("uses session-login with broker token access when x-user-login is present", async () => {
    const res = await resolvePayerWalletIdentity({
      sessionLogin: "alice",
      verifiedPayerWallet: "0xAbCdEf1234",
    });
    expect(res).toEqual({
      ok: true,
      mode: "session-login",
      subjectId: "alice",
      tierLookupLogin: "alice",
      canAccessUserBrokerTokens: true,
    });
  });

  it("scopes an unmapped payer wallet to wallet-as-subject without broker token access or tier elevation", async () => {
    const res = await resolvePayerWalletIdentity({
      sessionLogin: null,
      verifiedPayerWallet: "0xAbCdEf1234",
    });
    expect(res).toEqual({
      ok: true,
      mode: "wallet-as-subject",
      subjectId: "payer:0xabcdef1234",
      tierLookupLogin: null,
      canAccessUserBrokerTokens: false,
    });
  });

  it("resolves tierLookupLogin from a wallet-mapped login without granting session broker token access", async () => {
    const res = await resolvePayerWalletIdentity({
      verifiedPayerWallet: "0xAbCdEf1234",
      resolveWalletMappedLogin: async (w) =>
        w.toLowerCase() === "0xabcdef1234" ? "pro-member" : null,
    });
    expect(res).toEqual({
      ok: true,
      mode: "wallet-as-subject",
      subjectId: "payer:0xabcdef1234",
      tierLookupLogin: "pro-member",
      canAccessUserBrokerTokens: false,
    });
  });

  it("fails closed when neither a session login nor a verified payer wallet exists", async () => {
    const res = await resolvePayerWalletIdentity({
      sessionLogin: "",
      verifiedPayerWallet: null,
    });
    expect(res).toEqual({
      ok: false,
      code: "FAILURE_PAYER_IDENTITY_REQUIRED",
      error: "Verified session login or x402 payer wallet is required.",
    });
  });
});
