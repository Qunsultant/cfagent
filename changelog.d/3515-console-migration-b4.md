### Standards conformance

- **#3515 S3 batch 4**: migrated 47 unstructured `console.*` call sites across 9 files in `src/trading` to the S2 structured logger (`createStructuredLogger`), severity preserved, no behavior change; remaining unstructured sites now 187.
