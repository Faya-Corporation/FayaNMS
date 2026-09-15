"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import {
  AppWindow,
  ArrowDownToLine,
  ArrowUpFromLine,
  Cable,
  Database,
  GitBranchPlus,
  LoaderCircle,
  MapPin,
  Network,
  OctagonX,
  Pencil,
  Router,
  Search,
  ShieldCheck,
  Trash2,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  useCmdb,
  useCmdbImpact,
  useCmdbItemDetail,
  useCreateCmdbItem,
  useCreateCmdbRelation,
  useDeleteCmdbRelation,
  useUpdateCmdbItem,
} from "@/hooks/api/use-cmdb";
import { useDevices } from "@/hooks/api/use-devices";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import {
  cmdbCriticalityBadge,
  cmdbEnvironmentBadge,
} from "@/lib/cmdb/band";
import { ApiError, type CmdbImpactResult, type CmdbItemRow, type CmdbRelationType } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";

/**
 * CMDB (Phase 15-a) — configuration items, dependency relations and impact
 * analysis over /api/v1/cmdb/*:
 *  - KPI row (total CIs, active, critical/tier-1, relations — global counts,
 *    stable while filtering);
 *  - the CI register table (type/criticality/environment badges with icon +
 *    text, site code, device deep link via the device-detail navigation
 *    pattern, owner) with server-side filters + search;
 *  - create-CI dialog (real site codes + optional device picker from the
 *    live inventory — one CI per device is enforced server-side);
 *  - relations panel for the selected CI: both directions, add-relation
 *    form (direction aware), remove, plus the deterministic impact lookup
 *    (BFS upstream/downstream with hop counts and relation paths);
 *  - recent CMDB audit history (CMDB_* audit rows).
 */

const CI_TYPE_ICONS: Record<string, LucideIcon> = {
  device: Router,
  interface: Network,
  service: Waypoints,
  application: AppWindow,
  site: MapPin,
  circuit: Cable,
};

const CMDB_TYPES = ["device", "interface", "service", "application", "site", "circuit"] as const;
const CMDB_STATUSES = ["active", "planned", "retired", "maintenance"] as const;
const CMDB_CRITICALITIES = ["low", "medium", "high", "critical"] as const;
const CMDB_ENVIRONMENTS = ["production", "staging", "lab"] as const;
const CMDB_TIERS = ["tier-1", "tier-2", "tier-3"] as const;
const CMDB_RELATION_TYPES = ["runs_on", "connects_to", "part_of", "depends_on", "monitored_by"] as const;

interface CmdbFilters {
  q: string;
  ciType: string;
  status: string;
  criticality: string;
  environment: string;
  siteId: string;
}

const EMPTY_FILTERS: CmdbFilters = {
  q: "",
  ciType: "",
  status: "",
  criticality: "",
  environment: "",
  siteId: "",
};

