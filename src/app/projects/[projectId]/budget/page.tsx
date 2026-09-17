import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { CategoryCard } from "./category-card";
import { AddCategoryForm } from "./add-category-form";

export default async function BudgetPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const categories = await prisma.budgetCategory.findMany({
    where: { projectId },
    orderBy: { order: "asc" },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });

  const grandEstimated = categories.reduce(
    (sum, c) => sum + c.items.reduce((s, i) => s + i.estimated, 0),
    0
  );
  const grandActual = categories.reduce(
    (sum, c) => sum + c.items.reduce((s, i) => s + i.actual, 0),
    0
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budget"
        subtitle={`Estimated $${grandEstimated.toLocaleString()} · Actual $${grandActual.toLocaleString()}`}
        actions={<AddCategoryForm projectId={projectId} />}
      />

      {categories.length === 0 ? (
        <Card className="p-0">
          <EmptyState title="No budget categories yet" description="Add a category to start tracking spend." />
        </Card>
      ) : (
        <div className="space-y-4">
          {categories.map((category) => (
            <CategoryCard key={category.id} projectId={projectId} category={category} />
          ))}
        </div>
      )}
    </div>
  );
}
