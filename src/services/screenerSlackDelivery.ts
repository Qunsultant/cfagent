/**
 * Unified Screener Slack delivery service.
 *
 * Implements both:
 * 1. Direct Slack Web API / Webhook delivery (primary direct integration).
 * 2. cfpay Agent-to-Agent (A2A) protocol delivery (additive option).
 *
 * Contract: A2A is an additive capability and never replaces or breaks direct
 * Slack delivery. Bi-directional fallback ensures reports reach the user
 * even if one transport encounters an error.
 */

import {
  cfpayPostFileToSlack,
  cfpayPostToSlack,
  getCfpayConfig,
} from "./cfpayA2A";
import { postFilesToSlack, type SlackFile, type SlackFilesEnv } from "./slackFiles";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/screenerSlackDelivery",
});

export interface ScreenerSlackPdf {
  bytes: Uint8Array;
  fileName: string;
  title: string;
  comment: string;
}

export interface ScreenerSlackFile {
  bytes: Uint8Array;
  fileName: string;
  title: string;
  comment?: string;
}

export interface ScreenerSlackDelivery {
  text: string;
  channel?: string;
  pdf?: ScreenerSlackPdf;
  files?: ScreenerSlackFile[];
}

/** Deliver a screener result directly to Slack via Bot Web API or incoming webhook. */
export async function deliverScreenerToSlackDirect(
  env: unknown,
  delivery: ScreenerSlackDelivery,
): Promise<{ ok: boolean; error?: string }> {
  const e = env as Record<string, unknown> & SlackFilesEnv;
  const channel = delivery.channel ||
    e.SLACK_CHANNEL_ID ||
    (e.SCREENER_SLACK_CHANNEL as string | undefined) ||
    (e.SLACK_CHANNEL as string | undefined);

  const token = e.SLACK_BOT_TOKEN as string | undefined;
  const webhookUrl = e.SLACK_WEBHOOK_URL as string | undefined;

  if (!token && !webhookUrl) {
    return { ok: false, error: "Neither SLACK_BOT_TOKEN nor SLACK_WEBHOOK_URL is configured for direct delivery" };
  }

  // 1. If we have files to upload and a Bot Token is present, use external upload API
  const filesToUpload: ScreenerSlackFile[] = [
    ...(delivery.pdf ? [delivery.pdf] : []),
    ...(delivery.files ?? []),
  ];

  // Issue #1216 (#1209 F1): when files were requested, ONLY a complete
  // file upload may report ok — a text post is not a substitute for a
  // report the caller handed us. (The pre-F1 code degraded to a text
  // post and returned ok with zero files delivered.)
  if (filesToUpload.length > 0 && !(token && channel)) {
    return { ok: false, error: "Direct file delivery is not configured (SLACK_BOT_TOKEN / channel) — files were requested but cannot be posted" };
  }

  if (filesToUpload.length > 0 && token && channel) {
    const slackFiles: SlackFile[] = filesToUpload.map((f) => {
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < f.bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...f.bytes.subarray(i, i + chunkSize));
      }
      return {
        filename: f.fileName,
        contentB64: btoa(binary),
        title: f.title || f.fileName,
      };
    });

    const uploadRes = await postFilesToSlack(
      {
        SLACK_BOT_TOKEN: token,
        SLACK_CHANNEL_ID: channel,
        SCREENER_SLACK_CHANNEL: channel,
        SLACK_CHANNEL: channel,
      },
      delivery.text,
      slackFiles
    );

    if (uploadRes.posted >= filesToUpload.length) {
      return { ok: true };
    }
    structuredLog.warn("deliverScreenerToSlackDirect.file_upload_incomplete", {
      message: "[deliverScreenerToSlackDirect] Direct file upload incomplete",
      error: uploadRes.error,
      posted: uploadRes.posted,
      fileCount: filesToUpload.length,
    });
    return {
      ok: false,
      error: `Direct file upload incomplete: posted ${uploadRes.posted} of ${filesToUpload.length} file(s)${uploadRes.error ? ` — ${uploadRes.error}` : ""}`,
    };
  }

  // 2. Fall back to posting plain text via Web API or webhook
  if (token && channel) {
    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text: delivery.text }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (data.ok) return { ok: true };
      structuredLog.warn("deliverScreenerToSlackDirect.chat_post_message_failed", {
        message: "[deliverScreenerToSlackDirect] chat.postMessage failed",
        error: data.error,
      });
    } catch (err) {
      structuredLog.warn("deliverScreenerToSlackDirect.chat_post_message_error", {
        message: "[deliverScreenerToSlackDirect] chat.postMessage error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: delivery.text }),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Webhook returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { ok: false, error: "Direct Slack message post failed" };
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Deliver a screener result through the Slack A2A agent.
 *
 * Issue #1216 (#1209 F1): when the delivery carries files, EVERY file
 * is posted (the PDF plus delivery.files — the pre-F1 leg posted only
 * the PDF and silently dropped the rest, e.g. every XLSX), and ok
 * means every requested file actually posted. A file failure returns
 * NOT ok — never a text post dressed as success — so the master entry
 * falls through to the direct leg, which posts text + all files.
 */
export async function deliverScreenerToSlackA2A(
  env: unknown,
  delivery: ScreenerSlackDelivery,
): Promise<{ ok: boolean; error?: string }> {
  const config = getCfpayConfig(env);
  if (!config) return { ok: false, error: "CFPAY_A2A_TOKEN is not configured" };

  const e = env as Record<string, unknown>;
  const channel = delivery.channel ||
    (e.SCREENER_SLACK_CHANNEL as string | undefined) ||
    (e.SLACK_CHANNEL as string | undefined);

  const files: ScreenerSlackFile[] = [
    ...(delivery.pdf
      ? [{ bytes: delivery.pdf.bytes, fileName: delivery.pdf.fileName, title: delivery.pdf.title, comment: delivery.pdf.comment }]
      : []),
    ...(delivery.files ?? []),
  ];

  if (files.length > 0) {
    if (!channel) {
      return { ok: false, error: "No Slack channel resolved for A2A file delivery" };
    }
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const result = await cfpayPostFileToSlack(config, {
        channel,
        filename: f.fileName,
        contentB64: bytesToB64(f.bytes),
        title: f.title,
        // The run text rides as the first file's comment; a file's own
        // comment (the PDF's) wins when it carries one.
        ...(i === 0 ? { initial_comment: f.comment ?? delivery.text } : {}),
      });
      if (!result.ok) {
        structuredLog.warn("deliverScreenerToSlackA2A.file_delivery_failed", {
          message: `[deliverScreenerToSlackA2A] A2A file delivery failed for ${f.fileName}`,
          fileName: f.fileName,
          error: result.error,
        });
        return { ok: false, error: `A2A file delivery failed for ${f.fileName}: ${result.error ?? "unknown error"}` };
      }
    }
    return { ok: true };
  }

  const result = await cfpayPostToSlack(config, delivery.text, channel);
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}

/**
 * Master Slack delivery entry point.
 *
 * Tries A2A if configured; automatically falls back to direct Slack (bot token
 * or webhook) if A2A is unavailable or encounters an error. If A2A is not configured,
 * directly uses direct Slack.
 *
 * Issue #1216 contract: when the delivery carries files, `ok` means
 * one transport delivered the text AND every file. A transport that
 * could not post the files reports failure so the other is tried; if
 * neither completes the files, the result is failure — never a
 * text-only success. (A partial A2A success followed by a complete
 * direct re-send can duplicate a file in the channel in that edge;
 * at-least-once with an honest status beats silent loss.)
 */
export async function deliverScreenerToSlack(
  env: unknown,
  delivery: ScreenerSlackDelivery,
): Promise<{ ok: boolean; method: "a2a" | "direct"; error?: string }> {
  const cfpay = getCfpayConfig(env);
  if (cfpay) {
    const a2aRes = await deliverScreenerToSlackA2A(env, delivery);
    if (a2aRes.ok) return { ok: true, method: "a2a" };
    structuredLog.warn("deliverScreenerToSlack.a2a_delivery_failed_fallback", {
      message: "[deliverScreenerToSlack] A2A delivery failed, attempting direct Slack fallback",
      error: a2aRes.error,
    });
  }

  const directRes = await deliverScreenerToSlackDirect(env, delivery);
  if (directRes.ok) return { ok: true, method: "direct" };

  return {
    ok: false,
    method: cfpay ? "a2a" : "direct",
    error: directRes.error || "Slack delivery failed on all channels",
  };
}
