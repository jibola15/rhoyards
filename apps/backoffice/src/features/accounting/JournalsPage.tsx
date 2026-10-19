import { useState } from 'react';
import { Link } from 'react-router';
import { JOURNAL_SOURCES, type JournalSummary } from '@rhoyards/shared';
import { Badge, Input, Select } from '@rhoyards/ui';
import { DocumentList } from '../../components/DocumentList';
import { StatusBadge } from '../../components/StatusBadge';
import { formatDate, formatMoney } from '../../lib/format';
import { sourceLabel } from './api';

export function JournalsPage() {
  const [sourceType, setSourceType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  return (
    <DocumentList<JournalSummary>
      title="Journals"
      description="Every entry in the general ledger: manual journals and the entries posted by sales, purchasing and stock."
      queryKey="journals"
      path="/accounting/journals"
      statuses={[
        { value: 'DRAFT', label: 'Draft' },
        { value: 'POSTED', label: 'Posted' },
      ]}
      searchPlaceholder="Search by number or description"
      newLink={{ to: '/accounting/journals/new', label: 'New journal', permission: 'journals.create' }}
      params={{ sourceType: sourceType || undefined, from: from || undefined, to: to || undefined }}
      extraFilters={
        <>
          <Select aria-label="Source" className="sm:w-48" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
            <option value="">All sources</option>
            {Object.entries(JOURNAL_SOURCES).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Input type="date" aria-label="From" className="sm:w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" aria-label="To" className="sm:w-40" value={to} onChange={(e) => setTo(e.target.value)} />
        </>
      }
      columns={[
        { header: 'Date', cell: (j) => formatDate(j.entryDate) },
        {
          header: 'Number',
          cell: (j) => (
            <Link to={`/accounting/journals/${j.id}`} className="font-mono font-medium hover:underline">
              {j.number ?? 'Draft'}
            </Link>
          ),
        },
        {
          header: 'Description',
          cell: (j) => (
            <span>
              {j.description}
              {j.reversedBy && (
                <Badge variant="secondary" className="ml-2">
                  Reversed
                </Badge>
              )}
            </span>
          ),
        },
        { header: 'Source', cell: (j) => sourceLabel(j.sourceType), className: 'hidden md:table-cell' },
        { header: 'Amount', cell: (j) => formatMoney(j.total), className: 'text-right tabular-nums' },
        { header: 'Status', cell: (j) => <StatusBadge status={j.status} /> },
      ]}
    />
  );
}
