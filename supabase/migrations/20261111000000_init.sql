-- Hookbox: schema inicial, RLS, RPCs e triggers.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  slug text unique not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (char_length(email) <= 254),
  token text unique not null,
  role text not null check (role in ('owner', 'member')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index invites_org_id_idx on public.invites (org_id);

create table public.endpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  slug text unique not null check (slug ~ '^[a-z0-9]{12}$'),
  secret_ciphertext text,
  forward_url text check (forward_url is null or char_length(forward_url) <= 2048),
  forward_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create index endpoints_org_id_idx on public.endpoints (org_id);

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.endpoints (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  method text not null,
  path text not null,
  query jsonb not null default '{}'::jsonb,
  headers jsonb not null default '{}'::jsonb,
  body text,
  body_encoding text not null default 'utf8' check (body_encoding in ('utf8', 'base64')),
  content_type text,
  size_bytes int not null default 0,
  ip inet,
  signature_status text not null check (signature_status in ('valid', 'invalid', 'missing', 'not_configured')),
  received_at timestamptz not null default now()
);

create index requests_endpoint_received_idx on public.requests (endpoint_id, received_at desc);
create index requests_received_at_idx on public.requests (received_at);
create index requests_org_id_idx on public.requests (org_id);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  attempt int not null,
  status_code int,
  error text check (error is null or char_length(error) <= 500),
  duration_ms int,
  created_at timestamptz not null default now()
);

create index deliveries_request_id_idx on public.deliveries (request_id);
create index deliveries_org_id_idx on public.deliveries (org_id);

-- ---------------------------------------------------------------------------
-- Funções de autorização (usadas nas policies)
-- ---------------------------------------------------------------------------

create or replace function public.is_member(org uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_owner(org uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.is_owner(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.invites enable row level security;
alter table public.endpoints enable row level security;
alter table public.requests enable row level security;
alter table public.deliveries enable row level security;

-- organizations: criação só pela RPC create_organization.
create policy organizations_select on public.organizations
  for select to authenticated using (public.is_member(id));
create policy organizations_update on public.organizations
  for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));
create policy organizations_delete on public.organizations
  for delete to authenticated using (public.is_owner(id));

-- memberships
create policy memberships_select on public.memberships
  for select to authenticated using (public.is_member(org_id));
create policy memberships_insert on public.memberships
  for insert to authenticated with check (public.is_owner(org_id));
create policy memberships_update on public.memberships
  for update to authenticated using (public.is_owner(org_id)) with check (public.is_owner(org_id));
create policy memberships_delete on public.memberships
  for delete to authenticated using (public.is_owner(org_id));

-- invites
create policy invites_select on public.invites
  for select to authenticated using (public.is_owner(org_id));
create policy invites_insert on public.invites
  for insert to authenticated with check (public.is_owner(org_id));
create policy invites_delete on public.invites
  for delete to authenticated using (public.is_owner(org_id));

-- endpoints
create policy endpoints_select on public.endpoints
  for select to authenticated using (public.is_member(org_id));
create policy endpoints_insert on public.endpoints
  for insert to authenticated with check (public.is_member(org_id));
create policy endpoints_update on public.endpoints
  for update to authenticated using (public.is_member(org_id)) with check (public.is_member(org_id));
create policy endpoints_delete on public.endpoints
  for delete to authenticated using (public.is_member(org_id));

-- requests e deliveries: só leitura. Escrita apenas pela service role (que ignora RLS).
create policy requests_select on public.requests
  for select to authenticated using (public.is_member(org_id));
create policy deliveries_select on public.deliveries
  for select to authenticated using (public.is_member(org_id));

-- Defesa extra: anon não toca em nada; authenticated não escreve em requests/deliveries.
revoke all on public.organizations, public.memberships, public.invites,
  public.endpoints, public.requests, public.deliveries from anon;
revoke insert, update, delete on public.requests, public.deliveries from authenticated;
revoke insert on public.organizations from authenticated;

-- ---------------------------------------------------------------------------
-- Triggers de integridade
-- ---------------------------------------------------------------------------

-- Não permitir que uma organização fique sem owner.
create or replace function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;
  -- Exclusão em cascata da organização ou do usuário: deixa passar.
  if not exists (select 1 from public.organizations where id = old.org_id) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from auth.users where id = old.user_id) then
    return old;
  end if;
  if not exists (
    select 1 from public.memberships
    where org_id = old.org_id and role = 'owner' and user_id <> old.user_id
  ) then
    raise exception 'A organização precisa ter pelo menos um owner.'
      using errcode = 'P0001', hint = 'last_owner';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger memberships_last_owner
  before update or delete on public.memberships
  for each row execute function public.prevent_last_owner_removal();

