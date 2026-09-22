"use client";

import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { formatDistanceToNow, parseISO } from "date-fns";
import { useTranslations } from "next-intl";
import {
  BadgeCheck,
  KeyRound,
  LoaderCircle,
  Search,
  ShieldCheck,
  UserCog,
  UserPlus,
  Users,
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import {
  useAdminRoles,
  useAdminUsers,
  useCreateUser,
  useResetUserPassword,
  useUpdateUser,
} from "@/hooks/api/use-admin-users";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { USER_ROLES, type UserRole } from "@/lib/auth/roles";
import type { AdminRoleRow, AdminUserRow } from "@/lib/api-client";
import { useCanWrite, useCurrentUserId } from "@/stores/permissions";

/**
 * Administration → Users & Roles (Task 7-a).
 *
 * Account inventory with inline role + activation management, user
 * creation and admin-only password reset. The permission store's
 * `canWrite` (hydrated from /api/v1/auth/session) hides/disables every
 * mutation affordance for read-only roles — the API 403s are the backstop.
 */

const ROLE_TONE: Record<string, string> = {
  admin: "bg-primary/10 text-primary-ink",
  operator: "bg-success/10 text-success",
  engineer: "bg-info/10 text-info",
  manager: "bg-warning/10 text-warning",
  auditor: "bg-danger-orange/10 text-danger-orange",
  viewer: "bg-muted text-muted-foreground",
};

type TranslateFn = (key: string, values?: Record<string, string | number>) => string;

function roleLabel(role: string, t: TranslateFn): string {
  return t(`roles.${role}`);
}

const createUserSchema = (t: TranslateFn) => z.object({
  name: z.string().trim().min(1, t("validation.nameRequired")).max(80),
  email: z.string().trim().email(t("validation.emailInvalid")).max(160),
  role: z.enum(USER_ROLES),
  password: z.string().min(8, t("validation.passwordMin")).max(128),
  isActive: z.boolean(),
});

type CreateUserForm = z.infer<ReturnType<typeof createUserSchema>>;

export function AdminUsersView() {
  const t = useTranslations("adminUsers");
  const canWrite = useCanWrite();
  const currentUserId = useCurrentUserId();

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUserRow | null>(null);

  const usersQuery = useAdminUsers({
    q: search.trim() ? search.trim() : undefined,
    pageSize: 100,
  });
  const rolesQuery = useAdminRoles();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const resetPassword = useResetUserPassword();

  const users = usersQuery.data?.data ?? [];
  const counts = usersQuery.data?.meta?.counts;
  const roles = rolesQuery.data ?? [];
  const roleCount = roles.length;

  const visibleUsers = useMemo(() => {
    if (roleFilter === "all") return users;
    return users.filter((user) => user.role === roleFilter);
  }, [users, roleFilter]);

  const disabledCount = (counts?.total ?? 0) - (counts?.active ?? 0);
  const roleBreakdown = counts
    ? Object.entries(counts.byRole)
        .map(([role, count]) => t("accounts.roleCount", { role: roleLabel(role, t), count }))
        .join(", ")
    : "";

  return (
    <div className="flex flex-col gap-4">
      <div data-tour="admin-users-header">
        <PageHeader
          breadcrumbs={[{ label: t("page.breadcrumbAdministration") }, { label: t("page.breadcrumbUsersRoles") }]}
          description={t("page.description")}
          primaryAction={
            canWrite ? (
              <Button onClick={() => setCreateOpen(true)}>
                <UserPlus aria-hidden="true" className="size-4" />
                {t("common.createUser")}
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button disabled>
                      <UserPlus aria-hidden="true" className="size-4" />
                      {t("common.createUser")}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {t("page.readOnlyCreate")}
                </TooltipContent>
              </Tooltip>
            )
          }
          title={t("page.title")}
        />
      </div>

      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          description={t("kpi.totalDescription")}
          icon={Users}
          label={t("kpi.totalLabel")}
          loading={usersQuery.isLoading}
          value={counts?.total ?? "—"}
        />
        <KpiCard
          description={t("kpi.activeDescription", { count: disabledCount })}
          icon={BadgeCheck}
          label={t("kpi.activeLabel")}
          loading={usersQuery.isLoading}
          value={counts?.active ?? "—"}
        />
        <KpiCard
          description={t("kpi.rolesDescription")}
          icon={ShieldCheck}
          label={t("kpi.rolesLabel")}
          loading={rolesQuery.isLoading}
          value={roleCount || "—"}
        />
        <KpiCard
          description={
            counts
              ? Object.entries(counts.byRole)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([role, count]) => t("kpi.roleCount", { role: roleLabel(role, t), count }))
                  .join(" · ")
              : undefined
          }
          icon={UserCog}
          label={t("kpi.byRoleLabel")}
          loading={usersQuery.isLoading}
          value={counts ? Object.keys(counts.byRole).length : "—"}
        />
      </div>

      <SectionCard
        title={t("accounts.title")}
        description={
          counts
            ? t("accounts.description", { total: counts.total, breakdown: roleBreakdown })
            : t("accounts.loading")
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label={t("filters.searchAria")}
                className="w-full ps-8 sm:w-64"
                placeholder={t("filters.searchPlaceholder")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Select
              value={roleFilter}
              onValueChange={setRoleFilter}
            >
              <SelectTrigger aria-label={t("filters.roleAria")} className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("filters.allRoles")}</SelectItem>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.name}>
                    {t("roleCatalog.roleOption", { role: roleLabel(role.name, t), count: role.userCount })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {usersQuery.isError ? (
          <ErrorState
            reason={
              usersQuery.error instanceof Error
                ? usersQuery.error.message
                : t("accounts.errorReason")
            }
            title={t("accounts.errorTitle")}
          />
        ) : visibleUsers.length === 0 && !usersQuery.isLoading ? (
          <EmptyState
            description={t("accounts.emptyDescription")}
            icon={Users}
            title={t("accounts.emptyTitle")}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("accounts.tableAria")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("accounts.columns.user")}</TableHead>
                  <TableHead>{t("accounts.columns.role")}</TableHead>
                  <TableHead>{t("accounts.columns.active")}</TableHead>
                  <TableHead>{t("accounts.columns.created")}</TableHead>
                  <TableHead className="text-end">{t("accounts.columns.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersQuery.isLoading
                  ? Array.from({ length: 5 }).map((_, index) => (
                      <TableRow key={index}>
                        <TableCell colSpan={5}>
                          <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
                        </TableCell>
                      </TableRow>
                    ))
                  : visibleUsers.map((user) => (
                      <UserRow
                        key={user.id}
                        canWrite={canWrite}
                        isSelf={user.id === currentUserId}
                        onResetPassword={() => setResetTarget(user)}
                        onToggleActive={(isActive) =>
                          updateUser.mutate({ id: user.id, data: { isActive } })
                        }
                        onUpdateRole={(role) =>
                          updateUser.mutate({ id: user.id, data: { role } })
                        }
                        roles={roles}
                        user={user}
                      />
                    ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {/* Role catalog */}
      <SectionCard
        title={t("roleCatalog.title")}
        description={t("roleCatalog.description")}
      >
        {rolesQuery.isError ? (
          <ErrorState title={t("roleCatalog.errorTitle")} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rolesQuery.isLoading
              ? Array.from({ length: 3 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-24 animate-pulse rounded-xl bg-muted"
                  />
                ))
              : roles.map((role) => (
                  <div
                    key={role.id}
                    className="flex flex-col gap-2 rounded-xl border bg-background p-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          ROLE_TONE[role.name] ?? "bg-muted text-muted-foreground"
                        )}
                      >
                        {roleLabel(role.name, t)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t("roleCatalog.userCount", { count: role.userCount })}
                      </span>
                    </div>
                    {role.description && (
                      <p className="text-xs text-muted-foreground">
                        {role.description}
                      </p>
                    )}
                    <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
                      {role.permissions.map((permission) => (
                        <span
                          key={permission}
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        >
                          {permission}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
          </div>
        )}
      </SectionCard>

      <CreateUserDialog
        onOpenChange={setCreateOpen}
        open={createOpen}
        roles={roles}
        onSubmit={(values) =>
          createUser.mutate(values, {
            onSuccess: () => setCreateOpen(false),
          })
        }
        pending={createUser.isPending}
      />

      <ResetPasswordDialog
        key={resetTarget?.id ?? "none"}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
        onSubmit={(password) => {
          if (!resetTarget) return;
          resetPassword.mutate(
            { id: resetTarget.id, password },
            { onSuccess: () => setResetTarget(null) }
          );
        }}
        open={resetTarget !== null}
        pending={resetPassword.isPending}
        user={resetTarget}
      />
    </div>
  );
}

/* ─────────────────────────── table row ─────────────────────────── */

interface UserRowProps {
  user: AdminUserRow;
  roles: AdminRoleRow[];
  canWrite: boolean;
  isSelf: boolean;
  onUpdateRole: (role: string) => void;
  onToggleActive: (isActive: boolean) => void;
  onResetPassword: () => void;
}

function UserRow({
  user,
  roles,
  canWrite,
  isSelf,
  onUpdateRole,
  onToggleActive,
  onResetPassword,
}: UserRowProps) {
  const t = useTranslations("adminUsers");
  const roleTone = ROLE_TONE[user.role] ?? "bg-muted text-muted-foreground";
  const createdAt = user.createdAt ? parseISO(user.createdAt) : null;

  const roleControl = canWrite && !isSelf ? (
    <Select
      disabled={false}
      value={user.role}
      onValueChange={onUpdateRole}
    >
      <SelectTrigger
        aria-label={t("row.roleAria", { email: user.email })}
        className="h-8 w-32"
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {USER_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {roleLabel(role, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex cursor-default items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
            roleTone
          )}
        >
          {user.role}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {isSelf
          ? t("row.ownRole")
          : t("row.readonlyRole")}
      </TooltipContent>
    </Tooltip>
  );

  const activeControl = canWrite && !isSelf ? (
    <Switch
      aria-label={user.isActive ? t("row.deactivateAria", { email: user.email }) : t("row.activateAria", { email: user.email })}
      checked={user.isActive}
      onCheckedChange={onToggleActive}
    />
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Switch aria-label={t("row.activeAria", { email: user.email })} checked={user.isActive} disabled />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {isSelf
          ? t("row.ownAccount")
          : t("row.readonlyActivation")}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="flex items-center gap-2 font-medium">
            {user.name ?? user.email}
            {isSelf && (
              <Badge
                className="rounded-full px-1.5 py-0 text-[10px]"
                variant="secondary"
              >
                {t("row.you")}
              </Badge>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{user.email}</span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {roleControl}
          {isSelf && canWrite ? (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                roleTone
              )}
            >
            {roleLabel(user.role, t)}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {activeControl}
          {!user.isActive && (
            <span className="text-xs text-danger">{t("row.disabled")}</span>
          )}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
        {createdAt
          ? formatDistanceToNow(createdAt, { addSuffix: true })
          : "—"}
      </TableCell>
      <TableCell className="text-end">
        {canWrite ? (
          <Button
            onClick={onResetPassword}
            size="sm"
            variant="outline"
          >
            <KeyRound aria-hidden="true" className="size-3.5" />
            {t("common.resetPassword")}
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button disabled size="sm" variant="outline">
                  <KeyRound aria-hidden="true" className="size-3.5" />
                  {t("common.resetPassword")}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("row.readonlyReset")}
            </TooltipContent>
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );
}

/* ───────────────────────── create-user dialog ───────────────────────── */

interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: AdminRoleRow[];
  onSubmit: (values: CreateUserForm) => void;
  pending: boolean;
}

function CreateUserDialog({
  open,
  onOpenChange,
  roles,
  onSubmit,
  pending,
}: CreateUserDialogProps) {
  const t = useTranslations("adminUsers");
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    control,
    formState: { errors },
  } = useForm<CreateUserForm>({
    resolver: zodResolver(createUserSchema(t)),
    defaultValues: {
      name: "",
      email: "",
      role: "viewer",
      password: "",
      isActive: true,
    },
  });

  const role = useWatch({ control, name: "role" });
  const isActive = useWatch({ control, name: "isActive" });

  const availableRoles: UserRole[] = roles
    .map((role) => role.name)
    .filter((name): name is UserRole =>
      (USER_ROLES as readonly string[]).includes(name)
    );

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("common.createUser")}</DialogTitle>
          <DialogDescription>
            {t("create.description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((values) => onSubmit(values))}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-name">{t("create.fullNameLabel")}</Label>
            <Input
              id="create-user-name"
              placeholder={t("create.fullNamePlaceholder")}
              {...register("name")}
            />
            {errors.name && (
              <p className="text-xs text-danger">{errors.name.message}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-email">{t("create.emailLabel")}</Label>
            <Input
              id="create-user-email"
              placeholder={t("create.emailPlaceholder")}
              type="email"
              {...register("email")}
            />
            {errors.email && (
              <p className="text-xs text-danger">{errors.email.message}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label>{t("create.roleLabel")}</Label>
            <Select
              value={role}
              onValueChange={(value) =>
                setValue("role", value as CreateUserForm["role"])
              }
            >
              <SelectTrigger aria-label={t("create.roleAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(availableRoles.length > 0 ? availableRoles : USER_ROLES).map(
                  (roleOption) => (
                    <SelectItem key={roleOption} value={roleOption}>
                      {roleLabel(roleOption, t)}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-password">{t("create.passwordLabel")}</Label>
            <Input
              id="create-user-password"
              placeholder={t("create.passwordPlaceholder")}
              type="text"
              {...register("password")}
            />
            {errors.password && (
              <p className="text-xs text-danger">{errors.password.message}</p>
            )}
          </div>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
            <div>
              <Label htmlFor="create-user-active">{t("create.accountActiveLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("create.accountInactive")}
              </p>
            </div>
            <Switch
              aria-label={t("create.accountActiveAria")}
              checked={isActive}
              id="create-user-active"
              onCheckedChange={(checked) => setValue("isActive", checked)}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button disabled={pending} type="submit">
              {pending && (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              )}
              {t("common.createUser")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────── reset-password dialog ─────────────────────── */

const generatePassword = () =>
  `Faya-${Math.random().toString(36).slice(2, 8)}${Math.floor(
    Math.random() * 90 + 10
  )}!`;

interface ResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: AdminUserRow | null;
  onSubmit: (password: string) => void;
  pending: boolean;
}

function ResetPasswordDialog({
  open,
  onOpenChange,
  user,
  onSubmit,
  pending,
}: ResetPasswordDialogProps) {
  const t = useTranslations("adminUsers");
  // State initializes empty; the parent keys this dialog by the target user,
  // so every open mounts a fresh instance (no clear-on-open effect needed).
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const mismatch = confirm.length > 0 && password !== confirm;
  const valid = password.length >= 8 && !mismatch;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          setPassword("");
          setConfirm("");
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("common.resetPassword")}</DialogTitle>
          <DialogDescription>
            {user
              ? t("reset.descriptionWithUser", { email: user.email })
              : t("reset.descriptionGeneric")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="reset-password-value">{t("reset.newPasswordLabel")}</Label>
              <button
                className="text-xs font-medium text-primary hover:underline"
                type="button"
                onClick={() => {
                  const generated = generatePassword();
                  setPassword(generated);
                  setConfirm(generated);
                }}
              >
                {t("reset.generate")}
              </button>
            </div>
            <Input
              id="reset-password-value"
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("create.passwordPlaceholder")}
              value={password}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reset-password-confirm">{t("reset.confirmPasswordLabel")}</Label>
            <Input
              id="reset-password-confirm"
              onChange={(event) => setConfirm(event.target.value)}
              value={confirm}
            />
            {mismatch && (
              <p className="text-xs text-danger">
                {t("reset.passwordMismatch")}
              </p>
            )}
          </div>
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t("reset.securityHint")}
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={pending || !valid}
            onClick={() => onSubmit(password)}
            type="button"
          >
            {pending && (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            )}
            {t("common.resetPassword")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
