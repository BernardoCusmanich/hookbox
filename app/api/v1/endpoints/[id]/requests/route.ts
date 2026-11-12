import type { NextRequest } from "next/server";
import { apiDeps, toResponse } from "@/lib/api/deps";
import { handleListRequests } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/v1/endpoints/[id]/requests">) {
  const { id } = await ctx.params;
  const result = await handleListRequests(
    {
      authorization: request.headers.get("authorization"),
      endpointId: id,
      searchParams: request.nextUrl.searchParams,
    },
    apiDeps(),
  );
  return toResponse(result);
}