export function CmdbView() {
  const t = useTranslations("cmdb");
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [filters, setFilters] = useState<CmdbFilters>(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [impactItemId, setImpactItemId] = useState<string | null>(null);

  // Debounce the search box so each keystroke does not hit the API.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(filters.q.trim()), 250);
    return () => clearTimeout(timer);
  }, [filters.q]);

  const filterParams = useMemo(
    () => ({
      q: debouncedQ || undefined,
      ciType: filters.ciType || undefined,
      status: filters.status || undefined,
      criticality: filters.criticality || undefined,
      environment: filters.environment || undefined,
      siteId: filters.siteId || undefined,
      limit: 200,
    }),
    [debouncedQ, filters.ciType, filters.status, filters.criticality, filters.environment, filters.siteId]
  );

  const cmdb = useCmdb(filterParams);
  const detail = useCmdbItemDetail(selectedId);
  const impactQuery = useCmdbImpact(impactItemId);
  const refetchImpact = impactQuery.refetch;

  // Fire the on-demand impact query whenever a new lookup is requested.
  useEffect(() => {
    if (impactItemId) void refetchImpact();
  }, [impactItemId, refetchImpact]);

  const items = cmdb.data?.items ?? [];
  const counts = cmdb.data?.counts;
  const sites = cmdb.data?.sites ?? [];
  const history = cmdb.data?.history ?? [];

  const filtersActive =
    filters.ciType !== "" ||
    filters.status !== "" ||
    filters.criticality !== "" ||
    filters.environment !== "" ||
    filters.siteId !== "" ||
    debouncedQ !== "";

  const selectItem = (id: string) => {
    setSelectedId(id);
    setImpactItemId(null); // stale results from another CI would confuse
  };

  const runImpact = () => {
    if (selectedId) setImpactItemId(selectedId);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description={t("description")}
        primaryAction={
          <Button onClick={() => setCreateOpen(true)}>
            <GitBranchPlus aria-hidden="true" />
            {t("create.title")}
          </Button>
        }
        title={t("title")}
      />

      {cmdb.isError ? (
        <ErrorState
          onRetry={() => void cmdb.refetch()}
          reason={cmdb.error.message}
          title={t("errorTitle")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* ── KPI row (global counts — stable while filtering) ─────── */}
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <KpiCard
              description={t("kpi.totalHint")}
              icon={Database}
              label={t("kpi.total")}
              loading={!cmdb.data}
              value={counts?.total ?? "—"}
            />
            <KpiCard
              description={t("kpi.activeHint")}
              icon={ShieldCheck}
              label={t("kpi.active")}
              loading={!cmdb.data}
              value={counts?.active ?? "—"}
            />
            <KpiCard
              description={t("kpi.criticalTierHint")}
              icon={OctagonX}
              label={t("kpi.criticalTier")}
              loading={!cmdb.data}
              value={counts?.criticalTier ?? "—"}
            />
            <KpiCard
              description={t("kpi.relationsHint")}
              icon={Waypoints}
              label={t("kpi.relations")}
              loading={!cmdb.data}
              value={counts?.relations ?? "—"}
            />
          </div>

          {/* ── CI register ──────────────────────────────────────────── */}
          <SectionCard
            contentClassName="p-0"
            description={t("table.rowsCount", { count: items.length })}
            title={t("table.title")}
          >
            {/* Filters live in the card body (not the header actions slot):
                the actions slot is shrink-0 and would force a 866px filter
                cluster past the 375px viewport. This row wraps naturally. */}
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    aria-label={t("filters.searchLabel")}
                    className="h-8 w-44 ps-7 font-tech"
                    onChange={(event) =>
                      setFilters((f) => ({ ...f, q: event.target.value }))
                    }
                    placeholder={t("filters.searchPlaceholder")}
                    value={filters.q}
                  />
                </div>
                <FilterSelect
                  ariaLabel={t("filters.type")}
                  onValueChange={(value) => setFilters((f) => ({ ...f, ciType: value }))}
                  options={CMDB_TYPES.map((value) => ({ value, label: t(`type.${value}`) }))}
                  placeholder={t("filters.type")}
                  value={filters.ciType}
                />
                <FilterSelect
                  ariaLabel={t("filters.status")}
                  onValueChange={(value) => setFilters((f) => ({ ...f, status: value }))}
                  options={CMDB_STATUSES.map((value) => ({ value, label: t(`status.${value}`) }))}
                  placeholder={t("filters.status")}
                  value={filters.status}
                />
                <FilterSelect
                  ariaLabel={t("filters.criticality")}
                  onValueChange={(value) => setFilters((f) => ({ ...f, criticality: value }))}
                  options={CMDB_CRITICALITIES.map((value) => ({ value, label: t(`criticality.${value}`) }))}
                  placeholder={t("filters.criticality")}
                  value={filters.criticality}
                />
                <FilterSelect
                  ariaLabel={t("filters.environment")}
                  onValueChange={(value) => setFilters((f) => ({ ...f, environment: value }))}
                  options={CMDB_ENVIRONMENTS.map((value) => ({ value, label: t(`environment.${value}`) }))}
                  placeholder={t("filters.environment")}
                  value={filters.environment}
                />
                <FilterSelect
                  ariaLabel={t("filters.site")}
                  onValueChange={(value) => setFilters((f) => ({ ...f, siteId: value }))}
                  options={sites.map((site) => ({ value: site.code, label: site.code }))}
                  placeholder={t("filters.site")}
                  value={filters.siteId}
                />
                {filtersActive && (
                  <Button
                    aria-label={t("filters.resetAria")}
                    onClick={() => setFilters(EMPTY_FILTERS)}
                    size="sm"
                    variant="ghost"
                  >
                    <X aria-hidden="true" />
                    {t("filters.reset")}
                  </Button>
                )}
            </div>
            {cmdb.isLoading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  description={
                    filtersActive
                      ? t("table.emptyFilteredDescription")
                      : t("table.emptyDescription")
                  }
                  icon={Database}
                  title={t("table.emptyTitle")}
                />
              </div>
            ) : (
              <div tabIndex={0} className="max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>{t("table.ciId")}</TableHead>
                      <TableHead>{t("table.name")}</TableHead>
                      <TableHead>{t("table.type")}</TableHead>
                      <TableHead>{t("table.criticality")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("table.environment")}</TableHead>
                      <TableHead className="hidden md:table-cell">{t("table.site")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t("table.device")}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t("table.owner")}</TableHead>
                      <TableHead className="text-end">{t("table.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <CiRow
                        isSelected={selectedId === item.id}
                        item={item}
                        key={item.id}
                        onOpenDevice={() =>
                          setActiveView("network.device-detail", { deviceId: item.deviceId ?? "" })
                        }
                        onSelect={() => selectItem(item.id)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>

          {/* ── Relations + impact for the selected CI ───────────────── */}
          <RelationsAndImpact
            detail={detail}
            items={items}
            onImpact={runImpact}
            impactQuery={impactQuery}
            selectedId={selectedId}
            onClearImpact={() => setImpactItemId(null)}
          />

          {/* ── Recent CMDB audit history ────────────────────────────── */}
          <SectionCard
            contentClassName="p-0"
            description={t("audits.description")}
            title={t("audits.title")}
          >
            {(history ?? []).length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t("audits.empty")}</p>
            ) : (
              <ul className="divide-y">
                {history.map((entry, index) => (
                  <li
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-sm"
                    key={`${entry.action}-${index}`}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        entry.result === "SUCCESS" ? "bg-success" : "bg-danger"
                      )}
                    />
                    <span className="font-tech text-xs ltr-technical">{entry.action}</span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {entry.resourceLabel}
                    </span>
                    {entry.correlationId && (
                      <span className="font-tech text-xs text-muted-foreground ltr-technical">
                        {entry.correlationId}
                      </span>
                    )}
                    <span className="ms-auto whitespace-nowrap text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      )}

      {/* ── Create-CI dialog ──────────────────────────────────────────── */}
      <CreateCiDialog
        open={createOpen}
        sites={sites}
        onOpenChange={setCreateOpen}
        onCreated={(created) => selectItem(created.item.id)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Filter select (compact "All …" affordance)                          */
/* ------------------------------------------------------------------ */

function FilterSelect({
  ariaLabel,
  value,
  onValueChange,
  options,
  placeholder,
}: {
  ariaLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  return (
    <Select onValueChange={onValueChange} value={value}>
      <SelectTrigger aria-label={ariaLabel} className="h-8 w-[130px] text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ------------------------------------------------------------------ */
/* CI table row                                                        */
/* ------------------------------------------------------------------ */

function CiRow({
  item,
  isSelected,
  onSelect,
  onOpenDevice,
}: {
  item: CmdbItemRow;
  isSelected: boolean;
  onSelect: () => void;
  onOpenDevice: () => void;
}) {
  const t = useTranslations("cmdb");
  const TypeIcon = CI_TYPE_ICONS[item.ciType] ?? Database;
  const isCritical = item.criticality === "critical" || item.serviceTier === "tier-1";

  return (
    <TableRow
      className={cn(
        isSelected && "bg-info-subtle/40",
        isCritical && !isSelected && "bg-danger-subtle/20"
      )}
    >
      <TableCell className="whitespace-nowrap align-middle font-tech text-xs ltr-technical">
        {item.ciId}
      </TableCell>
      <TableCell className="max-w-0 align-middle">
        <span className="block truncate text-sm font-medium" title={item.description ?? item.name}>
          {item.name}
        </span>
        {item.serviceTier !== "tier-2" && (
          <span className="block font-tech text-[11px] text-muted-foreground ltr-technical">
            {t(`tier.${item.serviceTier}`)}
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap align-middle">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <TypeIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {t(`type.${item.ciType}`)}
        </span>
      </TableCell>
      <TableCell className="align-middle">
        <StatusBadge config={cmdbCriticalityBadge(item.criticality)} />
      </TableCell>
      <TableCell className="hidden align-middle md:table-cell">
        <StatusBadge config={cmdbEnvironmentBadge(item.environment)} withIcon />
      </TableCell>
      <TableCell className="hidden whitespace-nowrap align-middle font-tech text-xs ltr-technical md:table-cell">
        {item.siteId ?? "—"}
      </TableCell>
      <TableCell className="hidden align-middle lg:table-cell">
        {item.deviceId ? (
          <button
            className="font-tech text-xs text-info underline-offset-2 hover:underline ltr-technical"
            onClick={onOpenDevice}
            title={t("table.openDeviceAria", { hostname: item.deviceHostname ?? "" })}
            type="button"
          >
            {item.deviceHostname}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="hidden max-w-0 align-middle lg:table-cell">
        <span className="block truncate text-xs text-muted-foreground">
          {item.ownerName ?? "—"}
        </span>
      </TableCell>
      <TableCell className="text-end align-middle">
        <Button
          aria-label={t("table.openRelationsAria", { ci: item.ciId })}
          onClick={onSelect}
          size="sm"
          variant={isSelected ? "secondary" : "outline"}
        >
          <Waypoints aria-hidden="true" />
          {t("table.openRelations")}
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------ */
/* Relations + impact panel for the selected CI                        */
/* ------------------------------------------------------------------ */

type RelationsAndImpactProps = {
  selectedId: string | null;
  detail: ReturnType<typeof useCmdbItemDetail>;
  impactQuery: ReturnType<typeof useCmdbImpact>;
  items: CmdbItemRow[];
  onImpact: () => void;
  onClearImpact: () => void;
};

function RelationsAndImpact({
  selectedId,
  detail,
  impactQuery,
  items,
  onImpact,
  onClearImpact,
}: RelationsAndImpactProps) {
  const t = useTranslations("cmdb");
  const [editOpen, setEditOpen] = useState(false);

  if (!selectedId) {
    return (
      <SectionCard
        contentClassName="p-0"
        description={t("relations.description")}
        title={t("relations.title")}
      >
        <div className="p-4">
          <EmptyState
            description={t("relations.noneSelectedDescription")}
            icon={Waypoints}
            title={t("relations.noneSelected")}
          />
        </div>
      </SectionCard>
    );
  }

  const payload = detail.data;
  if (!payload) {
    return (
      <SectionCard
        contentClassName="p-0"
        description={t("relations.description")}
        title={t("relations.title")}
      >
        {detail.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void detail.refetch()}
              reason={detail.error.message}
              title={t("errorTitle")}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-8 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        )}
      </SectionCard>
    );
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      {/* Relations */}
      <SectionCard
        contentClassName="flex flex-col gap-3"
        description={t("relations.selectedDescription", {
          ci: payload.item.ciId,
          name: payload.item.name,
        })}
        title={t("relations.title")}
        actions={
          <Button onClick={() => setEditOpen(true)} size="sm" variant="outline">
            <Pencil aria-hidden="true" />
            {t("edit.open")}
          </Button>
        }
      >
        <AddRelationForm selectedId={payload.item.id} items={items} />

        <div className="flex flex-col gap-2">
          <RelationGroup
            emptyText={t("relations.emptyOutgoing")}
            icon={ArrowUpFromLine}
            relations={payload.outgoing}
            title={t("relations.outgoing")}
          />
          <RelationGroup
            emptyText={t("relations.emptyIncoming")}
            icon={ArrowDownToLine}
            relations={payload.incoming}
            title={t("relations.incoming")}
          />
        </div>
      </SectionCard>

      {/* Impact */}
      <SectionCard
        contentClassName="flex flex-col gap-3"
        description={t("impact.description")}
        title={t("impact.title")}
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={onImpact} size="sm" variant="outline">
              {impactQuery.isFetching ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" />
              ) : (
                <Waypoints aria-hidden="true" />
              )}
              {t("impact.lookup")}
            </Button>
            {impactQuery.data && (
              <Button onClick={onClearImpact} size="sm" variant="ghost">
                <X aria-hidden="true" />
                {t("impact.clear")}
              </Button>
            )}
          </div>
        }
      >
        {impactQuery.isError ? (
          <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger" role="alert">
            {impactQuery.error instanceof ApiError
              ? impactQuery.error.message
              : t("impact.loadFailed")}
          </p>
        ) : impactQuery.data ? (
          <ImpactResult result={impactQuery.data} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("impact.hint")}</p>
        )}
      </SectionCard>

      {/* Edit dialog (status / criticality / description) — keyed on the
          CI id + updatedAt so the draft re-initializes from fresh props. */}
      <EditCiDialog
        item={payload.item}
        key={`${payload.item.id}-${payload.item.updatedAt}`}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Relation group (one direction)                                      */
/* ------------------------------------------------------------------ */

function RelationGroup({
  title,
  relations,
  icon: Icon,
  emptyText,
}: {
  title: string;
  relations: {
    id: string;
    relationType: string;
    counterpart: { id: string; ciId: string; name: string; ciType: string };
  }[];
  icon: LucideIcon;
  emptyText: string;
}) {
  const t = useTranslations("cmdb");
  const removeRelation = useDeleteCmdbRelation();

  return (
    <div className="rounded-lg border">
      <p className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5" />
        {title}
        <span className="ms-auto font-tech ltr-technical">{relations.length}</span>
      </p>
      {relations.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="divide-y">
          {relations.map((relation) => (
            <li className="flex items-center gap-2 px-3 py-1.5 text-sm" key={relation.id}>
              <span className="whitespace-nowrap font-tech text-[11px] ltr-technical">
                {relation.counterpart.ciId}
              </span>
              <span className="min-w-0 flex-1 truncate">{relation.counterpart.name}</span>
              <span className="whitespace-nowrap rounded-md border bg-surface-subtle px-1.5 py-0.5 font-tech text-[10px] text-muted-foreground ltr-technical">
                {t(`relation.${relation.relationType}`)}
              </span>
              <Button
                aria-label={t("relations.removeAria", {
                  ci: relation.counterpart.ciId,
                  type: t(`relation.${relation.relationType}`),
                })}
                disabled={removeRelation.isPending}
                onClick={() => removeRelation.mutate(relation.id)}
                size="icon"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" className="text-danger" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add-relation form                                                   */
/* ------------------------------------------------------------------ */

function AddRelationForm({
  selectedId,
  items,
}: {
  selectedId: string;
  items: CmdbItemRow[];
}) {
  const t = useTranslations("cmdb");
  const { toast } = useToast();
  const createRelation = useCreateCmdbRelation();

  const [targetId, setTargetId] = useState("");
  const [relationType, setRelationType] = useState<string>("");
  const [direction, setDirection] = useState<"outgoing" | "incoming">("outgoing");

  const canSubmit = targetId !== "" && relationType !== "";
  const candidates = items.filter((item) => item.id !== selectedId);

  const submit = async () => {
    if (!canSubmit) return;
    const payload =
      direction === "outgoing"
        ? { sourceId: selectedId, targetId, relationType: relationType as CmdbRelationType }
        : { sourceId: targetId, targetId: selectedId, relationType: relationType as CmdbRelationType };
    try {
      const result = await createRelation.mutateAsync(payload);
      toast({
        title: t("toast.relationCreatedTitle", {
          source: result.relation.source.ciId,
          target: result.relation.target.ciId,
        }),
        description: t("toast.correlation", { correlation: result.correlationId }),
      });
      setTargetId("");
      setRelationType("");
    } catch (error) {
      toast({
        title: t("toast.failedTitle"),
        description: error instanceof Error ? error.message : t("errorTitle"),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="rounded-lg border bg-surface-subtle p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{t("relations.addTitle")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground" htmlFor="cmdb-rel-target">
            {t("relations.addTarget")}
          </label>
          <Select onValueChange={setTargetId} value={targetId}>
            <SelectTrigger id="cmdb-rel-target">
              <SelectValue placeholder={t("relations.targetPlaceholder")} />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {candidates.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.ciId} — {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground" htmlFor="cmdb-rel-type">
              {t("relations.type")}
            </label>
            <Select onValueChange={setRelationType} value={relationType}>
              <SelectTrigger id="cmdb-rel-type">
                <SelectValue placeholder={t("relations.type")} />
              </SelectTrigger>
              <SelectContent>
                {CMDB_RELATION_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`relation.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground" htmlFor="cmdb-rel-dir">
              {t("relations.direction")}
            </label>
            <Select
              onValueChange={(value) => setDirection(value === "incoming" ? "incoming" : "outgoing")}
              value={direction}
            >
              <SelectTrigger id="cmdb-rel-dir">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="outgoing">{t("relations.directionOutgoing")}</SelectItem>
                <SelectItem value="incoming">{t("relations.directionIncoming")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <Button className="mt-2" disabled={!canSubmit || createRelation.isPending} onClick={() => void submit()} size="sm">
        {createRelation.isPending ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" />
        ) : (
          <GitBranchPlus aria-hidden="true" />
        )}
        {createRelation.isPending ? t("relations.adding") : t("relations.add")}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Impact result (deterministic BFS output)                            */
/* ------------------------------------------------------------------ */

function ImpactResult({ result }: { result: CmdbImpactResult }) {
  const t = useTranslations("cmdb");

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {t("impact.analyzed", { ci: result.item.ciId, name: result.item.name })}{" "}
        · {t("impact.depthNote", { depth: result.meta.maxDepth })}
      </p>

      <ImpactDirection
        icon={ArrowUpFromLine}
        nodes={result.upstream}
        title={t("impact.upstream")}
      />
      <ImpactDirection
        icon={ArrowDownToLine}
        nodes={result.downstream}
        title={t("impact.downstream")}
      />
    </div>
  );
}

function ImpactDirection({
  title,
  nodes,
  icon: Icon,
}: {
  title: string;
  nodes: CmdbImpactResult["upstream"];
  icon: LucideIcon;
}) {
  const t = useTranslations("cmdb");

  return (
    <div className="rounded-lg border">
      <p className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5" />
        {title}
        <span className="ms-auto font-tech ltr-technical">{nodes.length}</span>
      </p>
      {nodes.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t("impact.empty")}</p>
      ) : (
        <ul className="divide-y">
          {nodes.map((node) => (
            <li className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-sm" key={`${node.ciId}-${node.hop}`}>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-0.5 font-tech text-[10px] ltr-technical",
                  node.hop <= 1
                    ? "border-danger/25 bg-danger-subtle text-danger"
                    : node.hop === 2
                      ? "border-warning/25 bg-warning-subtle text-warning"
                      : "border-neutral/25 bg-neutral-subtle text-neutral"
                )}
              >
                {t("impact.hops", { count: node.hop })}
              </span>
              <span className="whitespace-nowrap font-tech text-[11px] ltr-technical">
                {node.ciId}
              </span>
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span
                className="hidden max-w-[36ch] truncate font-tech text-[10px] text-muted-foreground ltr-technical md:inline"
                title={node.path.join(" → ")}
              >
                {node.path.join(" → ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create-CI dialog                                                    */
/* ------------------------------------------------------------------ */

function CreateCiDialog({
  open,
  onOpenChange,
  sites,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: { code: string; name: string }[];
  onCreated: (created: { item: { id: string; ciId: string } }) => void;
}) {
  const t = useTranslations("cmdb");
  const { toast } = useToast();
  const createItem = useCreateCmdbItem();

  // Device picker — live inventory via the existing devices hook.
  const devices = useDevices({ pageSize: 100, sort: "hostname", dir: "asc" });

  const [name, setName] = useState("");
  const [ciType, setCiType] = useState<string>("");
  const [criticality, setCriticality] = useState<string>("medium");
  const [environment, setEnvironment] = useState<string>("production");
  const [serviceTier, setServiceTier] = useState<string>("tier-2");
  const [siteId, setSiteId] = useState<string>("");
  const [deviceId, setDeviceId] = useState<string>("");
  const [description, setDescription] = useState("");

  const canSubmit =
    name.trim().length >= 2 && ciType !== "" && !createItem.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    try {
      const result = await createItem.mutateAsync({
        name: name.trim(),
        ciType: ciType as never,
        criticality: criticality as never,
        environment: environment as never,
        serviceTier: serviceTier as never,
        siteId: siteId || undefined,
        deviceId: deviceId || undefined,
        description: description.trim() || undefined,
      });
      toast({
        title: t("toast.createdTitle", { ci: result.item.ciId }),
        description: t("toast.correlation", { correlation: result.correlationId }),
      });
      onCreated(result);
      setName("");
      setCiType("");
      setCriticality("medium");
      setEnvironment("production");
      setServiceTier("tier-2");
      setSiteId("");
      setDeviceId("");
      setDescription("");
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t("toast.failedTitle"),
        description: error instanceof Error ? error.message : t("errorTitle"),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cmdb-create-name">{t("create.name")}</Label>
            <Input
              autoComplete="off"
              id="cmdb-create-name"
              onChange={(event) => setName(event.target.value)}
              placeholder={t("create.namePlaceholder")}
              value={name}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cmdb-create-type">{t("create.ciType")}</Label>
              <Select onValueChange={setCiType} value={ciType}>
                <SelectTrigger id="cmdb-create-type">
                  <SelectValue placeholder={t("create.ciType")} />
                </SelectTrigger>
                <SelectContent>
                  {CMDB_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`type.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cmdb-create-criticality">{t("create.criticality")}</Label>
              <Select onValueChange={setCriticality} value={criticality}>
                <SelectTrigger id="cmdb-create-criticality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CMDB_CRITICALITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`criticality.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cmdb-create-env">{t("create.environment")}</Label>
              <Select onValueChange={setEnvironment} value={environment}>
                <SelectTrigger id="cmdb-create-env">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CMDB_ENVIRONMENTS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`environment.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cmdb-create-tier">{t("create.serviceTier")}</Label>
              <Select onValueChange={setServiceTier} value={serviceTier}>
                <SelectTrigger id="cmdb-create-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CMDB_TIERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`tier.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cmdb-create-site">{t("create.site")}</Label>
              <Select onValueChange={setSiteId} value={siteId}>
                <SelectTrigger id="cmdb-create-site">
                  <SelectValue placeholder={t("create.siteAny")} />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((site) => (
                    <SelectItem key={site.code} value={site.code}>
                      {site.name} ({site.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cmdb-create-device">{t("create.device")}</Label>
              <Select onValueChange={setDeviceId} value={deviceId}>
                <SelectTrigger id="cmdb-create-device">
                  <SelectValue placeholder={t("create.deviceNone")} />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {(devices.data?.data ?? []).map((device) => (
                    <SelectItem key={device.id} value={device.id}>
                      {device.hostname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cmdb-create-description">{t("create.description")}</Label>
            <Textarea
              id="cmdb-create-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("create.descriptionPlaceholder")}
              rows={2}
              value={description}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("create.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {createItem.isPending ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            ) : (
              <GitBranchPlus aria-hidden="true" />
            )}
            {createItem.isPending ? t("create.submitting") : t("create.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Edit-CI dialog (status / criticality / description)                 */
/* ------------------------------------------------------------------ */

function EditCiDialog({
  item,
  open,
  onOpenChange,
}: {
  item: {
    id: string;
    ciId: string;
    status: string;
    criticality: string;
    description: string | null;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("cmdb");
  const { toast } = useToast();
  const updateItem = useUpdateCmdbItem();

  const [status, setStatus] = useState<string>(item.status);
  const [criticality, setCriticality] = useState<string>(item.criticality);
  const [description, setDescription] = useState<string>(item.description ?? "");

  // The parent keys this dialog on `${id}-${updatedAt}` so a saved edit (or a
  // different CI) remounts the draft from fresh props — no effect re-sync.

  const submit = async () => {
    try {
      await updateItem.mutateAsync({
        id: item.id,
        status: status as never,
        criticality: criticality as never,
        description: description.trim() || null,
      });
      toast({
        title: t("toast.updatedTitle", { ci: item.ciId }),
      });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t("toast.failedTitle"),
        description: error instanceof Error ? error.message : t("errorTitle"),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("edit.title", { ci: item.ciId })}</DialogTitle>
          <DialogDescription>{t("edit.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cmdb-edit-status">{t("edit.status")}</Label>
              <Select onValueChange={setStatus} value={status}>
                <SelectTrigger id="cmdb-edit-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CMDB_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`status.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cmdb-edit-criticality">{t("edit.criticality")}</Label>
              <Select onValueChange={setCriticality} value={criticality}>
                <SelectTrigger id="cmdb-edit-criticality">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CMDB_CRITICALITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`criticality.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cmdb-edit-description">{t("edit.description")}</Label>
            <Textarea
              id="cmdb-edit-description"
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("edit.descriptionPlaceholder")}
              rows={3}
              value={description}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("edit.cancel")}
          </Button>
          <Button disabled={updateItem.isPending} onClick={() => void submit()}>
            {updateItem.isPending ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            ) : (
              <ShieldCheck aria-hidden="true" />
            )}
            {updateItem.isPending ? t("edit.submitting") : t("edit.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
