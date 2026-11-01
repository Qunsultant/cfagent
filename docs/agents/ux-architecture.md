Below is an implementation-ready **UX architecture specification** you can give to a design-and-development agent. It complements your `AGENTS.md`: that file governs how the agent works; this document defines what user experience it must build.

The specification combines WCAG 2.2 accessibility requirements, Microsoft’s Human–AI Interaction guidelines, and OWASP’s agentic-application security guidance. Product-specific requirements below are proposed engineering requirements—not claims that those standards mandate this exact interface. [w3](https://www.w3.org/TR/WCAG22/)

***

# UX Architecture Specification: Agentic Application

## 1. Purpose and implementation mandate

Build an application in which users can:

1. Define goals and constraints.
2. Understand the proposed scope and consequences.
3. Delegate work within explicit permissions.
4. Observe meaningful progress.
5. Inspect evidence and artifacts.
6. Correct, pause, cancel, or redirect work.
7. Approve consequential actions.
8. Review outcomes and provide feedback.
9. Understand how preferences or system behavior change over time.

The application must make autonomous work understandable and controllable without requiring users to inspect every internal agent message.

### Core product principle

> Organize the experience around user goals, tasks, evidence, decisions, and outcomes—not around the number of agents.

Do not implement a chat-only interface when users need structured comparison, approvals, reports, editing, or operational monitoring.

## 2. Scope and architecture boundaries

### Required separation

```text
Presentation layer
  Navigation, task workspace, editors, approvals, artifacts
                         ↓
Interaction layer
  Commands, validation, pending states, subscriptions
                         ↓
Application API
  Authentication, authorization, task state, approval validation
                         ↓
Agent orchestration
  Planning, delegation, tools, recovery, bounded adaptation
                         ↓
Persistent services
  Tasks, events, artifacts, permissions, audit records
```

The frontend displays server-confirmed execution state. It must not decide authorization or fabricate task completion.

### Framework integration

Where the application uses Cloudflare Think:

- Integrate with the supported client/server APIs of the installed version.
- Separate conversational streaming from durable task and artifact state.
- Do not equate an active WebSocket with a running task.
- Do not equate a disconnected client with a cancelled task.
- Do not duplicate framework-owned streaming or conversation behavior without justification.

Business components should depend on typed application contracts rather than provider-specific response objects wherever practical.

## 3. Standards and guidance

| Reference | Required application |
|---|---|
| WCAG 2.2 Level AA | Accessibility target for the application’s complete user journeys |
| WAI-ARIA Authoring Practices | Reference for custom widget behavior, roles, and keyboard interaction |
| Microsoft Human–AI Interaction / HAX | Capability disclosure, uncertainty, correction, control, feedback, and change communication |
| OWASP agentic and LLM security guidance | Permission boundaries, untrusted content handling, tool-action transparency, and misuse-resistant interaction |
| Platform conventions | Expected browser navigation, keyboard behavior, forms, downloads, and notifications |

WCAG is a technical accessibility standard. HAX and OWASP serve different purposes and must not be represented as interchangeable certifications. Microsoft’s guidelines address initial use, routine interaction, errors, and behavior over time; OWASP addresses risks specific to agentic systems. [microsoft](https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/)

### Compliance evidence

Maintain:

```text
Requirement → Design decision → Component → Test → Evidence
```

Do not claim accessibility conformance or security certification based solely on automated scans.

## 4. Users, roles, and journeys

Begin implementation by validating the actual personas. Use these as provisional roles:

| Role | Primary needs |
|---|---|
| Requester | Delegate work, understand progress, inspect results |
| Approver | Review exact proposed actions and consequences |
| Operator | Investigate failures, recover work, manage limits |
| Administrator | Manage identities, integrations, permissions, retention |
| Auditor/reviewer | Reconstruct decisions and inspect evidence |

One person may hold several roles. Permissions must still be enforced separately.

### Required journeys

Design and test:

- First-time onboarding.
- Creating a task from a template.
- Creating an open-ended task.
- Clarifying an ambiguous request.
- Reviewing a proposed plan.
- Monitoring long-running work.
- Resolving a blocker.
- Approving or rejecting an action.
- Editing and resubmitting an artifact.
- Recovering after disconnection.
- Cancelling work with partial side effects.
- Reviewing completed or failed work.
- Managing memory, integrations, and notifications.

## 5. Information architecture

Use the following navigation as a starting structure. Consolidate sections when the product is small.

```text
Overview
Tasks
  Active
  Needs attention
  Completed
  Failed / cancelled
Approvals
Artifacts
Knowledge and memory
Activity / audit
Settings
  Integrations
  Permissions
  Budgets
  Notifications
  Privacy and retention
```

Agents belong in an optional operational view. They should not be the primary navigation unless managing agents is itself the product.

### Task workspace

```text
┌──────────────────────────────────────────────────────────────┐
│ Task title • Status • Owner • Budget • Attention required    │
├──────────────────────────────────────────────────────────────┤
│ Goal and constraints                                        │
│ Plan • Activity • Results • Evidence • Settings              │
├──────────────────────────────────────┬───────────────────────┤
│ Main artifact or task content        │ Context / evidence    │
│                                      │ Pending decisions     │
│                                      │ Relevant limitations  │
├──────────────────────────────────────┴───────────────────────┤
│ Contextual controls: clarify / pause / cancel / approve       │
└──────────────────────────────────────────────────────────────┘
```

On smaller screens, use a single-column layout with explicit navigation between panels. Preserve access to evidence and approvals.

## 6. Design system and frontend implementation

### Before selecting libraries

Inspect the existing stack, component library, routing, authentication, and design tokens.

Prefer extending an existing suitable system over introducing another component framework.

Document decisions for:

- Component primitives.
- Styling and design tokens.
- Server-state fetching and caching.
- Event subscriptions.
- Forms and schema validation.
- Tables, charts, and editors.
- Accessibility testing.
- Browser and device support.

Do not install multiple overlapping UI libraries without a documented reason.

### Design tokens

Define semantic tokens for:

- Typography.
- Spacing.
- Surfaces and elevation.
- Borders.
- Focus.
- Interactive states.
- Status colors.
- Motion.
- Responsive layouts.

Use semantic status names rather than raw colors:

```text
status.running
status.blocked
status.needsApproval
status.failed
status.completed
```

Color must never be the only indicator.

### Required reusable components

- Task card and task table.
- Status badge.
- Goal/constraint form.
- Plan outline.
- Progress summary.
- Activity timeline.
- Evidence/source panel.
- Artifact viewer/editor.
- Approval card and review dialog.
- Budget indicator.
- Error and recovery panel.
- Connection-status banner.
- Empty state.
- Notification item.
- Memory record editor.
- Change-comparison view.

### Dialogs: one system

Every dialog is built with the Modal primitive from
`src/client/components/ui/` (`Modal.tsx`). No hand-rolled modal shells
(backdrop/content divs with their own close, Escape, focus, or scroll
handling) may be added, and existing shells migrate to Modal when touched.

Creation pattern (uniform across the platform):

- `<Modal open onClose size="none" panelClassName ariaLabel>` — `size="none"`
  lets the panel class own sizing; `panelClassName` carries the dialog's
  panel class; `ariaLabel` labels the dialog.
- No `title` prop when the dialog has a custom header: the custom header
  (and its close control) stays in children, so there is exactly one close
  button. `title` is only for dialogs without a custom header.
- Behavior is the primitive's, everywhere: portal to body, Escape to close,
  focus trap with initial focus and restore on close, body scroll lock,
  backdrop-click to close, `role="dialog"` + `aria-modal` semantics.
  No dialog invents its own Escape, focus, or scroll behavior.

Rationale: one system gives consistent behavior, consistent structure, and
consistent creation, fully controlled by this architecture — no one-offs.

### Toasts: one place for transient feedback

Transient success/failure feedback — anything the user did that succeeded
or failed and does not need to stay on screen — goes through the global
Toast primitive (`ToastProvider` + `useToast()` in
`src/client/components/ui/`, viewport mounted once at the app root).
The user never hunts for a message: every confirmation lands in the same
familiar bottom-right place, in the same shape, whatever panel acted.

- Tones: success/info auto-dismiss (5s), warning 8s, danger persists
  until dismissed — an error the user must see is never timed out from
  under them. Every toast has a dismiss button; hover/focus pauses the
  timer; Escape dismisses the newest toast while focus is in the
  viewport; toasts never steal focus on arrival.
- Announced: danger/warning via `role="alert"`, success/info via
  `role="status"`. Identical visible toasts dedupe instead of stacking;
  at most 4 are visible, newest on top.
- No native `alert()`/`confirm()` dialogs, no per-panel toast one-offs.
  Persistent state that must remain visible (warnings, guarantees,
  page-level error/empty states) still belongs to the inline Notice —
  Toast is for transient feedback, Notice is for state that stays.

### Loading and empty states: never present loading as empty

While data is in flight the panel shows a Spinner (or a Skeleton);
EmptyState is reserved for settled-but-empty. An EmptyState titled
"Loading…" lies twice: it claims emptiness before the data has answered,
and it keeps claiming loading after the fetch failed.

- Async buttons use the Button `loading` prop, never a label swap.
  A swap ("Save" → "Saving…") renames the action mid-flight, shifts
  layout as the text width changes, and drops the spinner affordance;
  `loading` keeps the label, shows the spinner, disables the button,
  and sets `aria-busy`. Keep any existing `disabled` expression; the
  prop adds its own disable.
- Table has no `loading` prop: its `empty` slot renders a Spinner while
  loading and the static EmptyState once settled
  (`empty={loading ? <Spinner /> : <EmptyState title="…" />}`).
- PageShell `loading` hides children — never wire refresh-loading to
  it. It is for the initial page load only; a refresh keeps the old
  content visible with the refresh control itself in its loading state.
- Skeleton is for content-shaped waits (a panel whose layout is known
  before its data arrives); Spinner is for region waits. Either is a
  loading affordance, never an empty state.
- Silent success is a missing confirmation: a completed user action
  that changes nothing visible gets a transient Toast (see Toasts
  above), not silence and not a persistent Notice.
- Pins (`tests/ux_no_loading_empty_2283.test.ts`,
  `tests/ux_button_loading_2283.test.ts`): no EmptyState title contains
  "Loading" (the scan tracks `{}` depth, so JSX-valued props do not
  hide a title); no Button child ternary swaps to an ellipsis label.
  Static ellipses are content, not swaps, and live in the pin's
  allowlist with the reason: a picker label ("Select strategies…"),
  truncated content ("NLQ: …"), a truncation suffix inside a computed
  label. A new swap cannot hide behind the allowlist.

### Anchored surfaces: Menu, Popover, Drawer

Floating panels are primitives, not per-panel inventions. Menu, Popover,
and Drawer live in `src/client/components/ui/` with token-only styling
in `primitives.css`, and new floating surfaces use them; existing
hand-rolled menus migrate when touched (the AskAgentWidget drawer and
the landing ⌘K palette migrated in stream 5).

- Menu is a WAI-ARIA menu button: the trigger carries
  `aria-haspopup="menu"` and `aria-expanded`, the portaled panel is
  `role="menu"` with `role="menuitem"` buttons, ArrowDown/Up/Home/End
  move between enabled items, Escape closes and restores focus to the
  trigger, an outside pointer press closes, disabled items are
  `aria-disabled` and never fire, danger items take the danger tone.
- Popover is the non-modal sibling: a trigger-anchored dialog for
  secondary content, Escape/outside-close, placement shared with Menu.
  No focus trap by design — focus stays on the trigger.
- Drawer is a side panel on the Modal behavior contract: portal to
  body, Escape/backdrop close, focus trap with restore, body scroll
  lock, `role="dialog"` + `aria-modal`. Token z-order puts the drawer
  below Toast, so transient feedback always stays on top; the header
  takes a title node plus optional actions before the built-in close.
- The one-dialog-system rule extends to the vanilla landing page: its
  ⌘K palette uses `.modal-backdrop` + `.modal-dialog` with only its
  top-anchored placement page-local (no separate backdrop/box system).
- Sortable table headers are real buttons, and the column carries
  `aria-sort` (the Table primitive renders it on the `<th>`); a
  clickable span is not a sort control. Silent caps are disclosed, not
  hidden: DocsAndReports notes its 100-run request cap, NLQ notes its
  first-20-rows display cap.

## 7. Goal capture and delegation

The creation flow must collect:

| Field | Purpose |
|---|---|
| Goal | Desired outcome |
| Completion criteria | How success will be evaluated |
| Scope | Included and excluded work |
| Inputs | Files, data, context |
| Constraints | Time, budget, methods, policies |
| Permissions | Allowed tools and action classes |
| Review points | When human intervention is required |
| Output | Artifact type and destination |

Support templates and progressive disclosure. Do not force expert configuration for ordinary tasks.

### Before starting

Show a concise “delegation contract”:

```text
What will be done
What will not be done
Which systems will be accessed
Which actions require approval
Budget and duration limits
Expected outputs
```

Ask clarification questions when ambiguity affects material outcomes. Do not silently infer recipients, accounts, payment amounts, or live-trading authority.

## 8. Autonomy and permission UX

Use capability-based permissions rather than a vague “autonomous mode.”

| Permission class | Example |
|---|---|
| Read | Retrieve approved records |
| Analyze | Calculate, compare, summarize |
| Draft | Prepare an artifact without publishing |
| Change | Modify an approved resource |
| Commit | Send, publish, pay, trade, deploy, or delete |

Allow bounded grants where appropriate:

```text
Scope + allowed action + limits + expiry + revocation
```

### Approval requirements

Before a consequential action, display:

- Exact action.
- Resolved target.
- Complete material content or change.
- Cost or exposure.
- Relevant evidence.
- Reversibility.
- Expiration of the approval.

Approval must bind to the specific action version. If the target, amount, content, or material conditions change, require a new approval.

The backend must enforce the approval. Disabling a button is not access control.

## 9. Execution-state model

Maintain separate concepts:

```text
Connection state:
connected | reconnecting | disconnected

Task state:
draft | queued | running | waiting_for_user |
waiting_for_approval | paused | completed |
partially_completed | failed | cancelled

Action state:
proposed | approved | executing | succeeded |
failed | outcome_unknown
```

Define allowed transitions server-side.

### Control semantics

| Control | Required meaning |
|---|---|
| Pause | Stop accepting new work at a defined safe checkpoint; explain in-flight behavior |
| Cancel | Request termination; identify work that cannot be interrupted |
| Retry | Explain what will be repeated and how duplicates are prevented |
| Resume | Continue from a known checkpoint where supported |
| Undo | Offer only when reversal is actually supported |
| Compensate | Perform a separate corrective action; do not label it “undo” |

A successful cancellation request is not proof that external side effects stopped.

## 10. Progress and multi-agent transparency

Show progress in terms users understand:

```text
Retrieving evidence
Validating inputs
Comparing alternatives
Preparing recommendation
Waiting for your approval
```

### Requirements

- Show completed steps, current activity, blockers, and next decision.
- Show when evidence or estimates are incomplete.
- Use percentages only when there is a meaningful denominator.
- Mark estimated completion times as estimates.
- Explain replanning when scope, cost, or outcomes materially change.
- Expose agent assignments and delegation in an expandable view.

Do not expose private chain-of-thought. Provide concise decision rationales, actions, evidence, assumptions, and limitations instead.

Do not display simulated activity as real progress.

## 11. Evidence, uncertainty, and artifacts

### Every consequential result should support inspection

Provide:

- Source identity.
- Retrieval and observation timestamps where relevant.
- Data freshness.
- Assumptions.
- Missing information.
- Conflicting evidence.
- Calculation methodology.
- Artifact version.

Do not use an unexplained model-generated confidence percentage. Prefer concrete labels such as:

```text
Verified against source
Calculated from supplied inputs
Estimated under stated assumptions
Unverified
```

### Artifact lifecycle

```text
Draft → Validated → Ready for review → Approved → Published
```

Adapt these states to the domain.

Users must be able to:

- Inspect and edit.
- Compare versions.
- Trace evidence.
- Export in appropriate formats.
- See whether a displayed version differs from an approved version.

Treat artifacts and conversation messages as separate objects.

## 12. Errors, interruption, and recovery

Every error state should answer:

1. What happened?
2. What completed?
3. What remains uncertain?
4. Is retry safe?
5. What can the user do next?

Support:

- Tool timeout.
- Authentication expiry.
- Rate limiting.
- Missing data.
- Conflicting evidence.
- Partial execution.
- Model-provider failure.
- Budget exhaustion.
- Browser refresh or network loss.
- Unknown external action outcome.

When an external action times out, do not automatically offer “retry” as harmless. First reconcile whether it already succeeded.

Preserve drafts, selected filters, and recoverable task context.

## 13. Accessibility requirements

Target WCAG 2.2 AA across complete flows. Relevant requirements include:

- Semantic structure and programmatic labels.
- Keyboard operation.
- Visible focus and focus not entirely obscured.
- Appropriate text and non-text contrast.
- Reflow and text resizing.
- Accessible errors and status messages.
- Alternatives to dragging.
- Accessible authentication.
- Minimum target sizes or applicable spacing/exceptions. [w3](https://www.w3.org/TR/WCAG22/)

### Agent-specific accessibility

- Do not announce every streamed token to screen readers.
- Announce meaningful milestones through appropriate live regions.
- Allow users to pause auto-scrolling.
- Preserve focus during incoming updates.
- Never move focus merely because an agent produced a message.
- Ensure plan trees and activity feeds work with keyboards.
- Provide text/table alternatives for charts.
- Respect reduced-motion preferences.
- Do not rely on animation to communicate execution state.

For touch usability, prefer 44 × 44 CSS-pixel targets where practical. WCAG 2.2 AA’s target-size criterion is 24 × 24 CSS pixels with specified exceptions; 44 × 44 is the enhanced AAA criterion, not the AA minimum. [w3](https://www.w3.org/WAI/WCAG22/quickref/)

## 14. Privacy, memory, and personalization

Users must be able to understand:

- What is remembered.
- Why it is retained.
- Which tasks or tenants can use it.
- How to correct or delete it.
- Whether a preference affects future behavior.

Distinguish:

```text
Task context
Conversation history
Explicit saved preference
Verified domain record
Inferred preference
```

Do not silently promote speculation into durable user facts.

Explain limitations of deletion, retention, exports, and audit requirements. Do not claim data is erased from all systems unless that is verified.

## 15. Adaptation and improvement UX

Separate three mechanisms:

| Mechanism | User-facing treatment |
|---|---|
| Task adaptation | Explain material replanning during the current task |
| Personalization | Let users inspect and change saved preferences |
| System improvement | Version, evaluate, authorize, and communicate relevant changes |

Feedback buttons should specify what the feedback means:

```text
Incorrect evidence
Wrong calculation
Not useful
Wrong action
Permission concern
```

Do not imply that every feedback submission immediately retrains the model.

Notify users when changes affect permissions, approval behavior, saved preferences, or important capabilities. Making limitations clear, supporting correction, and communicating changes align with Microsoft’s Human–AI Interaction guidance. [microsoft](https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/)

## 16. Frontend–backend contracts

Define typed contracts before implementation:

| Object | Minimum fields |
|---|---|
| Task | ID, goal, constraints, owner, status, version |
| Plan step | ID, parent, description, status, dependencies |
| Event | ID, task ID, type, timestamp, sequence/version |
| Action proposal | ID, exact payload, target, risk, expiry, version |
| Approval | Proposal ID/version, decision, actor, timestamp |
| Artifact | ID, type, version, location, evidence references |
| Evidence | Source, timestamps, freshness, scope |
| Budget | Limit, consumed, reserved, unit |
| Error | Code, scope, recoverability, safe next actions |

### Synchronization rules

- Server state is authoritative.
- Reconcile from a snapshot after reconnect.
- Handle duplicate and out-of-order events.
- Distinguish requested actions from confirmed outcomes.
- Do not optimistically display “sent,” “paid,” “traded,” or “deployed.”
- Protect mutations from stale versions.
- Avoid putting secrets or sensitive full payloads in browser storage.
- Treat model-generated Markdown, HTML, links, and attachments as untrusted.

## 17. Validation and testing

### Required test layers

1. Component tests.
2. State-transition tests.
3. Keyboard and screen-reader checks.
4. Automated accessibility checks.
5. API-contract tests.
6. End-to-end user journeys.
7. Recovery and concurrency tests.
8. Permission and approval tests.
9. Representative usability sessions.

### Required scenarios

- User rejects a plan.
- User edits constraints mid-task.
- Agent needs clarification.
- Approval expires.
- Approved action changes before execution.
- Two approvers act concurrently.
- Network disconnects during execution.
- Browser refreshes during a long task.
- Tool returns conflicting evidence.
- External action times out with an unknown outcome.
- Budget is exhausted.
- A task is cancelled after partial success.
- A notification is missed.
- Screen-reader user reviews and approves an action.

The interface must not conceal backend failures with polished success states.

## 18. UX metrics

Measure outcomes, not just interaction volume:

- Task-completion rate.
- Time to first useful result.
- Time spent resolving blockers.
- Approval comprehension.
- Correction success.
- Recovery success.
- Unintended-action rate.
- False completion/status rate.
- Accessibility defects.
- User understanding of limitations.
- Cost per successfully completed task.

High approval rates and low intervention rates are not automatically good. Users may approve because consequences are unclear or because intervention is difficult.

Establish baseline measurements before claiming improvement.

## 19. Implementation phases

| Phase | Deliverable | Gate |
|---|---|---|
| Discovery | Personas, journeys, existing-UI audit, constraints | Scope agreement |
| Architecture | Navigation, state model, permissions, contracts | Architecture approval |
| Interaction design | Wireframes, content, error/recovery flows | Journey review |
| Design system | Tokens, primitives, accessible components | Component validation |
| Vertical slice | One complete task-to-result journey | Functional and UX tests |
| Expansion | Additional workflows and collaboration views | Regression checks |
| Hardening | Recovery, accessibility, security, performance | Release readiness |
| Evaluation | Real usability evidence and improvements | Measured review |

Do not build every screen before validating one complete journey.

## 20. Definition of done

A feature is complete only when:

- Its primary and failure journeys work.
- Server state and UI state agree.
- Permissions are enforced.
- Approvals show exact consequences.
- Evidence and uncertainty are inspectable.
- Keyboard and relevant assistive-technology flows are tested.
- Reconnection and cancellation behavior are demonstrated.
- No placeholder activity is represented as real.
- Telemetry and privacy behavior are documented.
- Tests and known limitations are recorded.

## 21. Instructions to the implementation agent

Before coding:

1. Inspect the existing repository and applicable instructions.
2. Identify current frameworks and reusable components.
3. Map this specification to existing and missing functionality.
4. Produce a proposed information architecture and state model.
5. Identify unresolved product decisions.
6. Recommend the smallest end-to-end vertical slice.
7. Obtain approval for material architecture changes.

During implementation:

- Work incrementally.
- Preserve existing capabilities.
- Use explicit contracts and reusable components.
- Keep authorization on the server.
- Test failure paths as well as happy paths.
- Report actual checks and observed results.
- Do not deploy or change external resources without authorization.

Final handoff:

- Implemented journeys.
- Screens and components.
- Contract changes.
- Accessibility evidence.
- Security and recovery evidence.
- Tests executed.
- Remaining gaps.
- Screenshots or recordings where available.
- Next recommended increment.

***

## Suggested instruction to give the agent

> Use this UX architecture specification alongside the repository’s `AGENTS.md`. First assess the existing application, then propose the information architecture, execution-state model, approval model, component system, and one complete vertical slice. Preserve the existing stack where suitable. Treat accessibility, evidence, recovery, and user control as acceptance criteria—not later enhancements. Do not start a broad redesign or deployment before the proposed scope is approved.
