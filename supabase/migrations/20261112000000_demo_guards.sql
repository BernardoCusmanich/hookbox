-- Proteções da conta demo no banco (além das Server Actions).
--
-- Todos os triggers só agem quando quem chama é a conta demo (auth.uid() não nulo e
-- is_demo_user). Seed e cron usam a service role (auth.uid() nulo) e não são afetados.
-- As funções são security definer porque is_demo_user não tem execute para authenticated.

-- Na demo, o encaminhamento e o segredo de assinatura não podem ser alterados.
-- Mudar só o nome continua permitido (a action manda forward_* mesmo assim, por isso
-- a comparação é por "is distinct from").
create or replace function public.endpoints_demo_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_demo_user(auth.uid()) then
    if new.forward_url is distinct from old.forward_url
       or new.forward_enabled is distinct from old.forward_enabled
       or new.secret_ciphertext is distinct from old.secret_ciphertext then
      raise exception 'Indisponível na demo pública.' using errcode = 'P0001', hint = 'demo';
    end if;
  end if;
  return new;
end;
$$;

create trigger endpoints_demo_guard_update
  before update on public.endpoints
  for each row execute function public.endpoints_demo_guard_update();

-- Endpoints criados na demo não podem nascer com encaminhamento.
create or replace function public.endpoints_demo_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_demo_user(auth.uid()) then
    if new.forward_url is not null or new.forward_enabled then
      raise exception 'Indisponível na demo pública.' using errcode = 'P0001', hint = 'demo';
    end if;
  end if;
  return new;
end;
$$;

create trigger endpoints_demo_guard_insert
  before insert on public.endpoints
  for each row execute function public.endpoints_demo_guard_insert();

-- Os endpoints de exemplo da demo não podem ser excluídos.
-- A lista de slugs replica DEMO_ENDPOINT_SLUGS de lib/demo-constants.ts.
create or replace function public.endpoints_demo_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_demo_user(auth.uid())
     and old.slug in ('demopedidos1', 'demobridge01') then
    raise exception 'Indisponível na demo pública.' using errcode = 'P0001', hint = 'demo';
  end if;
  return old;
end;
$$;

create trigger endpoints_demo_guard_delete
  before delete on public.endpoints
  for each row execute function public.endpoints_demo_guard_delete();

-- A organização demo não pode ser alterada nem excluída pela conta demo.
create or replace function public.organizations_demo_guard_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_demo and auth.uid() is not null and public.is_demo_user(auth.uid()) then
    raise exception 'Indisponível na demo pública.' using errcode = 'P0001', hint = 'demo';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger organizations_demo_guard_change
  before update or delete on public.organizations
  for each row execute function public.organizations_demo_guard_change();
