### Standards conformance

- **#3515 S3 batch 10**: migrated 13 unstructured `console.*` call sites across 9 files in `src/client` to the S2 structured logger via the new sanctioned client-side logger (`src/client/clientLogger.ts`), severity preserved, no behavior change; remaining unstructured sites now 6.
