import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Renova a sessão do Supabase e protege /app/**.
 * Sem login → /login. Logado sem organização → /app/onboarding.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  // Não colocar código entre createServerClient e getUser (recomendação do @supabase/ssr).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  const isApp = pathname === "/app" || pathname.startsWith("/app/");

  const redirectTo = (path: string, params?: Record<string, string>) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = params ? `?${new URLSearchParams(params)}` : "";
    const redirect = NextResponse.redirect(url);
    // Preserva cookies de sessão renovados.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  if (isApp && !user) {
    return redirectTo("/login", { next: pathname + search });
  }

  if (isApp && user && pathname !== "/app/onboarding") {
    const { count } = await supabase
      .from("memberships")
      .select("org_id", { count: "exact", head: true })
      .eq("user_id", user.id);
    if (!count) return redirectTo("/app/onboarding");
  }

  if (pathname === "/login" && user) {
    return redirectTo("/app");
  }

  return response;
}

export const config = {
  // Ingestão (/in), APIs e estáticos ficam de fora.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|in/|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
