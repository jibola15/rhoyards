import { Link } from 'react-router';
import { buttonVariants } from '@rhoyards/ui';

export function NotFoundPage() {
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-20 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">We couldn't find the page you were looking for.</p>
      <Link to="/" className={buttonVariants({ variant: 'outline' })}>
        Go to home page
      </Link>
    </section>
  );
}
