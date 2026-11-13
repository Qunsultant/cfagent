/**
 * #4282 P0 — externalized error codes and messages for the schema component.
 *
 * Cross-cutting rule (agentic-SaaS): error codes AND messages are
 * externalized in a catalogue, never inline literals at the throw
 * site. The throw sites pass the code (and a detail); the message,
 * http status, and remediation come from SCHEMA_ERROR_CATALOG.
 */
export enum SchemaErrorCode {
  UNKNOWN_CODE = "SCHEMA_UNKNOWN_CODE",
  DUPLICATE_CODE = "SCHEMA_DUPLICATE_CODE",
  INVALID_ENTRY = "SCHEMA_INVALID_ENTRY",
  MISSING_PARAMETER = "SCHEMA_MISSING_PARAMETER",
  EXECUTION_FAILED = "SCHEMA_EXECUTION_FAILED",
  UNCODED_STATEMENT = "SCHEMA_UNCODED_STATEMENT",
}

export interface SchemaErrorMetadata {
  code: SchemaErrorCode;
  httpStatus: number;
  defaultMessage: string;
  remediation: string;
}

export const SCHEMA_ERROR_CATALOG: Record<SchemaErrorCode, SchemaErrorMetadata> = {
  [SchemaErrorCode.UNKNOWN_CODE]: {
    code: SchemaErrorCode.UNKNOWN_CODE,
    httpStatus: 400,
    defaultMessage: "Unknown schema statement code.",
    remediation:
      "Register the statement in the schema catalogue before executing it; an unregistered code cannot execute.",
  },
  [SchemaErrorCode.DUPLICATE_CODE]: {
    code: SchemaErrorCode.DUPLICATE_CODE,
    httpStatus: 400,
    defaultMessage: "Duplicate schema statement code.",
    remediation:
      "One code identifies exactly one statement — rename the second entry or remove the duplicate registration.",
  },
  [SchemaErrorCode.INVALID_ENTRY]: {
    code: SchemaErrorCode.INVALID_ENTRY,
    httpStatus: 400,
    defaultMessage: "Invalid schema catalogue entry.",
    remediation:
      "Fix the entry to the catalogue format: code, plane, table, statement text, kind, and parameterized form must agree.",
  },
  [SchemaErrorCode.MISSING_PARAMETER]: {
    code: SchemaErrorCode.MISSING_PARAMETER,
    httpStatus: 400,
    defaultMessage: "Missing parameter for a parameterized schema statement.",
    remediation:
      "Supply every parameter the entry declares when executing it.",
  },
  [SchemaErrorCode.EXECUTION_FAILED]: {
    code: SchemaErrorCode.EXECUTION_FAILED,
    httpStatus: 500,
    defaultMessage: "Schema statement execution failed.",
    remediation:
      "Read the attached partial report: it names exactly which statements completed and which failed. The run is safe to re-run.",
  },
  [SchemaErrorCode.UNCODED_STATEMENT]: {
    code: SchemaErrorCode.UNCODED_STATEMENT,
    httpStatus: 400,
    defaultMessage: "A statement without a catalogue code cannot execute.",
    remediation:
      "Catalogue the statement first (code + plane + table + statement text), then execute it by code.",
  },
};

export class SchemaComponentError extends Error {
  public readonly code: SchemaErrorCode;
  public readonly httpStatus: number;
  public readonly remediation: string;
  public readonly details?: unknown;

  constructor(code: SchemaErrorCode, detail?: string, details?: unknown) {
    const meta = SCHEMA_ERROR_CATALOG[code];
    super(detail ? `${meta.defaultMessage} ${detail}` : meta.defaultMessage);
    this.name = "SchemaComponentError";
    this.code = code;
    this.httpStatus = meta.httpStatus;
    this.remediation = meta.remediation;
    this.details = details;
  }
}

export function createSchemaError(
  code: SchemaErrorCode,
  detail?: string,
  details?: unknown,
): SchemaComponentError {
  return new SchemaComponentError(code, detail, details);
}
