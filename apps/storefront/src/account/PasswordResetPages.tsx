import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { customerPasswordResetConfirmSchema, customerPasswordResetRequestSchema } from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardHeader, Field, Input } from '@rhoyards/ui';
import { api } from '../lib/api';

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <Card>
        <CardHeader>
          <h1 className="text-lg font-semibold">{title}</h1>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = customerPasswordResetRequestSchema.safeParse({ email });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address');
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/password-reset', parsed.data);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Forgot your password?">
      {sent ? (
        <div className="grid gap-4">
          <Alert>If an account uses that email, we have sent it a link to choose a new password. The link works once, for 30 minutes.</Alert>
          <Link to="/account/login" className="text-center text-sm underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="grid gap-4">
          <p className="text-sm text-muted-foreground">Enter the email you shop with and we will send you a reset link.</p>
          <Field id="reset-email" label="Email" error={error ?? undefined}>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send reset link'}
          </Button>
          <Link to="/account/login" className="text-center text-sm text-muted-foreground underline">
            Back to sign in
          </Link>
        </form>
      )}
    </Shell>
  );
}

/** The token comes in the URL fragment (never sent to servers) and is removed from the address bar at once. */
function takeTokenFromHash(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) window.history.replaceState(window.history.state, '', window.location.pathname);
  return token;
}

export function ResetPasswordPage() {
  const [token] = useState(takeTokenFromHash);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <Shell title="Choose a new password">
        <div className="grid gap-4">
          <Alert variant="destructive">This reset link is incomplete. Open the link from the email again, or request a new one.</Alert>
          <Link to="/account/forgot-password" className="text-center text-sm underline">
            Request a new link
          </Link>
        </div>
      </Shell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = customerPasswordResetConfirmSchema.safeParse({ token, newPassword: password });
    const next: typeof errors = {};
    if (!parsed.success) next.password = parsed.error.issues.find((i) => i.path[0] === 'newPassword')?.message ?? 'Check your password';
    if (password !== confirm) next.confirm = 'Passwords do not match';
    setErrors(next);
    if (!parsed.success || next.confirm) return;
    setBusy(true);
    try {
      await api.post('/auth/password-reset/confirm', parsed.data);
      setDone(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Choose a new password">
      {done ? (
        <div className="grid gap-4">
          <Alert>Your password has been changed and you have been signed out everywhere.</Alert>
          <Link to="/account/login" className="text-center text-sm font-medium underline">
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="grid gap-4">
          {formError && (
            <Alert variant="destructive">
              {formError}{' '}
              <Link to="/account/forgot-password" className="underline">
                Request a new link
              </Link>
            </Alert>
          )}
          <Field id="new-password" label="New password (at least 8 characters)" error={errors.password}>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field id="confirm-password" label="Confirm new password" error={errors.confirm}>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Set new password'}
          </Button>
        </form>
      )}
    </Shell>
  );
}
