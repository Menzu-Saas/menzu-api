-- CPF do comprador, cifrado no servidor (AES-256-GCM). Nunca acessível pelo navegador:
-- sem policies e sem privilégios para anon/authenticated; apenas o service_role lê e grava.
-- O CPF é necessário para criar o cliente no Asaas, por isso não pode ser um hash de mão única.
create table public.buyer_documents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_cpf text not null,
  cpf_last3 text not null check (cpf_last3 ~ '^[0-9]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.buyer_documents enable row level security;
revoke all on public.buyer_documents from anon, authenticated;
grant select, insert, update, delete on public.buyer_documents to service_role;
