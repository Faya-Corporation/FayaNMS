"use client";

import { getViewMeta } from "@/lib/navigation/registry";
import { useNavigationStore } from "@/stores/navigation";
import { AdminApiClientsView } from "@/components/views/admin-api-clients-view";
import { AdminCollectorsView } from "@/components/views/admin-collectors-view";
import { AdminCredentialsView } from "@/components/views/admin-credentials-view";
import { AdminDriversView } from "@/components/views/admin-drivers-view";
import { AdminIntegrationsView } from "@/components/views/admin-integrations-view";
import { AdminSystemView } from "@/components/views/admin-system-view";
import { AdminUsersView } from "@/components/views/admin-users-view";
import { AlertsView } from "@/components/views/alerts-view";
import { BackupComplianceView } from "@/components/views/backup-compliance-view";
import { BackupsView } from "@/components/views/backups-view";
import { BaselinesView } from "@/components/views/baselines-view";
import { CmdbView } from "@/components/views/cmdb-view";
import { ChangeDetailView } from "@/components/views/change-detail-view";
import { ChangeApprovalsView } from "@/components/views/change-approvals-view";
import { ChangesCalendarView } from "@/components/views/changes-calendar-view";
import { ChangeTemplatesView } from "@/components/views/changes-templates-view";
import { ChangesView } from "@/components/views/changes-view";
import { DashboardView } from "@/components/views/dashboard-view";
import { DeviceDetailView } from "@/components/views/device-detail-view";
import { DevicesView } from "@/components/views/devices-view";
import { DiscoveryView } from "@/components/views/discovery-view";
import { DriftView } from "@/components/views/drift-view";
import { EventsView } from "@/components/views/events-view";
import { FirmwareView } from "@/components/views/firmware-view";
import { FlowsView } from "@/components/views/flows-view";
import { HaView } from "@/components/views/ha-view";
import { IncidentsView } from "@/components/views/incidents-view";
import { IncidentDetailView } from "@/components/views/incident-detail-view";
import { MaintenanceView } from "@/components/views/maintenance-view";
import { NocView } from "@/components/views/noc-view";
import { JobsView } from "@/components/views/jobs-view";
import { PerfAvailabilityView } from "@/components/views/perf-availability-view";
import { PerfCapacityView } from "@/components/views/perf-capacity-view";
import { PerfDevicesView } from "@/components/views/perf-devices-view";
import { PerfInterfacesView } from "@/components/views/perf-interfaces-view";
import { PerfOverviewView } from "@/components/views/perf-overview-view";
import { PredictiveHealthView } from "@/components/views/predictive-health-view";
import { PlaceholderView } from "@/components/views/placeholder-view";
import { ReportsScheduledView } from "@/components/views/reports-scheduled-view";
import { ReportsView } from "@/components/views/reports-view";
import { SitesView } from "@/components/views/sites-view";
import { SnapshotsView } from "@/components/views/snapshots-view";
import { ZtpView } from "@/components/views/ztp-view";

/**
 * Client-side view router (ADR-02): maps the active ViewKey from the
 * navigation store onto the implemented views; everything not built yet
 * renders a phase-accurate placeholder.
 *
 * Implemented: dashboard, network.devices, network.device-detail (Phase 2),
 * network.sites (Phase 2), network.discovery (Phase 2-c),
 * admin.users + admin.credentials (Phase 7-a), ops.alerts, ops.incidents,
 * ops.maintenance, ops.events
 * (Phase 5-a/5-b/5-c), perf.overview, perf.devices, perf.interfaces,
 * perf.availability, perf.capacity (Phase 6-b), changes.all + changes.mine +
 * changes.calendar + changes.templates + changes.change-detail (Phase 4-a),
 * changes.approvals (Phase 4-b), ops.jobs, config.backups + config.compliance
 * (Phase 3-a), config.snapshots (Phase 3-b), config.baselines + config.drift
 * (Phase 3-c).
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
    case "admin.users":
      return <AdminUsersView />;
    case "admin.credentials":
      return <AdminCredentialsView />;
    case "admin.apiClients":
      return <AdminApiClientsView />;
    case "admin.integrations":
      return <AdminIntegrationsView />;
    case "admin.collectors":
      return <AdminCollectorsView />;
    case "admin.drivers":
      return <AdminDriversView />;
    case "admin.system":
      return <AdminSystemView />;
    case "network.discovery":
      return <DiscoveryView />;
    case "network.firmware":
      return <FirmwareView />;
    case "network.ztp":
      return <ZtpView />;
    case "ops.alerts":
      return <AlertsView />;
    case "ops.incidents":
      return <IncidentsView />;
    case "ops.incident-detail":
      return <IncidentDetailView />;
    case "ops.noc":
      return <NocView />;
    case "ops.maintenance":
      return <MaintenanceView />;
    case "ops.events":
      return <EventsView />;
    case "changes.all":
      return <ChangesView />;
    case "changes.mine":
      return <ChangesView mine />;
    case "changes.calendar":
      return <ChangesCalendarView />;
    case "changes.templates":
      return <ChangeTemplatesView />;
    case "changes.change-detail":
      return <ChangeDetailView />;
    case "changes.approvals":
      return <ChangeApprovalsView />;
    case "ops.jobs":
      return <JobsView />;
    case "ops.ha":
      return <HaView />;
    case "config.backups":
      return <BackupsView />;
    case "config.snapshots":
      return <SnapshotsView />;
    case "config.compliance":
      return <BackupComplianceView />;
    case "config.baselines":
      return <BaselinesView />;
    case "config.drift":
      return <DriftView />;
    case "config.cmdb":
      return <CmdbView />;
    case "perf.overview":
      return <PerfOverviewView />;
    case "perf.devices":
      return <PerfDevicesView />;
    case "perf.interfaces":
      return <PerfInterfacesView />;
    case "perf.availability":
      return <PerfAvailabilityView />;
    case "perf.capacity":
      return <PerfCapacityView />;
    case "perf.flows":
      return <FlowsView />;
    case "perf.predictive":
      return <PredictiveHealthView />;
    case "reports.reports":
      return <ReportsView />;
    case "reports.scheduled":
      return <ReportsScheduledView />;
    default: {
      const meta = getViewMeta(activeView);
      return <PlaceholderView meta={meta} viewKey={activeView} />;
    }
  }
}
