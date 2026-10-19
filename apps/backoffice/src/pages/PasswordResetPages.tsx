import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router';
import { z } from 'zod';
import { passwordResetRequestSchema, passwordSchema } from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@rhoyards/ui';
import { api } from '../lib/api';
import { applyServerErrors } from '../lib/forms';

function Shell({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}

const backToSignIn = (
  <Link to="/login" className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline">
    Back to sign in
  </Link>
);

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<z.input<typeof passwordResetRequestSchema>>({ resolver: zodResolver(passwordResetRequestSchema), defaultValues: { identifier: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/auth/password-reset', values);
      setSent(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Something went wrong');
    }
  });

  return (
    <Shell title="Reset your password" description="We will email you a link to choose a new password.">
      {sent ? (
        <div className="grid gap-4">
          <Alert>If an account matches, we have sent a reset link to its email address. The link works once, for 30 minutes.</Alert>
          {backToSignIn}
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          {formError && <Alert variant="destructive">{formError}</Alert>}
          <Field id="identifier" label="Email or username" error={errors.identifier?.message}>
            <Input autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus {...register('identifier')} />
          </Field>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </Button>
          {backToSignIn}
        </form>
      )}
    </Shell>
  );
}

const resetFormSchema = z
  .object({ newPassword: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

/** The token arrives in the URL fragment (never sent to servers); it is removed from the address bar straight away. */
function takeTokenFromHash(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) window.history.replaceState(window.history.state, '', window.location.pathname);
  return token;
}

export function ResetPasswordPage() {
  const [token] = useState(takeTokenFromHash);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof resetFormSchema>>({ resolver: zodResolver(resetFormSchema), defaultValues: { newPassword: '', confirmPassword: '' } });

  if (!token) {
    return (
      <Shell title="Reset your password" description="This page needs the link from the reset email.">
        <div className="grid gap-4">
          <Alert variant="destructive">The reset link is incomplete. Open the link from the email again, or request a new one.</Alert>
          <Link to="/forgot-password" className="text-center text-sm underline-offset-4 hover:underline">
            Request a new link
          </Link>
        </div>
      </Shell>
    );
  }

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    setFormError(null);
    try {
      await api.post('/auth/password-reset/confirm', { token, newPassword });
      setDone(true);
    } catch (error) {
      setFormError(applyServerErrors(error, setError, ['newPassword']));
    }
  });

  return (
    <Shell title="Choose a new password" description="Use at least 10 characters. A passphrase of several words works well.">
      {done ? (
        <div className="grid gap-4">
          <Alert>Your password has been changed and every device was signed out. Sign in with the new password and your authenticator app.</Alert>
          <Link to="/login" className="text-center text-sm font-medium underline-offset-4 hover:underline">
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          {formError && (
            <Alert variant="destructive">
              {formError}{' '}
              <Link to="/forgot-password" className="underline">
                Request a new link
              </Link>
            </Alert>
          )}
          <Field id="newPassword" label="New password" error={errors.newPassword?.message}>
            <Input type="password" autoComplete="new-password" autoFocus {...register('newPassword')} />
          </Field>
          <Field id="confirmPassword" label="Confirm new password" error={errors.confirmPassword?.message}>
            <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
          </Field>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      )}
    </Shell>
  );
}
