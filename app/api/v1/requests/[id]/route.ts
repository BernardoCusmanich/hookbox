import type { NextRequest } from "next/server";
import { apiDeps, toResponse } from "@/lib/api/deps";
import { handleGetRequest } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/requests/[id]">) {
  const { id } = await ctx.params;
  const result = await handleGetRequest(
    { authorization: request.headers.get("authorization"), requestId: id },
    apiDeps(),
  );
  return toResponse(result);
}
