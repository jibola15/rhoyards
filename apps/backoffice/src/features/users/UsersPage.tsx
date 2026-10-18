import { useState } from 'react';
import { KeyRound, Pencil, Plus, Search } from 'lucide-react';
import type { UserSummary } from '@rhoyards/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState, PageHeader, Pagination, QueryError } from '../../components/page';
import { formatDateTime } from '../../lib/format';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useUsers } from './api';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import { UserFormDialog } from './UserFormDialog';

const PAGE_SIZE = 20;

export function UsersPage() {
  const { can } = useAuth();
  const canManage = can('users.manage');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'DISABLED'>('');
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search.trim());
  const users = useUsers({ q, status, page, pageSize: PAGE_SIZE });

  const [editing, setEditing] = useState<UserSummary | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [resetting, setResetting] = useState<UserSummary | null>(null);

  const openCreate = () => {
    setEditing(undefined);
    setFormOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Staff users"
        description="Who can sign in to the back office and POS, and what they can do."
        actions={
          canManage && (
            <Button onClick={openCreate}>
              <Plus />
              New user
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input
                type="search"
                aria-label="Search by name or email"
                placeholder="Search by name or email"
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Select
              aria-label="Filter by status"
              className="sm:w-44"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="DISABLED">Disabled</option>
            </Select>
          </div>

          {users.isError ? (
            <QueryError error={users.error} onRetry={() => void users.refetch()} />
          ) : (
            <>
              <Table aria-busy={users.isFetching}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Roles</TableHead>
                    <TableHead className="hidden md:table-cell">Locations</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Last sign-in</TableHead>
                    {canManage && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.isPending &&
                    Array.from({ length: 4 }, (_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={canManage ? 6 : 5}>
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    ))}
                  {users.data?.data.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="font-medium">{u.fullName}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map((r) => (
                            <Badge key={r.id} variant="secondary">
                              {r.name}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {u.locations.map((l) => l.name).join(', ') || '—'}
                      </TableCell>
                      <TableCell>
                        {u.status === 'ACTIVE' ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Disabled</Badge>}
                        {u.mustChangePassword && u.status === 'ACTIVE' && (
                          <span className="ml-1 text-xs text-muted-foreground">password change pending</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">{formatDateTime(u.lastLoginAt)}</TableCell>
                      {canManage && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Edit ${u.fullName}`}
                              onClick={() => {
                                setEditing(u);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil />
                            </Button>
                            <Button variant="ghost" size="icon" aria-label={`Reset password for ${u.fullName}`} onClick={() => setResetting(u)}>
                              <KeyRound />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {users.data && users.data.data.length === 0 && (
                <EmptyState title={q || status ? 'No users match your filters' : 'No users yet'}>
                  {q || status ? 'Try a different search or status.' : canManage && 'Create the first staff account.'}
                </EmptyState>
              )}
              {users.data && users.data.meta.total > 0 && (
                <Pagination page={page} pageSize={PAGE_SIZE} total={users.data.meta.total} onPageChange={setPage} />
              )}
            </>
          )}
        </CardContent>
      </Card>

      <UserFormDialog open={formOpen} onOpenChange={setFormOpen} {...(editing ? { user: editing } : {})} />
      <ResetPasswordDialog user={resetting} onOpenChange={(o) => !o && setResetting(null)} />
    </div>
  );
}
