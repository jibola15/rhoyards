import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import type { DataEnvelope, ExpenseCategoryRow } from '@rhoyards/shared';
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { api } from '../../lib/api';
import { useAccountOptions } from '../purchasing/api';

function CategoryForm({ category, onDone }: { category?: ExpenseCategoryRow | undefined; onDone: () => void }) {
  const queryClient = useQueryClient();
  const accounts = useAccountOptions('expense');
  const [v, setV] = useState({ name: category?.name ?? '', accountId: category?.account.id ?? '', isActive: category?.isActive ?? true });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => (category ? api.put(`/expense-categories/${category.id}`, v) : api.post('/expense-categories', v)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['expense-categories'] });
      toast.success(category ? 'Category saved' : 'Category added');
      onDone();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <div className="grid gap-4">
      {error && <Alert variant="destructive">{error}</Alert>}
      <Field id="ec-name" label="Name">
        <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      </Field>
      <Field id="ec-account" label="Charged to account">
        <Select value={v.accountId} onChange={(e) => setV({ ...v, accountId: e.target.value })}>
          <option value="">Choose…</option>
          {accounts.data
            ?.filter((a) => a.type === 'EXPENSE')
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} /> In use
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={save.isPending || v.name.trim().length < 2 || !v.accountId} onClick={() => (setError(null), save.mutate())}>
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}

export function ExpenseCategoriesCard() {
  const { can } = useAuth();
  const canManage = can('settings.manage');
  const [dialog, setDialog] = useState<{ open: boolean; category?: ExpenseCategoryRow }>({ open: false });
  const categories = useQuery({
    queryKey: ['expense-categories'],
    queryFn: ({ signal }) => api.get<DataEnvelope<ExpenseCategoryRow[]>>('/expense-categories', { signal }).then((r) => r.data),
    enabled: can('expenses.view') || can('expenses.create') || can('expenses.approve'),
  });
  if (!categories.data && !categories.isPending) return null;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Expense categories</CardTitle>
          <CardDescription>What staff choose when recording an expense, and the account each one is charged to.</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setDialog({ open: true })}>
            <Plus />
            Add
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {categories.data?.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2">
              <span>
                {c.name}{' '}
                {!c.isActive && <Badge variant="secondary">Off</Badge>}
                <span className="block text-xs text-muted-foreground">
                  {c.account.code} {c.account.name}
                </span>
              </span>
              {canManage && (
                <Button variant="ghost" size="icon" aria-label={`Edit ${c.name}`} onClick={() => setDialog({ open: true, category: c })}>
                  <Pencil />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog.category ? `Edit ${dialog.category.name}` : 'New expense category'}</DialogTitle>
          </DialogHeader>
          {dialog.open && <CategoryForm key={dialog.category?.id ?? 'new'} category={dialog.category} onDone={() => setDialog({ open: false })} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
