import { Link } from 'react-router';
import { buttonVariants } from '@rhoyards/ui';

export function ForbiddenPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="text-sm text-muted-foreground">
        Your role does not include access to this page. Ask an owner or manager if you need it.
      </p>
      <Link to="/" className={buttonVariants({ variant: 'outline' })}>
        Back to start
      </Link>
    </div>
  );
}
