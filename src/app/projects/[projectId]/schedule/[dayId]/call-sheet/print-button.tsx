"use client";

import { Button } from "@/components/ui";

export function PrintButton() {
  return (
    <Button variant="secondary" size="sm" className="print:hidden" onClick={() => window.print()}>
      Print
    </Button>
  );
}
