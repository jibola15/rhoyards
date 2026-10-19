import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { ApiError, customerLoginSchema, customerRegisterSchema, type DataEnvelope, type StoreSession } from '@rhoyards/shared';
import { Alert, Button, Card, CardContent, CardHeader, Field, Input } from '@rhoyards/ui';
import { api } from '../lib/api';
import { useCustomer } from './CustomerProvider';

/** Only same-site paths are followed after sign-in, so a crafted link cannot send the customer elsewhere. */
function useNext() {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/account/orders';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/account/orders';
}

function AuthForm<T extends Record<string, string>>({
  title,
  fields,
  schema,
  path,
  submitLabel,
  footer,
}: {
  title: string;
  fields: { name: keyof T & string; label: string; type?: string; autoComplete?: string }[];
  schema: { safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } };
  path: string;
  submitLabel: string;
  footer: React.ReactNode;
}) {
  const { customer, signedIn } = useCustomer();
  const navigate = useNavigate();
  const next = useNext();
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.name, ''])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (body: unknown) => api.post<DataEnvelope<StoreSession>>(path, body).then((r) => r.data),
    onSuccess: (session) => {
      signedIn(session);
      navigate(next, { replace: true });
    },
    onError: (e) => {
      const field = e instanceof ApiError ? (e.details as { field?: string } | undefined)?.field : undefined;
      if (field && field in values) setErrors({ [field]: e.message });
      else setFormError(e.message);
    },
  });
  if (customer) return <Navigate to={next} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    mutation.mutate(parsed.data);
  };

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <Card>
        <CardHeader>
          <h1 className="text-lg font-semibold">{title}</h1>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} noValidate className="grid gap-4">
            {formError && <Alert variant="destructive">{formError}</Alert>}
            {fields.map((f) => (
              <Field key={f.name} id={`auth-${f.name}`} label={f.label} error={errors[f.name]}>
                <Input type={f.type ?? 'text'} autoComplete={f.autoComplete} value={values[f.name]} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
              </Field>
            ))}
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Please wait…' : submitLabel}
            </Button>
            <p className="text-center text-sm text-muted-foreground">{footer}</p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function LoginPage() {
  const next = useNext();
  return (
    <AuthForm<{ email: string; password: string }>
      title="Sign in"
      path="/auth/login"
      schema={customerLoginSchema}
      submitLabel="Sign in"
      fields={[
        { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
        { name: 'password', label: 'Password', type: 'password', autoComplete: 'current-password' },
      ]}
      footer={
        <>
          New here?{' '}
          <Link to={`/account/register?next=${encodeURIComponent(next)}`} className="underline">
            Create an account
          </Link>
          <span className="mt-2 block">
            <Link to="/account/forgot-password" className="underline">
              Forgot your password?
            </Link>
          </span>
        </>
      }
    />
  );
}

export function RegisterPage() {
  const next = useNext();
  return (
    <AuthForm<{ name: string; email: string; phone: string; password: string }>
      title="Create an account"
      path="/auth/register"
      schema={customerRegisterSchema}
      submitLabel="Create account"
      fields={[
        { name: 'name', label: 'Full name', autoComplete: 'name' },
        { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
        { name: 'phone', label: 'Phone', type: 'tel', autoComplete: 'tel' },
        { name: 'password', label: 'Password (at least 8 characters)', type: 'password', autoComplete: 'new-password' },
      ]}
      footer={
        <>
          Already have an account?{' '}
          <Link to={`/account/login?next=${encodeURIComponent(next)}`} className="underline">
            Sign in
          </Link>
        </>
      }
    />
  );
}
