-- Study-state synchronization and account-scoped mutation receipts.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
  if current_user <> 'postgres' or current_database() <> 'postgres' then
    raise exception 'Expected reviewed postgres database/creator';
  end if;
  if to_regclass('public.topictrail_cloud_documents') is null then raise exception 'Original document table missing'; end if;
  if to_regclass('public.topictrail_sync_records') is not null or to_regclass('public.topictrail_sync_receipts') is not null
    or exists(select 1 from pg_namespace where nspname='topictrail_sync_private')
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('topictrail_sync_apply','topictrail_sync_list')) then
    raise exception 'Sync objects already exist; inspect instead of overwriting';
  end if;
end $$;

create schema topictrail_sync_private;
revoke all on schema topictrail_sync_private from public, anon, authenticated, service_role;
grant usage on schema topictrail_sync_private to authenticated;

create table public.topictrail_sync_records (
  user_id uuid not null references auth.users(id) on delete restrict,
  kind text collate "C" not null check(kind in ('document','bookmark','progress')),
  id text collate "C" not null check(id ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  document_id text,
  revision bigint not null check(revision between 1 and 9007199254740991),
  restored_revision bigint not null default 0 check(restored_revision between 0 and revision),
  deleted boolean not null default false,
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=32768),
  updated_at timestamptz not null default now(),
  primary key(user_id,kind,id),
  foreign key(user_id,document_id) references public.topictrail_cloud_documents(user_id,id) on delete restrict,
  check((kind='bookmark' and document_id is null) or (kind in ('document','progress') and document_id=id))
);
create table public.topictrail_sync_receipts (
  user_id uuid not null references auth.users(id) on delete restrict,
  operation_id text not null check(char_length(operation_id) between 1 and 128 and operation_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=40000),
  result jsonb not null check(jsonb_typeof(result)='object' and octet_length(result::text)<=40000),
  created_at timestamptz not null default now(),
  primary key(user_id,operation_id)
);
alter table public.topictrail_sync_records enable row level security;
alter table public.topictrail_sync_records force row level security;
alter table public.topictrail_sync_receipts enable row level security;
alter table public.topictrail_sync_receipts force row level security;
revoke all on public.topictrail_sync_records, public.topictrail_sync_receipts from public, anon, authenticated, service_role;
grant select on public.topictrail_sync_records to authenticated;
create policy topictrail_sync_records_owner_read on public.topictrail_sync_records for select to authenticated
  using(user_id=(select auth.uid()));
-- Receipts are accessed only inside the owner-checking writer, never through direct client DML/SELECT.

