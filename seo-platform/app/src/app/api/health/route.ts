import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export async function GET() {
  try {
    // A real round trip to Postgres — not a stub. If this throws, the
    // health check reports unhealthy.
    await db.execute(sql`select 1`);
    return NextResponse.json({ status: "ok", db: "connected" }, { status: 200 });
  } catch (error) {
    console.error("Health check failed:", error);
    return NextResponse.json(
      {
        status: "error",
        db: "disconnected",
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 503 }
    );
  }
}
