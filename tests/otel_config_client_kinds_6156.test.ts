/**
 * Issue #6156 (observability program #5080) — the OTel config panel
 * broke in production after #5164 (PR #6145): the backend keys it
 * added use kinds ("string", "protocol") the panel's client-side
 * validator did not know, so `parseOtelConfig` rejected the whole
 * response as "malformed" and the config page failed to load — even
 * though the API returned a complete, valid 200.
 *
 * TDD Red first: the backend keys below carry kinds "string" and
 * "protocol", which are not in KEY_KINDS yet, so this file fails
 * with "OTel config response was malformed." until the fix lands.
 */
import { describe, it, expect } from "vitest";
import { parseOtelConfig } from "../src/client/otelConfigApi";

const BACKEND_RESPONSE = {
  catalog: [
    {
      code: "OBS-1001",
      name: "otel.config.invalid",
      template: "{switch} unrecognized value at {source}",
      severity: "warning",
    },
  ],
  keys: [
    {
      key: "backend.serviceName",
      kind: "string",
      description: "OTLP service name stamped as service.name",
      envName: "OTEL_SERVICE_NAME",
    },
    {
      key: "backend.protocol",
      kind: "protocol",
      description: "OTLP backend wire protocol (http/json | http/protobuf)",
      envName: "OTEL_EXPORTER_OTLP_PROTOCOL",
    },
    {
      key: "backend.endpoint",
      kind: "string",
      description: "Grafana Cloud OTLP gateway URL",
      envName: "OTEL_BACKEND_ENDPOINT",
    },
    {
      key: "backend.instanceId",
      kind: "string",
      description: "Grafana Cloud stack/instance ID",
      envName: "OTEL_BACKEND_INSTANCE_ID",
    },
    {
      key: "backend.enabled",
      kind: "boolean",
      description: "Grafana Cloud backend on/off",
      envName: "OTEL_BACKEND_ENABLED",
    },
  ],
  overrides: [],
  effective: {
    "backend.serviceName": { value: "ai-search-agent", source: "file" },
    "backend.protocol": { value: "http/json", source: "file" },
    "backend.endpoint": {
      value: "https://otlp-gateway-prod-us-east-2.grafana.net/otlp",
      source: "file",
    },
    "backend.instanceId": { value: "1929738", source: "file" },
    "backend.enabled": { value: true, source: "file" },
  },
};

describe("otel config client kinds (#6156)", () => {
  it("parses a config response carrying the backend keys (string / protocol kinds)", () => {
    const parsed = parseOtelConfig(BACKEND_RESPONSE);
    expect(parsed.keys).toHaveLength(5);
    expect(parsed.keys.find((k) => k.key === "backend.serviceName")?.kind).toBe(
      "string",
    );
    expect(parsed.keys.find((k) => k.key === "backend.protocol")?.kind).toBe(
      "protocol",
    );
    expect(parsed.keys.find((k) => k.key === "backend.endpoint")?.kind).toBe(
      "string",
    );
    expect(parsed.keys.find((k) => k.key === "backend.instanceId")?.kind).toBe(
      "string",
    );
    expect(parsed.effective["backend.serviceName"]?.value).toBe(
      "ai-search-agent",
    );
    expect(parsed.effective["backend.protocol"]?.value).toBe("http/json");
  });

  it("still rejects a key whose kind is not in the allow-list", () => {
    const bad = {
      ...BACKEND_RESPONSE,
      keys: [
        {
          key: "backend.serviceName",
          kind: "nope",
          description: "not a kind",
        },
      ],
    };
    expect(() => parseOtelConfig(bad)).toThrow(
      "OTel config response was malformed.",
    );
  });
});
