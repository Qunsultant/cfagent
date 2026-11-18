### Standards conformance

- **#3515 S3 batch 6**: migrated 38 unstructured `console.*` call sites across 5 files in `src/server/routes` to the S2 structured logger (`createStructuredLogger`), severity preserved, no behavior change; remaining unstructured sites now 103.
