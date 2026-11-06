# Data provider platform

**Status:** As-built · 2026-11-06 · Traces to #1116 (data-provider
platform programme, closed), under epic #798 · #CDO-mha7

The provider platform is how all market data enters the system. Before
it, providers were constructed at dozens of call sites, three provider
vocabularies coexisted, raw provider payloads were stored nowhere, and
provider choice was implied by the route a caller happened to take.
The platform replaced that with one contract, one registry, and
capture of everything fetched.

## The port and the registry

- **Contract** — `src/trading/dataProviders/contract.ts` defines the
  plugin surface: `DATA_PROVIDER_IDS`, `DATA_PROVIDER_CAPABILITIES`,
  the tier model (`freemium` / `premium`), and the per-capability
  request/result shapes (quotes, options chains, screen universes,
  historical bars).
- **Registry** — `src/trading/dataProviders/registry.ts`
  (`DataProviderRegistry`) resolves providers by capability. It
  raises typed errors (`DataProviderNotFoundError`,
  `DataProviderTierError`) rather than substituting silently.
- **Adapters** — `src/trading/dataProviders/adapters.ts` holds the
  per-provider adapters (E*TRADE first as the vertical slice, then
  Yahoo, Nasdaq, Alpaca, Public.com). An adapter names the provider
  it integrates; that naming is the integration layer's job and stays
  behind the port (see [neutrality-census.md](neutrality-census.md)).
- **Lifecycle and configuration** — `lifecycle.ts` (runtime
  provisioning/deprovisioning) and `providerConfigStore.ts` (one
  provider-config store, replacing config scattered across files).
  Tier entitlements ride the platform's existing x402 gate.

## Capability routing — composition, not precedence

Screening does not pick one provider per run. The registry assigns
providers **per data element** within a run: a primary assignment
plus declared gap-fill, with precedence applied only where two
providers genuinely overlap on the same element. Every element in a
result carries its **per-element provenance** (which provider supplied
it), so a composed result is auditable element by element. This is
the routing model the registry's `CapabilityAssignment` encodes.

## Capture

Everything fetched through the platform is captured — **raw payload
plus normalized form, linked to the run that fetched it** — behind
the capture port (`src/data/providerCapturePorts.ts`, with the store
in `src/trading/dataProviders/captureStore.ts`). Capture is what
makes provider behaviour inspectable after the fact and what the
health read model aggregates. Feed jobs (#3530,
[feed-jobs.md](feed-jobs.md)) persist through this same machinery;
there is no second capture store.

## Provider health

`src/trading/dataProviders/providerHealth.ts` is the metering read
model over capture records: per-provider capture counts, failure
rates, and recent activity, surfaced in the client
(`src/client/DataProvidersPanel.tsx`, data via
`src/client/dataProvidersApi.ts`). Health is derived from what was
actually captured — it is telemetry over fetches that happened, not
a synthetic probe. Its limits are named in
[feed-jobs.md](feed-jobs.md): health is not job status.

## Conformance

`src/trading/dataProviders/conformance.ts` is the drop-in replacement
gate: `runDataProviderConformance` runs probes against a provider
and returns a `ConformanceReport`. A provider that cannot pass the
kit for a capability is not assigned that capability by the registry.
New adapters land behind the same kit; conformance is the admission
test, not documentation.

## Boundaries

- Screening request shapes have a single definition site
  (`src/trading/screeningSchemas.ts`, Zod); provider selection is
  never re-declared per surface.
- The platform is broker-neutral and provider-neutral at the platform
  layer: platform services do not wear a provider's brand. Provider
  names belong to the integration layer (adapters, provider OAuth,
  provider routes) — see [neutrality-census.md](neutrality-census.md).
