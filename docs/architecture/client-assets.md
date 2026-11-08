# Client Static Assets (`/assets`) Architecture & Maintenance

This document defines the architecture, lifecycle, maintenance procedures, and incident triage methodology for the client static assets served under `/assets` on `agent.openaimp.com`.

---

## 1. What `/assets` Is

The `/assets` URL prefix serves the compiled, minified, and bundled client frontend of cfagent. It is produced by the Vite build pipeline from TypeScript/React source files in `src/client/` and deployed to Cloudflare Workers via the Static Assets binding.

- **Source Location:** `src/client/` (React, TypeScript, CSS)
- **Compilation Output:** `dist/assets/`
- **Hosting / Delivery:** Cloudflare Workers Static Assets (`ASSETS` binding) backed by Cloudflare Edge CDN
- **Routing Configuration (`wrangler.jsonc`):**
  ```jsonc
  "assets": {
    "directory": "./dist/",
    "binding": "ASSETS",
    "run_worker_first": ["/", "/index.html"]
  }
  ```
  Requests matching `/assets/*` bypass Worker execution and are served directly from Cloudflare's global edge network at lowest latency. Requests to `/` and `/index.html` evaluate `run_worker_first` to handle authentication, session injection, and HTML shell delivery.

---

## 2. Contents of `/assets`

When `npm run build` executes, Vite produces:

1. **Hashed JavaScript Bundles:**
   - Entry bundle: `index-[hash].js` (e.g. `index-lWjLEYmK.js`).
   - Asynchronously loaded dynamic chunks (e.g. specialized panels, chart libraries, or code split modules).
2. **Hashed CSS Style Bundles:**
   - Compiled stylesheets: `index-[hash].css`.
   - Design tokens and component styles bundled into unified asset files.
3. **Static Media & Data:**
   - Fonts, icons, and SVG illustrations.
   - Static strategy definitions and manifests under root or asset directories.

---

## 3. Lifecycle, Build, and Deployment Flow

### Build Command
The build process is automated via npm scripts:
```bash
npm run build     # Runs `vite build`, writing output to ./dist/
```
The root `package.json` coordinates validation and build in CI:
```bash
npm run check     # node scripts/gen-design-tokens.mjs --check && npm run typecheck && npm run test:ci && npm run build
```

### Gitignored Output
The build directory `./dist/` contains ephemeral build artifacts and is strictly excluded from version control via `.gitignore`. No build outputs or `.js` bundles are committed to the repository.

### Deployment Flow
On merge to `main`, the deployment workflow (`.github/workflows/deploy.yml` or manual release trigger):
1. Checks out the repository at the merged commit `HEAD`.
2. Installs pinned dependencies (`npm ci`).
3. Executes verification and build (`npm run check`).
4. Executes `wrangler deploy`, which synchronizes `./dist/` to Cloudflare's static asset store and deploys worker entry point `src/worker.ts`.

### Content Hashing & Versioning
Vite uses Rollup's chunk hashing algorithm:
- Every bundle file name includes an 8-character base64-url content hash: `[name]-[hash].[ext]`.
- If the source code changes, the content hash changes (`index-A.js` → `index-B.js`).
- If source files are unchanged between releases, the content hash remains identical, preserving CDN cache hits.

### Cache Behavior & Edge Headers
- **`/assets/*`:** Served with immutable caching headers:
  ```http
  Cache-Control: public, max-age=31536000, immutable
  ```
  Because the file names are content-hashed, edge caches and browser caches can store them indefinitely without risk of serving stale code.
- **`/index.html` & `/`:** Served with revalidation headers:
  ```http
  Cache-Control: public, max-age=0, must-revalidate
  ```
  When a new release deploys, the HTML document references the new asset hash (`index-B.js`), instantly updating clients upon next page load without requiring manual cache clearing.

---

## 4. Production Incident Triage: Mapping Deployed Bundle Hashes to Source

When a production client error or unhandled exception occurs (such as an ITIL incident report), the browser console or error boundary produces a stack trace pointing to a minified file:

```
TypeError: Cannot read properties of undefined (reading 'toFixed')
    at pge (https://agent.openaimp.com/assets/index-lWjLEYmK.js:310:245918)
    at pge (https://agent.openaimp.com/assets/index-lWjLEYmK.js:310:256454)
```

To diagnose and resolve the issue quickly, follow this 5-step provenance mapping workflow:

### Step 1: Extract Bundle Hash and Location
- Asset URL: `https://agent.openaimp.com/assets/index-lWjLEYmK.js`
- Bundle Hash: `lWjLEYmK`
- Minified Location: Line 310, Column 245918 and Column 256454
- Minified Identifier: `pge`

### Step 2: Determine Deployed Commit
To find which commit produced the bundle hash:
1. **GitHub Deployments / Releases:** Check the GitHub Actions `Deploy` workflow history on `main` corresponding to the incident timestamp. The job output logs the Vite build output table showing file names and hashes.
2. **Git Log Search:** Match the deployment timestamp against `git log --format="%H %cd %s" origin/main`.
3. **Local Build Verification:** Run `git checkout <commit_hash> && npm run build` to confirm the generated bundle hash matches `index-lWjLEYmK.js`.

### Step 3: Map Minified Function to Source Component
Minified identifiers (such as `pge`) correspond to React functional components:
- Search `./dist/assets/index-lWjLEYmK.js` around column 245918 for neighboring string literals, CSS classes, or UI labels (e.g. `"order-quote-peek"`, `"quote-price"`, `"OrderTicketPanel"`).
- Identify the parent component: In this incident, line 310 column 245918 is inside the JSX render of `OrderTicketPanel.tsx` (rendering `.lastPrice.toFixed(2)`), and column 256454 is inside `ETradeTradingHub.tsx` (rendering active draft price `(limitPrice || estimatedPrice).toFixed(2)`).

### Step 4: Source Map Decoding
When source maps are retained in CI build artifacts:
```bash
# Using source-map-cli
npx source-map-cli resolve dist/assets/index-lWjLEYmK.js.map 310 245918
# Output:
# src/client/OrderTicketPanel.tsx:565:42
```

### Step 5: Root Cause Remediation
Once mapped to source:
- Replace direct, unguarded property accesses or number method calls (`.toFixed()`, `.toLocaleString()`) with safe client formatters from `src/client/formatters.ts`:
  - `safeNumberFormat(value, decimals, fallback)`
  - `safePriceFormat(value, decimals, fallback)`
- Ensure error boundaries (`<ErrorBoundary label="...">`) dynamically reflect the active tenant broker rather than a hardcoded single broker brand.

