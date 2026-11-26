begin;
create table public.asaas_accounts (
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  environment text not null check (environment in ('sandbox', 'production')),
  account_id text not null,
  wallet_id uuid not null,
  encrypted_api_key text not null,
  created_at timestamptz not null default now(),
  primary key (restaurant_id, environment),
  unique (environment, account_id),
  unique (environment, wallet_id)
);
create table public.asaas_webhook_inbox (
  environment text not null check (environment in ('sandbox', 'production')),
  event_id text not null,
  event_type text not null,
  account_id text,
  resource_id text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (environment, event_id)
);
-- API credentials and webhook metadata are never accessible through browser sessions.
alter table public.asaas_accounts enable row level security;
alter table public.asaas_webhook_inbox enable row level security;
revoke all on public.asaas_accounts, public.asaas_webhook_inbox from anon, authenticated;
grant select, insert, update on public.asaas_accounts, public.asaas_webhook_inbox to service_role;
commit;
