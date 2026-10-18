import { Link } from 'react-router';
import { buttonVariants } from '@rhoyards/ui';

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you requested does not exist.</p>
      <Link to="/" className={buttonVariants({ variant: 'outline' })}>
        Back to start
      </Link>
    </div>
  );
}
