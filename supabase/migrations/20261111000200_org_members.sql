-- Lista os membros de uma organização com e-mail e nome (auth.users não é exposto via RLS).
-- Só devolve linhas se quem chama for membro da organização.
create or replace function public.org_members(org uuid)
returns table (user_id uuid, email text, name text, avatar_url text, role text, created_at timestamptz)
language sql
security definer
stable
set search_path = public
as $$
  select m.user_id,
         u.email::text,
         coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', u.raw_user_meta_data ->> 'user_name'),
         u.raw_user_meta_data ->> 'avatar_url',
         m.role,
         m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.org_id = org and public.is_member(org)
  order by m.created_at;
$$;

revoke execute on function public.org_members(uuid) from public, anon;
grant execute on function public.org_members(uuid) to authenticated;
