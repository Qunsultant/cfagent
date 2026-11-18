### Standards conformance

- **#3515 S3 batch 7**: migrated 33 unstructured `console.*` call sites across 22 files in `src/data` to the S2 structured logger (`createStructuredLogger`), severity preserved, no behavior change; remaining unstructured sites now 70.
