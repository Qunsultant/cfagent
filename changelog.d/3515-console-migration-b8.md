### Standards conformance

- **#3515 S3 batch 8**: migrated 29 unstructured `console.*` call sites across 14 files in `src/security` to the S2 structured logger (`createStructuredLogger`), severity preserved, no behavior change; remaining unstructured sites now 41.
