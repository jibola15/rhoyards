import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { z } from 'zod';
import {
  authenticatorChangeStartSchema,
  regenerateBackupCodesSchema,
  totpCodeSchema,
  type AuthenticatorChange,
  type BackupCodes as BackupCodesData,
  type DataEnvelope,
} from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, toast } from '@rhoyards/ui';
import { useAuth } from '../auth/AuthProvider';
import { AuthenticatorSetup, BackupCodes } from '../auth/two-factor';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { applyServerErrors } from '../lib/forms';

const STATUS_KEY = ['auth', 'two-factor'] as const;

function useTwoFactorStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) =>
      api.get<DataEnvelope<{ enabledAt: string | null; backupCodesLeft: number }>>('/auth/two-factor', { signal }).then((r) => r.data),
  });
}

function NewBackupCodes() {
  const queryClient = useQueryClient();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof regenerateBackupCodesSchema>>({ resolver: zodResolver(regenerateBackupCodesSchema), defaultValues: { code: '' } });

  if (codes) {
    return (
      <BackupCodes
        codes={codes}
        doneLabel="Done"
        onDone={() => {
          setCodes(null);
          reset({ code: '' });
        }}
      />
    );
  }

  const onSubmit = handleSubmit(async ({ code }) => {
    setFormError(null);
    try {
      const res = await api.post<DataEnvelope<BackupCodesData>>('/auth/two-factor/backup-codes', { code });
      setCodes(res.data.backupCodes);
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['code']));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-3">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="backup-code" label="Current code" description="From your authenticator app (or one of your backup codes)." error={errors.code?.message}>
        <Input autoComplete="one-time-code" {...register('code')} />
      </Field>
      <Button type="submit" variant="outline" disabled={isSubmitting}>
        {isSubmitting ? 'Generating…' : 'Generate new backup codes'}
      </Button>
    </form>
  );
}

function ChangeAuthenticator() {
  const queryClient = useQueryClient();
  const [change, setChange] = useState<AuthenticatorChange | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const passwordForm = useForm<z.input<typeof authenticatorChangeStartSchema>>({
    resolver: zodResolver(authenticatorChangeStartSchema),
    defaultValues: { password: '' },
  });
  const codeForm = useForm<{ code: string }>({ resolver: zodResolver(z.object({ code: totpCodeSchema })), defaultValues: { code: '' } });

  if (codes) {
    return (
      <BackupCodes
        codes={codes}
        doneLabel="Done"
        onDone={() => {
          setCodes(null);
          setChange(null);
          passwordForm.reset();
          codeForm.reset();
        }}
      />
    );
  }

  if (change) {
    const onConfirm = codeForm.handleSubmit(async ({ code }) => {
      setFormError(null);
      try {
        const res = await api.post<DataEnvelope<BackupCodesData>>('/auth/two-factor/change/confirm', { challengeToken: change.challengeToken, code });
        setCodes(res.data.backupCodes);
        toast.success('Your new authenticator app is set up. Other devices have been signed out.');
        await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      } catch (error) {
        setFormError(applyServerErrors(error, codeForm.setError, ['code']));
      }
    });
    return (
      <form onSubmit={onConfirm} noValidate className="grid gap-3">
        <AuthenticatorSetup setup={change.setup} />
        {formError && <Alert variant="destructive">{formError}</Alert>}
        <Field id="new-app-code" label="Code from the new app" error={codeForm.formState.errors.code?.message}>
          <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} {...codeForm.register('code')} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={codeForm.formState.isSubmitting}>
            Switch to this app
          </Button>
          <Button type="button" variant="outline" onClick={() => setChange(null)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  const onStart = passwordForm.handleSubmit(async ({ password }) => {
    setFormError(null);
    try {
      setChange((await api.post<DataEnvelope<AuthenticatorChange>>('/auth/two-factor/change', { password })).data);
    } catch (error) {
      setFormError(applyServerErrors(error, passwordForm.setError, ['password']));
    }
  });
  return (
    <form onSubmit={onStart} noValidate className="grid gap-3">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="change-password" label="Your password" error={passwordForm.formState.errors.password?.message}>
        <Input type="password" autoComplete="current-password" {...passwordForm.register('password')} />
      </Field>
      <Button type="submit" variant="outline" disabled={passwordForm.formState.isSubmitting}>
        Set up a new authenticator app
      </Button>
    </form>
  );
}

export function AccountSecurityPage() {
  const { session } = useAuth();
  const status = useTwoFactorStatus();
  const user = session?.user;

  return (
    <div className="mx-auto grid max-w-2xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Account security</CardTitle>
          <CardDescription>
            Signed in as {user?.fullName} ({user?.email}
            {user?.username ? `, username ${user.username}` : ''}).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p>
            Two-step sign-in is <strong>on</strong>
            {status.data?.enabledAt ? ` (since ${formatDateTime(status.data.enabledAt)})` : ''}.{' '}
            {status.data && (
              <span className={status.data.backupCodesLeft <= 2 ? 'font-medium text-destructive' : 'text-muted-foreground'}>
                {status.data.backupCodesLeft} backup {status.data.backupCodesLeft === 1 ? 'code' : 'codes'} left.
              </span>
            )}
          </p>
          <p>
            <Link to="/account/password" className="underline underline-offset-4">
              Change password
            </Link>
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Backup codes</CardTitle>
          <CardDescription>Generate a new set if you have used most of them or think someone has seen them. The old set stops working.</CardDescription>
        </CardHeader>
        <CardContent>
          <NewBackupCodes />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New phone</CardTitle>
          <CardDescription>Move two-step sign-in to a different authenticator app. Your other devices will be signed out.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangeAuthenticator />
        </CardContent>
      </Card>
    </div>
  );
}
