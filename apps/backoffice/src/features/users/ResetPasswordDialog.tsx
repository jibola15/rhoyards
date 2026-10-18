import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { resetPasswordSchema, type UserSummary } from '@rhoyards/shared';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  toast,
} from '@rhoyards/ui';
import { api } from '../../lib/api';
import { applyServerErrors } from '../../lib/forms';

function ResetPasswordForm({ user, onDone }: { user: UserSummary; onDone: () => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<{ newPassword: string }>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: '' },
  });
  const mutation = useMutation({
    mutationFn: (values: { newPassword: string }) => api.post(`/users/${user.id}/reset-password`, values),
    onSuccess: () => {
      toast.success(`Password reset. ${user.fullName} has been signed out and must choose a new password.`);
      onDone();
    },
    onError: (error) => setFormError(applyServerErrors(error, setError, ['newPassword'])),
  });

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="newPassword" label="Temporary password" error={formState.errors.newPassword?.message}>
        <Input type="password" autoComplete="new-password" {...register('newPassword')} />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Resetting…' : 'Reset password'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ResetPasswordDialog({ user, onOpenChange }: { user: UserSummary | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>Set a temporary password for {user?.fullName}. Their current sessions will end.</DialogDescription>
        </DialogHeader>
        {user && <ResetPasswordForm user={user} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
