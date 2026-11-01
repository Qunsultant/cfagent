### Changed

- **Left-navigation UX improvements and structural reorganization (#2685):**
  - Collapsible sidebar UX enhanced with centered brand header layout and overflow prevention in collapsed mode.
  - Dual-target toggle for sub-menus: clicking either the menu item row or the chevron toggles expansion (open/close) with smooth chevron rotation.
  - Options Screener sub-menus consolidated: hosts Contract Screen (`options`), Strategy Scanner (`scanner`), Options Flows (`options-flows`), and IV History (`iv-history`); removes docs, workflow runs, and schedules; removes `options-flows` from the main menu.
  - Stock Screener: renamed from Screeners, hosting Stock Screener (`screeners`) and Market Research (`research`) sub-menus only.
  - New dedicated top-level Workflows menu: hosts Reports & Docs (`docs`), Workflow Runs (`workflow-runs`), Screener Reports (`reports`), Proposal Review (`review`), and Track Record (`track-record`).
  - Platform menu updated: hosts Platform Admin (`platform-admin`), Scheduled Runs (`schedules`), Agent Mesh Registry (`agents`), Compliance & Audit (`audit`), Workflows & FAQ (`workflows`), and API Endpoints (`endpoints`).
  - Billing menu: separated from Platform into its own top-level menu hosting Billing & Payments (`payments`), Revenue Analytics (`revenue`), Audit Ledger (`ledger`), and Checkout (`checkout`).
  - Intelligence & Copilot: Goal Screen added as a dedicated top-level navigation item.
  - Sandbox menu: dedicated top-level menu hosting Payment Assurance and Checkout Sandbox.
  - Route table, navigation derivation, and configurable navigation test pins updated in lockstep.

## Agent #cfo-qunso

Closes #2685

Process documentation impact: None (client UI and navigation enhancement).
