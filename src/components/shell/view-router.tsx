"use client";

import { getViewMeta } from "@/lib/navigation/registry";
import { useNavigationStore } from "@/stores/navigation";
import { AlertsView } from "@/components/views/alerts-view";
import { ChangesView } from "@/components/views/changes-view";
import { DashboardView } from "@/components/views/dashboard-view";
import { DevicesView } from "@/components/views/devices-view";
import { IncidentsView } from "@/components/views/incidents-view";
import { JobsView } from "@/components/views/jobs-view";
import { PlaceholderView } from "@/components/views/placeholder-view";

/**
 * Client-side view router (ADR-02): maps the active ViewKey from the
 * navigation store onto the implemented views; everything not built yet
 * renders a phase-accurate placeholder.
 *
 * Implemented in Phase 1 (Gate G1): dashboard, network.devices,
 * ops.alerts, ops.incidents, changes.all, ops.jobs.
 */
export function ViewRouter() {
  const activeView = useNavigationStore((state) => state.activeView);

  switch (activeView) {
    case "dashboard":
      return <DashboardView />;
    case "network.devices":
      return <DevicesView />;
    case "ops.alerts":
      return <AlertsView />;
    case "ops.incidents":
      return <IncidentsView />;
    case "changes.all":
      return <ChangesView />;
    case "ops.jobs":
      return <JobsView />;
    default: {
      const meta = getViewMeta(activeView);
      return <PlaceholderView meta={meta} viewKey={activeView} />;
    }
  }
}
