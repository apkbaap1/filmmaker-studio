import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PrintButton } from "./print-button";

export default async function CallSheetPage({
  params,
}: {
  params: Promise<{ projectId: string; dayId: string }>;
}) {
  const { projectId, dayId } = await params;
  const { project } = await requireProjectAccess(projectId);

  const day = await prisma.scheduleDay.findFirst({
    where: { id: dayId, projectId },
    include: { items: { include: { scene: true }, orderBy: { id: "asc" } } },
  });
  if (!day) notFound();

  const [cast, crew] = await Promise.all([
    prisma.castMember.findMany({ where: { projectId, status: "CONFIRMED" }, orderBy: { characterName: "asc" } }),
    prisma.crewMember.findMany({ where: { projectId }, orderBy: [{ department: "asc" }, { name: "asc" }] }),
  ]);

  return (
    <div className="mx-auto max-w-3xl bg-surface p-8 text-foreground print:bg-white print:text-black">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-accent print:text-black">
            Call Sheet
          </p>
          <h1 className="text-2xl font-semibold">{project.title}</h1>
          <p className="mt-1 text-sm text-muted print:text-black">
            Day {day.dayNumber} —{" "}
            {new Date(day.date).toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
        </div>
        <PrintButton />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 border-y border-border py-4 text-sm sm:grid-cols-4 print:border-black">
        <div>
          <p className="text-xs text-muted print:text-black">Call time</p>
          <p className="font-medium">{day.callTime || "TBD"}</p>
        </div>
        <div>
          <p className="text-xs text-muted print:text-black">Wrap time</p>
          <p className="font-medium">{day.wrapTime || "TBD"}</p>
        </div>
        <div>
          <p className="text-xs text-muted print:text-black">Location</p>
          <p className="font-medium">{day.location || "TBD"}</p>
        </div>
        <div>
          <p className="text-xs text-muted print:text-black">Weather</p>
          <p className="font-medium">{day.weather || "—"}</p>
        </div>
      </div>

      {day.notes && (
        <div className="mb-6">
          <h2 className="mb-1 text-sm font-semibold">Notes</h2>
          <p className="whitespace-pre-wrap text-sm text-muted print:text-black">{day.notes}</p>
        </div>
      )}

      <div className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">Scene schedule</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted print:border-black print:text-black">
              <th className="py-1.5 pr-2">Time</th>
              <th className="py-1.5 pr-2">Scene</th>
              <th className="py-1.5 pr-2">Location</th>
              <th className="py-1.5">Notes</th>
            </tr>
          </thead>
          <tbody>
            {day.items.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-muted print:text-black">
                  No scenes scheduled yet.
                </td>
              </tr>
            )}
            {day.items.map((item) => (
              <tr key={item.id} className="border-b border-border/60 print:border-black">
                <td className="py-1.5 pr-2">{[item.startTime, item.endTime].filter(Boolean).join(" – ") || "—"}</td>
                <td className="py-1.5 pr-2">
                  {item.scene ? `${item.scene.number} — ${item.scene.intExt}. ${item.scene.location}` : "—"}
                </td>
                <td className="py-1.5 pr-2">{item.scene?.location ?? "—"}</td>
                <td className="py-1.5">{item.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">Cast — confirmed</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted print:border-black print:text-black">
              <th className="py-1.5 pr-2">Character</th>
              <th className="py-1.5 pr-2">Actor</th>
              <th className="py-1.5">Contact</th>
            </tr>
          </thead>
          <tbody>
            {cast.length === 0 && (
              <tr>
                <td colSpan={3} className="py-3 text-muted print:text-black">
                  No confirmed cast yet.
                </td>
              </tr>
            )}
            {cast.map((c) => (
              <tr key={c.id} className="border-b border-border/60 print:border-black">
                <td className="py-1.5 pr-2">{c.characterName}</td>
                <td className="py-1.5 pr-2">{c.actorName ?? "—"}</td>
                <td className="py-1.5">{[c.contactPhone, c.contactEmail].filter(Boolean).join(" · ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Crew</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted print:border-black print:text-black">
              <th className="py-1.5 pr-2">Department</th>
              <th className="py-1.5 pr-2">Name</th>
              <th className="py-1.5 pr-2">Position</th>
              <th className="py-1.5">Contact</th>
            </tr>
          </thead>
          <tbody>
            {crew.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-muted print:text-black">
                  No crew added yet.
                </td>
              </tr>
            )}
            {crew.map((c) => (
              <tr key={c.id} className="border-b border-border/60 print:border-black">
                <td className="py-1.5 pr-2">{c.department}</td>
                <td className="py-1.5 pr-2">{c.name}</td>
                <td className="py-1.5 pr-2">{c.position}</td>
                <td className="py-1.5">{[c.contactPhone, c.contactEmail].filter(Boolean).join(" · ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
