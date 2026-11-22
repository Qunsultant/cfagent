/**
 * Issue #5164 (S10, observability program #5080) — the OTel
 * service resource: the ONE place that builds the resource
 * every OTel provider carries, so every outbound OTLP payload
 * (logs, metrics, traces) carries `service.name`.
 *
 * Why this exists: without it the SDK's default resource
 * names the service "unknown_service:node" (verified in
 * node: defaultResource().attributes.service.name), so
 * Grafana shows the service as unknown. The service name is
 * externalized — config/otel.json `backend.serviceName`
 * (default "ai-search-agent", the Worker name) + env override
 * OTEL_SERVICE_NAME — never a literal in code; the resolved
 * value arrives here through the provider configs
 * (`config.backend.serviceName`).
 *
 * The resource is the SDK default MERGED with the configured
 * service name (defaultResource().merge(...)): the merge
 * keeps the telemetry.sdk.* attributes and only overrides
 * service.name. The three SDK providers already call
 * defaultResource() when no resource is given, so building
 * it explicitly adds no new detector cost in the Worker.
 * The library is @opentelemetry/resources (the SDKs' own
 * dependency, now declared direct): resourceFromAttributes
 * + defaultResource — no hand-rolled resource.
 */
import { defaultResource, resourceFromAttributes, type Resource } from "@opentelemetry/resources";

/** The OTLP resource attribute key for the service name. */
export const OTEL_SERVICE_NAME_ATTRIBUTE = "service.name" as const;

/**
 * Builds the OTel resource for one provider: the SDK default
 * resource with `service.name` set to the configured service
 * name. The same resource is passed to the LoggerProvider,
 * MeterProvider, and TracerProvider, so all three signals'
 * payloads carry the same service identity — the archive AND
 * Grafana both get it, because the resource is stamped in
 * the shared provider builders, before the fan-out transport.
 */
export function otelServiceResource(serviceName: string): Resource {
  return defaultResource().merge(
    resourceFromAttributes({ [OTEL_SERVICE_NAME_ATTRIBUTE]: serviceName }),
  );
}
