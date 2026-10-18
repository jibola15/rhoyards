import { useId, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { ApiError, type DataEnvelope, type ListEnvelope, type VariantLookup } from '@rhoyards/shared';
import { cn, Input } from '@rhoyards/ui';
import { api, qs } from '../lib/api';
import { formatMoney, formatQty } from '../lib/format';
import { useDebouncedValue } from '../lib/use-debounced-value';

interface VariantPickerProps {
  onSelect: (variant: VariantLookup) => void;
  /** When given, results show stock on hand at this location. */
  locationId?: string | undefined;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
}

/**
 * Accessible combobox for choosing a product variant. Typing searches by name/SKU; pressing Enter on
 * an exact barcode or SKU (what a scanner sends) selects it directly.
 */
export function VariantPicker({ onSelect, locationId, placeholder = 'Search or scan a product', label = 'Add product', autoFocus }: VariantPickerProps) {
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const q = useDebouncedValue(text.trim(), 250);

  const results = useQuery({
    queryKey: ['variants', 'picker', q, locationId],
    queryFn: ({ signal }) =>
      api.get<ListEnvelope<VariantLookup>>(`/variants${qs({ q, locationId, pageSize: 10 })}`, { signal }).then((r) => r.data),
    enabled: q.length >= 2,
  });
  const options = q.length >= 2 ? (results.data ?? []) : [];

  const choose = (v: VariantLookup) => {
    onSelect(v);
    setText('');
    setOpen(false);
    setActive(0);
    setError(null);
  };

  const onKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const code = text.trim();
      if (!code) return;
      if (open && options[active] && q === code) {
        choose(options[active]!);
        return;
      }
      try {
        const res = await api.get<DataEnvelope<VariantLookup>>(`/variants/by-code/${encodeURIComponent(code)}${qs({ locationId })}`);
        choose(res.data);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && options[active]) choose(options[active]!);
        else setError(err instanceof Error ? err.message : 'Lookup failed');
      }
    }
  };

  return (
    <div className="relative">
      <label htmlFor={`${listId}-input`} className="sr-only">
        {label}
      </label>
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <Input
        id={`${listId}-input`}
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        className="pl-8"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          setError(null);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => void onKeyDown(e)}
      />
      {error && (
        <p role="alert" className="mt-1 text-xs font-medium text-destructive">
          {error}
        </p>
      )}
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {options.map((v, i) => (
            <li
              key={v.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(v);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-sm', i === active && 'bg-accent')}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {v.productName} — {v.name}
                </span>
                <span className="block font-mono text-xs text-muted-foreground">{v.sku}</span>
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
                {formatMoney(v.sellingPrice)}
                {v.qtyOnHand !== null && <span className="block">{formatQty(v.qtyOnHand)} in stock</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && q.length >= 2 && results.isSuccess && options.length === 0 && (
        <p className="absolute z-30 mt-1 w-full rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">No products match “{q}”.</p>
      )}
    </div>
  );
}
