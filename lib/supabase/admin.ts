import "server-only";
import { createClient } from "@supabase/supabase-js";
import { clientEnv, serverEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/types";

/**
 * Cliente com a service role: ignora o RLS.
 *
 * Usado SOMENTE em /in/[slug], /api/deliver, /api/cron/*, /api/v1/* e no seed
 * (o seed roda com `--conditions=react-server`, por isso o `server-only` não quebra lá).
 * Em /api/v1 toda consulta filtra pelo org_id da chave de API: esse filtro é a segurança.
 * Nunca importar em componente client nem em Server Action.
 */
export function createAdminClient() {
  return createClient<Database>(clientEnv.NEXT_PUBLIC_SUPABASE_URL, serverEnv.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
