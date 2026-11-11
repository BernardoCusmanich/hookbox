-- Proteções ligadas ao Supabase Auth.
--
-- A conta demo é compartilhada por todos os visitantes. Ela é marcada pelo seed com
-- app_metadata.hookbox_demo = true (app_metadata só pode ser escrito pela service role).

create or replace function public.is_demo_user(uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select (u.raw_app_meta_data ->> 'hookbox_demo')::boolean from auth.users u where u.id = uid),
    false
  );
$$;

revoke execute on function public.is_demo_user(uuid) from public, anon, authenticated;

-- Um visitante logado na demo não pode trocar a senha nem o e-mail da conta
-- (o que trancaria a demo para todo mundo). As mudanças são simplesmente descartadas.
create or replace function public.protect_demo_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce((old.raw_app_meta_data ->> 'hookbox_demo')::boolean, false) then
    new.encrypted_password := old.encrypted_password;
    new.email := old.email;
    new.email_change := '';
    new.email_change_token_new := '';
    new.email_change_token_current := '';
    new.phone := old.phone;
  end if;
  return new;
end;
$$;

create trigger protect_demo_user
  before update on auth.users
  for each row execute function public.protect_demo_user();

-- A conta demo não cria organizações nem aceita convites.
create or replace function public.create_organization_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_demo_user(auth.uid()) then
    raise exception 'A conta demo não pode criar organizações.' using errcode = 'P0001', hint = 'demo';
  end if;
  return new;
end;
$$;

create trigger organizations_demo_guard
  before insert on public.organizations
  for each row execute function public.create_organization_guard();

-- accept_invite: além de bater o e-mail, exige e-mail confirmado. Assim uma conta criada
-- direto na API de Auth com o e-mail de outra pessoa não consegue roubar o convite.
create or replace function public.accept_invite(invite_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  user_email text;
  confirmed timestamptz;
  inv public.invites;
  org_slug text;
begin
  if uid is null then
    raise exception 'Não autenticado.' using errcode = '42501';
  end if;
  if public.is_demo_user(uid) then
    raise exception 'A conta demo não pode aceitar convites.' using errcode = 'P0001', hint = 'demo';
  end if;

  select * into inv from public.invites where token = invite_token for update;
  if not found then
    raise exception 'Convite não encontrado.' using errcode = 'P0001', hint = 'not_found';
  end if;
  if inv.accepted_at is not null then
    raise exception 'Convite já utilizado.' using errcode = 'P0001', hint = 'accepted';
  end if;
  if inv.expires_at < now() then
    raise exception 'Convite expirado.' using errcode = 'P0001', hint = 'expired';
  end if;

  select u.email, u.email_confirmed_at into user_email, confirmed from auth.users u where u.id = uid;
  if user_email is null or confirmed is null or lower(user_email) <> lower(inv.email) then
    raise exception 'O e-mail da conta não corresponde ao convite.' using errcode = 'P0001', hint = 'email_mismatch';
  end if;

  insert into public.memberships (org_id, user_id, role)
  values (inv.org_id, uid, inv.role)
  on conflict (org_id, user_id) do nothing;

  update public.invites set accepted_at = now() where id = inv.id;

  select slug into org_slug from public.organizations where id = inv.org_id;
  return org_slug;
end;
$$;

revoke execute on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;
