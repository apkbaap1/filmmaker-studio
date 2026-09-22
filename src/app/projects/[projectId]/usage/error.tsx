"use client";

import { Button, Card, PageHeader } from "@/components/ui";

/**
 * Shown when the ledger cannot be read.
 *
 * It says the figures are unavailable rather than showing an empty report,
 * because an empty spend page and a failed one look identical and mean opposite
 * things. `error.message` is not rendered: a database error can carry a
 * connection string, and this screen has no business displaying one.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="space-y-6">
      <PageHeader title="Usage & spend" />
      <Card className="p-6">
        <h2 className="text-sm font-semibold text-foreground">The spend ledger could not be read</h2>
        <p className="mt-1 text-sm text-muted">
          This is a problem reading the figures, not a sign that nothing was spent. Do not treat
          this screen as evidence of zero cost.
        </p>
        <div className="mt-4">
          <Button onClick={reset}>Try again</Button>
        </div>
      </Card>
    </div>
  );
}
