import type { NextRequest } from "next/server";
import { apiDeps, toResponse } from "@/lib/api/deps";
import { handleResend } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, ctx: RouteContext<"/api/v1/requests/[id]/resend">) {
  const { id } = await ctx.params;
  const result = await handleResend(
    { authorization: request.headers.get("authorization"), requestId: id },
    apiDeps(),
  );
  return toResponse(result);
}
