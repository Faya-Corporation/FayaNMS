"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

import { ErrorState } from "@/components/domain/error-state";

/**
 * View-level error boundary (RT-004 / F-004, audit A4-01).
 *
 * Wraps the client-side ViewRouter switch in AppShell so a crashing view
 * degrades to the shared `ErrorState` card while the shell (sidebar, header,
 * command palette, footer) stays alive — the operator can simply navigate
 * away instead of losing the whole app to Next's crash screen.
 *
 * AppShell mounts this boundary with `key={activeView}`, so navigating to
 * another view remounts a fresh boundary (reset-on-navigation); "Try again"
 * re-attempts the failing view in place.
 */

interface ViewErrorBoundaryProps {
  children: ReactNode;
}

interface ViewErrorBoundaryState {
  failed: boolean;
}

export class ViewErrorBoundary extends Component<
  ViewErrorBoundaryProps,
  ViewErrorBoundaryState
> {
  state: ViewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(_error: unknown): ViewErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Trace log only — the error never reaches the DOM (production
    // messages/digests may leak internals).
    console.error("[view-error]", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <ErrorState
          className="mx-auto my-8 max-w-xl"
          onRetry={() => this.setState({ failed: false })}
        />
      );
    }
    return this.props.children;
  }
}
