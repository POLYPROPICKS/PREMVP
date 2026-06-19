create or replace function public.get_morning_strict_resolved_corpus_count()
returns bigint
language sql
stable
as $$
  with strict_corpus as (
    select distinct on (condition_id, selected_token_id)
      condition_id,
      selected_token_id,
      resolved_at,
      created_at,
      id
    from public.generated_signal_pairs
    where condition_id is not null
      and selected_token_id is not null
      and (
        signal_result is not null
        or realized_return_pct is not null
        or winning_outcome is not null
      )
    order by
      condition_id,
      selected_token_id,
      resolved_at desc nulls last,
      created_at desc nulls last,
      id desc
  )
  select count(*) from strict_corpus;
$$;

create or replace function public.get_morning_strict_resolved_corpus_page(
  p_limit integer default 500,
  p_offset integer default 0
)
returns table (
  id text,
  created_at timestamptz,
  resolved_at timestamptz,
  condition_id text,
  selected_token_id text,
  selected_outcome text,
  market_slug text,
  event_slug text,
  signal_result text,
  winning_outcome text,
  realized_return_pct numeric,
  signal_confidence_num numeric,
  pre_event_score_num numeric,
  score numeric,
  expected_return_pct_num numeric,
  smart_money_score_num numeric,
  whale_public_score_num numeric,
  entry_price_num numeric,
  formula_version text,
  metric_formula_version text,
  expires_at timestamptz,
  source text,
  market_source text,
  premium_signal boolean
)
language sql
stable
as $$
  with strict_corpus as (
    select distinct on (condition_id, selected_token_id)
      id::text as id,
      created_at,
      resolved_at,
      condition_id,
      selected_token_id,
      selected_outcome,
      market_slug,
      event_slug,
      signal_result,
      winning_outcome,
      realized_return_pct,
      signal_confidence_num,
      pre_event_score_num,
      score,
      expected_return_pct_num,
      smart_money_score_num,
      whale_public_score_num,
      entry_price_num,
      formula_version,
      metric_formula_version,
      expires_at,
      source,
      market_source,
      premium_signal
    from public.generated_signal_pairs
    where condition_id is not null
      and selected_token_id is not null
      and (
        signal_result is not null
        or realized_return_pct is not null
        or winning_outcome is not null
      )
    order by
      condition_id,
      selected_token_id,
      resolved_at desc nulls last,
      created_at desc nulls last,
      id desc
  )
  select * from strict_corpus
  order by resolved_at desc nulls last, created_at desc nulls last, id desc
  limit p_limit offset p_offset;
$$;
