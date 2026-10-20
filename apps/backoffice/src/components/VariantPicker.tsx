import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { ApiError, type DataEnvelope, type ListEnvelope, type VariantLookup } from '@rhoyards/shared';
import { cn, Input } from '@rhoyards/ui';
import { api, qs } from '../lib/api';
import { formatMoney, formatQty } from '../lib/format';
import { errorBeep, useGlobalScanner, useScanTiming } from '../lib/scanner';
import { useDebouncedValue } from '../lib/use-debounced-value';

interface VariantPickerProps {
  onSelect: (variant: VariantLookup) => void;
  /** When given, results show stock on hand at this location. */
  locationId?: string | undefined;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  /** Also take scans made while no text box has the focus (till and stock screens). */
  captureScans?: boolean;
}

/**
 * Accessible combobox for choosing a product variant. Typing searches by name/SKU; Enter on an exact barcode or
 * SKU selects it directly. Built for hand-held scanners: the box clears as soon as a code arrives and codes are
 * looked up in order, so rapid scans are never lost; a Tab suffix works too; a code that matches nothing beeps.
 */
export function VariantPicker({
  onSelect,
  locationId,
  placeholder = 'Search or scan a product',
  label = 'Add product',
  autoFocus,
  captureScans = false,
}: VariantPickerProps) {
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const q = useDebouncedValue(text.trim(), 250);
  const inputRef = useRef<HTMLInputElement>(null);
  const timing = useScanTiming();
  /** Lookups run one after another, in the order the codes were scanned. */
  const queue = useRef<Promise<void>>(Promise.resolve());

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

  const lookUp = useCallback(
    (code: string, fallback?: VariantLookup) => {
      queue.current = queue.current.then(async () => {
        try {
          const res = await api.get<DataEnvelope<VariantLookup>>(`/variants/by-code/${encodeURIComponent(code)}${qs({ locationId })}`);
          setError(null);
          onSelect(res.data);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404 && fallback) {
            onSelect(fallback);
            return;
          }
          setError(err instanceof ApiError && err.status === 404 ? `No product has the code “${code}”` : err instanceof Error ? err.message : 'Lookup failed');
          errorBeep();
        }
      });
    },
    [locationId, onSelect],
  );

  useGlobalScanner((code) => {
    inputRef.current?.focus();
    lookUp(code);
  }, captureScans);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    timing.track(e);
    if (timing.endsScan(e)) {
      const code = e.currentTarget.value.trim();
      // Enter never submits the surrounding form; an empty Tab still moves focus as usual.
      if (e.key === 'Enter') e.preventDefault();
      if (!code) return;
      e.preventDefault();
      // A name typed and chosen from the list.
      if (e.key === 'Enter' && open && options[active] && q === code) {
        choose(options[active]!);
        return;
      }
      // Clear now, before the lookup answers: the next scan may already be arriving.
      setText('');
      setOpen(false);
      setActive(0);
      lookUp(code, e.key === 'Enter' ? options[active] : undefined);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <label htmlFor={`${listId}-input`} className="sr-only">
        {label}
      </label>
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <Input
        ref={inputRef}
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
        onKeyDown={onKeyDown}
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
