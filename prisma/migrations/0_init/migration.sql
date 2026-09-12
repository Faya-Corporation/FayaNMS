-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissionsJson" TEXT NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "region" TEXT,
    "address" TEXT,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "mgmtIp" TEXT NOT NULL,
    "displayName" TEXT,
    "vendorId" TEXT NOT NULL,
    "platform" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "firmware" TEXT,
    "role" TEXT,
    "siteId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "criticality" TEXT NOT NULL DEFAULT 'MEDIUM',
    "healthScore" INTEGER NOT NULL DEFAULT 100,
    "uptimeSeconds" BIGINT,
    "lastSeen" TIMESTAMP(3),
    "lastBackupAt" TIMESTAMP(3),
    "lastConfigChangeAt" TIMESTAMP(3),
    "backupCompliance" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "tagsJson" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceInterface" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adminStatus" TEXT NOT NULL DEFAULT 'UP',
    "operStatus" TEXT NOT NULL DEFAULT 'DOWN',
    "speedMbps" INTEGER,
    "macAddress" TEXT,
    "description" TEXT,
    "vlan" INTEGER,
    "mtu" INTEGER,
    "countersInBps" BIGINT,
    "countersOutBps" BIGINT,
    "lastFlapAt" TIMESTAMP(3),

    CONSTRAINT "DeviceInterface_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'SSH_PASSWORD',
    "username" TEXT NOT NULL,
    "secretRef" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "lastRotatedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "CredentialProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cronExpr" TEXT NOT NULL,
    "scopeJson" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BackupPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigSnapshot" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "configType" TEXT NOT NULL DEFAULT 'RUNNING',
    "rawText" TEXT NOT NULL,
    "normalizedText" TEXT,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "encKeyId" TEXT,
    "encIv" TEXT,
    "encTag" TEXT,
    "normIv" TEXT,
    "normTag" TEXT,
    "wrappedDek" TEXT,
    "wrapIv" TEXT,
    "wrapTag" TEXT,
    "encAad" TEXT,
    "userId" TEXT,
    "changeId" TEXT,
    "jobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'HISTORICAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigBaseline" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "ConfigBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriftRecord" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "baselineSnapshotId" TEXT NOT NULL,
    "currentSnapshotId" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "diffSummary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DriftRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'LOW',
    "requesterId" TEXT NOT NULL,
    "ownerId" TEXT,
    "technicalOwnerId" TEXT,
    "siteId" TEXT,
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "implementationPlan" TEXT,
    "validationPlan" TEXT,
    "rollbackPlan" TEXT,
    "preChecksJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeDevice" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeStep" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'APPLY',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "output" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ChangeStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeApproval" (
    "id" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'TECHNICAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,

    CONSTRAINT "ChangeApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'SEV3',
    "priority" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "source" TEXT NOT NULL DEFAULT 'ALERT',
    "siteId" TEXT,
    "ownerTeam" TEXT,
    "ownerId" TEXT,
    "changeId" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "rootCause" TEXT,
    "correctiveAction" TEXT,
    "preventiveAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentDevice" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SYSTEM',
    "message" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ruleId" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count" INTEGER NOT NULL DEFAULT 1,
    "incidentId" TEXT,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "dedupKey" TEXT,
    "parentAlertId" TEXT,
    "suppressReason" TEXT,
    "assignedToId" TEXT,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL DEFAULT 'GT',
    "threshold" DOUBLE PRECISION NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 5,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "scopeJson" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceWindow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" TEXT,
    "deviceId" TEXT,
    "changeId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MaintenanceWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSample" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "interfaceId" TEXT,
    "metric" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricRollup" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "granularity" TEXT NOT NULL DEFAULT '1H',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "avg" DOUBLE PRECISION NOT NULL,
    "max" DOUBLE PRECISION NOT NULL,
    "min" DOUBLE PRECISION NOT NULL,
    "p95" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "MetricRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'SYSTEM',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "severity" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobExecution" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "payloadJson" TEXT,
    "resultJson" TEXT,
    "error" TEXT,
    "correlationId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceLabel" TEXT,
    "result" TEXT NOT NULL DEFAULT 'SUCCESS',
    "ip" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "hash" TEXT,
    "prevHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'WEEKLY',
    "format" TEXT NOT NULL DEFAULT 'PDF',
    "recipientsJson" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ApiClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopesJson" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "eventsJson" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" TEXT,
    "lastStatusCode" INTEGER,
    "lastDeliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTestAt" TIMESTAMP(3),
    "lastTestResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collector" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "capabilitiesJson" TEXT NOT NULL,
    "host" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "statsJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Collector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZtpClaim" (
    "id" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "vendorKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "siteId" TEXT,
    "deviceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZtpClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmdbItem" (
    "id" TEXT NOT NULL,
    "ciId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ciType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "criticality" TEXT NOT NULL DEFAULT 'medium',
    "environment" TEXT NOT NULL DEFAULT 'production',
    "serviceTier" TEXT NOT NULL DEFAULT 'tier-2',
    "description" TEXT,
    "deviceId" TEXT,
    "siteId" TEXT,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmdbItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmdbRelation" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CmdbRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE INDEX "Organization_name_idx" ON "Organization"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Site_code_key" ON "Site"("code");

-- CreateIndex
CREATE INDEX "Site_organizationId_idx" ON "Site"("organizationId");

-- CreateIndex
CREATE INDEX "Site_region_idx" ON "Site"("region");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_key_key" ON "Vendor"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Device_hostname_key" ON "Device"("hostname");

-- CreateIndex
CREATE INDEX "Device_siteId_idx" ON "Device"("siteId");

-- CreateIndex
CREATE INDEX "Device_vendorId_idx" ON "Device"("vendorId");

-- CreateIndex
CREATE INDEX "Device_status_idx" ON "Device"("status");

-- CreateIndex
CREATE INDEX "Device_criticality_idx" ON "Device"("criticality");

-- CreateIndex
CREATE INDEX "Device_healthScore_idx" ON "Device"("healthScore");

-- CreateIndex
CREATE INDEX "Device_backupCompliance_idx" ON "Device"("backupCompliance");

-- CreateIndex
CREATE INDEX "Device_role_idx" ON "Device"("role");

-- CreateIndex
CREATE INDEX "DeviceInterface_deviceId_operStatus_idx" ON "DeviceInterface"("deviceId", "operStatus");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceInterface_deviceId_name_key" ON "DeviceInterface"("deviceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialProfile_name_key" ON "CredentialProfile"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BackupPolicy_name_key" ON "BackupPolicy"("name");

-- CreateIndex
CREATE INDEX "ConfigSnapshot_deviceId_createdAt_idx" ON "ConfigSnapshot"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "ConfigSnapshot_deviceId_status_idx" ON "ConfigSnapshot"("deviceId", "status");

-- CreateIndex
CREATE INDEX "ConfigSnapshot_changeId_idx" ON "ConfigSnapshot"("changeId");

-- CreateIndex
CREATE INDEX "ConfigSnapshot_sha256_idx" ON "ConfigSnapshot"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigSnapshot_deviceId_version_key" ON "ConfigSnapshot"("deviceId", "version");

-- CreateIndex
CREATE INDEX "ConfigBaseline_deviceId_idx" ON "ConfigBaseline"("deviceId");

-- CreateIndex
CREATE INDEX "ConfigBaseline_approvedById_idx" ON "ConfigBaseline"("approvedById");

-- CreateIndex
CREATE INDEX "DriftRecord_deviceId_status_idx" ON "DriftRecord"("deviceId", "status");

-- CreateIndex
CREATE INDEX "DriftRecord_status_idx" ON "DriftRecord"("status");

-- CreateIndex
CREATE INDEX "DriftRecord_detectedAt_idx" ON "DriftRecord"("detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeRequest_number_key" ON "ChangeRequest"("number");

-- CreateIndex
CREATE INDEX "ChangeRequest_status_idx" ON "ChangeRequest"("status");

-- CreateIndex
CREATE INDEX "ChangeRequest_requesterId_idx" ON "ChangeRequest"("requesterId");

-- CreateIndex
CREATE INDEX "ChangeRequest_scheduledStart_idx" ON "ChangeRequest"("scheduledStart");

-- CreateIndex
CREATE INDEX "ChangeRequest_type_idx" ON "ChangeRequest"("type");

-- CreateIndex
CREATE INDEX "ChangeDevice_deviceId_idx" ON "ChangeDevice"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeDevice_changeId_deviceId_key" ON "ChangeDevice"("changeId", "deviceId");

-- CreateIndex
CREATE INDEX "ChangeStep_changeId_status_idx" ON "ChangeStep"("changeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeStep_changeId_order_key" ON "ChangeStep"("changeId", "order");

-- CreateIndex
CREATE INDEX "ChangeApproval_approverId_idx" ON "ChangeApproval"("approverId");

-- CreateIndex
CREATE INDEX "ChangeApproval_status_idx" ON "ChangeApproval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeApproval_changeId_level_key" ON "ChangeApproval"("changeId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_number_key" ON "Incident"("number");

-- CreateIndex
CREATE INDEX "Incident_status_idx" ON "Incident"("status");

-- CreateIndex
CREATE INDEX "Incident_severity_idx" ON "Incident"("severity");

-- CreateIndex
CREATE INDEX "Incident_siteId_idx" ON "Incident"("siteId");

-- CreateIndex
CREATE INDEX "Incident_changeId_idx" ON "Incident"("changeId");

-- CreateIndex
CREATE INDEX "Incident_createdAt_idx" ON "Incident"("createdAt");

-- CreateIndex
CREATE INDEX "Incident_slaDueAt_idx" ON "Incident"("slaDueAt");

-- CreateIndex
CREATE INDEX "IncidentDevice_deviceId_idx" ON "IncidentDevice"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentDevice_incidentId_deviceId_key" ON "IncidentDevice"("incidentId", "deviceId");

-- CreateIndex
CREATE INDEX "IncidentEvent_incidentId_createdAt_idx" ON "IncidentEvent"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_deviceId_status_idx" ON "Alert"("deviceId", "status");

-- CreateIndex
CREATE INDEX "Alert_status_idx" ON "Alert"("status");

-- CreateIndex
CREATE INDEX "Alert_severity_idx" ON "Alert"("severity");

-- CreateIndex
CREATE INDEX "Alert_ruleId_idx" ON "Alert"("ruleId");

-- CreateIndex
CREATE INDEX "Alert_incidentId_idx" ON "Alert"("incidentId");

-- CreateIndex
CREATE INDEX "Alert_lastSeen_idx" ON "Alert"("lastSeen");

-- CreateIndex
CREATE INDEX "Alert_dedupKey_status_idx" ON "Alert"("dedupKey", "status");

-- CreateIndex
CREATE INDEX "Alert_parentAlertId_idx" ON "Alert"("parentAlertId");

-- CreateIndex
CREATE INDEX "Alert_assignedToId_idx" ON "Alert"("assignedToId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRule_name_key" ON "AlertRule"("name");

-- CreateIndex
CREATE INDEX "AlertRule_metric_idx" ON "AlertRule"("metric");

-- CreateIndex
CREATE INDEX "AlertRule_isActive_idx" ON "AlertRule"("isActive");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_deviceId_startsAt_idx" ON "MaintenanceWindow"("deviceId", "startsAt");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_siteId_idx" ON "MaintenanceWindow"("siteId");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_startsAt_idx" ON "MaintenanceWindow"("startsAt");

-- CreateIndex
CREATE INDEX "MaintenanceWindow_endsAt_idx" ON "MaintenanceWindow"("endsAt");

-- CreateIndex
CREATE INDEX "MetricSample_deviceId_metric_ts_idx" ON "MetricSample"("deviceId", "metric", "ts");

-- CreateIndex
CREATE INDEX "MetricSample_ts_idx" ON "MetricSample"("ts");

-- CreateIndex
CREATE INDEX "MetricSample_metric_idx" ON "MetricSample"("metric");

-- CreateIndex
CREATE UNIQUE INDEX "MetricRollup_deviceId_metric_granularity_periodStart_key" ON "MetricRollup"("deviceId", "metric", "granularity", "periodStart");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_readAt_idx" ON "Notification"("readAt");

-- CreateIndex
CREATE INDEX "JobExecution_status_priority_idx" ON "JobExecution"("status", "priority");

-- CreateIndex
CREATE INDEX "JobExecution_type_status_idx" ON "JobExecution"("type", "status");

-- CreateIndex
CREATE INDEX "JobExecution_correlationId_idx" ON "JobExecution"("correlationId");

-- CreateIndex
CREATE INDEX "JobExecution_createdAt_idx" ON "JobExecution"("createdAt");

-- CreateIndex
CREATE INDEX "JobExecution_scheduledAt_idx" ON "JobExecution"("scheduledAt");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_resourceType_idx" ON "AuditEvent"("resourceType");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_idx" ON "AuditEvent"("actorId");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_prevHash_key" ON "AuditEvent"("prevHash");

-- CreateIndex
CREATE INDEX "ReportSchedule_isActive_idx" ON "ReportSchedule"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_tokenHash_key" ON "ApiClient"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiClient_isActive_idx" ON "ApiClient"("isActive");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_isActive_idx" ON "WebhookEndpoint"("isActive");

-- CreateIndex
CREATE INDEX "NotificationChannel_type_idx" ON "NotificationChannel"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Collector_name_key" ON "Collector"("name");

-- CreateIndex
CREATE INDEX "Collector_kind_idx" ON "Collector"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "ZtpClaim_serial_key" ON "ZtpClaim"("serial");

-- CreateIndex
CREATE INDEX "ZtpClaim_status_idx" ON "ZtpClaim"("status");

-- CreateIndex
CREATE INDEX "ZtpClaim_vendorKey_idx" ON "ZtpClaim"("vendorKey");

-- CreateIndex
CREATE UNIQUE INDEX "CmdbItem_ciId_key" ON "CmdbItem"("ciId");

-- CreateIndex
CREATE UNIQUE INDEX "CmdbItem_name_key" ON "CmdbItem"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CmdbItem_deviceId_key" ON "CmdbItem"("deviceId");

-- CreateIndex
CREATE INDEX "CmdbItem_ciType_status_idx" ON "CmdbItem"("ciType", "status");

-- CreateIndex
CREATE INDEX "CmdbItem_siteId_idx" ON "CmdbItem"("siteId");

-- CreateIndex
CREATE INDEX "CmdbItem_criticality_idx" ON "CmdbItem"("criticality");

-- CreateIndex
CREATE INDEX "CmdbRelation_sourceId_idx" ON "CmdbRelation"("sourceId");

-- CreateIndex
CREATE INDEX "CmdbRelation_targetId_idx" ON "CmdbRelation"("targetId");

-- CreateIndex
CREATE INDEX "CmdbRelation_relationType_idx" ON "CmdbRelation"("relationType");

-- CreateIndex
CREATE UNIQUE INDEX "CmdbRelation_sourceId_targetId_relationType_key" ON "CmdbRelation"("sourceId", "targetId", "relationType");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceInterface" ADD CONSTRAINT "DeviceInterface_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigSnapshot" ADD CONSTRAINT "ConfigSnapshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigSnapshot" ADD CONSTRAINT "ConfigSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigSnapshot" ADD CONSTRAINT "ConfigSnapshot_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "ChangeRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigSnapshot" ADD CONSTRAINT "ConfigSnapshot_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "JobExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigBaseline" ADD CONSTRAINT "ConfigBaseline_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigBaseline" ADD CONSTRAINT "ConfigBaseline_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ConfigSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigBaseline" ADD CONSTRAINT "ConfigBaseline_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftRecord" ADD CONSTRAINT "DriftRecord_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftRecord" ADD CONSTRAINT "DriftRecord_baselineSnapshotId_fkey" FOREIGN KEY ("baselineSnapshotId") REFERENCES "ConfigSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftRecord" ADD CONSTRAINT "DriftRecord_currentSnapshotId_fkey" FOREIGN KEY ("currentSnapshotId") REFERENCES "ConfigSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_technicalOwnerId_fkey" FOREIGN KEY ("technicalOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeDevice" ADD CONSTRAINT "ChangeDevice_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "ChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeDevice" ADD CONSTRAINT "ChangeDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeStep" ADD CONSTRAINT "ChangeStep_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "ChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeApproval" ADD CONSTRAINT "ChangeApproval_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "ChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeApproval" ADD CONSTRAINT "ChangeApproval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "ChangeRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentDevice" ADD CONSTRAINT "IncidentDevice_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentDevice" ADD CONSTRAINT "IncidentDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_parentAlertId_fkey" FOREIGN KEY ("parentAlertId") REFERENCES "Alert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceWindow" ADD CONSTRAINT "MaintenanceWindow_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "ChangeRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSample" ADD CONSTRAINT "MetricSample_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSample" ADD CONSTRAINT "MetricSample_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "DeviceInterface"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricRollup" ADD CONSTRAINT "MetricRollup_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmdbItem" ADD CONSTRAINT "CmdbItem_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmdbRelation" ADD CONSTRAINT "CmdbRelation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "CmdbItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmdbRelation" ADD CONSTRAINT "CmdbRelation_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "CmdbItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

