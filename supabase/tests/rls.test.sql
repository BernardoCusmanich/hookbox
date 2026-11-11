-- Testes de RLS, RPCs e triggers. Rode com: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- Usuários de teste --------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com', now(), '{}', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com',   now(), '{}', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.com', null,  '{}', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000d', 'demo@example.com',  now(), '{"hookbox_demo": true}', 'authenticated', 'authenticated');

create function pg_temp.login(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;
create function pg_temp.logout() returns void language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- create_organization -------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select lives_ok($$ select public.create_organization('Acme Ação') $$, 'alice cria organização pela RPC');
select is((select slug from public.organizations), 'acme-acao', 'slug gerado sem acento');
select is((select role from public.memberships where user_id = auth.uid()), 'owner', 'criador vira owner');
select throws_ok(
  $$ insert into public.organizations (name, slug) values ('X', 'x') $$,
  '42501', null, 'insert direto em organizations é negado'
);
select lives_ok($$ select public.create_organization('Acme Ação') $$, 'segundo nome igual ganha sufixo');
select is((select count(*)::int from public.organizations where slug like 'acme-acao-%'), 1, 'slug com sufixo aleatório');

-- Isolamento entre tenants --------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.organizations), 0, 'bob não vê orgs da alice');
select is((select count(*)::int from public.memberships), 0, 'bob não vê memberships da alice');
select lives_ok($$ select public.create_organization('Bob Corp') $$, 'bob cria a própria org');
select is((select count(*)::int from public.organizations), 1, 'bob vê só a própria org');

select throws_ok(
  format($$ insert into public.endpoints (org_id, name, slug) values (%L, 'x', 'aaaaaaaaaaaa') $$,
    (select id from public.organizations where slug = 'acme-acao')),
  '42501', null, 'bob não cria endpoint na org da alice'
);
select throws_ok(
  format($$ insert into public.memberships (org_id, user_id, role) values (%L, auth.uid(), 'owner') $$,
    (select o.id from public.organizations o where o.slug = 'acme-acao')),
  '42501', null, 'bob não se adiciona na org da alice'
);

-- Endpoints e limite de 5 ---------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select lives_ok(
  $$ insert into public.endpoints (org_id, name, slug)
     select o.id, 'ep' || g, lpad(g::text, 12, 'e') from public.organizations o, generate_series(1, 5) g
     where o.slug = 'acme-acao' $$,
  'alice cria 5 endpoints'
);
select throws_ok(
  $$ insert into public.endpoints (org_id, name, slug)
     select o.id, 'ep6', 'eeeeeeeeeee6' from public.organizations o where o.slug = 'acme-acao' $$,
  'P0001', 'Limite de 5 endpoints por organização atingido.', 'sexto endpoint é barrado pelo trigger'
);
select throws_ok(
  $$ insert into public.endpoints (org_id, name, slug)
     select o.id, 'bad', 'ABC' from public.organizations o where o.slug like 'acme-acao-%' $$,
  '23514', null, 'slug fora do formato é rejeitado'
);

-- requests: só leitura para usuários ---------------------------------------
select throws_ok(
  $$ insert into public.requests (endpoint_id, org_id, method, path, signature_status)
     select e.id, e.org_id, 'POST', '/', 'missing' from public.endpoints e limit 1 $$,
  '42501', null, 'usuário não insere em requests'
);

select pg_temp.logout();
insert into public.requests (endpoint_id, org_id, method, path, signature_status)
  select e.id, e.org_id, 'POST', '/', 'missing' from public.endpoints e;
insert into public.deliveries (request_id, org_id, attempt, status_code)
  select r.id, r.org_id, 1, 200 from public.requests r;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select is((select count(*)::int from public.requests), 5, 'alice vê os requests da org');
select is((select count(*)::int from public.deliveries), 5, 'alice vê as entregas da org');
select is((select sum(total)::int from public.endpoint_request_counts(
  (select id from public.organizations where slug = 'acme-acao'))), 5, 'contagem de 24 h');
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.requests), 0, 'bob não vê requests da alice');
select is((select count(*)::int from public.deliveries), 0, 'bob não vê entregas da alice');

-- Convites ------------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
insert into public.invites (org_id, email, token, role, expires_at, created_by)
  select id, 'bob@example.com', 'tok-bob', 'member', now() + interval '7 days', auth.uid()
  from public.organizations where slug = 'acme-acao';
insert into public.invites (org_id, email, token, role, expires_at, created_by)
  select id, 'carol@example.com', 'tok-carol', 'member', now() + interval '7 days', auth.uid()
  from public.organizations where slug = 'acme-acao';

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.invites), 0, 'não-owner não lê convites');
select throws_ok($$ select public.accept_invite('tok-carol') $$, 'P0001',
  'O e-mail da conta não corresponde ao convite.', 'convite de outro e-mail é recusado');
select is(public.accept_invite('tok-bob'), 'acme-acao', 'bob aceita o próprio convite');
select is((select count(*)::int from public.organizations), 2, 'bob agora vê as duas orgs');
select throws_ok($$ select public.accept_invite('tok-bob') $$, 'P0001', 'Convite já utilizado.', 'convite não é reutilizável');

select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select throws_ok($$ select public.accept_invite('tok-carol') $$, 'P0001',
  'O e-mail da conta não corresponde ao convite.', 'e-mail não confirmado não aceita convite');

-- Membro comum não muda papéis nem a org -----------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
update public.memberships set role = 'owner'
  where user_id = auth.uid() and org_id = (select id from public.organizations where slug = 'acme-acao');
select is(
  (select role from public.memberships where user_id = auth.uid()
     and org_id = (select id from public.organizations where slug = 'acme-acao')),
  'member', 'membro não se promove a owner'
);

-- Último owner --------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select throws_ok(
  $$ delete from public.memberships where user_id = auth.uid()
     and org_id = (select id from public.organizations where slug = 'acme-acao') $$,
  'P0001', 'A organização precisa ter pelo menos um owner.', 'não remove o último owner'
);
select throws_ok(
  $$ update public.memberships set role = 'member' where user_id = auth.uid()
     and org_id = (select id from public.organizations where slug = 'acme-acao') $$,
  'P0001', 'A organização precisa ter pelo menos um owner.', 'não rebaixa o último owner'
);
select lives_ok(
  $$ delete from public.organizations where slug like 'acme-acao-%' $$,
  'owner apaga a org (cascade passa pelo trigger de último owner)'
);

-- Conta demo ----------------------------------------------------------------
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select throws_ok($$ select public.create_organization('Spam') $$, 'P0001',
  'A conta demo não pode criar organizações.', 'demo não cria organizações');
select pg_temp.logout();
update auth.users set encrypted_password = 'trocada', email = 'hacker@example.com'
  where id = '00000000-0000-0000-0000-00000000000d';
select is((select email from auth.users where id = '00000000-0000-0000-0000-00000000000d'),
  'demo@example.com', 'e-mail da conta demo não muda');

select * from finish();
rollback;
