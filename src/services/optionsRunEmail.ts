/**
 * Issue #1336 (job-truth program #1332): email for manual options
 * runs, mirroring the scheduled direct path in ScheduledTasksService
 * exactly — cfpay first with PDF + XLSX attachments, local fallback,
 * never throwing (a failed email warns in the route, never fails
 * the run). The bridged path is untouched: when the follow-up
 * pipeline owns delivery, the bridge plans the email instead and
 * this helper is not called.
 */
import type { CfpayA2AConfig } from "./cfpayA2A";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/optionsRunEmail",
});

export const OPTIONS_PDF_CONTENT_TYPE = "application/pdf";
export const OPTIONS_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Recipient precedence, same as the scheduled path. */
export function resolveOptionsRunEmailRecipient(
  requestEmailTo: string | undefined,
  env: Record<string, unknown>,
): string | undefined {
  const opt = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  return opt(requestEmailTo) ?? opt(env.OPTIONS_EMAIL_TO) ?? opt(env.SCREENER_EMAIL_TO);
}

export interface OptionsRunEmailFile {
  bytes: Uint8Array;
  fileName: string;
}

function toB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export interface OptionsRunEmailDeps {
  cfpay: CfpayA2AConfig | null;
  sendCfpay: (
    config: CfpayA2AConfig,
    args: { to: string; subject: string; body: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  sendCfpayWithAttachments: (
    config: CfpayA2AConfig,
    args: {
      to: string;
      subject: string;
      body: string;
      attachments: Array<{ filename: string; contentB64: string; contentType: string }>;
    },
  ) => Promise<{ ok: boolean; error?: string }>;
  sendLocal: (
    to: string,
    subject: string,
    html: string,
    text: string,
    attachments?: Array<{ fileName: string; contentType: string; contentBase64: string }>,
  ) => Promise<boolean>;
}

export interface OptionsRunEmailArgs {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  pdf?: OptionsRunEmailFile;
  xlsx?: OptionsRunEmailFile;
}

export async function sendOptionsRunEmail(
  deps: OptionsRunEmailDeps,
  args: OptionsRunEmailArgs,
): Promise<{ sent: boolean; via: "cfpay" | "local" | "none" }> {
  const cfpayAttachments = [
    ...(args.pdf ? [{ filename: args.pdf.fileName, contentB64: toB64(args.pdf.bytes), contentType: OPTIONS_PDF_CONTENT_TYPE }] : []),
    ...(args.xlsx ? [{ filename: args.xlsx.fileName, contentB64: toB64(args.xlsx.bytes), contentType: OPTIONS_XLSX_CONTENT_TYPE }] : []),
  ];
  if (deps.cfpay) {
    try {
      const r =
        cfpayAttachments.length > 0
          ? await deps.sendCfpayWithAttachments(deps.cfpay, { to: args.to, subject: args.subject, body: args.textBody, attachments: cfpayAttachments })
          : await deps.sendCfpay(deps.cfpay, { to: args.to, subject: args.subject, body: args.textBody });
      if (r.ok) return { sent: true, via: "cfpay" };
      structuredLog.warn("options_run_email.cfpay_failed", {
        message: "[optionsRunEmail] cfpay email failed, falling back to local",
        error: r.error,
      });
    } catch (err) {
      structuredLog.warn("options_run_email.cfpay_error", {
        message: "[optionsRunEmail] cfpay email error, falling back to local",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    const localAttachments = [
      ...(args.pdf ? [{ fileName: args.pdf.fileName, contentType: OPTIONS_PDF_CONTENT_TYPE, contentBase64: toB64(args.pdf.bytes) }] : []),
      ...(args.xlsx ? [{ fileName: args.xlsx.fileName, contentType: OPTIONS_XLSX_CONTENT_TYPE, contentBase64: toB64(args.xlsx.bytes) }] : []),
    ];
    const ok = await deps.sendLocal(
      args.to,
      args.subject,
      args.htmlBody,
      args.textBody,
      localAttachments.length > 0 ? localAttachments : undefined,
    );
    return ok ? { sent: true, via: "local" } : { sent: false, via: "none" };
  } catch (err) {
    structuredLog.warn("options_run_email.local_failed", {
      message: "[optionsRunEmail] local email failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, via: "none" };
  }
}
