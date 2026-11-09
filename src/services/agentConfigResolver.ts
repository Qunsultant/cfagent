/**
 * Issue #3741 — the ONE resolver: every capability enable and
 * every documented choice resolves through this module, per
 * agent class AND per copilot registration/surface, from
 * externalized configuration. The decision record adopted on
 * the issue (2026-11-08) is the contract:
 *
 * - ONE resolver for everything — channels, runtime
 *   capabilities, tools, and choices. No family keeps its own
 *   mechanism: the family modules (copilotChannels,
 *   copilotVoiceBackend, chatNlqModes, screenerModes) REGISTER
 *   their entries here and their public resolvers delegate;
 *   their keys, value shapes, and behavior are preserved
 *   exactly (the #3796 generalization pattern).
 * - Granularity: the most granular available scope wins —
 *   code default → agent class → tenant → instance/
 *   registration → run, where a machinery has that scope.
 * - Layers: stored > env > code default. The env layer is
 *   deployment defaults only; the stored layer is read at
 *   resolve time, so a stored flip is live on the next turn —
 *   nothing is cached at construction.
 * - The effective source is NAMED in every resolution result
 *   (and available to audits): "run" | "session" | "user" |
 *   "stored" | "env" | "pin" | "default".
 * - Who flips: the operator (deployment layer), the tenant
 *   (self-service, the stored layer's write door), and the
 *   agent itself (its settings door) — every flip through the
 *   write door is AUDITED (agent_config.write /
 *   agent_config.write_refused, through the host's audit — the
 *   awareness/settings-change machinery).
 * - Same-layer conflicts: last-writer-wins, audited.
 * - Operator floor: the operator layer can PIN an entry
 *   (AGENT_CONFIG_PINS, entries `<scope>:<entryId>`; payments
 *   is the standing example). A pin is externalized, named as
 *   the effective source ("pin"), and freezes the operator
 *   layer's own value; lower-layer write attempts refuse BY
 *   NAME (AGENT_CONFIG_PINNED) and change nothing.
 * - State OFF = fully ephemeral: the manifest's requires-edges
 *   refuse by name where an enabled capability requires state
 *   (see capabilityManifest.ts — the resolver's `state` entry
 *   carries the same named refusals as the manifest read).
 *
 * This module is a pure seam in the family idiom: no env access
 * at import time, resolution never throws on configuration
 * (malformed entries are collected into `issues`, surfaced,
 * never silently applied), and the only throw is for an
 * UNREGISTERED entry id — a programming error, which the write
 * door and the HTTP door convert into a named refusal.
 */

import {
  ALL_CAPABILITY_IDS,
  AGENT_CAPABILITIES_DISABLED_ENV,
  parseCapabilityDisabledList,
  resolveAgentCapabilityManifest,
  type CapabilityId,
} from "../actors/capabilityManifest";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Identity, sources, results
// ---------------------------------------------------------------------------

/**
 * The agent a resolution is FOR. Every field is a scope the
 * granularity chain can key on; a family entry reads the
 * fields its machinery has (a channel reads registrationId, a
 * capability reads className + scopes, the voice backend reads
 * surfaceId).
 */
export interface AgentConfigIdentity {
  /** Agent class name (e.g. "OrchestratorAgent", "ScreenerAgent"). */
  className?: string;
  /** Copilot registration id (general | options | stock). */
  registrationId?: string;
  /** Voice surface id (a registration, or "trading-desk"). */
  surfaceId?: string;
  /**
   * Additional env-override scopes for capability entries —
   * the class's wrangler binding names (the manifest override
   * scopes match these, beside the class name and `*`).
   */
  scopes?: string[];
}

/** The layer that decided a resolution — named, always. */
export type AgentConfigSource =
  | "run"
  | "session"
  | "user"
  | "stored"
  | "env"
  | "pin"
  | "default";

