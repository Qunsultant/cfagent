### Platform Admin: real session identity + diagnosable Data Providers failures (#2624 fix-up)

- **"Signed in as unknown" is gone.** The nav shell mounts the Platform Admin drawer and now passes the signed-in identity (`NavigationMenu`'s `user`) through to the panel. When no identity is available the section says *"No signed-in identity"* and explains that an access request cannot be attributed — it never prints `unknown` / `UN` / `@unknown`, and it does not render a request button without an attributable login.
- **Data Providers 500s are diagnosable.** The panel's request seam now reads the response body once, uses the server's JSON `error`/`code` when present, and otherwise includes the raw body hint (e.g. *"(HTML error page from the edge — see Worker logs)"*) with the status. Before, a non-JSON 500 surfaced only as `Request failed (500)`.
- The route's catch-all 500 now carries `code: "DATA_PROVIDER_ROUTE_FAILED"` alongside the message, so the panel and logs agree on what failed.
- Tests: identity cases (present / absent) in `platform_admin_panel_2624.test.tsx`; the non-JSON 500 case in `data_providers_panel_e4.test.ts`, whose fetch stub gained a raw-body option.
- Note: the 500 itself is a server-side failure of `GET /api/data-providers`; this change makes it visible and traceable, it does not fabricate a fix for an unproven cause.
