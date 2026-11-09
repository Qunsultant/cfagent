/**
 * Issue #3741 — the one resolver's registry composition: the
 * family modules register their entries with the resolver at
 * import (agentConfigResolver.ts holds the engine, the pins,
 * and the capability entries; each family keeps its parsers,
 * keys, and defaults beside its own code). Consumers that
 * resolve BY ENTRY ID — the write door's HTTP route, the
 * conformance suite — import THIS module so every family's
 * registration has run; consumers that call a family's own
 * resolver import the family module as before (its delegation
 * carries the registration with it).
 */
import "./copilotChannels";
import "./copilotVoiceBackend";
import "../config/chatNlqModes";
import "../config/screenerModes";

export * from "./agentConfigResolver";
