"use client";

import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { formatDistanceToNow, parseISO } from "date-fns";
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
import { ROLE_LABELS, USER_ROLES, type UserRole } from "@/lib/auth/roles";
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

const createUserSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().email("Enter a valid email address").max(160),
  role: z.enum(USER_ROLES),
  password: z.string().min(8, "At least 8 characters").max(128),
  isActive: z.boolean(),
});

type CreateUserForm = z.infer<typeof createUserSchema>;

export function AdminUsersView() {
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

  return (
    <div className="flex flex-col gap-4">
      <div data-tour="admin-users-header">
        <PageHeader
          breadcrumbs={[{ label: "Administration" }, { label: "Users & Roles" }]}
          description="Accounts, roles and permissions — auditors and disabled accounts are blocked from every write at the API layer"
          primaryAction={
            canWrite ? (
              <Button onClick={() => setCreateOpen(true)}>
                <UserPlus aria-hidden="true" className="size-4" />
                Create user
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button disabled>
                      <UserPlus aria-hidden="true" className="size-4" />
                      Create user
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Read-only session — account changes require an administrator
                </TooltipContent>
              </Tooltip>
            )
          }
          title="Users & Roles"
        />
      </div>

      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          description="Accounts with sign-in access"
          icon={Users}
          label="Total users"
          loading={usersQuery.isLoading}
          value={counts?.total ?? "—"}
        />
        <KpiCard
          description={`${disabledCount} disabled`}
          icon={BadgeCheck}
          label="Active"
          loading={usersQuery.isLoading}
          value={counts?.active ?? "—"}
        />
        <KpiCard
          description="Permission templates"
          icon={ShieldCheck}
          label="Roles"
          loading={rolesQuery.isLoading}
          value={roleCount || "—"}
        />
        <KpiCard
          description={
            counts
              ? Object.entries(counts.byRole)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 3)
                  .map(([role, count]) => `${role} ${count}`)
                  .join(" · ")
              : undefined
          }
          icon={UserCog}
          label="By role"
          loading={usersQuery.isLoading}
          value={counts ? Object.keys(counts.byRole).length : "—"}
        />
      </div>

      <SectionCard
        title="Accounts"
        description={
          counts
            ? `${counts.total} users · ${Object.entries(counts.byRole)
                .map(([role, count]) => `${count} ${role}`)
                .join(", ")}`
            : "Loading…"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search users"
                className="w-full ps-8 sm:w-64"
                placeholder="Search name or email…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <Select
              value={roleFilter}
              onValueChange={setRoleFilter}
            >
              <SelectTrigger aria-label="Filter by role" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.name}>
                    {role.name} ({role.userCount})
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
                : "The user list could not be loaded."
            }
            title="Could not load users"
          />
        ) : visibleUsers.length === 0 && !usersQuery.isLoading ? (
          <EmptyState
            description="Adjust the search or role filter, or create the first account."
            icon={Users}
            title="No users match"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label="User accounts — email, role, active state and last activity per user">
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-end">Actions</TableHead>
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
        title="Role catalog"
        description="Permission keys served by /api/v1/auth/session and enforced across the platform"
      >
        {rolesQuery.isError ? (
          <ErrorState title="Could not load roles" />
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
                        {role.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {role.userCount} user{role.userCount === 1 ? "" : "s"}
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
  const roleTone = ROLE_TONE[user.role] ?? "bg-muted text-muted-foreground";
  const createdAt = user.createdAt ? parseISO(user.createdAt) : null;

  const roleControl = canWrite && !isSelf ? (
    <Select
      disabled={false}
      value={user.role}
      onValueChange={onUpdateRole}
    >
      <SelectTrigger
        aria-label={`Role for ${user.email}`}
        className="h-8 w-32"
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {USER_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {ROLE_LABELS[role]}
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
          ? "You cannot change your own role"
          : "Read-only session — role changes require an administrator"}
      </TooltipContent>
    </Tooltip>
  );

  const activeControl = canWrite && !isSelf ? (
    <Switch
      aria-label={user.isActive ? `Deactivate ${user.email}` : `Activate ${user.email}`}
      checked={user.isActive}
      onCheckedChange={onToggleActive}
    />
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Switch aria-label={`${user.email} active state`} checked={user.isActive} disabled />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {isSelf
          ? "You cannot deactivate your own account"
          : "Read-only session — activation changes require an administrator"}
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
                You
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
              {user.role}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {activeControl}
          {!user.isActive && (
            <span className="text-xs text-danger">Disabled</span>
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
            Reset password
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button disabled size="sm" variant="outline">
                  <KeyRound aria-hidden="true" className="size-3.5" />
                  Reset password
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Password resets require an administrator
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
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    control,
    formState: { errors },
  } = useForm<CreateUserForm>({
    resolver: zodResolver(createUserSchema),
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
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription>
            The password is hashed with scrypt before it is stored — plaintext
            is never persisted. The action is audited (USER_CREATED).
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((values) => onSubmit(values))}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-name">Full name</Label>
            <Input
              id="create-user-name"
              placeholder="e.g. Layla Al-Mutairi"
              {...register("name")}
            />
            {errors.name && (
              <p className="text-xs text-danger">{errors.name.message}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-email">Email</Label>
            <Input
              id="create-user-email"
              placeholder="name@faya.local"
              type="email"
              {...register("email")}
            />
            {errors.email && (
              <p className="text-xs text-danger">{errors.email.message}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label>Role</Label>
            <Select
              value={role}
              onValueChange={(value) =>
                setValue("role", value as CreateUserForm["role"])
              }
            >
              <SelectTrigger aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(availableRoles.length > 0 ? availableRoles : USER_ROLES).map(
                  (roleOption) => (
                    <SelectItem key={roleOption} value={roleOption}>
                      {ROLE_LABELS[roleOption]}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="create-user-password">Initial password</Label>
            <Input
              id="create-user-password"
              placeholder="At least 8 characters"
              type="text"
              {...register("password")}
            />
            {errors.password && (
              <p className="text-xs text-danger">{errors.password.message}</p>
            )}
          </div>
          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
            <div>
              <Label htmlFor="create-user-active">Account active</Label>
              <p className="text-xs text-muted-foreground">
                Inactive accounts cannot sign in.
              </p>
            </div>
            <Switch
              aria-label="Account active"
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
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {pending && (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              )}
              Create user
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
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            {user
              ? `Set a new password for ${user.email}. The current password stops working immediately. Audited as USER_PASSWORD_RESET.`
              : "Set a new password. Audited as USER_PASSWORD_RESET."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="reset-password-value">New password</Label>
              <button
                className="text-xs font-medium text-primary hover:underline"
                type="button"
                onClick={() => {
                  const generated = generatePassword();
                  setPassword(generated);
                  setConfirm(generated);
                }}
              >
                Generate
              </button>
            </div>
            <Input
              id="reset-password-value"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 8 characters"
              value={password}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="reset-password-confirm">Confirm password</Label>
            <Input
              id="reset-password-confirm"
              onChange={(event) => setConfirm(event.target.value)}
              value={confirm}
            />
            {mismatch && (
              <p className="text-xs text-danger">
                Passwords do not match.
              </p>
            )}
          </div>
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Share the new password over a secure channel — it is shown only
            here and stored as a scrypt hash.
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={pending || !valid}
            onClick={() => onSubmit(password)}
            type="button"
          >
            {pending && (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            )}
            Reset password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
