export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-2xl font-semibold">Bonolini Transfer</h1>
      <p className="text-neutral-500 dark:text-neutral-400">
        Full online booking is coming soon.
      </p>
      <a
        href="/request-quote"
        className="mt-2 rounded bg-neutral-900 px-4 py-2 text-sm text-white"
      >
        Request a Quote
      </a>
    </main>
  );
}
