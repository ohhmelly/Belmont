/**
 * Download a previously generated report file (Phase 4).
 *
 * Fix (prior gap): this used to only check that *some* session was
 * signed in, not that the caller's organization actually owns the
 * report's website — any authenticated user could download any org's
 * report by guessing/reusing a report id. requireReportInActiveOrg now
 * enforces that, uniformly returning 404 for "doesn't exist" and
 * "exists but belongs elsewhere" so this endpoint can't be used to probe
 * which report ids exist in other organizations.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireReportInActiveOrg, TenantError } from "@/lib/tenant";
import { readReportFile, contentTypeForFormat } from "@/lib/reports/generate";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let report;
  try {
    report = await requireReportInActiveOrg(id);
  } catch (err) {
    if (err instanceof TenantError) {
      return NextResponse.json({ error: err.message }, { status: err.status === 403 ? 404 : err.status });
    }
    throw err;
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
