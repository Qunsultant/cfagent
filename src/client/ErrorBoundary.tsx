/**
 * ErrorBoundary — containment for panel render failures.
 *
 * The app previously had NO error boundary anywhere: a single throw in
 * any panel unmounted the entire React tree and left a blank page with
 * no diagnostics (the Portfolio & Holdings crash, issue #71). This
 * boundary (1) contains the failure to the wrapped subtree so the rest
 * of the app keeps working, and (2) renders a business-language
 * fallback first — what is unavailable, what is unaffected, and the
 * recovery actions — with the technical detail (error name/message,
 * component and error stacks) collapsed under "Technical details" for
 * diagnosability from a screenshot without devtools.
 *
 * Recovery (issue #1704, A3-b): Retry re-mounts the children (useful
 * for transient data states); Reload page recovers a panel stuck on a
 * stale bundle. Neither action places orders or changes anything —
 * recovery here is view-only, which is why retry is always safe to
 * offer for a render failure.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./components/ui";
import { createClientLogger } from "./clientLogger";

const log = createClientLogger("client/ErrorBoundary");

interface ErrorBoundaryProps {
  /** Human label naming the wrapped area, shown in the fallback. */
  label: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // The failure stays visible in the console as a structured event
    // (the client logger's console sink emits one JSON line).
    log.error("errorBoundary.component_error", {
      message: `[ErrorBoundary:${this.props.label}]`,
      error: error.message,
      componentStack: info.componentStack ?? null,
    });
  }

  private handleRetry = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  private handleReloadPage = (): void => {
    if (typeof window !== "undefined" && window.location) {
      window.location.reload();
    }
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          margin: "12px 0",
          padding: "var(--space-3) var(--space-4)",
          border: "1px solid var(--color-danger)",
          borderRadius: 10,
          background: "var(--color-danger-subtle)",
          color: "inherit",
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          ⚠ {this.props.label} hit a problem and was stopped so the rest of the app keeps working.
        </div>
        <div style={{ marginBottom: 6 }}>
          What this panel was showing is unavailable. Nothing in the rest of the app is affected.
        </div>
        <div style={{ marginBottom: 10 }}>
          Retry reloads just this panel&apos;s view. If it fails again, reload the whole page — it
          may be running an older version.
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <Button size="sm" onClick={this.handleRetry}>
            Retry
          </Button>
          <Button variant="secondary" size="sm" onClick={this.handleReloadPage}>
            Reload page
          </Button>
        </div>
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer" }}>Technical details</summary>
          <div style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {error.name}: {error.message}
          </div>
          {componentStack && (
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "var(--font-size-micro)", margin: "6px 0 0" }}>
              {componentStack.trim()}
            </pre>
          )}
          {error.stack && (
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "var(--font-size-micro)", margin: "6px 0 0" }}>
              {error.stack}
            </pre>
          )}
        </details>
      </div>
    );
  }
}

export default ErrorBoundary;
