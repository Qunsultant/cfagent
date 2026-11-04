/**
 * Issue #2991 (#2770 Phase A) — Block contract: the onboarding gate
 * in code. A capability onboards onto the workflow platform only
 * when its definition carries every piece the platform needs:
 *
 *   - a port interface (the methods a caller uses),
 *   - input/output schemas (descriptor data, not a new validation
 *     language — engines keep their own zod schemas),
 *   - a stage contract (the stage ids the capability emits, and
 *     the terminal semantics mapping each terminal to an outcome
 *     catalog code),
 *   - outcome-catalog entries (the codes its terminals resolve to),
 *   - governed promotion (§5: candidate -> evaluation -> promotion).
 *
 * The contract is asset-class agnostic: no stock-only assumptions
 * anywhere in the definition shape. The Phase B registry itself is
 * NOT in this slice — this module is the contract the registry
 * will enforce, implemented here for the saga's capabilities.
 */

export type BlockKind =
  | "leg"
  | "gate"
  | "compensation"
  | "notice"
  | "disclosure"
  | "plan";

export interface BlockSchemaField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface BlockStageContract {
  stageIds: string[];
  /** Terminal name -> outcome catalog code. */
  terminalSemantics: Record<string, string>;
}

export interface BlockPortDescriptor {
  methods: string[];
}

/** Governed promotion (§5 RSI loop), recorded as data. */
export interface BlockPromotion {
  candidate: string;
  evaluation: string;
  promotion: string;
}

export interface BlockDefinition {
  id: string;
  kind: BlockKind;
  version: string;
  port: BlockPortDescriptor;
  inputSchema: BlockSchemaField[];
  outputSchema: BlockSchemaField[];
  stageContract: BlockStageContract;
  catalogEntries: string[];
  promotion: BlockPromotion;
}

export interface BlockCompositionRef {
  blockId: string;
  action: string;
  /** When present, must reference a gate-kind block. */
  gateBlockId?: string;
}

export interface BlockComposition {
  id: string;
  refs: BlockCompositionRef[];
  /** Terminal name -> outcome catalog code. */
  terminals: Record<string, string>;
}

function fail(message: string): never {
  throw new Error(`Block contract violation: ${message}`);
}

/**
 * Validate a Block definition. Missing pieces throw — this is the
 * onboarding gate in code, not a suggestion.
 */
export function defineBlock(def: BlockDefinition): BlockDefinition {
  if (!def.id) fail("a block needs an id");
  if (!def.kind) fail(`block ${def.id} needs a kind`);
  if (!def.version) fail(`block ${def.id} needs a version`);
  if (!def.port || def.port.methods.length === 0) {
    fail(`block ${def.id} needs port methods`);
  }
  if (!def.stageContract || def.stageContract.stageIds.length === 0) {
    fail(`block ${def.id} needs stage ids`);
  }
  // Wiring capabilities (disclosure) have no terminal of their
  // own — they ride another row. Every other kind must declare
  // its terminals.
  if (
    !def.stageContract.terminalSemantics ||
    (Object.keys(def.stageContract.terminalSemantics).length === 0 &&
      def.kind !== "disclosure")
  ) {
    fail(`block ${def.id} needs terminal semantics`);
  }
  if (!def.catalogEntries || def.catalogEntries.length === 0) {
    fail(`block ${def.id} needs catalog entries`);
  }
  if (
    !def.promotion ||
    !def.promotion.candidate ||
    !def.promotion.evaluation ||
    !def.promotion.promotion
  ) {
    fail(`block ${def.id} needs governed promotion (candidate, evaluation, promotion)`);
  }
  return def;
}

/**
 * Runtime conformance: an implementation must carry every method
 * its definition's port declares.
 */
export function assertBlockConforms(
  impl: Record<string, unknown>,
  def: BlockDefinition,
): void {
  for (const method of def.port.methods) {
    if (typeof impl[method] !== "function") {
      fail(`block ${def.id} implementation is missing port method ${method}`);
    }
  }
}

/**
 * Validate a composition: every ref resolves to a registered block,
 * every gate ref points at a gate-kind block, and every terminal
 * resolves through the caller's outcome-code predicate (the
 * catalog itself lives in outcomeAspects; this module stays free
 * of that dependency by taking the predicate).
 */
export function validateComposition(
  comp: BlockComposition,
  defs: BlockDefinition[],
  opts: { outcomeCodeResolves: (code: string) => boolean },
): void {
  const byId = new Map(defs.map((d) => [d.id, d]));
  for (const ref of comp.refs) {
    const def = byId.get(ref.blockId);
    if (!def) fail(`composition ${comp.id} references unregistered block ${ref.blockId}`);
    if (ref.gateBlockId !== undefined) {
      const gate = byId.get(ref.gateBlockId);
      if (!gate) {
        fail(`composition ${comp.id} gate ref ${ref.gateBlockId} is unregistered`);
      }
      if (gate.kind !== "gate") {
        fail(`composition ${comp.id} gate ref ${ref.gateBlockId} is a ${gate.kind}, not a gate`);
      }
    }
  }
  for (const [terminal, code] of Object.entries(comp.terminals)) {
    if (!opts.outcomeCodeResolves(code)) {
      fail(`composition ${comp.id} terminal ${terminal} outcome code ${code} does not resolve`);
    }
  }
}
