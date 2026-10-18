import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { roleInputSchema, type DataEnvelope, type RoleSummary } from '@rhoyards/shared';
import type { z } from 'zod';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Skeleton,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader, QueryError } from '../../components/page';
import { api } from '../../lib/api';
import { applyServerErrors } from '../../lib/forms';
import { useRoles } from '../users/api';

interface PermissionInfo {
  code: string;
  module: string;
  description: string;
}

const MODULE_LABELS: Record<string, string> = {
  users: 'Users', roles: 'Roles', settings: 'Settings', taxes: 'Tax', locations: 'Locations', audit: 'Audit',
  catalog: 'Catalogue', inventory: 'Inventory', stock: 'Inventory', suppliers: 'Suppliers', purchasing: 'Purchasing',
  supplier_payments: 'Purchasing', customers: 'Customers', pos: 'Point of sale', returns: 'Returns & refunds',
  refunds: 'Returns & refunds', orders: 'Online orders', payments: 'Online orders', expenses: 'Expenses',
  accounting: 'Accounting', accounts: 'Accounting', journals: 'Accounting', periods: 'Accounting',
  reconciliation: 'Accounting', dashboard: 'Reports', reports: 'Reports',
};

function usePermissions() {
  return useQuery({
    queryKey: ['permissions'],
    queryFn: ({ signal }) => api.get<DataEnvelope<PermissionInfo[]>>('/permissions', { signal }).then((r) => r.data),
    staleTime: Infinity,
  });
}

type NewRoleValues = z.input<typeof roleInputSchema>;

function NewRoleForm({ onCreated, onDone }: { onCreated: (id: string) => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<NewRoleValues>({
    resolver: zodResolver(roleInputSchema),
    defaultValues: { code: '', name: '', description: '', permissions: [] },
  });
  const mutation = useMutation({
    mutationFn: (v: NewRoleValues) => api.post<DataEnvelope<RoleSummary>>('/roles', v),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      toast.success('Role created. Now choose its permissions.');
      onCreated(res.data.id);
      onDone();
    },
    onError: (e) => setFormError(applyServerErrors(e, setError, ['code', 'name', 'description'])),
  });
  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="role-name" label="Name" error={formState.errors.name?.message}>
        <Input {...register('name')} />
      </Field>
      <Field id="role-code" label="Code" description="e.g. SENIOR_CASHIER — cannot be changed later." error={formState.errors.code?.message}>
        <Input {...register('code')} />
      </Field>
      <Field id="role-description" label="Description" error={formState.errors.description?.message}>
        <Input {...register('description')} />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          Create role
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Keyed by role + saved permissions, so its draft starts fresh whenever the saved state changes. */
function RoleEditor({ role, groups, canManage, onDeleted }: {
  role: RoleSummary;
  groups: [string, PermissionInfo[]][];
  canManage: boolean;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Set<string>>(() => new Set(role.permissions));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const readOnly = !canManage || role.code === 'OWNER';
  const dirty = role.permissions.length !== draft.size || role.permissions.some((p) => !draft.has(p));

  const save = useMutation({
    mutationFn: () => api.patch(`/roles/${role.id}`, { permissions: [...draft] }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      toast.success(`Permissions for ${role.name} saved. They apply on each user's next request.`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            {role.name}
            {role.isSystem && <Badge variant="secondary">System</Badge>}
          </CardTitle>
          <CardDescription>{role.code === 'OWNER' ? 'The Owner role always has every permission.' : (role.description ?? '')}</CardDescription>
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            {!role.isSystem && (
              <Button
                variant="outline"
                onClick={() => setConfirmDelete(true)}
                disabled={role.userCount > 0}
                title={role.userCount > 0 ? 'Remove this role from all users first' : undefined}
              >
                <Trash2 />
                Delete
              </Button>
            )}
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save permissions'}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        {groups.map(([label, perms]) => (
          <fieldset key={label} className="space-y-2">
            <legend className="text-sm font-semibold">{label}</legend>
            {perms.map((p) => (
              <label key={p.code} className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  disabled={readOnly}
                  checked={draft.has(p.code)}
                  onChange={(e) => {
                    const next = new Set(draft);
                    if (e.target.checked) next.add(p.code);
                    else next.delete(p.code);
                    setDraft(next);
                  }}
                />
                <span>
                  {p.description}
                  <span className="block font-mono text-xs text-muted-foreground">{p.code}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </CardContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${role.name}?`}
        description="This custom role will be removed. This cannot be undone."
        confirmLabel="Delete role"
        destructive
        onConfirm={async () => {
          try {
            await api.delete(`/roles/${role.id}`);
            onDeleted();
            await queryClient.invalidateQueries({ queryKey: ['roles'] });
            toast.success('Role deleted');
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not delete role');
          }
        }}
      />
    </Card>
  );
}

export function RolesPage() {
  const { can } = useAuth();
  const canManage = can('roles.manage');
  const roles = useRoles();
  const permissions = usePermissions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selected = roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[0];

  const groups = useMemo(() => {
    const map = new Map<string, PermissionInfo[]>();
    for (const p of permissions.data ?? []) {
      const label = MODULE_LABELS[p.module] ?? p.module;
      map.set(label, [...(map.get(label) ?? []), p]);
    }
    return [...map.entries()];
  }, [permissions.data]);

  if (roles.isError) return <QueryError error={roles.error} onRetry={() => void roles.refetch()} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles & permissions"
        description="Permissions are enforced by the server for every request."
        actions={
          canManage && (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              New role
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card>
          <CardContent className="p-2">
            {roles.isPending && <Skeleton className="m-2 h-40" />}
            <ul aria-label="Roles" className="space-y-0.5">
              {roles.data?.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-current={selected?.id === r.id}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-accent',
                      selected?.id === r.id && 'bg-accent font-medium',
                    )}
                  >
                    <span>{r.name}</span>
                    <span className="text-xs text-muted-foreground">{r.userCount} users</span>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {selected && (
          <RoleEditor
            key={`${selected.id}:${selected.permissions.join(',')}`}
            role={selected}
            groups={groups}
            canManage={canManage}
            onDeleted={() => setSelectedId(null)}
          />
        )}
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New role</DialogTitle>
          </DialogHeader>
          <NewRoleForm onCreated={setSelectedId} onDone={() => setCreating(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
