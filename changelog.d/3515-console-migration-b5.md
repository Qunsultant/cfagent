### Standards conformance

- **#3515 S3 batch 5**: migrated 44 unstructured `console.*` call sites across 18 files in `src/workflows` to the S2 structured logger (`createStructuredLogger`), severity preserved, no behavior change; remaining unstructured sites now 143.
