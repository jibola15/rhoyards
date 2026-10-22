import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { ApiError, type DataEnvelope, type ListEnvelope, type VariantLookup } from '@rhoyards/shared';
import { cn, Input } from '@rhoyards/ui';
import { api, qs } from '../lib/api';
import { formatMoney, formatQty } from '../lib/format';
import { errorBeep, useGlobalScanner, useScanTiming } from '../lib/scanner';
import { useDebouncedValue } from '../lib/use-debounced-value';

interface VariantPickerProps {
  /** `qty` is the number of pieces to add: "1" unless the Pieces box (or an "N*" prefix) said otherwise. */
  onSelect: (variant: VariantLookup, qty: string) => void;
  /** When given, results show stock on hand at this location. */
  locationId?: string | undefined;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  /** Also take scans made while no text box has the focus (till and stock screens). */
  captureScans?: boolean;
  /** Show a Pieces box, so one scan can add several of the same item. */
  withQty?: boolean;
}

const QTY = /^\d+(\.\d{1,3})?$/;
/** "12*5012345678900": twelve pieces of the scanned item, typed straight into the search box. */
const QTY_PREFIX = /^(\d+(?:\.\d{1,3})?)\s*\*\s*(\S.*)$/;
const validQty = (q: string) => QTY.test(q) && Number(q) > 0;

/** Bolds the parts of `text` that match a typed word, so the cashier sees why a suggestion came up. */
function Highlight({ text, words }: { text: string; words: string[] }) {
  if (words.length === 0) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i} className="bg-transparent font-semibold text-foreground underline">{part}</mark> : part))}
    </>
  );
}

/**
 * Accessible combobox for choosing a product variant. Typing searches by name/SKU; Enter on an exact barcode or
 * SKU selects it directly. Built for hand-held scanners: the box clears as soon as a code arrives and codes are
 * looked up in order, so rapid scans are never lost; a Tab suffix works too; a code that matches nothing beeps.
 * With `withQty`, a Pieces box sets how many the next scan adds (it goes back to 1 afterwards); typing "12*" before
 * a scan does the same.
 */
export function VariantPicker({
  onSelect,
  locationId,
  placeholder = 'Search or scan a product',
  label = 'Add product',
  autoFocus,
  captureScans = false,
  withQty = false,
}: VariantPickerProps) {
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState('1');
  const q = useDebouncedValue(text.trim(), 150);
  const inputRef = useRef<HTMLInputElement>(null);
  const timing = useScanTiming();
  const qtyTiming = useScanTiming();
  /** Lookups run one after another, in the order the codes were scanned. */
  const queue = useRef<Promise<void>>(Promise.resolve());

  const results = useQuery<VariantLookup[]>({
    queryKey: ['variants', 'picker', q, locationId],
    queryFn: ({ signal }) =>
      api.get<ListEnvelope<VariantLookup>>(`/variants${qs({ q, locationId, pageSize: 10 })}`, { signal }).then((r) => r.data),
    enabled: q.length >= 2,
    // Keep the last suggestions on screen while the next keystroke's results load.
    placeholderData: keepPreviousData,
  });
  const options = text.trim().length >= 2 ? (results.data ?? []) : [];
  const words = q.split(/\s+/).filter(Boolean);

  /** The pieces for this pick, or null (with a message) when the Pieces box does not hold a usable number. */
  const takeQty = (typed?: string): string | null => {
    const n = (typed ?? (withQty ? qty.trim() : '1')) || '1';
    if (!validQty(n)) {
      setError('Enter the number of pieces');
      errorBeep();
      return null;
    }
    setQty('1');
    return n;
  };

  const choose = (v: VariantLookup) => {
    const n = takeQty();
    if (!n) return;
    onSelect(v, n);
    setText('');
    setOpen(false);
    setActive(0);
    setError(null);
  };

  const lookUp = useCallback(
    (code: string, n: string, fallback?: VariantLookup) => {
      queue.current = queue.current.then(async () => {
        try {
          const res = await api.get<DataEnvelope<VariantLookup>>(`/variants/by-code/${encodeURIComponent(code)}${qs({ locationId })}`);
          setError(null);
          onSelect(res.data, n);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404 && fallback) {
            onSelect(fallback, n);
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
    const n = takeQty();
    if (n) lookUp(code, n);
  }, captureScans);

  /** Enter in the Pieces box moves on to the search box; a code scanned into it is taken as a scan. */
  const onQtyKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    qtyTiming.track(e);
    if (!qtyTiming.endsScan(e)) return;
    const burst = qtyTiming.burstLength();
    if (e.key === 'Enter') e.preventDefault();
    if (!burst) {
      if (e.key === 'Enter') inputRef.current?.focus();
      return;
    }
    e.preventDefault();
    const value = e.currentTarget.value;
    const code = value.slice(-burst).trim();
    const n = takeQty(value.slice(0, -burst).trim());
    inputRef.current?.focus();
    if (n && code) lookUp(code, n);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    timing.track(e);
    if (timing.endsScan(e)) {
      const value = e.currentTarget.value.trim();
      // Enter never submits the surrounding form; an empty Tab still moves focus as usual.
      if (e.key === 'Enter') e.preventDefault();
      if (!value) return;
      e.preventDefault();
      const prefixed = withQty ? QTY_PREFIX.exec(value) : null;
      const code = prefixed ? prefixed[2]!.trim() : value;
      // A name typed and chosen from the list.
      if (e.key === 'Enter' && open && options[active] && q === code) {
        choose(options[active]!);
        return;
      }
      const n = takeQty(prefixed?.[1]);
      if (!n) return;
      // Clear now, before the lookup answers: the next scan may already be arriving.
      setText('');
      setOpen(false);
      setActive(0);
      lookUp(code, n, e.key === 'Enter' && !prefixed ? options[active] : undefined);
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
    <div className="flex items-start gap-2">
      {withQty && (
        <div className="w-20 shrink-0">
          <label htmlFor={`${listId}-qty`} className="sr-only">
            Pieces
          </label>
          <Input
            id={`${listId}-qty`}
            inputMode="decimal"
            autoComplete="off"
            title="Pieces added by the next scan"
            className="text-right tabular-nums"
            value={qty}
            onChange={(e) => {
              setQty(e.target.value.trim());
              setError(null);
            }}
            onFocus={(e) => e.target.select()}
            onKeyDown={onQtyKeyDown}
          />
          <span className="mt-0.5 block text-center text-[11px] text-muted-foreground" aria-hidden="true">
            pieces
          </span>
        </div>
      )}
    <div className="relative min-w-0 flex-1">
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
                  <Highlight text={`${v.productName} — ${v.name}`} words={words} />
                </span>
                <span className="block font-mono text-xs text-muted-foreground">
                  <Highlight text={v.sku} words={words} />
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
                {formatMoney(v.sellingPrice)}
                {v.qtyOnHand !== null && <span className="block">{formatQty(v.qtyOnHand)} in stock</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && q.length >= 2 && results.isSuccess && !results.isPlaceholderData && options.length === 0 && (
        <p className="absolute z-30 mt-1 w-full rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">No products match “{q}”.</p>
      )}
    </div>
    </div>
  );
}
