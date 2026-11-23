### Fixed

- Research report PDFs no longer crash on non-WinAnsi characters: the WinAnsi sanitizer is now shared (`src/trading/pdfText.ts`) and applied by all four pdf-lib renderers, so a "≥" in a rejection reason or a "⚠" falsification warning renders instead of aborting the PDF.
- The options and discovery renderers now use the same sanitizer (the options copy lacked the ▲/▼ replacements; discovery had none).
