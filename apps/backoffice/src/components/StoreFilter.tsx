import { Field, Select } from '@rhoyards/ui';
import { useMyStores } from '../lib/stores';

/**
 * "Which store?" for reports and the dashboard. Hidden while the business has a single store. `anyStore` lists every
 * store (stock may be looked up anywhere); otherwise only the person's own.
 */
export function StoreFilter({ value, onChange, anyStore = false, className = 'w-52' }: { value: string; onChange: (id: string) => void; anyStore?: boolean; className?: string }) {
  const { all, mine, scoped } = useMyStores();
  const options = anyStore ? all : mine;
  if (all.length < 2) return null;
  return (
    <Field id="store-filter" label="Store" className={className}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{scoped ? 'All my stores' : 'All stores'}</option>
        {options.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
