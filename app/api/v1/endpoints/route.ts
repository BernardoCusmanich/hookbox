import type { NextRequest } from "next/server";
import { apiDeps, toResponse } from "@/lib/api/deps";
import { handleListEndpoints } from "@/lib/api/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const result = await handleListEndpoints({ authorization: request.headers.get("authorization") }, apiDeps());
  return toResponse(result);
}
