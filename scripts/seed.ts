/**
 * Seed da demo: usuário demo, organização "Demo", 2 endpoints e 10 requisições.
 * Idempotente. Rode com `npm run seed` (usa .env.local / .env, como o Next).
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { validateEnv, clientEnv, serverEnv } = await import("@/lib/env");
  validateEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { resetDemoOrg } = await import("@/lib/demo");

  const admin = createAdminClient();
  const email = serverEnv.DEMO_EMAIL;
  const password = serverEnv.DEMO_PASSWORD;

  // 1. Usuário demo (Admin API).
  async function findUserId(): Promise<string | null> {
    for (let page = 1; ; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (user) return user.id;
      if (data.users.length < 200) return null;
    }
  }

  async function createUser(): Promise<string> {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { hookbox_demo: true },
      user_metadata: { name: "Visitante da demo" },
    });
    if (error || !data.user) throw error ?? new Error("createUser sem usuário");
    return data.user.id;
  }

  let userId = await findUserId();
  if (userId) {
    // A conta demo não aceita troca de senha (trigger). Se a senha do .env mudou,
    // recria o usuário.
    const anon = createClient(clientEnv.NEXT_PUBLIC_SUPABASE_URL, clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    const { error } = await anon.auth.signInWithPassword({ email, password });
    if (error) {
      console.log("• senha da conta demo não confere; recriando o usuário");
      const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
      if (deleteError) throw deleteError;
      userId = await createUser();
    } else {
      await anon.auth.signOut();
      await admin.auth.admin.updateUserById(userId, { app_metadata: { hookbox_demo: true } });
      console.log("• usuário demo já existe");
    }
  } else {
    userId = await createUser();
    console.log("• usuário demo criado");
  }

  // 2. Organização, endpoints e requisições.
  const { orgId, inserted } = await resetDemoOrg(admin);
  console.log(`• organização demo pronta, ${inserted} requisições de exemplo`);

  // 3. Membership. A conta demo é "member": não mexe em membros, convites nem no nome da org.
  const { error: membershipError } = await admin
    .from("memberships")
    .upsert({ org_id: orgId, user_id: userId, role: "member" }, { onConflict: "org_id,user_id" });
  if (membershipError) throw membershipError;
  console.log(`• ${email} é membro da org demo`);
}

main().then(
  () => {
    console.log("Seed concluído.");
    process.exit(0);
  },
  (err) => {
    console.error("Seed falhou:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