export interface AgentConfigResolution<T = unknown> {
  entryId: string;
  identity: AgentConfigIdentity;
  /** The resolved value (the entry's typed domain). */
  value: T;
  /** Which layer decided — named in every result. */
  source: AgentConfigSource;
  /** The winning scope detail: the stored key, the pin scope, or the disable-list scope. */
  scope?: string;
  /** True when an operator pin froze this entry (source is then "pin"). */
  pinned: boolean;
  /**
   * True when the winning layer held an unrecognized value and
   * the entry failed closed (the mode switches' posture).
   */
  invalid?: boolean;
  /** The raw winning value, when it was a string (preserved for audit). */
  raw?: string;
  /** Malformed entries encountered while resolving — surfaced, never applied. */
  issues: string[];
  /** Named refusals attached to this resolution (requires-edge refusals). */
  refusals: string[];
}

/** The dependencies every resolution reads — at resolve time, never cached. */
export interface AgentConfigDeps {
  /** The hosting instance's settings reader (absent ⇒ no stored layer). */
  readSettingRaw?: (key: string) => string | null;
  /** The deployment env (absent ⇒ no env layer). */
  env?: Env | Record<string, unknown> | null;
  /** Run-granularity carriers (run/session/user raw values), where a machinery has them. */
  carriers?: { run?: unknown; session?: unknown; user?: unknown };
}

// ---------------------------------------------------------------------------
// Entry definitions and the registry
// ---------------------------------------------------------------------------

export type AgentConfigLayerParse<T> =
  | { kind: "decision"; value: T; scope?: string; raw?: string }
  | { kind: "invalid"; raw?: string }
  | { kind: "absent" };

export interface AgentConfigLayerOutcome<T> {
  parse: AgentConfigLayerParse<T>;
  issues: string[];
}

export type AgentConfigLayerName = "carriers" | "stored" | "env";

/**
 * One registered configuration entry: how its value is carried
 * at each layer. Family modules define these beside their
 * existing parsers (the parsers ARE the layer implementations;
 * nothing is re-implemented here) and register them at import.
 */
export interface AgentConfigEntryDef<T = unknown> {
  id: string;
  /** The layers this entry has, most-preferred first (the pin check runs above all). */
  layers: readonly AgentConfigLayerName[];
  /** Carrier levels for the "carriers" layer, most-preferred first. */
  carrierKeys?: readonly ("run" | "session" | "user")[];
  /** Parse one carrier's raw value (the mode switches' normalization). */
  parseCarrier?: (raw: unknown) => AgentConfigLayerParse<T>;
  /** An invalid carrier: fail closed (mode switches) or skip the level. */
  carrierInvalid?: "fail-closed" | "skip";
  /** Stored keys to try, most granular first. */
  storedKeys?: (identity: AgentConfigIdentity) => string[];
  /** Parse the stored raw under one key. Malformed stored values never decide (skip + issue). */
  parseStored?: (
    raw: string | null,
    identity: AgentConfigIdentity,
  ) => AgentConfigLayerOutcome<T>;
  /** The deployment-layer var carrying this entry. */
  envVar?: string;
  /** Parse the env raw. Multi-entry vars absorb malformed entries per entry. */
  parseEnv?: (
    raw: unknown,
    identity: AgentConfigIdentity,
  ) => AgentConfigLayerOutcome<T>;
  /** An invalid env value: fail closed (mode switches) or skip (multi-entry vars). */
  envInvalid?: "fail-closed" | "skip";
  /** The value an entry fails closed TO (the mode switches' "off"). */
  failClosedValue?: (identity: AgentConfigIdentity) => T;
  /** THE code default for an identity (the family's defaults table). */
  codeDefault: (identity: AgentConfigIdentity) => T;
  /**
   * What an operator pin freezes: "env" (default) — the env
   * layer's decision when one exists, else the code default
   * (the choice entries: the operator pins the VALUE they set);
   * "default" — the code default unconditionally (the
   * capability entries: their env layer is a disable-only flip
   * list, and the floor exists to bound exactly that flip, so
   * a pinned capability holds its unflipped state).
   */
  pinValueSource?: "env" | "default";
  /** The canonical stored/wire form of a value. */
  formatValue: (value: T) => string;
  /** Validate a write-door value; undefined refuses the write. */
  parseWriteValue: (raw: string) => T | undefined;
  /** The value domain, named in write-refusal messages. */
  valueDomain: string;
  /**
   * The stored key a tenant write lands in (the most granular
   * key). Null/absent ⇒ the entry has no stored layer to write
   * (capability entries: their config lives at the operator
   * layer) and writes refuse by name.
   */
  writeStoredKey?: (identity: AgentConfigIdentity) => string | null;
  /**
   * Merge a write into a multi-entry stored form (the channel
   * map); absent ⇒ the write replaces the key's scalar.
   */
  mergeStoredWrite?: (
    existingRaw: string | null,
    value: T,
    identity: AgentConfigIdentity,
  ) => string;
  /** Named refusals to attach to a resolution (requires-edges). */
  refusals?: (
    identity: AgentConfigIdentity,
    deps: AgentConfigDeps,
    value: T,
  ) => string[];
}

