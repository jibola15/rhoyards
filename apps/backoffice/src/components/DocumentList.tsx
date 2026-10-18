import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import type { ListEnvelope, Permission } from '@rhoyards/shared';
import { buttonVariants, Card, CardContent, Input, Select, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@rhoyards/ui';
import { useAuth } from '../auth/AuthProvider';
import { api, qs } from '../lib/api';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { EmptyState, PageHeader, Pagination, QueryError } from './page';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

interface DocumentListProps<T> {
  title: string;
  description: string;
  /** First query-key segment; invalidating it refreshes the list. */
  queryKey: string;
  path: string;
  statuses?: { value: string; label: string }[];
  columns: Column<T>[];
  newLink?: { to: string; label: string; permission: Permission };
  searchPlaceholder?: string;
  /** Extra fixed query parameters (e.g. supplierId). */
  params?: Record<string, string | undefined>;
  extraFilters?: ReactNode;
}

const PAGE_SIZE = 25;

/** Searchable, filterable, server-paginated list used by the document screens. */
export function DocumentList<T extends { id: string }>({
  title,
  description,
  queryKey,
  path,
  statuses,
  columns,
  newLink,
  searchPlaceholder = 'Search by number or supplier',
  params = {},
  extraFilters,
}: DocumentListProps<T>) {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(search.trim());
  const query = { q, status: status || undefined, page, pageSize: PAGE_SIZE, ...params };
  const list = useQuery({
    queryKey: [queryKey, 'list', query],
    queryFn: ({ signal }) => api.get<ListEnvelope<T>>(`${path}${qs(query)}`, { signal }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={description}
        actions={
          newLink &&
          can(newLink.permission) && (
            <Link to={newLink.to} className={buttonVariants()}>
              <Plus />
              {newLink.label}
            </Link>
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
                aria-label="Search"
                placeholder={searchPlaceholder}
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            {statuses && (
              <Select aria-label="Status" className="sm:w-52" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
                <option value="">All statuses</option>
                {statuses.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            )}
            {extraFilters}
          </div>
          {list.isError ? (
            <QueryError error={list.error} onRetry={() => void list.refetch()} />
          ) : (
            <>
              <Table aria-busy={list.isFetching}>
                <TableHeader>
                  <TableRow>
                    {columns.map((c) => (
                      <TableHead key={c.header} className={c.className}>
                        {c.header}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.isPending && (
                    <TableRow>
                      <TableCell colSpan={columns.length}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  )}
                  {list.data?.data.map((row) => (
                    <TableRow key={row.id}>
                      {columns.map((c) => (
                        <TableCell key={c.header} className={c.className}>
                          {c.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {list.data?.data.length === 0 && <EmptyState title={q || status ? 'Nothing matches these filters' : 'Nothing here yet'} />}
              {list.data && list.data.meta.total > 0 && <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.meta.total} onPageChange={setPage} />}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
