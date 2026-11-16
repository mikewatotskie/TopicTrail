-- Versioned annotations attached to immutable documents.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin
  if current_user<>'postgres' or current_database()<>'postgres' then raise exception 'Expected reviewed postgres creator/database'; end if;
  if to_regclass('public.topictrail_cloud_documents') is null or to_regclass('public.topictrail_sync_records') is null then
    raise exception 'Required immutable originals and legacy study state are missing';
  end if;
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='topictrail_sync_private'
    and p.proname='apply' and position('hashtextextended(''topictrail-sync:''||actor::text,0)' in p.prosrc)>0) then
    raise exception 'Legacy account lock contract changed; inspect before deployment';
  end if;
  if to_regclass('public.topictrail_annotations_v1_records') is not null or to_regclass('public.topictrail_annotations_v1_receipts') is not null
    or exists(select 1 from pg_namespace where nspname='topictrail_annotations_v1_private')
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('topictrail_annotations_v1_list','topictrail_annotations_v1_apply')) then
    raise exception 'Annotation v1 objects already exist; inspect instead of overwriting';
  end if;
end $$;

create schema topictrail_annotations_v1_private;
revoke all on schema topictrail_annotations_v1_private from public,anon,authenticated,service_role;
grant usage on schema topictrail_annotations_v1_private to authenticated;

