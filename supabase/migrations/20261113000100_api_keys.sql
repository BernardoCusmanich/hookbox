-- Chaves de API da organização (API pública /api/v1).
-- A chave em texto nunca é gravada: só o prefixo (para identificar na UI) e o sha256.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  prefix text not null check (char_length(prefix) = 12),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index api_keys_org_id_idx on public.api_keys (org_id);

alter table public.api_keys enable row level security;

-- Só owners veem, criam e apagam chaves. Não há update: last_used_at é atualizado
-- pela service role na API.
create policy api_keys_select on public.api_keys
  for select to authenticated using (public.is_owner(org_id));
create policy api_keys_insert on public.api_keys
  for insert to authenticated with check (public.is_owner(org_id) and created_by = auth.uid());
create policy api_keys_delete on public.api_keys
  for delete to authenticated using (public.is_owner(org_id));

-- Defesa extra: anon não toca em nada; authenticated não atualiza.
revoke all on public.api_keys from anon;
revoke update on public.api_keys from authenticated;

-- Máximo de 5 chaves por organização.
create or replace function public.enforce_api_key_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Serializa inserções concorrentes da mesma organização.
  perform 1 from public.organizations where id = new.org_id for update;
  if (select count(*) from public.api_keys where org_id = new.org_id) >= 5 then
    raise exception 'Limite de 5 chaves de API por organização atingido.'
      using errcode = 'P0001', hint = 'api_key_limit';
  end if;
  return new;
end;
$$;

create trigger api_keys_limit
  before insert on public.api_keys
  for each row execute function public.enforce_api_key_limit();

-- A conta demo (compartilhada) não cria chaves de API.
create or replace function public.api_keys_demo_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_demo_user(auth.uid()) then
    raise exception 'Indisponível na demo pública.' using errcode = 'P0001', hint = 'demo';
  end if;
  return new;
end;
$$;

create trigger api_keys_demo_guard_insert
  before insert on public.api_keys
  for each row execute function public.api_keys_demo_guard_insert();
