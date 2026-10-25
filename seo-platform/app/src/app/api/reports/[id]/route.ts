/**
 * Download a previously generated report file (Phase 4; Phase 6 adds
 * tenant isolation).
 *
 * Phase 6 fix: this used to check only "is there a session" and then
 * stream ANY report by id — any authenticated user could download any
 * other organization's report just by knowing/guessing its id. It now
 * re-verifies server-side, via requireReportAccess, that the caller's
 * organization actually owns the website this report belongs to.
 *
 * Uses the request's own `req.headers` (not `next/headers`'s
 * `headers()`) so this Route Handler's auth check can be exercised
 * directly in a test with a hand-built `NextRequest` — no running Next
 * HTTP server required — while behaving identically in production,
 * where `req.headers` already carries the real request's cookies.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireReportAccess, OrgAccessError } from "@/lib/auth/require-org-access";
import { readReportFile, contentTypeForFormat } from "@/lib/reports/generate";
import { logAudit } from "@/lib/audit/log";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let access;
  try {
    access = await requireReportAccess(id, { headersOverride: req.headers });
  } catch (err) {
    if (err instanceof OrgAccessError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const { report, website, session } = access;

  let buffer: Buffer;
  try {
    buffer = await readReportFile(report.filePath);
  } catch (err) {
    console.error("Failed to read report file:", err);
    return NextResponse.json({ error: "Report file missing on disk" }, { status: 410 });
  }

  await logAudit({
    organizationId: website.organizationId,
    actorUserId: session.userId,
    action: "report_downloaded",
    targetType: "report",
    targetId: report.id,
    metadata: { format: report.format, websiteId: website.id },
  });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": contentTypeForFormat(report.format),
      "Content-Disposition": `attachment; filename="seo-report-${report.id}.${report.format}"`,
      "Content-Length": String(buffer.length),
    },
  });
}
