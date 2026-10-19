import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { createUserSchema, usernameSchema, type UserSummary } from '@rhoyards/shared';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  toast,
} from '@rhoyards/ui';
import { api } from '../../lib/api';
import { applyServerErrors } from '../../lib/forms';
import { useLocations, useRoles, usersKeys } from './api';

/** Blank means no username (sign in with the email only). */
const optionalUsername = z.union([z.literal(''), usernameSchema]);

const createSchema = createUserSchema.extend({ username: optionalUsername });

const editSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(120),
  username: optionalUsername,
  status: z.enum(['ACTIVE', 'DISABLED']),
  roleIds: z.array(z.string()).min(1, 'Assign at least one role'),
  locationIds: z.array(z.string()),
});

type CreateValues = z.input<typeof createSchema>;
type EditValues = z.infer<typeof editSchema>;
type Values = CreateValues & Partial<EditValues>;

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit to create a new user. */
  user?: UserSummary;
}

function CheckboxGroup({
  legend,
  options,
  value,
  onChange,
  error,
}: {
  legend: string;
  options: { id: string; label: string; hint?: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  error?: string | undefined;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {options.map((o) => (
        <label key={o.id} className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={value.includes(o.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((v) => v !== o.id))}
          />
          <span>
            {o.label}
            {o.hint && <span className="block text-xs text-muted-foreground">{o.hint}</span>}
          </span>
        </label>
      ))}
      {error && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Mounted only while the dialog is open, so every opening starts from fresh state. */
function UserForm({ user, onDone }: { user?: UserSummary | undefined; onDone: () => void }) {
  const isEdit = Boolean(user);
  const queryClient = useQueryClient();
  const roles = useRoles();
  const locations = useLocations();
  const [formError, setFormError] = useState<string | null>(null);

  const { register, handleSubmit, control, setError, formState } = useForm<Values>({
    resolver: zodResolver((isEdit ? editSchema : createSchema) as unknown as z.ZodType<Values, Values>),
    defaultValues: user
      ? {
          email: user.email,
          username: user.username ?? '',
          fullName: user.fullName,
          password: '',
          status: user.status,
          roleIds: user.roles.map((r) => r.id),
          locationIds: user.locations.map((l) => l.id),
        }
      : { email: '', username: '', fullName: '', password: '', roleIds: [], locationIds: [], status: 'ACTIVE' },
  });

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      user
        ? api.patch(`/users/${user.id}`, {
            fullName: values.fullName,
            username: values.username || null,
            status: values.status,
            roleIds: values.roleIds,
            locationIds: values.locationIds,
          })
        : api.post('/users', {
            email: values.email,
            ...(values.username ? { username: values.username } : {}),
            fullName: values.fullName,
            password: values.password,
            roleIds: values.roleIds,
            locationIds: values.locationIds,
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: usersKeys.all });
      toast.success(user ? 'User updated' : 'User created. They will choose a new password at first sign-in.');
      onDone();
    },
    onError: (error) => {
      setFormError(applyServerErrors(error, setError, ['email', 'username', 'fullName', 'password', 'roleIds', 'locationIds', 'status']));
    },
  });

  const roleOptions = (roles.data ?? []).map((r) => ({ id: r.id, label: r.name, hint: r.description ?? undefined }));
  const locationOptions = (locations.data ?? []).filter((l) => l.isActive).map((l) => ({ id: l.id, label: l.name }));

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="fullName" label="Full name" error={formState.errors.fullName?.message}>
        <Input autoComplete="off" {...register('fullName')} />
      </Field>
      <Field
        id="username"
        label="Username (optional)"
        description="Lets them sign in without typing their email. Letters, digits, dots, dashes or underscores."
        error={formState.errors.username?.message}
      >
        <Input autoComplete="off" autoCapitalize="none" spellCheck={false} {...register('username')} />
      </Field>
      {isEdit ? (
        <Field id="status" label="Status" error={formState.errors.status?.message}>
          <Select {...register('status')}>
            <option value="ACTIVE">Active</option>
            <option value="DISABLED">Disabled (signs the user out)</option>
          </Select>
        </Field>
      ) : (
        <>
          <Field id="email" label="Email" error={formState.errors.email?.message}>
            <Input type="email" autoComplete="off" {...register('email')} />
          </Field>
          <Field id="password" label="Temporary password" description="At least 10 characters." error={formState.errors.password?.message}>
            <Input type="password" autoComplete="new-password" {...register('password')} />
          </Field>
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          control={control}
          name="roleIds"
          render={({ field, fieldState }) => (
            <CheckboxGroup legend="Roles" options={roleOptions} value={field.value ?? []} onChange={field.onChange} error={fieldState.error?.message} />
          )}
        />
        <Controller
          control={control}
          name="locationIds"
          render={({ field }) => (
            <CheckboxGroup legend="Locations" options={locationOptions} value={field.value ?? []} onChange={field.onChange} />
          )}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function UserFormDialog({ open, onOpenChange, user }: UserFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{user ? `Edit ${user.fullName}` : 'New staff user'}</DialogTitle>
          <DialogDescription>
            {user ? 'Users are disabled rather than deleted so their history is kept.' : 'The user must change this password at first sign-in.'}
          </DialogDescription>
        </DialogHeader>
        <UserForm user={user} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
