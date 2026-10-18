import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { changePasswordSchema } from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, toast } from '@rhoyards/ui';
import { useAuth } from '../auth/AuthProvider';
import { api } from '../lib/api';
import { applyServerErrors } from '../lib/forms';

const formSchema = changePasswordSchema
  .and(z.object({ confirmPassword: z.string() }))
  .refine((v) => v.newPassword === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });
type FormValues = z.infer<typeof formSchema>;

export function ChangePasswordPage() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  const forced = session?.user.mustChangePassword ?? false;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = handleSubmit(async ({ currentPassword, newPassword }) => {
    setFormError(null);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      await refresh();
      toast.success('Password changed. Other devices have been signed out.');
      navigate('/', { replace: true });
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['currentPassword', 'newPassword']));
    }
  });

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            {forced
              ? 'Your password was set by an administrator. Choose a new one to continue.'
              : 'Use at least 10 characters. A passphrase of several words works well.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="grid gap-4">
            {formError && <Alert variant="destructive">{formError}</Alert>}
            <Field id="currentPassword" label="Current password" error={errors.currentPassword?.message}>
              <Input type="password" autoComplete="current-password" {...register('currentPassword')} />
            </Field>
            <Field id="newPassword" label="New password" error={errors.newPassword?.message}>
              <Input type="password" autoComplete="new-password" {...register('newPassword')} />
            </Field>
            <Field id="confirmPassword" label="Confirm new password" error={errors.confirmPassword?.message}>
              <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
            </Field>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Change password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
