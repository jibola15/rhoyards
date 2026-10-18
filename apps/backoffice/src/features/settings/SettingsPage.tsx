import { useEffect, type ReactNode } from 'react';
import { useForm, type DefaultValues, type FieldValues, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { settingsSchema, type DataEnvelope, type Settings, type SettingsKey } from '@rhoyards/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Skeleton,
  Textarea,
  toast,
} from '@rhoyards/ui';
import { useAuth } from '../../auth/AuthProvider';
import { PageHeader, QueryError } from '../../components/page';
import { api } from '../../lib/api';
import { LocationsCard } from './LocationsCard';
import { TaxRatesCard } from './TaxRatesCard';

const SETTINGS_KEY = ['settings'] as const;
type SectionValues<K extends SettingsKey> = Settings[K] & FieldValues;

function useSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: ({ signal }) => api.get<DataEnvelope<Settings>>('/settings', { signal }).then((r) => r.data),
  });
}

/** One card per settings section; each saves independently (PATCH with just that section). */
function SectionForm<K extends SettingsKey>({
  section,
  title,
  description,
  value,
  disabled,
  children,
}: {
  section: K;
  title: string;
  description: string;
  value: Settings[K];
  disabled: boolean;
  children: (form: UseFormReturn<SectionValues<K>, unknown, SectionValues<K>>) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const schema = settingsSchema.shape[section] as unknown as z.ZodType<SectionValues<K>, SectionValues<K>>;
  const form = useForm<SectionValues<K>, unknown, SectionValues<K>>({
    resolver: zodResolver(schema),
    defaultValues: value as DefaultValues<SectionValues<K>>,
  });
  useEffect(() => {
    form.reset(value as SectionValues<K>);
  }, [value, form]);

  const mutation = useMutation({
    mutationFn: (v: Settings[K]) => api.patch<DataEnvelope<Settings>>('/settings', { [section]: v }),
    onSuccess: (res) => {
      queryClient.setQueryData(SETTINGS_KEY, res.data);
      toast.success(`${title} saved`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
          <fieldset disabled={disabled} className="grid gap-4">
            {children(form)}
          </fieldset>
          {!disabled && (
            <div>
              <Button type="submit" disabled={mutation.isPending || !form.formState.isDirty}>
                {mutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const { can } = useAuth();
  const settings = useSettings();
  const readOnly = !can('settings.manage');

  if (settings.isError) return <QueryError error={settings.error} onRetry={() => void settings.refetch()} />;
  if (settings.isPending) return <Skeleton className="h-96 w-full" />;
  const s = settings.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={
          readOnly
            ? 'You can view these settings. Changes require the settings permission.'
            : 'Business configuration used across POS, online store and accounting.'
        }
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <SectionForm
          section="business"
          title="Business details"
          description="Shown on receipts, invoices and the online store."
          value={s.business}
          disabled={readOnly}
        >
          {({ register, formState: { errors } }) => (
            <>
              <Field
                id="business-name"
                label="Business name"
                error={errors.name?.message as string | undefined}
              >
                <Input {...register('name')} />
              </Field>
              <Field
                id="business-address"
                label="Address"
                error={errors.address?.message as string | undefined}
              >
                <Textarea rows={2} {...register('address')} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="business-phone" label="Phone" error={errors.phone?.message as string | undefined}>
                  <Input type="tel" {...register('phone')} />
                </Field>
                <Field id="business-email" label="Email" error={errors.email?.message as string | undefined}>
                  <Input type="email" {...register('email')} />
                </Field>
              </div>
              <Field
                id="business-tin"
                label="Tax identification number (TIN)"
                error={errors.taxId?.message as string | undefined}
              >
                <Input {...register('taxId')} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox {...register('vatRegistered')} />
                Registered for VAT
              </label>
            </>
          )}
        </SectionForm>

        <SectionForm
          section="pricing"
          title="VAT on prices"
          description="Choose how selling prices relate to VAT. Changing this affects new sales only."
          value={s.pricing}
          disabled={readOnly}
        >
          {({ watch, setValue }) => {
            const inclusive = watch('pricesIncludeTax');
            return (
              <fieldset className="grid gap-3">
                <legend className="sr-only">VAT treatment of prices</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="pricesIncludeTax"
                    className="mt-1 accent-primary"
                    checked={inclusive === true}
                    onChange={() => setValue('pricesIncludeTax', true as never, { shouldDirty: true })}
                  />
                  <span>
                    <span className="font-medium">Prices include VAT</span>
                    <span className="block text-muted-foreground">
                      The shelf price is what the customer pays; VAT is calculated out of it.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="pricesIncludeTax"
                    className="mt-1 accent-primary"
                    checked={inclusive === false}
                    onChange={() => setValue('pricesIncludeTax', false as never, { shouldDirty: true })}
                  />
                  <span>
                    <span className="font-medium">Prices exclude VAT</span>
                    <span className="block text-muted-foreground">
                      VAT is added on top of the price at checkout.
                    </span>
                  </span>
                </label>
              </fieldset>
            );
          }}
        </SectionForm>

        <TaxRatesCard />

        <SectionForm
          section="inventory"
          title="Inventory rules"
          description="Controls applied when stock leaves the business."
          value={s.inventory}
          disabled={readOnly}
        >
          {({ register, formState: { errors } }) => (
            <>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" {...register('blockExpiredSale')} />
                <span>
                  Block the sale of expired batches
                  <span className="block text-muted-foreground">Recommended for cosmetics.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox className="mt-0.5" {...register('allowNegativeStock')} />
                <span>
                  Allow selling below zero stock
                  <span className="block text-muted-foreground">
                    Only users with the “allow negative stock” permission can do so.
                  </span>
                </span>
              </label>
              <Field
                id="expiry-days"
                label="Expiry warning (days)"
                error={errors.expiryWarningDays?.message as string | undefined}
              >
                <Input
                  type="number"
                  min={0}
                  className="w-32"
                  {...register('expiryWarningDays', { valueAsNumber: true })}
                />
              </Field>
            </>
          )}
        </SectionForm>

        <SectionForm
          section="receipt"
          title="Receipt"
          description="Text printed at the top and bottom of POS receipts."
          value={s.receipt}
          disabled={readOnly}
        >
          {({ register }) => (
            <>
              <Field id="receipt-header" label="Header">
                <Textarea rows={2} {...register('header')} />
              </Field>
              <Field id="receipt-footer" label="Footer">
                <Textarea rows={2} {...register('footer')} />
              </Field>
            </>
          )}
        </SectionForm>

        <SectionForm
          section="fiscal"
          title="Fiscal year"
          description="Month in which the financial year starts."
          value={s.fiscal}
          disabled={readOnly}
        >
          {({ register, formState: { errors } }) => (
            <Field
              id="fy-start"
              label="Start month (1–12)"
              error={errors.yearStartMonth?.message as string | undefined}
            >
              <Input
                type="number"
                min={1}
                max={12}
                className="w-32"
                {...register('yearStartMonth', { valueAsNumber: true })}
              />
            </Field>
          )}
        </SectionForm>

        <LocationsCard />
      </div>
    </div>
  );
}
