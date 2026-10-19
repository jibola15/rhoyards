import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import {
  ApiError,
  loginSchema,
  twoFactorCodeSchema,
  totpCodeSchema,
  type AuthSession,
  type BackupCodes as BackupCodesData,
  type DataEnvelope,
  type LoginInput,
  type LoginStep,
} from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@rhoyards/ui';
import { useAuth } from '../auth/AuthProvider';
import { AuthenticatorSetup, BackupCodes } from '../auth/two-factor';
import { api } from '../lib/api';

/** Only same-app paths are accepted as a post-login destination (prevents open redirects). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
/** The server says the sign-in expired (or was used up): start again from the password. */
const mustRestart = (error: unknown) =>
  error instanceof ApiError && typeof error.details === 'object' && error.details !== null && 'restart' in error.details;

type Stage =
  | { kind: 'password' }
  | { kind: 'code'; step: Extract<LoginStep, { next: 'TWO_FACTOR' }> }
  | { kind: 'setup'; step: Extract<LoginStep, { next: 'TWO_FACTOR_SETUP' }> }
  | { kind: 'backup-codes'; session: AuthSession; codes: string[] };

function Shell({ description, children }: { description: string; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Rhoyards Back Office</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}

function PasswordStep({ onNext, notice }: { onNext: (step: LoginStep) => void; notice: string | null }) {
  const { login } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { identifier: '', password: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      onNext(await login(values));
    } catch (error) {
      setFormError(errorMessage(error, 'Sign-in failed'));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4">
      {notice && !formError && <Alert>{notice}</Alert>}
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="identifier" label="Email or username" error={errors.identifier?.message}>
        <Input autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus {...register('identifier')} />
      </Field>
      <Field id="password" label="Password" error={errors.password?.message}>
        <Input type="password" autoComplete="current-password" {...register('password')} />
      </Field>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
      <Link to="/forgot-password" className="text-center text-sm text-muted-foreground underline-offset-4 hover:underline">
        Forgot your password?
      </Link>
    </form>
  );
}

/** Second step: a code from the authenticator app, or a backup code. */
function CodeStep({ challengeToken, onSignedIn, onRestart }: { challengeToken: string; onSignedIn: (s: AuthSession) => void; onRestart: (msg: string) => void }) {
  const [useBackup, setUseBackup] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<{ code: string }>({ resolver: zodResolver(z.object({ code: twoFactorCodeSchema })), defaultValues: { code: '' } });

  const onSubmit = handleSubmit(async ({ code }) => {
    setFormError(null);
    try {
      const res = await api.post<DataEnvelope<AuthSession>>('/auth/login/two-factor', { challengeToken, code });
      onSignedIn(res.data);
    } catch (error) {
      if (mustRestart(error)) return onRestart(errorMessage(error, 'Please sign in again.'));
      setFormError(errorMessage(error, 'Sign-in failed'));
      reset({ code: '' });
      setFocus('code');
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4">
      {formError && <Alert variant="destructive">{formError}</Alert>}
      {useBackup ? (
        <Field id="code" label="Backup code" description="One of the codes you saved when you set up two-step sign-in." error={errors.code?.message}>
          <Input key="backup" autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus placeholder="xxxxx-xxxxx" {...register('code')} />
        </Field>
      ) : (
        <Field id="code" label="Authentication code" description="The 6-digit code in your authenticator app." error={errors.code?.message}>
          <Input key="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus {...register('code')} />
        </Field>
      )}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Checking…' : 'Verify'}
      </Button>
      <Button
        type="button"
        variant="link"
        className="text-muted-foreground"
        onClick={() => {
          setUseBackup((v) => !v);
          setFormError(null);
          reset({ code: '' });
        }}
      >
        {useBackup ? 'Use my authenticator app' : 'Lost your phone? Use a backup code'}
      </Button>
    </form>
  );
}

/** First sign-in: set up the authenticator app, prove it works, then get the backup codes. */
function SetupStep({
  step,
  onDone,
  onRestart,
}: {
  step: Extract<LoginStep, { next: 'TWO_FACTOR_SETUP' }>;
  onDone: (session: AuthSession, codes: string[]) => void;
  onRestart: (msg: string) => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<{ code: string }>({ resolver: zodResolver(z.object({ code: totpCodeSchema })), defaultValues: { code: '' } });

  const onSubmit = handleSubmit(async ({ code }) => {
    setFormError(null);
    try {
      const res = await api.post<DataEnvelope<AuthSession & BackupCodesData>>('/auth/login/two-factor-setup', { challengeToken: step.challengeToken, code });
      const { backupCodes, ...session } = res.data;
      onDone(session, backupCodes);
    } catch (error) {
      if (mustRestart(error)) return onRestart(errorMessage(error, 'Please sign in again.'));
      setFormError(errorMessage(error, 'That code did not work'));
      reset({ code: '' });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4">
      <AuthenticatorSetup setup={step.setup} />
      {formError && <Alert variant="destructive">{formError}</Alert>}
      <Field id="code" label="Code from the app" error={errors.code?.message}>
        <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} {...register('code')} />
      </Field>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Checking…' : 'Turn on two-step sign-in'}
      </Button>
    </form>
  );
}

export function LoginPage() {
  const { session, finishSignIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [stage, setStage] = useState<Stage>({ kind: 'password' });
  const [notice, setNotice] = useState<string | null>(null);

  // While backup codes are on screen the new session is held back, so the redirect below waits for "Continue".
  if (session && stage.kind !== 'backup-codes') return <Navigate to={safeNext(params.get('next'))} replace />;

  const enter = (s: AuthSession) => {
    finishSignIn(s);
    navigate(s.user.mustChangePassword ? '/account/password' : safeNext(params.get('next')), { replace: true });
  };
  const restart = (message: string) => {
    setNotice(message);
    setStage({ kind: 'password' });
  };

  switch (stage.kind) {
    case 'password':
      return (
        <Shell description="Sign in with your staff account.">
          <PasswordStep
            notice={notice}
            onNext={(step) => {
              setNotice(null);
              setStage(step.next === 'TWO_FACTOR' ? { kind: 'code', step } : { kind: 'setup', step });
            }}
          />
        </Shell>
      );
    case 'code':
      return (
        <Shell description="Two-step sign-in">
          <CodeStep challengeToken={stage.step.challengeToken} onSignedIn={enter} onRestart={restart} />
        </Shell>
      );
    case 'setup':
      return (
        <Shell description="Set up two-step sign-in. Staff accounts need a code from an authenticator app as well as the password.">
          <SetupStep step={stage.step} onRestart={restart} onDone={(s, codes) => setStage({ kind: 'backup-codes', session: s, codes })} />
        </Shell>
      );
    case 'backup-codes':
      return (
        <Shell description="Two-step sign-in is on. Save your backup codes.">
          <BackupCodes codes={stage.codes} onDone={() => enter(stage.session)} />
        </Shell>
      );
  }
}
