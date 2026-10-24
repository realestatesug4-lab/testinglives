-- The settlement UPDATE referenced a PL/pgSQL variable that shares its name
-- with a transactions column, so every completed/failed event failed with
-- "column reference provider_request_id is ambiguous". Rename the local
-- variables to make settlement apply cleanly.

create or replace function public.apply_marzpay_webhook(p_payload jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb;
  event_name text;
  transaction_data jsonb;
  collection_data jsonb;
  disbursement_data jsonb;
  amount_data jsonb;
  payment_row public.transactions%rowtype;
  payment_kind text;
  event_status text;
  event_reference text;
  event_transaction_id text;
  event_provider_transaction_id text;
  event_provider text;
  event_phone text;
  event_currency text;
  event_amount numeric;
  expected_amount numeric;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'MarzPay webhook processing requires the service role.';
  end if;
  if jsonb_typeof(p_payload) <> 'object' then raise exception 'Invalid MarzPay webhook payload.'; end if;

  payload := case
    when jsonb_typeof(p_payload -> 'data') = 'object' then p_payload -> 'data'
    else p_payload
  end;
  event_name := lower(coalesce(payload ->> 'event_type', p_payload ->> 'event_type', ''));
  transaction_data := payload -> 'transaction';
  collection_data := payload -> 'collection';
  disbursement_data := payload -> 'disbursement';
  if jsonb_typeof(transaction_data) <> 'object' then raise exception 'MarzPay webhook transaction is missing.'; end if;

  if event_name like 'collection.%'
    or (event_name = '' and jsonb_typeof(collection_data) = 'object') then
    payment_kind := 'deposit';
    event_reference := coalesce(transaction_data ->> 'reference', '');
    event_provider_transaction_id := nullif(collection_data ->> 'provider_transaction_id', '');
    amount_data := coalesce(transaction_data -> 'amount', collection_data -> 'amount');
    event_phone := coalesce(transaction_data ->> 'phone_number', collection_data ->> 'phone_number');
    event_provider := lower(coalesce(transaction_data ->> 'provider', collection_data ->> 'provider', ''));
  elsif event_name like 'disbursement.%'
    or (event_name = '' and jsonb_typeof(disbursement_data) = 'object') then
    payment_kind := 'withdraw';
    event_reference := coalesce(transaction_data ->> 'provider_reference', '');
    event_provider_transaction_id := nullif(disbursement_data ->> 'provider_transaction_id', '');
    amount_data := transaction_data -> 'amount';
    event_phone := coalesce(transaction_data ->> 'phone_number', disbursement_data ->> 'phone_number');
    event_provider := lower(coalesce(transaction_data ->> 'provider', disbursement_data ->> 'provider', ''));
  elsif event_name in ('success', 'failure') then
    if jsonb_typeof(collection_data) = 'object' then
      payment_kind := 'deposit';
      event_reference := coalesce(transaction_data ->> 'reference', '');
      event_provider_transaction_id := nullif(collection_data ->> 'provider_transaction_id', '');
      amount_data := coalesce(transaction_data -> 'amount', collection_data -> 'amount');
      event_phone := coalesce(transaction_data ->> 'phone_number', collection_data ->> 'phone_number');
      event_provider := lower(coalesce(transaction_data ->> 'provider', collection_data ->> 'provider', ''));
    elsif jsonb_typeof(disbursement_data) = 'object' then
      payment_kind := 'withdraw';
      event_reference := coalesce(transaction_data ->> 'provider_reference', '');
      event_provider_transaction_id := nullif(disbursement_data ->> 'provider_transaction_id', '');
      amount_data := transaction_data -> 'amount';
      event_phone := coalesce(transaction_data ->> 'phone_number', disbursement_data ->> 'phone_number');
      event_provider := lower(coalesce(transaction_data ->> 'provider', disbursement_data ->> 'provider', ''));
    else
      raise exception 'Unsupported MarzPay event.';
    end if;
  else
    raise exception 'Unsupported MarzPay event.';
  end if;

  if event_name in ('collection.pending', 'collection.processing', 'disbursement.pending', 'disbursement.processing')
    or (event_name = '' and lower(coalesce(transaction_data ->> 'status', '')) in ('pending', 'processing')) then
    return true;
  elsif event_name in ('collection.completed', 'disbursement.completed', 'success') then
    event_status := 'completed';
  elsif event_name in ('collection.failed', 'collection.cancelled', 'disbursement.failed', 'disbursement.cancelled', 'failure') then
    event_status := 'failed';
  else
    raise exception 'Unsupported MarzPay event status.';
  end if;

  if event_reference = '' or jsonb_typeof(amount_data) <> 'object' then
    raise exception 'Incomplete MarzPay payment event.';
  end if;
  begin
    event_amount := (amount_data ->> 'raw')::numeric;
  exception when others then
    raise exception 'Invalid MarzPay payment amount.';
  end;
  event_currency := upper(coalesce(amount_data ->> 'currency', ''));
  event_transaction_id := nullif(transaction_data ->> 'uuid', '');

  select * into payment_row from public.transactions
  where payment_reference = event_reference
    and payment_gateway = 'marzpay'
    and kind = payment_kind
  for update;
  if not found then raise exception 'MarzPay payment reference not found.'; end if;

  if payment_kind = 'withdraw' then
    expected_amount := payment_row.net_amount;
  else
    expected_amount := payment_row.amount;
  end if;

  if event_amount is null
    or event_amount <> trunc(event_amount)
    or event_amount <> expected_amount
    or event_currency <> 'UGX'
    or event_phone is distinct from payment_row.payment_phone
    or event_provider is distinct from payment_row.payment_provider then
    raise exception 'MarzPay payment details do not match the stored request.';
  end if;
  if payment_row.provider_request_id is not null
    and event_transaction_id is distinct from payment_row.provider_request_id then
    raise exception 'MarzPay transaction ID does not match the stored request.';
  end if;
  if event_provider_transaction_id is not null and payment_row.provider_transaction_id is not null
    and event_provider_transaction_id <> payment_row.provider_transaction_id then
    raise exception 'MarzPay provider transaction ID does not match the stored request.';
  end if;
  if payment_row.status in ('approved', 'rejected') then return true; end if;
  if payment_row.status not in ('pending', 'processing')
    or (payment_kind = 'withdraw' and payment_row.approved_at is null) then
    raise exception 'MarzPay payment is not approved for settlement.';
  end if;

  if event_status = 'completed' then
    if payment_kind = 'deposit' then
      update public.profiles set balance = balance + payment_row.amount where id = payment_row.user_id;
    end if;
    update public.transactions
    set status = 'approved',
        provider_request_id = coalesce(payment_row.provider_request_id, event_transaction_id),
        provider_transaction_id = coalesce(payment_row.provider_transaction_id, event_provider_transaction_id),
        failure_reason = null,
        settled_at = now(),
        note = case when payment_kind = 'deposit' then 'MarzPay deposit completed' else 'MarzPay payout completed' end
    where id = payment_row.id;
  else
    if payment_kind = 'withdraw' then
      update public.profiles set balance = balance + payment_row.amount where id = payment_row.user_id;
    end if;
    update public.transactions
    set status = 'rejected',
        provider_request_id = coalesce(payment_row.provider_request_id, event_transaction_id),
        provider_transaction_id = coalesce(payment_row.provider_transaction_id, event_provider_transaction_id),
        failure_reason = coalesce(nullif(payload ->> 'failure_reason', ''), nullif(payload ->> 'failureReason', ''), event_status),
        settled_at = now(),
        note = case when payment_kind = 'deposit' then 'MarzPay deposit failed' else 'MarzPay payout failed; reserved balance refunded' end
    where id = payment_row.id;
  end if;

  return true;
end;
$$;

revoke all on function public.apply_marzpay_webhook(jsonb) from public, anon, authenticated;
grant execute on function public.apply_marzpay_webhook(jsonb) to service_role;

-- Catch the referral copy up when migration 003 was applied after the text had
-- already been changed (its WHERE clause no longer matched).
update public.app_settings
set referral_rule = 'Commission is credited on each successful deposit and never depends on HIV status or test results.'
where id = 1
  and referral_rule in (
    'Reward is paid after a referred member reports a completed test and it is verified. Rewards never depend on HIV status or test results.',
    'Reward is paid after a referred member reports a completed test and it is verified. Rewards never depend on HIV status or results.'
  );
