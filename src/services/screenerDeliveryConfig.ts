/**
 * Issue #1770 (slice B, F-63): the named delivery-config check for
 * screener email.
 *
 * History: the scan row said email dispatch is "safely skipped (with
 * warning) when RESEND_API_KEY/SMTP config [is] missing". On current
 * main there is NO Resend sender at all (RESEND_API_KEY has zero hits
 * in src) and no SMTP sender either — email actually travels via
 * cfpay A2A (CFPAY_OUTBOUND_TOKEN, with DASHBOARD_API_KEY_IS_A2A_TOKEN
 * as a deprecated transitional fallback superseded by
 * CFPAY_OUTBOUND_TOKEN, and CFPAY_A2A_TOKEN as a third fallback) or the
 * Cloudflare Email Sending binding (env.EMAIL). A run that requests
 * email with neither transport configured used to skip silently: the
 * bus publisher dropped the local send's `false` return without even
 * a warning. This check names the gap so callers can surface it as a
 * visible status instead of a silent skip.
 *
 * Pure env inspection: it reads only the PRESENCE of config (never a
 * secret value), and RESEND/SMTP variables are reported by NAME only
 * as set-but-unconsumed — setting one does not enable delivery.
 */
import { getCfpayConfig } from "./cfpayA2A";

export type ScreenerEmailTransport = "cfpay-a2a" | "email-binding";

export interface ScreenerDeliveryConfigStatus {
  /** Transports available for screener email in this deployment. */
  emailTransports: ScreenerEmailTransport[];
  /** True when at least one email transport is available. */
  emailConfigured: boolean;
  /**
   * Named reason email is unavailable; absent when configured. Names
   * exactly which transports are missing, and notes that RESEND/SMTP
   * variables do not enable delivery on current main.
   */
  emailMissingReason?: string;
  /**
   * Email-related env var NAMES present in env but consumed by no
   * sender on current main (values never read, never returned).
   */
  unusedEmailVars: string[];
}

/**
 * Email-related env var names that no sender on current main reads.
 * RESEND_API_KEY is the scan row's original name; the SMTP names cover
 * the common SMTP configuration shapes. Presence here means "set but
 * does not enable delivery", never "configured".
 */
const UNUSED_EMAIL_VAR_NAMES = [
  "RESEND_API_KEY",
  "SMTP_HOST",
  "SMTP_URL",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
] as const;

function hasEmailBinding(env: Record<string, unknown>): boolean {
  const binding = env.EMAIL as { send?: unknown } | undefined;
  return !!binding && typeof binding.send === "function";
}

export function checkScreenerDeliveryConfig(
  env: unknown
): ScreenerDeliveryConfigStatus {
  const record = (env ?? {}) as Record<string, unknown>;
  const emailTransports: ScreenerEmailTransport[] = [];
  if (getCfpayConfig(env) !== null) emailTransports.push("cfpay-a2a");
  if (hasEmailBinding(record)) emailTransports.push("email-binding");
  const unusedEmailVars = UNUSED_EMAIL_VAR_NAMES.filter((name) => {
    const value = record[name];
    return typeof value === "string" && value.length > 0;
  });
  const emailConfigured = emailTransports.length > 0;
  if (emailConfigured) {
    return { emailTransports, emailConfigured, unusedEmailVars };
  }
  const unusedNote =
    unusedEmailVars.length > 0
      ? ` Note: ${unusedEmailVars.join(", ")} ${unusedEmailVars.length === 1 ? "is" : "are"} set but consumed by no sender on current main, so ${unusedEmailVars.length === 1 ? "it does" : "they do"} not enable delivery.`
      : "";
  return {
    emailTransports,
    emailConfigured,
    emailMissingReason:
      "No email transport is configured: the cfpay A2A token " +
      "(CFPAY_OUTBOUND_TOKEN, deprecated fallback " +
      "DASHBOARD_API_KEY_IS_A2A_TOKEN, or CFPAY_A2A_TOKEN) is unset and " +
      "the env.EMAIL binding is not bound. Email requested by this run " +
      "will be skipped." +
      unusedNote,
    unusedEmailVars,
  };
}