create function topictrail_sync_private.valid_text(value jsonb, maximum integer) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_typeof(value)='string' and char_length(value#>>'{}') between 1 and maximum
    and char_length(btrim(value#>>'{}'))>0 and (value#>>'{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]',false)
$$;
create function topictrail_sync_private.valid_url(value jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
  select topictrail_sync_private.valid_text(value,2048)
    and (value#>>'{}') ~ '^https://[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+([/?#]|$)'
    and (value#>>'{}') !~ '[[:space:]]'
$$;
create function topictrail_sync_private.record_json(value public.topictrail_sync_records) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('kind',value.kind,'id',value.id,'revision',value.revision,'deleted',value.deleted,'payload',value.payload)
$$;

create function topictrail_sync_private.apply(p_mutation jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare
  actor uuid := auth.uid();
  operation text; entity text; entity_id text; action text; expected bigint; body jsonb;
  original public.topictrail_cloud_documents%rowtype;
  existing public.topictrail_sync_records%rowtype;
  document_state public.topictrail_sync_records%rowtype;
  prior_receipt public.topictrail_sync_receipts%rowtype;
  found_record boolean; response jsonb; authoritative jsonb; conflict boolean:=false;
  field text; attribute jsonb; next_revision bigint; doc_id text;
begin
  if actor is null then raise exception using errcode='28000',message='Authenticated account required'; end if;
  if p_mutation is null or jsonb_typeof(p_mutation)<>'object' or octet_length(p_mutation::text)>40000
    or not (p_mutation ?& array['operationId','kind','id','expectedRevision','action','payload'])
    or exists(select 1 from jsonb_object_keys(p_mutation) k where k not in ('operationId','kind','id','expectedRevision','action','payload')) then
    raise exception using errcode='22023',message='Invalid sync mutation';
  end if;
  if jsonb_typeof(p_mutation->'operationId')<>'string' or jsonb_typeof(p_mutation->'kind')<>'string'
    or jsonb_typeof(p_mutation->'id')<>'string' or jsonb_typeof(p_mutation->'action')<>'string'
    or jsonb_typeof(p_mutation->'expectedRevision')<>'number' or jsonb_typeof(p_mutation->'payload')<>'object'
    or (p_mutation->>'expectedRevision') !~ '^(0|[1-9][0-9]{0,15})$' then
    raise exception using errcode='22023',message='Invalid sync mutation types';
  end if;
  operation:=p_mutation->>'operationId'; entity:=p_mutation->>'kind'; entity_id:=p_mutation->>'id';
  action:=p_mutation->>'action'; expected:=(p_mutation->>'expectedRevision')::bigint; body:=p_mutation->'payload';
  if char_length(operation) not between 1 and 128 or operation !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'
    or entity not in ('document','bookmark','progress') or entity_id !~ '^[a-z0-9][a-z0-9-]{0,127}$'
    or action not in ('put','remove','restore') or expected>9007199254740991 or octet_length(body::text)>32768 then
    raise exception using errcode='22023',message='Invalid sync mutation bounds';
  end if;

  -- One transaction lock per account also serializes delete/progress races and bookmark quotas.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('topictrail-sync:'||actor::text,0));
  select * into prior_receipt from public.topictrail_sync_receipts where user_id=actor and operation_id=operation;
  if found then
    if prior_receipt.request<>p_mutation then raise exception using errcode='22023',message='Operation ID already used for a different mutation'; end if;
    return prior_receipt.result || jsonb_build_object('duplicate',true);
  end if;

  if entity in ('document','progress') then
    select * into original from public.topictrail_cloud_documents where user_id=actor and id=entity_id;
    if not found then raise exception using errcode='42501',message='Document unavailable to this account'; end if;
    doc_id:=entity_id;
  end if;
  select * into existing from public.topictrail_sync_records where user_id=actor and kind=entity and id=entity_id;
  found_record:=found;

  -- Validate new values, never trust a URL/title supplied by another account or a malformed client.
  if action in ('put','restore') then
    if entity='document' then
      if not topictrail_sync_private.valid_text(body->'title',512)
        or exists(select 1 from jsonb_object_keys(body) k where k<>'title') then
        raise exception using errcode='22023',message='Invalid document title';
      end if;
    elsif entity='progress' then
      if not(body ?& array['documentId','hash','readerVersion','format','page','totalPages'])
        or exists(select 1 from jsonb_object_keys(body) k where k not in ('documentId','hash','readerVersion','format','page','totalPages'))
        or jsonb_typeof(body->'documentId')<>'string' or body->>'documentId'<>entity_id
        or jsonb_typeof(body->'hash')<>'string' or body->>'hash'<>original.sha256
        or jsonb_typeof(body->'format')<>'string' or body->>'format'<>original.format
        or jsonb_typeof(body->'readerVersion')<>'number' or (body->>'readerVersion') !~ '^[1-9][0-9]{0,5}$'
        or jsonb_typeof(body->'page')<>'number' or (body->>'page') !~ '^[1-9][0-9]{0,5}$'
        or jsonb_typeof(body->'totalPages')<>'number' or (body->>'totalPages') !~ '^[1-9][0-9]{0,5}$' then
        raise exception using errcode='22023',message='Invalid reading position';
      end if;
      if (body->>'page')::integer>(body->>'totalPages')::integer or (body->>'totalPages')::integer>100000
        or (body->>'readerVersion')::integer>100000 then
        raise exception using errcode='22023',message='Reading position outside bounds';
      end if;
    else
      if not(body ?& array['id','savedAt','url','title','providerId','providerName','type'])
        or exists(select 1 from jsonb_object_keys(body) k where k not in ('id','savedAt','url','title','providerId','providerName','type','description','topic','attribution'))
        or jsonb_typeof(body->'id')<>'string' or body->>'id'<>entity_id
        or not topictrail_sync_private.valid_url(body->'url')
        or entity_id<>'bookmark-'||pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body->>'url','UTF8')),'hex')
        or body->>'type'<>'Article' or jsonb_typeof(body->'type')<>'string'
        or not topictrail_sync_private.valid_text(body->'title',300)
        or not topictrail_sync_private.valid_text(body->'providerId',80)
        or not topictrail_sync_private.valid_text(body->'providerName',120)
        or jsonb_typeof(body->'savedAt')<>'string' or (body->>'savedAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
        raise exception using errcode='22023',message='Invalid bookmark metadata';
      end if;
      -- Cast rejects invalid calendar dates, not merely malformed timestamp strings.
      if not isfinite((body->>'savedAt')::timestamptz) then raise exception using errcode='22023',message='Invalid bookmark date'; end if;
      if (body ? 'description' and not topictrail_sync_private.valid_text(body->'description',2000))
        or (body ? 'topic' and not topictrail_sync_private.valid_text(body->'topic',140)) then
        raise exception using errcode='22023',message='Invalid optional bookmark metadata';
      end if;
      if body ? 'attribution' then
        attribute:=body->'attribution';
        if jsonb_typeof(attribute)<>'object' then raise exception using errcode='22023',message='Invalid attribution'; end if;
        if not(attribute ?& array['author','licenseName','licenseUrl','sourceUrl'])
          or exists(select 1 from jsonb_object_keys(attribute) k where k not in ('author','licenseName','licenseUrl','sourceUrl','revisionUrl'))
          or not topictrail_sync_private.valid_text(attribute->'author',300)
          or not topictrail_sync_private.valid_text(attribute->'licenseName',120)
          or not topictrail_sync_private.valid_url(attribute->'licenseUrl')
          or not topictrail_sync_private.valid_url(attribute->'sourceUrl')
          or (attribute ? 'revisionUrl' and not topictrail_sync_private.valid_url(attribute->'revisionUrl')) then
          raise exception using errcode='22023',message='Invalid attribution';
        end if;
      end if;
    end if;
  end if;

  if found_record then
    authoritative:=topictrail_sync_private.record_json(existing);
  else
    authoritative:=jsonb_build_object('kind',entity,'id',entity_id,'revision',0,'deleted',entity<>'document',
      'payload',case when entity='document' then jsonb_build_object('title',original.title) else '{}'::jsonb end);
  end if;

  if entity='progress' then
    select * into document_state from public.topictrail_sync_records where user_id=actor and kind='document' and id=entity_id;
    if found and document_state.deleted then
      authoritative:=authoritative || jsonb_build_object('deleted',true);
      conflict:=true;
    end if;
  end if;
  if not conflict then
    if action='remove' then
      -- A removal beats concurrent ordinary edits, but never a later explicit restoration.
      conflict:=expected>coalesce(existing.revision,0) or expected<coalesce(existing.restored_revision,0);
    elsif action='restore' then
      conflict:=not found_record or not existing.deleted or expected<>existing.revision;
    else
      conflict:=expected<>coalesce(existing.revision,0) or coalesce(existing.deleted,false);
    end if;
  end if;

  if conflict then
    response:=jsonb_build_object('status','conflict','record',authoritative);
  elsif action='remove' and found_record and existing.deleted then
    response:=jsonb_build_object('status','applied','record',authoritative);
  else
    if entity='bookmark' and action<>'remove' and (not found_record or existing.deleted)
      and (select count(*) from public.topictrail_sync_records where user_id=actor and kind='bookmark' and not deleted)>=500 then
      raise exception using errcode='22023',message='Saved resource library is full';
    end if;
    next_revision:=coalesce(existing.revision,0)+1;
    if next_revision>9007199254740991 then raise exception using errcode='22003',message='Revision exhausted'; end if;
    if action='remove' then body:=authoritative->'payload'; end if;
    insert into public.topictrail_sync_records(user_id,kind,id,document_id,revision,restored_revision,deleted,payload)
      values(actor,entity,entity_id,doc_id,next_revision,
        case when action='restore' then next_revision else coalesce(existing.restored_revision,0) end,action='remove',body)
      on conflict(user_id,kind,id) do update set revision=excluded.revision, restored_revision=excluded.restored_revision,
        deleted=excluded.deleted,payload=excluded.payload,updated_at=now()
      returning * into existing;
    if entity='document' and action in ('remove','restore') then
      -- Preserve the locator while hiding it in Trash; explicit restore reactivates it.
      update public.topictrail_sync_records set deleted=(action='remove'),revision=revision+1,
        restored_revision=case when action='restore' then revision+1 else restored_revision end,updated_at=now()
        where user_id=actor and kind='progress' and id=entity_id and deleted<>(action='remove');
    end if;
    response:=jsonb_build_object('status','applied','record',topictrail_sync_private.record_json(existing));
  end if;
  insert into public.topictrail_sync_receipts(user_id,operation_id,request,result) values(actor,operation,p_mutation,response);
  return response;
end $$;

create function public.topictrail_sync_apply(p_mutation jsonb) returns jsonb
language sql security invoker set search_path='' as $$
  select topictrail_sync_private.apply(p_mutation)
$$;
create function public.topictrail_sync_list(p_after_kind text default '',p_after_id text default '',p_limit integer default 100) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare actor uuid:=auth.uid(); answer jsonb;
begin
  if actor is null then raise exception using errcode='28000',message='Authenticated account required'; end if;
  if p_limit is null or p_limit not between 1 and 200 or p_after_kind is null or p_after_id is null
    or p_after_kind not in ('','bookmark','document','progress') or char_length(p_after_id)>128
    or (p_after_id<>'' and p_after_id !~ '^[a-z0-9][a-z0-9-]{0,127}$') then
    raise exception using errcode='22023',message='Invalid state cursor';
  end if;
  select coalesce(jsonb_agg(topictrail_sync_private.record_json(r::public.topictrail_sync_records) order by r.kind,r.id),'[]'::jsonb) into answer
  from (select * from public.topictrail_sync_records
    where user_id=actor and (kind,id)>(p_after_kind collate "C",p_after_id collate "C")
    order by kind,id limit p_limit) r;
  return answer;
end $$;

-- Every function receives explicit ACLs, preserving the project's hardened default privileges.
revoke all on function topictrail_sync_private.valid_text(jsonb,integer), topictrail_sync_private.valid_url(jsonb),
  topictrail_sync_private.record_json(public.topictrail_sync_records), topictrail_sync_private.apply(jsonb),
  public.topictrail_sync_apply(jsonb), public.topictrail_sync_list(text,text,integer) from public, anon, authenticated, service_role;
grant execute on function topictrail_sync_private.record_json(public.topictrail_sync_records), topictrail_sync_private.apply(jsonb),
  public.topictrail_sync_apply(jsonb), public.topictrail_sync_list(text,text,integer) to authenticated;
notify pgrst,'reload schema';
commit;
