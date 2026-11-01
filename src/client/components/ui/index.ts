/**
 * Shared UI primitives (#492) — the composable component layer.
 *
 * Inventory (each primitive: semantic tokens only via primitives.css,
 * themed by construction, pinned by tests/composable_ui_primitives.test.ts):
 * - SegmentedControl — single-selection radio group (sizes sm/md/lg, badges,
 *   roving-tabindex keyboard navigation).
 * - PillGroup — selection pill group (sizes sm/md; tone variants
 *   default/cyan/emerald/amber/purple).
 * - Badge — status/label pill (tones neutral/accent/success/warning/
 *   danger/info/purple/trade; sizes xs/sm/md; optional status dot).
 * - Button — action button (variants primary/secondary/ghost/danger/
 *   trade/accent/warning; tones solid/subtle; sizes sm/md/lg; loading
 *   state with aria-busy).
 * - Spinner — loading indicator (sizes sm/md/lg; role="status" label).
 * - EmptyState — icon/title/description/action empty block (optional
 *   framed panel variant).
 * - Card — surface container (flat/elevated; padding scale).
 * - Notice — inline banner/alert (tones; box/strip; dismissible;
 *   role=alert for danger/warning).
 * - Tabs + TabPanel — WAI-ARIA tablist/tabpanel pair (roving tabindex,
 *   arrow/Home/End keys, automatic activation).
 * - TextInput / Select — labeled form controls on the token input
 *   family (TextInput adds ref forwarding + a multiline textarea mode)
 *   family, with hint/error wiring (aria-invalid + aria-describedby)
 *   via the shared FieldShell.
 * - Checkbox — native boolean toggle (bare control; callers keep their
 *   <label> wrappers; token accent + fixed box size).
 * - Modal — dialog on the tokens.css Universal Modal System classes:
 *   portal, Escape/backdrop close, focus trap + restore, scroll lock
 *   (sizes sm/md/lg/xl, optional footer).
 * - Table — semantic data table from a column config, with an empty
 *   slot (usually EmptyState).
 * - Skeleton — decorative loading placeholder (text/block/circle).
 * - PageShell + PageSection — page chrome (title + scope note + sections)
 *   with primitive loading/empty/error states; sections carry the shared
 *   section treatment (title + description) instead of hand-rolled h3s.
 * - Toast — the one global place for transient success/failure feedback
 *   (ToastProvider + useToast; auto-dismiss by tone, danger persists,
 *   hover/focus pause, Escape dismisses, role=status/alert announced).
 * - Menu — WAI-ARIA menu button (trigger + portaled role="menu" items,
 *   ArrowDown/Up/Home/End, Escape/outside-close, disabled + danger items).
 * - Popover — non-modal anchored panel (trigger + portaled dialog,
 *   Escape/outside-close, placement shared with Menu).
 * - Drawer — side panel on the Modal behavior contract (portal, Escape/
 *   backdrop close, focus trap + restore, scroll lock; sides left/right).
 *
 * Styles live in ./primitives.css (imported once by main.tsx). New
 * primitives are added here with their styles + tests in the same PR.
 */
export { SegmentedControl, type SegmentedControlOption, type SegmentedControlProps } from "./SegmentedControl";
export { PillGroup, type PillOption, type PillGroupProps } from "./PillGroup";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Button, type ButtonProps, type ButtonVariant } from "./Button";
export { Spinner, type SpinnerProps } from "./Spinner";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { Card, type CardProps } from "./Card";
export { Notice, type NoticeProps, type NoticeTone } from "./Notice";
export { Tabs, TabPanel, type TabsProps, type TabOption, type TabPanelProps } from "./Tabs";
export { TextInput, type TextInputProps } from "./TextInput";
export { Select, type SelectProps } from "./Select";
export { FileInput, type FileInputProps } from "./FileInput";
export { Checkbox, type CheckboxProps } from "./Checkbox";
export { FieldShell, type FieldShellProps } from "./Field";
export { Modal, type ModalProps } from "./Modal";
export { Table, type TableProps, type TableColumn } from "./Table";
export { Skeleton, type SkeletonProps } from "./Skeleton";
export { PageShell, PageSection, type PageShellProps, type PageSectionProps } from "./PageShell";
export { ToastProvider, useToast, type ToastTone, type ToastInput, type ToastApi } from "./Toast";
export { Menu, type MenuProps, type MenuItem } from "./Menu";
export { Popover, type PopoverProps } from "./Popover";
export { Drawer, type DrawerProps } from "./Drawer";
