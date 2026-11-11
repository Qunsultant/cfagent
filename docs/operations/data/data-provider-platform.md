# Data provider platform

**Status:** As-built · 2026-11-06 · Updated 2026-11-10 (#3990: defaults
alpaca/alpaca, broker/pure taxonomy, Public.com as a live broker) ·
Traces to #1116 (data-provider platform programme, closed), under epic
#798 · #CDO-mha7

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

## Defaults and taxonomy (#3990)

**The default pair is alpaca/alpaca** (`DEFAULT_TENANT_PROVIDERS` in
`src/data/commercialPorts.ts`, mirrored on the client): the tenant's
data provider and broker are both Alpaca unless the tenant stores
otherwise. History: #2594 introduced the two selections (both
etrade); #3451 moved only the *broker* default to Alpaca in paper
mode; #3812 kept the data default at etrade; #3990 moves the data
default to alpaca. The reason is the options gate: the gate checks
the tenant's data provider for `optionsChains`, and the Alpaca data
adapter now declares and serves it (via the repo's own Alpaca
options read path), so a default tenant's chains work instead of
being refused. No tenant silently mixes two firms' data and money
paths. Fundamentals for an Alpaca-default tenant come from Yahoo by
design (ADR 0019: Alpaca fundamentals are Yahoo-covered, never
faked). The capability routes themselves are unchanged — the
optionsChains route primary stays etrade, because the unified
options service registers only the E*TRADE adapter in its local
registry.

**Brokers vs pure data providers.** `DATA_PROVIDER_IDS` (etrade,
public, yahoo, nasdaq, alpaca) mixes the two kinds in one list, so
`DATA_PROVIDER_KINDS` (`src/trading/dataProviders/contract.ts`)
splits them: etrade, public and alpaca are **brokers** (quote data +
trading capabilities); yahoo and nasdaq are **pure data providers**
(Yahoo: delayed quotes, technicals, fundamentals, sentiment; Nasdaq:
symbols/listings). A broker MAY also be a data source, registered
with its declared capabilities — the split is a kind annotation, not
a second registry. The Settings UI lists brokers under Broker and
data sources under Data provider, both derived from the same map.

**Capability matrix — declared == servable.** Each provider's
declared capabilities are exactly what it serves (the conformance
kit's rule is the law: a provider that declares a capability it does
not implement fails that capability's check):

| Provider | Serves |
| --- | --- |
| etrade | quotes, optionsChains |
| public | quotes, optionsChains (servable only once an operator configures → verifies → enables its provider record; the seed is "registered") |
| yahoo | quotes, historicalBars, fundamentals, news |
| nasdaq | screenUniverse |
| alpaca | quotes, historicalBars, optionsChains (fundamentals via the Yahoo route, never faked) |

Gap-fill routing covers a missing capability from a provider that
declares it (quotes never gap-fill, #2144). The options gate's
capability map (`DATA_PROVIDER_CAPABILITIES` in
`src/services/optionsProviderContext.ts`) is a pure projection of
the adapters' declared capabilities, pinned by test
(`tests/data_provider_capabilities_3990.test.ts`).

**Public.com as a live broker.** Public has a trading platform
(`src/trading/public/platform.ts`), a catalog entry, five copilot
tools (`public_get_quote`, `public_preview_order`,
`public_place_order`, `public_orders`, `public_cancel_order`), and
a personal-token connect surface in Settings. Public has **no paper
trading mode**: a TEST tenant gets reads + preview only, and
placement in TEST is refused with `FAILURE_PUBLIC_NO_PAPER_MODE`
before any broker call; live (PROD) placement is an explicit act.
Placement is preview-first (a stored draft is settled, #3846) and
returns an acceptance receipt, never a fill.

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