const REGISTRY = new Map<string, AgentConfigEntryDef>();

/** Register one entry (family modules call this at import). */
export function registerAgentConfigEntry<T>(
  def: AgentConfigEntryDef<T>,
): void {
  REGISTRY.set(def.id, def as AgentConfigEntryDef);
}

/** The registered entry, or undefined for an unknown id. */
export function getAgentConfigEntry(
  entryId: string,
): AgentConfigEntryDef | undefined {
  return REGISTRY.get(entryId);
}

/** Every registered entry id (registration order). */
export function listAgentConfigEntries(): string[] {
  return [...REGISTRY.keys()];
}

/** The named refusal for an unregistered entry id. */
export const AGENT_CONFIG_UNKNOWN_ENTRY = "AGENT_CONFIG_UNKNOWN_ENTRY";

// ---------------------------------------------------------------------------
// Operator pins (the floor)
// ---------------------------------------------------------------------------

/**
 * The operator pin list (deployment layer): comma-separated
 * `<scope>:<entryId>` entries — scope is an agent class name, a
 * copilot registration, a voice surface, or `*`. A pinned entry
 * cannot be flipped below the operator layer: its resolution
 * freezes the operator layer's own value — for a choice, the
 * env decision when one exists, else the code default; for a
 * capability, its unflipped state (the disable list is
 * precisely the flip the floor bounds) — and names the pin as
 * its source; write-door attempts against it refuse by name.
 * Declared on the Env type in src/types.ts and set explicitly
 * EMPTY in wrangler.jsonc (the #3727 externalization precedent:
 * the fleet ships with nothing pinned).
 */
export const AGENT_CONFIG_PINS_ENV = "AGENT_CONFIG_PINS";

export interface AgentConfigPin {
  scope: string;
  entryId: string;
}

export function parseAgentConfigPins(raw: string | null | undefined): {
  pins: AgentConfigPin[];
  issues: string[];
} {
  const pins: AgentConfigPin[] = [];
  const issues: string[] = [];
  if (typeof raw !== "string") return { pins, issues };
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    const scope = sep > 0 ? trimmed.slice(0, sep).trim() : "";
    const entryId = sep > 0 ? trimmed.slice(sep + 1).trim() : "";
    if (!scope || !entryId) {
      issues.push(
        `${AGENT_CONFIG_PINS_ENV}: malformed entry "${trimmed}" (expected "<scope>:<entryId>")`,
      );
      continue;
    }
    pins.push({ scope, entryId });
  }
  return { pins, issues };
}

