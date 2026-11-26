/**
 * Issue #4708 — Wire STRIPE_TEST_SECRET_KEY through CI/CD deploy workflow and wrangler.jsonc
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { StripePaymentStrategy } from "../src/patterns/paymentStrategies";
import { createCheckoutPorts } from "../src/services/createCheckoutPorts";
import { createBillingPorts } from "../src/services/createBillingPorts";
import { createBillingCheckoutPorts } from "../src/services/createBillingCheckoutPorts";
import type { Env } from "../src/types";

const deployWorkflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf-8",
);

const wranglerRaw = readFileSync(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf-8",
);

describe("Issue #4708 — STRIPE_TEST_SECRET_KEY CI/CD & wrangler.jsonc wiring", () => {
  it("maps and syncs STRIPE_TEST_SECRET_KEY and STRIPE_LIVE_SECRET_KEY in deploy.yml", () => {
    expect(deployWorkflow).toMatch(
      /STRIPE_TEST_SECRET_KEY:\s*\$\{\{\s*secrets\.STRIPE_TEST_SECRET_KEY\s*\}\}/,
    );
    expect(deployWorkflow).toMatch(
      /STRIPE_LIVE_SECRET_KEY:\s*\$\{\{\s*secrets\.STRIPE_LIVE_SECRET_KEY\s*\}\}/,
    );
    expect(deployWorkflow).toContain(
      'optional_secret STRIPE_TEST_SECRET_KEY "$STRIPE_TEST_SECRET_KEY"',
    );
    expect(deployWorkflow).toContain(
      'optional_secret STRIPE_LIVE_SECRET_KEY "$STRIPE_LIVE_SECRET_KEY"',
    );
    expect(deployWorkflow).toContain(
      'if [ -z "$EFFECTIVE_STRIPE_SECRET_KEY" ]; then EFFECTIVE_STRIPE_SECRET_KEY="$STRIPE_TEST_SECRET_KEY"; fi',
    );
    expect(deployWorkflow).toContain(
      'optional_secret STRIPE_SECRET_KEY "$EFFECTIVE_STRIPE_SECRET_KEY"',
    );
  });

  it("configures keep_vars and documents CI/CD Stripe secret management in wrangler.jsonc without hardcoding keys", () => {
    // Phase 3 (#6550): keep_vars is false (the moved vars must actually
    // leave the deployed env) and the Stripe note is a real `//`
    // comment now, not a `_comment_stripe` var. The secrets themselves
    // are still synced by the deploy workflow's sync-secrets job.
    expect(wranglerRaw).toContain('"keep_vars": false');
    expect(wranglerRaw).not.toContain('"_comment_stripe"');
    expect(wranglerRaw).toContain("Set STRIPE_TEST_SECRET_KEY / STRIPE_LIVE_SECRET_KEY / STRIPE_SECRET_KEY via CI/CD");
    expect(wranglerRaw).toContain("STRIPE_TEST_SECRET_KEY");
    expect(wranglerRaw).not.toMatch(/sk_test_[A-Za-z0-9]{10,}/);
    expect(wranglerRaw).not.toMatch(/sk_live_[A-Za-z0-9]{10,}/);
  });

  it("resolves STRIPE_TEST_SECRET_KEY in both TEST and PROD environments when no live/generic key is set", () => {
    const strategy = new StripePaymentStrategy();

    const prodWithTestKey = strategy.resolveApiKey({
      ENVIRONMENT: "PROD",
      STRIPE_TEST_SECRET_KEY: "sk_test_cicd_4708",
    } as Env);
    expect(prodWithTestKey).toEqual({
      apiKey: "sk_test_cicd_4708",
      mode: "sandbox",
    });

    const testWithTestKey = strategy.resolveApiKey({
      ENVIRONMENT: "TEST",
      STRIPE_TEST_SECRET_KEY: "sk_test_cicd_4708",
    } as Env);
    expect(testWithTestKey).toEqual({
      apiKey: "sk_test_cicd_4708",
      mode: "sandbox",
    });

    // Composition roots also activate when only STRIPE_TEST_SECRET_KEY is present in PROD
    expect(
      createCheckoutPorts({
        STRIPE_TEST_SECRET_KEY: "sk_test_cicd_4708",
      })?.card,
    ).not.toBeNull();
    expect(
      createBillingPorts(
        { STRIPE_TEST_SECRET_KEY: "sk_test_cicd_4708" },
        true,
      ),
    ).not.toBeNull();
    expect(
      createBillingCheckoutPorts({
        STRIPE_TEST_SECRET_KEY: "sk_test_cicd_4708",
      }),
    ).not.toBeNull();
  });
});
