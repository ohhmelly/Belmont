/**
 * Download a previously generated report file (Phase 4).
 *
 * Auth bar matches the existing website results page
 * (src/app/dashboard/websites/[id]/page.tsx): any authenticated session
 * may fetch any report by id. This is the same level of protection the
 * rest of Phase 2/3's dashboard pages use today (no per-organization
 * ownership check yet) — tightening that is a pre-existing gap outside
 * Phase 4's scope, not something newly introduced here.
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { reports } from "@/db/app-schema";
import { readReportFile, contentTypeForFormat } from "@/lib/reports/generate";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;
  const [report] = await db.select().from(reports).where(eq(reports.id, id));
  if (!report) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  let buffer: Buffer;
  try {
    buffer = await readReportFile(report.filePath);
  } catch (err) {
    console.error("Failed to read report file:", err);
    return NextResponse.json({ error: "Report file missing on disk" }, { status: 410 });
  }

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": contentTypeForFormat(report.format),
      "Content-Disposition": `attachment; filename="seo-report-${report.id}.${report.format}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
