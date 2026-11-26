-- Endereços antigos do cardápio: quando o endereço muda, o antigo continua levando ao restaurante
-- (links e QR Codes impressos) e fica reservado para ele. Não altera dados existentes.

create table public.restaurant_slug_history (
  slug extensions.citext primary key,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  changed_at timestamptz not null default now()
);
create index restaurant_slug_history_restaurant_idx on public.restaurant_slug_history (restaurant_id);

-- Ninguém lê nem grava direto: só as funções abaixo.
alter table public.restaurant_slug_history enable row level security;
revoke all on table public.restaurant_slug_history from public, anon, authenticated;

create or replace function public.menzu_keep_old_slug()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if exists (
    select 1 from public.restaurant_slug_history h
    where h.slug operator(extensions.=) new.slug::extensions.citext
      and h.restaurant_id <> new.id
  ) then
    -- Mesmo código de endereço repetido, que o painel já trata como "em uso".
    raise unique_violation using message = 'MENZU:SLUG_TAKEN';
  end if;

  if tg_op = 'UPDATE' then
    -- Voltando a um endereço que já foi seu: ele deixa de ser "antigo".
    delete from public.restaurant_slug_history h
      where h.slug operator(extensions.=) new.slug::extensions.citext;
    if old.slug::text is distinct from new.slug::text
       and lower(old.slug::text) <> lower(new.slug::text) then
      insert into public.restaurant_slug_history (slug, restaurant_id)
      values (old.slug, old.id)
      on conflict (slug) do nothing;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.menzu_keep_old_slug() from public, anon, authenticated;

-- INSERT: BEFORE basta para recusar. UPDATE: AFTER, para o restaurante já ter o endereço novo.
create trigger menzu_keep_old_slug_insert
  before insert on public.restaurants
  for each row execute function public.menzu_keep_old_slug();
create trigger menzu_keep_old_slug_update
  after update of slug on public.restaurants
  for each row execute function public.menzu_keep_old_slug();

-- A checagem de disponibilidade passa a considerar também os endereços antigos de outros restaurantes.
create or replace function public.is_slug_available(p_slug text, p_restaurant_id uuid default null::uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select not exists (
    select 1 from public.restaurants r
    where r.slug operator(extensions.=) lower(btrim(coalesce(p_slug, '')))::extensions.citext
      and (p_restaurant_id is null or r.id <> p_restaurant_id)
  ) and not exists (
    select 1 from public.restaurant_slug_history h
    where h.slug operator(extensions.=) lower(btrim(coalesce(p_slug, '')))::extensions.citext
      and (p_restaurant_id is null or h.restaurant_id <> p_restaurant_id)
  );
$$;

-- Usada pelo cardápio público: endereço antigo -> endereço atual (ou nulo).
create or replace function public.resolve_old_slug(p_slug text)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select r.slug::text
  from public.restaurant_slug_history h
  join public.restaurants r on r.id = h.restaurant_id
  where h.slug operator(extensions.=) lower(btrim(coalesce(p_slug, '')))::extensions.citext;
$$;
revoke all on function public.resolve_old_slug(text) from public;
grant execute on function public.resolve_old_slug(text) to anon, authenticated;