-- Máximo de 5 endpoints por organização.
create or replace function public.enforce_endpoint_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Serializa inserções concorrentes da mesma organização.
  perform 1 from public.organizations where id = new.org_id for update;
  if (select count(*) from public.endpoints where org_id = new.org_id) >= 5 then
    raise exception 'Limite de 5 endpoints por organização atingido.'
      using errcode = 'P0001', hint = 'endpoint_limit';
  end if;
  return new;
end;
$$;

create trigger endpoints_limit
  before insert on public.endpoints
  for each row execute function public.enforce_endpoint_limit();

-- endpoints.org_id e endpoints.slug são imutáveis.
create or replace function public.endpoints_immutable_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.org_id <> old.org_id or new.slug <> old.slug then
    raise exception 'org_id e slug do endpoint não podem ser alterados.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger endpoints_immutable
  before update on public.endpoints
  for each row execute function public.endpoints_immutable_columns();

-- organizations.slug e is_demo não podem ser alterados por usuários.
create or replace function public.organizations_immutable_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.role() = 'authenticated'
     and (new.slug <> old.slug or new.is_demo <> old.is_demo) then
    raise exception 'slug e is_demo não podem ser alterados.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger organizations_immutable
  before update on public.organizations
  for each row execute function public.organizations_immutable_columns();

-- memberships: org_id e user_id imutáveis (só o papel muda).
create or replace function public.memberships_immutable_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.org_id <> old.org_id or new.user_id <> old.user_id then
    raise exception 'org_id e user_id não podem ser alterados.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger memberships_immutable
  before update on public.memberships
  for each row execute function public.memberships_immutable_columns();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Cria a organização e o membership owner do usuário atual, numa transação.
create or replace function public.create_organization(name text)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  clean_name text := btrim(name);
  base_slug text;
  candidate text;
  org public.organizations;
begin
  if uid is null then
    raise exception 'Não autenticado.' using errcode = '42501';
  end if;
  if clean_name is null or char_length(clean_name) < 2 or char_length(clean_name) > 80 then
    raise exception 'Nome inválido.' using errcode = '22023';
  end if;

  base_slug := translate(
    lower(clean_name),
    'áàâãäéèêëíìîïóòôõöúùûüçñ',
    'aaaaaeeeeiiiiooooouuuucn'
  );
  base_slug := regexp_replace(base_slug, '[^a-z0-9]+', '-', 'g');
  base_slug := btrim(base_slug, '-');
  base_slug := left(base_slug, 40);
  base_slug := btrim(base_slug, '-');
  if base_slug = '' then
    base_slug := 'org';
  end if;

  candidate := base_slug;
  loop
    begin
      insert into public.organizations (name, slug)
      values (clean_name, candidate)
      returning * into org;
      exit;
    exception when unique_violation then
      candidate := base_slug || '-' || substr(md5(gen_random_uuid()::text), 1, 6);
    end;
  end loop;

  insert into public.memberships (org_id, user_id, role) values (org.id, uid, 'owner');
  return org;
end;
$$;

revoke execute on function public.create_organization(text) from public, anon;
grant execute on function public.create_organization(text) to authenticated;

-- Dados públicos de um convite, para a tela /invite/[token]. O token é o segredo.
create or replace function public.get_invite(invite_token text)
returns table (org_name text, email text, role text, expired boolean, accepted boolean)
language sql
security definer
stable
set search_path = public
as $$
  select o.name, i.email, i.role, i.expires_at < now(), i.accepted_at is not null
  from public.invites i
  join public.organizations o on o.id = i.org_id
  where i.token = invite_token;
$$;

revoke execute on function public.get_invite(text) from public, anon;
grant execute on function public.get_invite(text) to authenticated;

-- Aceita o convite: o e-mail da conta precisa bater com o do convite.
create or replace function public.accept_invite(invite_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  user_email text;
  inv public.invites;
  org_slug text;
begin
  if uid is null then
    raise exception 'Não autenticado.' using errcode = '42501';
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

  select u.email into user_email from auth.users u where u.id = uid;
  if user_email is null or lower(user_email) <> lower(inv.email) then
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

-- Contagem de requisições nas últimas 24 h por endpoint (respeita RLS: security invoker).
create or replace function public.endpoint_request_counts(org uuid)
returns table (endpoint_id uuid, total bigint)
language sql
stable
set search_path = public
as $$
  select r.endpoint_id, count(*)
  from public.requests r
  where r.org_id = org and r.received_at > now() - interval '24 hours'
  group by r.endpoint_id;
$$;

revoke execute on function public.endpoint_request_counts(uuid) from public, anon;
grant execute on function public.endpoint_request_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: só a tabela requests.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.requests;
