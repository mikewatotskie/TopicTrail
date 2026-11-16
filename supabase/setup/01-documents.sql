-- Immutable document metadata and private per-account file storage.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
begin
  if current_user <> 'postgres' or current_database() <> 'postgres' then
    raise exception 'Deployment requires the reviewed postgres creator/database';
  end if;
  if to_regclass('public.topictrail_cloud_documents') is not null then
    raise exception 'Cloud table already exists; review its schema before proceeding';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'Expected Supabase Storage schema is unavailable';
  end if;
  if not exists (select 1 from pg_class where oid = 'storage.objects'::regclass and relrowsecurity) then
    raise exception 'Storage RLS must already be enabled';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'storage'
    and table_name = 'objects' and column_name = 'owner_id' and data_type = 'text') then
    raise exception 'Expected Storage owner_id contract is unavailable';
  end if;
  if exists (select 1 from storage.buckets where id = 'topictrail-documents' or name = 'topictrail-documents') then
    raise exception 'Cloud bucket already exists; review its settings before proceeding';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and policyname like 'topictrail_cloud_%') then
    raise exception 'Cloud Storage policy names already exist; review before proceeding';
  end if;
end $$;

create table public.topictrail_cloud_documents (
  user_id uuid not null references auth.users(id) on delete restrict,
  id text not null check (id ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  title text not null check (char_length(title) between 1 and 512 and char_length(btrim(title)) > 0),
  format text not null check (format in ('pdf', 'docx')),
  byte_size bigint not null check (byte_size between 1 and 52428800),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  imported_at timestamptz not null check (isfinite(imported_at)),
  created_at timestamptz not null default now() check (isfinite(created_at)),
  object_path text generated always as (user_id::text || '/' || id || '.' || format) stored,
  primary key (user_id, id)
);
alter table public.topictrail_cloud_documents enable row level security;
alter table public.topictrail_cloud_documents force row level security;
-- Limit this new table only; do not alter default or shared-schema privileges.
revoke all on public.topictrail_cloud_documents from public, anon, authenticated;
grant select, insert on public.topictrail_cloud_documents to authenticated;
create policy topictrail_cloud_documents_select on public.topictrail_cloud_documents
for select to authenticated using (user_id = (select auth.uid()));
create policy topictrail_cloud_documents_insert on public.topictrail_cloud_documents
for insert to authenticated with check (
  user_id = (select auth.uid()) and exists (
    select 1 from storage.objects o
    where o.bucket_id = 'topictrail-documents'
      and o.name = topictrail_cloud_documents.user_id::text || '/' || topictrail_cloud_documents.id || '.' || topictrail_cloud_documents.format
      and o.owner_id = (select auth.uid())::text
      and o.metadata ->> 'size' = topictrail_cloud_documents.byte_size::text
      and o.metadata ->> 'mimetype' = case topictrail_cloud_documents.format when 'pdf' then 'application/pdf'
        else 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' end
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('topictrail-documents', 'topictrail-documents', false, 52428800,
  array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

create policy topictrail_cloud_objects_select on storage.objects for select to authenticated
using (bucket_id = 'topictrail-documents' and owner_id = (select auth.uid())::text
  and name ~ ('^' || (select auth.uid())::text || '/[a-z0-9][a-z0-9-]{0,127}\.(pdf|docx)$'));
create policy topictrail_cloud_objects_insert on storage.objects for insert to authenticated
with check (bucket_id = 'topictrail-documents' and owner_id = (select auth.uid())::text
  and name ~ ('^' || (select auth.uid())::text || '/[a-z0-9][a-z0-9-]{0,127}\.(pdf|docx)$'));

-- Restrictive guards ensure unrelated permissive policies cannot expose/overwrite this bucket.
-- They evaluate true for every other bucket, leaving unrelated policy behavior intact.
create policy topictrail_cloud_guard_select on storage.objects as restrictive for select to public
using (bucket_id <> 'topictrail-documents' or (owner_id = (select auth.uid())::text
  and name ~ ('^' || (select auth.uid())::text || '/[a-z0-9][a-z0-9-]{0,127}\.(pdf|docx)$')));
create policy topictrail_cloud_guard_insert on storage.objects as restrictive for insert to public
with check (bucket_id <> 'topictrail-documents' or (owner_id = (select auth.uid())::text
  and name ~ ('^' || (select auth.uid())::text || '/[a-z0-9][a-z0-9-]{0,127}\.(pdf|docx)$')));
create policy topictrail_cloud_guard_update on storage.objects as restrictive for update to public
using (bucket_id <> 'topictrail-documents') with check (bucket_id <> 'topictrail-documents');
create policy topictrail_cloud_guard_delete on storage.objects as restrictive for delete to public
using (bucket_id <> 'topictrail-documents');
commit;
