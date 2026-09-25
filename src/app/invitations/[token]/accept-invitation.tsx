"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ErrorText } from "@/components/ui";
import { acceptInvitationAction } from "@/lib/actions/members";
import { describeRefusal } from "@/lib/invitations";

/**
 * The accept button.
 *
 * A deliberate action rather than something the page does on load: a link that
 * joined you to a project by being visited would fire for every crawler, mail
 * scanner and link preview that touched it on the way.
 */
export function AcceptInvitation({
  token,
  projectTitle,
}: {
  token: string;
  projectTitle: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  return (
    <div className="mt-5">
      <Button
        disabled={pending}
        onClick={() => {
          setError(undefined);
          start(async () => {
            const result = await acceptInvitationAction(token);
            if (result.ok) {
              router.push(`/projects/${result.projectId}`);
              router.refresh();
            } else {
              setError(describeRefusal(result.reason, result.invitedEmail));
            }
          });
        }}
      >
        {pending ? "Joining…" : `Join ${projectTitle}`}
      </Button>
      {error && <ErrorText message={error} />}
    </div>
  );
}