create table public.topictrail_annotations_v1_records (
  user_id uuid not null references auth.users(id) on delete restrict,
  id text collate "C" not null check(id ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  document_id text, document_hash text,
  revision bigint not null check(revision between 1 and 9007199254740991),
  deleted boolean not null default false,
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=32768),
  updated_at timestamptz not null default now(),
  primary key(user_id,id),
  foreign key(user_id,document_id) references public.topictrail_cloud_documents(user_id,id) on delete restrict,
  check((document_id is null and document_hash is null) or (document_id is not null and document_hash ~ '^[a-f0-9]{64}$')),
  check(payload->>'id'=id),
  check((payload->>'documentId') is not distinct from document_id),
  check((payload->>'documentHash') is not distinct from document_hash)
);
create index topictrail_annotations_v1_parent on public.topictrail_annotations_v1_records(user_id,document_id) where document_id is not null;
create table public.topictrail_annotations_v1_receipts (
  user_id uuid not null references auth.users(id) on delete restrict,
  operation_id text not null check(operation_id ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  request jsonb not null check(jsonb_typeof(request)='object' and octet_length(request::text)<=40000),
  result jsonb not null check(jsonb_typeof(result)='object' and octet_length(result::text)<=40000),
  created_at timestamptz not null default now(),
  primary key(user_id,operation_id)
);
alter table public.topictrail_annotations_v1_records enable row level security;
alter table public.topictrail_annotations_v1_records force row level security;
alter table public.topictrail_annotations_v1_receipts enable row level security;
alter table public.topictrail_annotations_v1_receipts force row level security;
revoke all on public.topictrail_annotations_v1_records,public.topictrail_annotations_v1_receipts from public,anon,authenticated,service_role;
grant select on public.topictrail_annotations_v1_records to authenticated;
create policy topictrail_annotations_v1_owner_read on public.topictrail_annotations_v1_records for select to authenticated
  using(user_id=(select auth.uid()));
-- No direct client DML and no receipt SELECT/DML permissions.

create function topictrail_annotations_v1_private.utf16_length(value text) returns integer
language sql immutable security invoker set search_path='' as $$
  select coalesce(sum(case when ascii(codepoint)>65535 then 2 else 1 end),0)::integer
  from regexp_split_to_table(value,'') as characters(codepoint) where codepoint<>''
$$;
create function topictrail_annotations_v1_private.not_blank(value text) returns boolean
language sql immutable security invoker set search_path='' as $$
  -- ECMAScript String.trim whitespace, including NBSP and BOM, not locale-dependent.
  select coalesce(length(btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0,false)
$$;
create function topictrail_annotations_v1_private.string_punctuation(value jsonb) returns integer
language plpgsql immutable security invoker set search_path='' as $$
declare child jsonb;total integer:=0;content text;
begin
  if jsonb_typeof(value)='string' then
    content:=value#>>'{}';return length(content)-length(translate(content,',:',''));
  elsif jsonb_typeof(value)='object' then
    for child in select v from jsonb_each(value) as entries(k,v) loop total:=total+topictrail_annotations_v1_private.string_punctuation(child);end loop;
  elsif jsonb_typeof(value)='array' then
    for child in select * from jsonb_array_elements(value) loop total:=total+topictrail_annotations_v1_private.string_punctuation(child);end loop;
  end if;
  return total;
end $$;
create function topictrail_annotations_v1_private.text_ok(value jsonb,maximum integer,allow_empty boolean default true) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_typeof(value)='string' and topictrail_annotations_v1_private.utf16_length(value#>>'{}')<=maximum
    and (allow_empty or topictrail_annotations_v1_private.not_blank(value#>>'{}'))
    and (value#>>'{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]',false)
$$;
create function topictrail_annotations_v1_private.exact_keys(value jsonb,names text[]) returns boolean
language sql immutable security invoker set search_path='' as $$
  select coalesce(jsonb_typeof(value)='object' and value ?& names
    and not exists(select 1 from jsonb_object_keys(value) key where not(key=any(names))),false)
$$;
create function topictrail_annotations_v1_private.valid_payload(body jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare anchor jsonb; location jsonb; item jsonb; value jsonb; name text; idx integer; seen text[]:='{}';
  rectangle double precision[]:='{}'; page_box double precision[]:='{}'; expected_unit text;
begin
  if body is null or not topictrail_annotations_v1_private.exact_keys(body,array['id','documentId','documentHash','format','location','anchor','title','body','color','createdAt','updatedAt'])
    or octet_length(body::text)>32768 then return false; end if;
  -- Mirror the client's conservative comma/colon estimate. PostgreSQL's
  -- non-exponent numeric rendering may be larger; rejecting it is also safe.
  if octet_length(body::text)+topictrail_annotations_v1_private.string_punctuation(body)>32768 then return false; end if;
  if jsonb_typeof(body->'id') is distinct from 'string' or (body->>'id') !~ '^[a-z0-9][a-z0-9-]{0,127}$'
    or not topictrail_annotations_v1_private.text_ok(body->'title',512)
    or not topictrail_annotations_v1_private.text_ok(body->'body',16000)
    or jsonb_typeof(body->'color') is distinct from 'string' or (body->>'color') not in ('yellow','green','blue','purple') then return false; end if;
  foreach name in array array['createdAt','updatedAt'] loop
    if jsonb_typeof(body->name) is distinct from 'string' or (body->>name) !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      or not isfinite((body->>name)::timestamptz)
      or to_char((body->>name)::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>body->>name then return false; end if;
  end loop;
  if body->'documentId'='null'::jsonb then
    if body->'documentHash'<>'null'::jsonb or body->'format'<>'null'::jsonb or body->'location'<>'null'::jsonb or body->'anchor'<>'null'::jsonb then return false; end if;
  else
    if jsonb_typeof(body->'documentId') is distinct from 'string' or (body->>'documentId') !~ '^[a-z0-9][a-z0-9-]{0,127}$'
      or jsonb_typeof(body->'documentHash') is distinct from 'string' or (body->>'documentHash') !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(body->'format') is distinct from 'string' or (body->>'format') not in ('pdf','docx','pptx') then return false; end if;
    location:=body->'location';anchor:=body->'anchor';
    if location<>'null'::jsonb then
      expected_unit:=case body->>'format' when 'pdf' then 'page' when 'docx' then 'section' else 'slide' end;
      if not topictrail_annotations_v1_private.exact_keys(location,array['unit','index'])
        or location->>'unit' is distinct from expected_unit or jsonb_typeof(location->'index') is distinct from 'number'
        or (location->>'index') !~ '^[1-9][0-9]{0,5}$' or (location->>'index')::integer>100000 then return false; end if;
    end if;
    if anchor<>'null'::jsonb then
      if location='null'::jsonb or jsonb_typeof(anchor) is distinct from 'object' or anchor->'version' is distinct from '1'::jsonb then return false; end if;
      if anchor->>'kind'='text' then
        if not topictrail_annotations_v1_private.exact_keys(anchor,array['kind','version','surface','textHash','ranges','quote','prefix','suffix'])
          or jsonb_typeof(anchor->'surface') is distinct from 'string'
          or not(anchor->>'surface'=(body->>'format')||'-text' or (body->>'format'='pdf' and anchor->>'surface'='ocr-text'))
          or jsonb_typeof(anchor->'textHash') is distinct from 'string' or (anchor->>'textHash') !~ '^[a-f0-9]{64}$'
          or not topictrail_annotations_v1_private.text_ok(anchor->'quote',6000,false)
          or not topictrail_annotations_v1_private.text_ok(anchor->'prefix',256)
          or not topictrail_annotations_v1_private.text_ok(anchor->'suffix',256)
          or jsonb_typeof(anchor->'ranges') is distinct from 'array' or jsonb_array_length(anchor->'ranges') not between 1 and 128 then return false; end if;
        for item in select * from jsonb_array_elements(anchor->'ranges') loop
          if not topictrail_annotations_v1_private.exact_keys(item,array['blockId','startUtf16','endUtf16'])
            or not topictrail_annotations_v1_private.text_ok(item->'blockId',128,false)
            or (item->>'blockId')=any(seen)
            or jsonb_typeof(item->'startUtf16') is distinct from 'number' or (item->>'startUtf16') !~ '^(0|[1-9][0-9]{0,7})$'
            or jsonb_typeof(item->'endUtf16') is distinct from 'number' or (item->>'endUtf16') !~ '^[1-9][0-9]{0,7}$'
            or (item->>'startUtf16')::integer >= (item->>'endUtf16')::integer or (item->>'endUtf16')::integer>10000000 then return false; end if;
          seen:=array_append(seen,item->>'blockId');
        end loop;
      elsif anchor->>'kind'='region' then
        if body->>'format'<>'pdf' or not topictrail_annotations_v1_private.exact_keys(anchor,array['kind','version','rect','pageBox']) then return false; end if;
        foreach name in array array['rect','pageBox'] loop
          if jsonb_typeof(anchor->name) is distinct from 'array' or jsonb_array_length(anchor->name)<>4 then return false; end if;
          for idx in 0..3 loop
            value:=anchor->name->idx;
            if jsonb_typeof(value) is distinct from 'number' or abs((value#>>'{}')::numeric)>1000000000 then return false; end if;
            -- Validate with the same IEEE-754 precision as JS. Tiny/nearby
            -- decimal values must not form a rectangle that collapses on read.
            if name='rect' then rectangle:=array_append(rectangle,(value#>>'{}')::double precision);else page_box:=array_append(page_box,(value#>>'{}')::double precision);end if;
          end loop;
        end loop;
        if rectangle[1]>=rectangle[3] or rectangle[2]>=rectangle[4] or page_box[1]>=page_box[3] or page_box[2]>=page_box[4]
          or rectangle[1]<page_box[1] or rectangle[2]<page_box[2] or rectangle[3]>page_box[3] or rectangle[4]>page_box[4] then return false; end if;
      else return false;
      end if;
    end if;
  end if;
  if body->'anchor'='null'::jsonb and not topictrail_annotations_v1_private.not_blank(body->>'body') then return false; end if;
  return true;
exception when others then return false;
end $$;
create function topictrail_annotations_v1_private.record_json(value public.topictrail_annotations_v1_records) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_object('id',value.id,'revision',value.revision,'deleted',value.deleted,'payload',value.payload)
$$;

create function topictrail_annotations_v1_private.apply(p_mutation jsonb) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='5s' as $$
declare actor uuid:=auth.uid(); operation text; entity_id text; action text; expected bigint; body jsonb;
  original public.topictrail_cloud_documents%rowtype;
  existing public.topictrail_annotations_v1_records%rowtype;
  receipt public.topictrail_annotations_v1_receipts%rowtype;
  found_record boolean; parent_deleted boolean:=false; conflict boolean:=false; authoritative jsonb; response jsonb;
  next_revision bigint; doc_id text; doc_hash text;
begin
  if actor is null then raise exception using errcode='28000',message='Authenticated account required'; end if;
  if p_mutation is null or not topictrail_annotations_v1_private.exact_keys(p_mutation,array['operationId','id','expectedRevision','action','payload'])
    or octet_length(p_mutation::text)>40000 then raise exception using errcode='22023',message='Invalid annotation mutation'; end if;
  if jsonb_typeof(p_mutation->'operationId') is distinct from 'string' or (p_mutation->>'operationId') !~ '^[a-z0-9][a-z0-9-]{0,127}$'
    or jsonb_typeof(p_mutation->'id') is distinct from 'string' or (p_mutation->>'id') !~ '^[a-z0-9][a-z0-9-]{0,127}$'
    or jsonb_typeof(p_mutation->'expectedRevision') is distinct from 'number' or (p_mutation->>'expectedRevision') !~ '^(0|[1-9][0-9]{0,15})$'
    or jsonb_typeof(p_mutation->'action') is distinct from 'string' or (p_mutation->>'action') not in ('put','remove','restore')
    or not topictrail_annotations_v1_private.valid_payload(p_mutation->'payload') then raise exception using errcode='22023',message='Invalid annotation fields'; end if;
  operation:=p_mutation->>'operationId';entity_id:=p_mutation->>'id';expected:=(p_mutation->>'expectedRevision')::bigint;
  action:=p_mutation->>'action';body:=p_mutation->'payload';doc_id:=body->>'documentId';doc_hash:=body->>'documentHash';
  if expected>9007199254740991 or body->>'id'<>entity_id then raise exception using errcode='22023',message='Invalid annotation identity or revision'; end if;

  -- EXACTLY the same account transaction lock as legacy document Trash/Restore.
  -- No annotation operation changes parent state or any legacy feed row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('topictrail-sync:'||actor::text,0));
  select * into receipt from public.topictrail_annotations_v1_receipts where user_id=actor and operation_id=operation;
  if found then
    if receipt.request<>p_mutation then raise exception using errcode='22023',message='Operation ID already used for another mutation'; end if;
    return receipt.result || jsonb_build_object('duplicate',true);
  end if;
  if doc_id is not null then
    select * into original from public.topictrail_cloud_documents where user_id=actor and id=doc_id;
    if not found or original.sha256<>doc_hash or original.format<>body->>'format' then
      raise exception using errcode='42501',message='Owned immutable document/hash unavailable';
    end if;
    select coalesce((select deleted from public.topictrail_sync_records where user_id=actor and kind='document' and id=doc_id),false) into parent_deleted;
  end if;
  select * into existing from public.topictrail_annotations_v1_records where user_id=actor and id=entity_id;
  found_record:=found;
  if found_record then
    if existing.document_id is distinct from doc_id or existing.document_hash is distinct from doc_hash
      or existing.payload->'format' is distinct from body->'format' or existing.payload->'location' is distinct from body->'location'
      or existing.payload->'anchor' is distinct from body->'anchor' or existing.payload->'createdAt' is distinct from body->'createdAt' then
      raise exception using errcode='22023',message='Original annotation attachment and anchor are immutable';
    end if;
    authoritative:=topictrail_annotations_v1_private.record_json(existing);
  else
    authoritative:=jsonb_build_object('id',entity_id,'revision',0,'deleted',true,'payload',body);
  end if;
  conflict:=parent_deleted or expected<>coalesce(existing.revision,0)
    or (action='put' and coalesce(existing.deleted,false))
    or (action='restore' and (not found_record or not existing.deleted))
    or (action='remove' and not found_record);
  if conflict then
    response:=jsonb_build_object('owner',actor,'status','conflict','record',authoritative,'reason',case when parent_deleted then 'parent-trashed' else 'revision' end);
  else
    if action='put' and not found_record and (select count(*) from public.topictrail_annotations_v1_records where user_id=actor)>=20000 then
      raise exception using errcode='22023',message='Notes library is full';
    end if;
    next_revision:=coalesce(existing.revision,0)+1;
    if next_revision>9007199254740991 then raise exception using errcode='22003',message='Annotation revision exhausted'; end if;
    -- Trash and Restore affect only the tombstone; a pending edit cannot be
    -- smuggled into a Restore, and prior text remains available for recovery.
    if action in ('remove','restore') then body:=existing.payload; end if;
    insert into public.topictrail_annotations_v1_records(user_id,id,document_id,document_hash,revision,deleted,payload)
      values(actor,entity_id,doc_id,doc_hash,next_revision,action='remove',body)
      on conflict(user_id,id) do update set revision=excluded.revision,deleted=excluded.deleted,payload=excluded.payload,updated_at=now()
      returning * into existing;
    response:=jsonb_build_object('owner',actor,'status','applied','record',topictrail_annotations_v1_private.record_json(existing));
  end if;
  insert into public.topictrail_annotations_v1_receipts(user_id,operation_id,request,result) values(actor,operation,p_mutation,response);
  return response;
end $$;
create function public.topictrail_annotations_v1_apply(p_mutation jsonb) returns jsonb
language sql security invoker set search_path='' as $$
  select topictrail_annotations_v1_private.apply(p_mutation)
$$;
create function public.topictrail_annotations_v1_list(p_after_id text default '',p_limit integer default 100) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare actor uuid:=auth.uid();answer jsonb;
begin
  if actor is null then raise exception using errcode='28000',message='Authenticated account required'; end if;
  if p_after_id is null or (p_after_id<>'' and p_after_id !~ '^[a-z0-9][a-z0-9-]{0,127}$') or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='22023',message='Invalid annotation cursor';
  end if;
  -- Include tombstones and parent-hidden children in the owner's feed, retaining
  -- their independent deletion state. Clients apply parent visibility separately.
  select coalesce(jsonb_agg(jsonb_build_object('owner',actor,'record',topictrail_annotations_v1_private.record_json(r::public.topictrail_annotations_v1_records)) order by r.id),'[]'::jsonb)
    into answer from (select * from public.topictrail_annotations_v1_records where user_id=actor and id>p_after_id collate "C" order by id limit p_limit) r;
  return answer;
end $$;

revoke all on function topictrail_annotations_v1_private.utf16_length(text),topictrail_annotations_v1_private.not_blank(text),
  topictrail_annotations_v1_private.string_punctuation(jsonb),topictrail_annotations_v1_private.text_ok(jsonb,integer,boolean),
  topictrail_annotations_v1_private.exact_keys(jsonb,text[]),topictrail_annotations_v1_private.valid_payload(jsonb),
  topictrail_annotations_v1_private.record_json(public.topictrail_annotations_v1_records),topictrail_annotations_v1_private.apply(jsonb),
  public.topictrail_annotations_v1_apply(jsonb),public.topictrail_annotations_v1_list(text,integer) from public,anon,authenticated,service_role;
grant execute on function topictrail_annotations_v1_private.record_json(public.topictrail_annotations_v1_records),
  topictrail_annotations_v1_private.apply(jsonb),public.topictrail_annotations_v1_apply(jsonb),public.topictrail_annotations_v1_list(text,integer) to authenticated;
notify pgrst,'reload schema';
commit;
