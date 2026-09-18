import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/access";
import { buildExportPackage } from "@/lib/export/build";
import { exportCsv } from "@/lib/export/csv";
import { exportPdf } from "@/lib/export/pdf";

/**
 * Production export downloads.
 *
 * All three formats are built from the same package, so they can never disagree
 * about the project. Access is checked first: an export is the whole production,
 * and it is only ever served to someone who can already see it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; format: string }> }
) {
  const { projectId, format } = await params;
  const { project } = await requireProjectAccess(projectId);

  const pkg = await buildExportPackage(projectId);
  const stem = slug(project.title);

  switch (format) {
    case "json":
      return download(JSON.stringify(pkg, null, 2), `${stem}-package.json`, "application/json");
    case "csv":
      // A BOM so Excel opens UTF-8 correctly instead of mangling accents.
      return download(`﻿${exportCsv(pkg)}`, `${stem}-shot-list.csv`, "text/csv; charset=utf-8");
    case "pdf": {
      const bytes = await exportPdf(pkg);
      return new NextResponse(Buffer.from(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${stem}-production-report.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }
    default:
      return NextResponse.json({ error: "Unknown export format" }, { status: 404 });
  }
}

function download(body: string, filename: string, contentType: string) {
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}
