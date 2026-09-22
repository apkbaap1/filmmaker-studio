import { Card, PageHeader } from "@/components/ui";

/**
 * Shown while the ledger is queried.
 *
 * Deliberately shows no numbers at all — not even zeros. A skeleton that
 * rendered "0" would, for the half-second before the real figures arrive, tell
 * a filmmaker their project had cost nothing. On a spend screen that is the one
 * lie worth engineering against.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHeader title="Usage & spend" subtitle="Loading the ledger…" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="p-4">
            <div className="h-3 w-24 animate-pulse rounded bg-border" />
            <div className="mt-2 h-7 w-16 animate-pulse rounded bg-border" />
            <div className="mt-2 h-3 w-32 animate-pulse rounded bg-border" />
          </Card>
        ))}
      </div>
      <Card className="p-4">
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-4 w-full animate-pulse rounded bg-border" />
          ))}
        </div>
      </Card>
    </div>
  );
}