function identityScopes(identity: AgentConfigIdentity): string[] {
  return [
    "*",
    identity.className,
    identity.registrationId,
    identity.surfaceId,
    ...(identity.scopes ?? []),
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
}

function envRawValue(
  env: AgentConfigDeps["env"],
  varName: string,
): unknown {
  if (!env || typeof env !== "object") return undefined;
  return (env as Record<string, unknown>)[varName];
}

/** The pin binding one (entry, identity), or null when unpinned. */
export function agentConfigPinFor(
  entryId: string,
  identity: AgentConfigIdentity,
  env: AgentConfigDeps["env"],
): AgentConfigPin | null {
  const raw = envRawValue(env, AGENT_CONFIG_PINS_ENV);
  const { pins } = parseAgentConfigPins(
    typeof raw === "string" ? raw : undefined,
  );
  const scopes = identityScopes(identity);
  return pins.find((p) => p.entryId === entryId && scopes.includes(p.scope)) ?? null;
}

// ---------------------------------------------------------------------------
// The resolution engine
// ---------------------------------------------------------------------------

/**
 * Resolve one entry for one agent identity through the ONE
 * chain: operator pin → the entry's layers in its declared
 * order (carriers / stored / env, most granular first within
 * each) → code default. The result names its source; stored
 * state is read at resolve time, so a stored flip is live on
 * the next resolution (the next turn). Throws only for an
 * unregistered entry id.
 */
export function resolveAgentConfig(
  entryId: string,
  identity: AgentConfigIdentity = {},
  deps: AgentConfigDeps = {},
): AgentConfigResolution {
  const def = REGISTRY.get(entryId);
  if (!def) {
    throw new Error(
      `${AGENT_CONFIG_UNKNOWN_ENTRY}: no agent config entry is registered as "${entryId}"`,
    );
  }
  const issues: string[] = [];
  const finish = (
    value: unknown,
    source: AgentConfigSource,
    extra?: { scope?: string; pinned?: boolean; invalid?: boolean; raw?: string },
  ): AgentConfigResolution => ({
    entryId,
    identity,
    value,
    source,
    scope: extra?.scope,
    pinned: extra?.pinned ?? false,
    invalid: extra?.invalid,
    raw: extra?.raw,
    issues,
    refusals: def.refusals ? def.refusals(identity, deps, value) : [],
  });

  // The operator floor: a pin freezes the operator layer's own
  // value and is named as the source. Lower layers (carriers,
  // stored) are not consulted at all.
  const pin = agentConfigPinFor(entryId, identity, deps.env);
  if (pin) {
    if (def.pinValueSource !== "default" && def.parseEnv && def.envVar) {
      const out = def.parseEnv(envRawValue(deps.env, def.envVar), identity);
      issues.push(...out.issues);
      if (out.parse.kind === "decision") {
        return finish(out.parse.value, "pin", { scope: pin.scope, pinned: true, raw: out.parse.raw });
      }
      if (out.parse.kind === "invalid" && def.envInvalid === "fail-closed") {
        return finish(def.failClosedValue?.(identity), "pin", {
          scope: pin.scope,
          pinned: true,
          invalid: true,
          raw: out.parse.raw,
        });
      }
    }
    return finish(def.codeDefault(identity), "pin", { scope: pin.scope, pinned: true });
  }

  for (const layer of def.layers) {
    if (layer === "carriers" && def.parseCarrier) {
      for (const carrierKey of def.carrierKeys ?? []) {
        const parse = def.parseCarrier(deps.carriers?.[carrierKey]);
        if (parse.kind === "decision") {
          return finish(parse.value, carrierKey, { scope: carrierKey, raw: parse.raw });
        }
        if (parse.kind === "invalid" && def.carrierInvalid === "fail-closed") {
          return finish(def.failClosedValue?.(identity), carrierKey, {
            scope: carrierKey,
            invalid: true,
            raw: parse.raw,
          });
        }
      }
      continue;
    }
    if (layer === "stored" && deps.readSettingRaw && def.storedKeys && def.parseStored) {
      for (const key of def.storedKeys(identity)) {
        const out = def.parseStored(deps.readSettingRaw(key), identity);
        issues.push(...out.issues);
        if (out.parse.kind === "decision") {
          return finish(out.parse.value, "stored", { scope: key });
        }
        // A malformed stored value never decides: the issue is
        // recorded above and the chain falls through.
      }
      continue;
    }
    if (layer === "env" && def.parseEnv && def.envVar) {
      const out = def.parseEnv(envRawValue(deps.env, def.envVar), identity);
      issues.push(...out.issues);
      if (out.parse.kind === "decision") {
        return finish(out.parse.value, "env", { scope: out.parse.scope, raw: out.parse.raw });
      }
      if (out.parse.kind === "invalid" && def.envInvalid === "fail-closed") {
        return finish(def.failClosedValue?.(identity), "env", {
          invalid: true,
          raw: out.parse.raw,
        });
      }
    }
  }

  return finish(def.codeDefault(identity), "default", {});
}

// ---------------------------------------------------------------------------
// Capability entries — the manifest's config layer, as entries
// ---------------------------------------------------------------------------

/**
 * The requires-edge refusals riding a `state` resolution: when
 * config disables state for a class, the class manifest's own
 * refusals (computed by capabilityManifest from the same env)
 * are attached, so a resolver consumer sees the same names the
 * PortThink composition read surfaces.
 */
function stateEntryRefusals(
  identity: AgentConfigIdentity,
  deps: AgentConfigDeps,
  value: unknown,
): string[] {
  if (value !== false || !identity.className) return [];
  const manifest = resolveAgentCapabilityManifest(identity.className, {
    env: (deps.env ?? undefined) as Record<string, unknown> | undefined,
    bindings: identity.scopes ?? [],
  });
  return manifest.refusals;
}

/**
 * Every capability id is a boolean entry here: the value is the
 * CONFIG decision — true unless the deployment's disable list
 * (AGENT_CAPABILITIES_DISABLED) names it for this class. The
 * parse and the scope matching are the manifest's own
 * (parseCapabilityDisabledList — one definition, invoked);
 * posture composition (which states exist, which prerequisites
 * are met) stays the manifest's, and the conformance suite pins
 * the two views to agree wherever a posture is enabled. The
 * entries carry no stored layer: capability config lives at
 * the operator layer, and the write door refuses them by name.
 */
for (const capability of ALL_CAPABILITY_IDS as readonly CapabilityId[]) {
  registerAgentConfigEntry<boolean>({
    id: capability,
    layers: ["env"],
    envVar: AGENT_CAPABILITIES_DISABLED_ENV,
    parseEnv: (raw, identity) => {
      const { entries, issues } = parseCapabilityDisabledList(
        typeof raw === "string" ? raw : undefined,
      );
      const scopes = identityScopes(identity);
      const hit = entries.find(
        (e) => e.capability === capability && scopes.includes(e.scope),
      );
      return hit
        ? { parse: { kind: "decision", value: false, scope: hit.scope }, issues }
        : { parse: { kind: "absent" }, issues };
    },
    pinValueSource: "default",
    codeDefault: () => true,
    formatValue: (value) => (value ? "on" : "off"),
    parseWriteValue: (raw) => {
      const normalized = raw.trim().toLowerCase();
      return normalized === "on" ? true : normalized === "off" ? false : undefined;
    },
    valueDomain: '"on" or "off"',
    writeStoredKey: () => null,
    ...(capability === "state" ? { refusals: stateEntryRefusals } : {}),
  });
}

// ---------------------------------------------------------------------------
// The write door — the stored layer, writable and audited
// ---------------------------------------------------------------------------

/** A lower-layer write attempt against an operator-pinned entry. */
export const AGENT_CONFIG_PINNED = "AGENT_CONFIG_PINNED";
/** The write's value is outside the entry's value domain. */
export const AGENT_CONFIG_INVALID_VALUE = "AGENT_CONFIG_INVALID_VALUE";
/** The entry has no stored layer a tenant write can land in. */
export const AGENT_CONFIG_WRITE_UNSUPPORTED = "AGENT_CONFIG_WRITE_UNSUPPORTED";
/** The host offers no settings writer — the write fails closed. */
export const AGENT_CONFIG_WRITE_UNAVAILABLE = "AGENT_CONFIG_WRITE_UNAVAILABLE";

/** Audit event for a committed flip (the awareness/settings-change idiom). */
export const AGENT_CONFIG_WRITE_EVENT = "agent_config.write";
/** Audit event for a refused flip attempt. */
export const AGENT_CONFIG_WRITE_REFUSED_EVENT = "agent_config.write_refused";

export interface AgentConfigWriteDeps {
  /** The hosting instance's settings reader (the stored layer's read side). */
  readSettingRaw: (key: string) => string | null;
  /** The hosting instance's settings writer; absent ⇒ writes fail closed by name. */
  writeSetting?: (key: string, value: string) => void;
  /** The host's audit (the settings-change machinery); flips and refusals are recorded through it. */
  audit?: (type: string, payload: Record<string, unknown>) => void;
  /** The deployment env (the pin layer is evaluated against it). */
  env?: Env | Record<string, unknown> | null;
  /** Who is flipping: the login, or the agent itself through its settings door. */
  actor: string;
}

export type AgentConfigWriteResult =
  | {
      ok: true;
      entryId: string;
      identity: AgentConfigIdentity;
      /** The stored key the flip landed in. */
      key: string;
      oldValue: string | null;
      newValue: string;
      /** The post-write resolution (the flip, read back at resolve time). */
      resolution: AgentConfigResolution;
    }
  | { ok: false; error: string; message: string };

/**
 * Flip one entry at the stored (tenant) layer — the write half
 * of the resolver. The flip commits through the host's existing
 * settings machinery (mas_settings via writeSetting; no
 * parallel store), is audited with old → new, and takes effect
 * at the next resolution. Refusals are BY NAME and change
 * nothing: unknown entry, invalid value, an operator pin
 * (AGENT_CONFIG_PINNED), an entry with no stored layer, or a
 * host without a writer. Same-layer conflicts are
 * last-writer-wins: a later write simply replaces the value,
 * and both flips stand in the audit.
 */
export function writeAgentConfigValue(
  deps: AgentConfigWriteDeps,
  entryId: string,
  identity: AgentConfigIdentity,
  rawValue: string,
): AgentConfigWriteResult {
  const refuse = (error: string, message: string): AgentConfigWriteResult => {
    deps.audit?.(AGENT_CONFIG_WRITE_REFUSED_EVENT, {
      entryId,
      identity,
      error,
      actor: deps.actor,
      layer: "stored",
    });
    return { ok: false, error, message };
  };

  const def = REGISTRY.get(entryId);
  if (!def) {
    return refuse(
      AGENT_CONFIG_UNKNOWN_ENTRY,
      `Unknown agent config entry "${entryId}" — nothing was written.`,
    );
  }
  const value = def.parseWriteValue(rawValue);
  if (value === undefined) {
    return refuse(
      AGENT_CONFIG_INVALID_VALUE,
      `Invalid value "${rawValue}" for agent config entry "${entryId}" (expected ${def.valueDomain}) — nothing was written.`,
    );
  }
  const pin = agentConfigPinFor(entryId, identity, deps.env);
  if (pin) {
    return refuse(
      AGENT_CONFIG_PINNED,
      `Agent config entry "${entryId}" is pinned by the operator layer (pin "${pin.scope}:${entryId}") — lower layers cannot flip it, and nothing was written.`,
    );
  }
  const key = def.writeStoredKey?.(identity) ?? null;
  if (key === null) {
    return refuse(
      AGENT_CONFIG_WRITE_UNSUPPORTED,
      `Agent config entry "${entryId}" has no stored layer — its configuration lives at the operator layer and cannot be flipped through the tenant write door. Nothing was written.`,
    );
  }
  if (!deps.writeSetting) {
    return refuse(
      AGENT_CONFIG_WRITE_UNAVAILABLE,
      `This host offers no settings writer, so the "${entryId}" flip cannot be stored — failing closed rather than reporting a success that stored nothing.`,
    );
  }

  const oldValue = deps.readSettingRaw(key);
  const newValue = def.mergeStoredWrite
    ? def.mergeStoredWrite(oldValue, value, identity)
    : def.formatValue(value);
  deps.writeSetting(key, newValue);
  deps.audit?.(AGENT_CONFIG_WRITE_EVENT, {
    entryId,
    identity,
    key,
    oldValue,
    newValue,
    value: def.formatValue(value),
    layer: "stored",
    actor: deps.actor,
  });
  const resolution = resolveAgentConfig(entryId, identity, {
    readSettingRaw: deps.readSettingRaw,
    env: deps.env,
  });
  return { ok: true, entryId, identity, key, oldValue, newValue, resolution };
}
