-- Transformação de payload: template JSON opcional por endpoint (ver lib/transform.ts).
alter table public.endpoints
  add column transform_template text
  check (transform_template is null or char_length(transform_template) <= 10000);

-- Na demo, o template também não pode ser alterado (mesma regra do encaminhamento e do segredo).
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
       or new.secret_ciphertext is distinct from old.secret_ciphertext
       or new.transform_template is distinct from old.transform_template then
      raise exception 'Indisponível na demo pública.' using errcode = 'P0001', hint = 'demo';
    end if;
  end if;
  return new;
end;
$$;

-- Endpoints criados na demo não podem nascer com template.
create or replace function public.endpoints_demo_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_demo_user(auth.uid()) then
    if new.forward_url is not null or new.forward_enabled or new.transform_template is not null then
      raise exception 'Indisponível na demo pública.' using errcode = 'P0001', hint = 'demo';
    end if;
  end if;
  return new;
end;
$$;
