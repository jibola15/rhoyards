import { STORE_NAME } from '../config';

export function HomePage() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 text-center">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{STORE_NAME}</h1>
      <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
        Our online store is being prepared. Please visit us in store in the meantime.
      </p>
    </section>
  );
}
