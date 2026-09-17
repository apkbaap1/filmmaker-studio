import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { readStoredFile } from "@/lib/storage";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: {
      project: {
        include: { members: { where: { userId: session.user.id } } },
      },
    },
  });

  if (!asset) {
    return new NextResponse("Not found", { status: 404 });
  }

  const isOwner = asset.project.ownerId === session.user.id;
  const isMember = asset.project.members.length > 0;
  if (!isOwner && !isMember) {
    return new NextResponse("Not found", { status: 404 });
  }

  let buffer: Buffer;
  try {
    buffer = await readStoredFile(asset.filePath);
  } catch {
    return new NextResponse("File missing", { status: 404 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": asset.mimeType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
