-- Research clone ONLY. Apply separately; never include in PREMVP production migrations.
-- One row per existing model-ready identity. Optional historical source fields remain NULL.
-- The exact decision timestamp join forbids post-decision observations. Settlement is a
-- separate label column and is never copied into predictive_features.
CREATE OR REPLACE VIEW public.step3_legacy_feature_overlay_v1
WITH (security_invoker = true) AS
SELECT
  r.model_date, r.population_id, r.condition_id, r.selected_token_id,
  r.decision_at, r.provider_event_id, r.event_start,
  COALESCE(NULLIF(lower(trim(r.sport_family)), ''),
    NULLIF(lower(trim(r.canonical_row->>'providerSportFamily')), '')) AS sport_family,
  r.entry_price_num AS entry_price,
  CASE WHEN r.entry_price_num > 0 AND r.entry_price_num < 1
    THEN 1 / r.entry_price_num ELSE NULL END AS decimal_odds_from_price,
  r.canonical_row->>'formulaVersion' AS formula_version,
  r.canonical_row->>'marketFamily' AS market_family,
  r.canonical_row->>'marketTypeRaw' AS market_type_raw,
  r.canonical_row->>'providerSportCode' AS provider_sport_code,
  g.diagnostics->'providerEventContext'->>'league' AS league,
  r.canonical_row->>'selectedOutcome' AS selected_outcome,
  CASE WHEN r.event_start IS NOT NULL THEN
    EXTRACT(EPOCH FROM (r.event_start - r.decision_at)) / 3600 END AS lead_time_hours,
  COALESCE(g.signal_confidence_num, e.signal_confidence_num) AS legacy_final_score,
  (g.diagnostics->'formulaAudit'->>'rawSignalBeforeOddsCap')::numeric AS legacy_raw_score,
  (g.diagnostics->'formulaAudit'->>'smartMoneyVal')::numeric AS smart_money_score,
  (g.diagnostics->'formulaAudit'->>'pubWhaleVal')::numeric AS whale_public_score,
  COALESCE(g.pre_event_score_num, e.pre_event_score_num) AS pre_event_score,
  (g.diagnostics->>'delta1hPp')::numeric AS delta1h_pp,
  (g.diagnostics->>'delta6hPp')::numeric AS delta6h_pp,
  (g.diagnostics->>'maxTradeCash')::numeric AS max_trade_cash,
  (g.diagnostics->>'recentTradeCash')::numeric AS recent_trade_cash,
  (g.diagnostics->>'selectedTradeCount')::numeric AS selected_trade_count,
  (g.diagnostics->>'holderConcentrationScore')::numeric AS holder_concentration_score,
  COALESCE((g.diagnostics->>'dataCoverage')::numeric, e.data_coverage) AS data_coverage,
  CASE WHEN g.id IS NOT NULL THEN 'CLONE_GSP_DECISION_ROW'
       WHEN e.item_observation_id IS NOT NULL THEN 'CLONE_NARROW_EVIDENCE_ROW'
       ELSE 'NO_MATCHED_SCORE_SOURCE' END AS feature_source,
  b.odds_base_score AS legacy_odds_base_score,
  CASE WHEN b.odds_base_score IS NOT NULL
     AND COALESCE(g.signal_confidence_num, e.signal_confidence_num) IS NOT NULL
    THEN COALESCE(g.signal_confidence_num, e.signal_confidence_num) - b.odds_base_score
    ELSE NULL END AS legacy_non_price_delta,
  jsonb_build_object(
    'entry_price', r.entry_price_num,
    'decimal_odds_from_price', CASE WHEN r.entry_price_num > 0 AND r.entry_price_num < 1 THEN 1 / r.entry_price_num END,
    'legacy_odds_base_score', b.odds_base_score,
    'delta1h_pp', (g.diagnostics->>'delta1hPp')::numeric,
    'delta6h_pp', (g.diagnostics->>'delta6hPp')::numeric,
    'max_trade_cash', (g.diagnostics->>'maxTradeCash')::numeric,
    'recent_trade_cash', (g.diagnostics->>'recentTradeCash')::numeric,
    'selected_trade_count', (g.diagnostics->>'selectedTradeCount')::numeric,
    'holder_concentration_score', (g.diagnostics->>'holderConcentrationScore')::numeric,
    'data_coverage', COALESCE((g.diagnostics->>'dataCoverage')::numeric, e.data_coverage)
  ) AS predictive_features,
  r.settlement_label
FROM public.research_model_ready_rows AS r
LEFT JOIN LATERAL (
  SELECT id, diagnostics, signal_confidence_num, pre_event_score_num
  FROM public.generated_signal_pairs
  WHERE created_at = r.decision_at
    AND condition_id = r.condition_id
    AND selected_token_id = r.selected_token_id
  ORDER BY id
  LIMIT 1
) AS g ON true
LEFT JOIN LATERAL (
  SELECT item_observation_id, signal_confidence_num, pre_event_score_num, data_coverage
  FROM public.research_evidence_page_rows
  WHERE observed_at = r.decision_at
    AND condition_id = r.condition_id
    AND selected_token_id = r.selected_token_id
  ORDER BY observation_id, item_observation_id
  LIMIT 1
) AS e ON true
LEFT JOIN LATERAL (
  SELECT CASE
    WHEN (g.diagnostics->'formulaAudit'->>'selectedOdds')::numeric BETWEEN 1.35 AND 5.0 THEN
      CASE
        WHEN (g.diagnostics->'formulaAudit'->>'selectedOdds')::numeric <= 1.44 THEN 85
        WHEN (g.diagnostics->'formulaAudit'->>'selectedOdds')::numeric <= 1.70 THEN 81
        WHEN (g.diagnostics->'formulaAudit'->>'selectedOdds')::numeric <= 2.20 THEN 76
        WHEN (g.diagnostics->'formulaAudit'->>'selectedOdds')::numeric <= 2.70 THEN 72
        WHEN (g.diagnostics->'formulaAudit'->>'selectedOdds')::numeric <= 3.20 THEN 67
        WHEN (g.diagnostics->'formulaAudit'->>'selectedOdds')::numeric <= 4.00 THEN 62
        ELSE 55 END
    ELSE NULL END AS odds_base_score
) AS b ON true;

REVOKE ALL ON public.step3_legacy_feature_overlay_v1 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.step3_legacy_feature_overlay_v1 TO service_role;
