"use client";

import { getViewMeta } from "@/lib/navigation/registry";
import { useNavigationStore } from "@/stores/navigation";
import { AlertsView } from "@/components/views/alerts-view";
import { ChangesView } from "@/components/views/changes-view";
import { CredentialsView } from "@/components/views/credentials-view";
import { DashboardView } from "@/components/views/dashboard-view";
import { DeviceDetailView } from "@/components/views/device-detail-view";
import { DevicesView } from "@/components/views/devices-view";
import { DiscoveryView } from "@/components/views/discovery-view";
import { IncidentsView } from "@/components/views/incidents-view";
import { JobsView } from "@/components/views/jobs-view";
import { PlaceholderView } from "@/components/views/placeholder-view";
import { SitesView } from "@/components/views/sites-view";

/**
 * Client-side view router (ADR-02): maps the active ViewKey from the
 * navigation store onto the implemented views; everything not built yet
 * renders a phase-accurate placeholder.
 *
 * Implemented: dashboard, network.devices, network.device-detail (Phase 2),
 * network.sites (Phase 2), network.discovery (Phase 2-c), admin.credentials
 * (Phase 2-c), ops.alerts, ops.incidents, changes.all, ops.jobs.
 */
export function ViewRouter() {
  const activeView = useNavigationStore((state) => state.activeView);

  switch (activeView) {
    case "dashboard":
      return <DashboardView />;
    case "network.devices":
      return <DevicesView />;
    case "network.device-detail":
      return <DeviceDetailView />;
    case "network.sites":
      return <SitesView />;
    case "network.discovery":
      return <DiscoveryView />;
    case "admin.credentials":
      return <CredentialsView />;
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
