import { AppShell } from "@/components/shell/app-shell";

/**
 * Single user-visible route (ADR-02): hosts the whole FayaNMS app shell —
 * sidebar, header, command palette, client-side view router and dashboard.
 */
export default function Home() {
  return <AppShell />;
}
