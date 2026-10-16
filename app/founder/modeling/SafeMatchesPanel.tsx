"use client";

import { useEffect, useState } from "react";
import type { readFounderShadowMatches } from "@/lib/research/founderShadowMatches";
import { modelLabelRu } from "@/lib/research/founderModelingGuide";

type Report = Awaited<ReturnType<typeof readFounderShadowMatches>>;
const pct = (n: number | null) => n === null ? "UNKNOWN" : `${(n * 100).toFixed(2)}%`;
const u = (n: number | null) => n === null ? "UNKNOWN" : n.toFixed(3);
const th = { textAlign: "left" as const, padding: 8, borderBottom: "1px solid #596575" };
const td = { padding: 8, borderBottom: "1px solid #303c4a", whiteSpace: "nowrap" as const };

export default function SafeMatchesPanel() {
  const [days, setDays] = useState("7"), [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(true), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setBusy(true); setError("");
      try {
        const res = await fetch(`/api/founder/modeling/research/shadow-matches?days=${days}`, { cache: "no-store", signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw Error(res.status === 404 ? "Нужна действующая Founder-сессия (Founder Preview): войдите по личной ссылке владельца и обновите страницу." : data.message ?? "Статистика SAFE по матчам недоступна.");
        setReport(data);
      } catch (e) { if (!controller.signal.aborted) { setReport(null); setError(e instanceof Error ? e.message : "Статистика SAFE по матчам недоступна."); } }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [days, refresh]);
  return <section aria-label="SAFE-модели по физическим матчам" style={{ background: "#0d141c", color: "#e9eef5", padding: 24, fontSize: 14 }}>
    <h3 style={{ fontSize: 20, marginBottom: 8 }}>SAFE-модели — отдельные физические матчи</h3>
    <p>Пять теневых SAFE-моделей, одна строка на ключ события на модель (Five SAFE shadow models, one row per event key per model). «Экспозиции моделей» — не независимые матчи: одно физическое событие может входить в несколько моделей. SAFE отделён от бумажных контролей A/B/C и от Production LIVE.</p>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "12px 0" }}>
      <label>Дней решений (Recent decision days) <select value={days} onChange={e => setDays(e.target.value)} style={{ color: "#111", background: "#fff" }}>
        {["3", "7", "14"].map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <button onClick={() => setRefresh(n => n + 1)} disabled={busy}>Обновить</button>
    </div>
    <div role="status" aria-live="polite">{busy && !report ? "Читается агрегат SAFE-журнала…" : error ||
      `${report?.freshness} · проверено ${report?.read_at} · снимок обновлён ${report?.snapshot_refreshed_at ?? "UNKNOWN"} (источник: ${report?.snapshot_refresh_source}) · последняя дата решений ${report?.latest_decision_date} (сегодня по Минску ${report?.minsk_today})`}</div>
    {report && <>
      {report.snapshot_refresh_source === "row_updated_at_fallback" && <p role="alert">Refresh time uses the snapshot row&apos;s updated_at fallback; it may also change on a failed refresh and can overstate freshness.</p>}
      {report.freshness === "STALE" && <p role="alert">STALE (данные устарели): {report.behind_today ? "последняя дата решений раньше сегодняшней; " : ""}теневой снимок старше 2 часов или отсутствует. Цифры описывают только сохранённый журнал. (STALE: shadow snapshot older than 2h or missing.)</p>}
      <p>Окно {report.window_from} … {report.window_to}: {report.overall.exposures} экспозиций моделей (model exposures); последняя проверка расчёта (last settlement check) {report.last_settlement_check ?? "UNKNOWN"}; {report.rows_first_persistence_unknown} строк с неизвестным временем первой записи; у {report.rows_without_selected_outcome} из {report.overall.exposures} строк нет сохранённого selected_outcome (сторона показывается, только если журнал её хранит).</p>
      <p style={{ opacity: 0.8 }}>{report.identity_caveat} Gross P&amp;L (1u) считается по сохранённой цене входа только для расчётных провайдером WIN/LOSS; UNQUERIED остаётся нерешённым; комиссии и net — UNKNOWN. Это не торговый результат и не ROI реальной торговли.</p>
      <h2 style={{ fontSize: 18, marginTop: 16 }}>По дате решения: экспозиции моделей и уникальные физические события</h2>
      <div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Дата", "Экспозиции моделей", "Уникальные ключи событий", "Ключи в ≥2 моделях", "Пересечение (моделей→ключей)", "Без ключа", "Win / Loss / Unresolved", "Gross P&L (u)", "Settled ROI"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{report.days.map(d => <tr key={d.decision_date}>
          {[d.decision_date, d.model_exposures, d.unique_event_keys, d.keys_shared_across_models,
            Object.entries(d.overlap_by_model_count).map(([k, n]) => `${k}→${n}`).join(", "), d.rows_without_event_key,
            `${d.overall.win} / ${d.overall.loss} / ${d.overall.unresolved}`, u(d.overall.gross_pnl_u), pct(d.overall.settled_roi)].map((v, i) => <td key={i} style={td}>{v}</td>)}
        </tr>)}</tbody></table></div>
      <h2 style={{ fontSize: 18, marginTop: 16 }}>По модели и дате</h2>
      <div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Дата", "Модель", "Выборы", "Уникальные ключи событий", "Win / Loss / Unresolved", "Gross P&L (u)", "Settled ROI"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{report.days.flatMap(d => d.models.map(m => <tr key={`${d.decision_date}/${m.model_id}`}>
          {[d.decision_date, `${modelLabelRu(m.model_id)} · ${m.model_id}`, m.exposures === 0 ? "0 (выборов нет)" : m.exposures, m.unique_event_keys, `${m.win} / ${m.loss} / ${m.unresolved}`, u(m.gross_pnl_u), pct(m.settled_roi)].map((v, i) => <td key={i} style={td}>{v}</td>)}
        </tr>))}</tbody></table></div>
      <h2 style={{ fontSize: 18, marginTop: 16 }}>Физические матчи за два последних дня решений</h2>
      <div style={{ overflowX: "auto", maxHeight: 520 }}><table style={{ borderCollapse: "collapse" }}>
        <thead><tr>{["Дата", "Ключ события", "Спорт", "Старт события", "Моделей", "Модель / токен / вход / результат / P&L (u)"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>{report.events.map(e => <tr key={`${e.decision_date}/${e.physical_event_key}`}>
          {[e.decision_date, e.physical_event_key, e.sport ?? "UNKNOWN", e.event_start ?? "UNKNOWN", e.model_count,
            e.selections.map(s => `${modelLabelRu(s.model_id)} (${s.model_id}) · ${s.selected_outcome ?? "SIDE NOT PERSISTED"} (token …${s.selected_token ?? "?"}) · ${s.entry_price ?? "?"} · ${s.result} · ${u(s.gross_pnl_u)}`).join("  |  ")].map((v, i) => <td key={i} style={{ ...td, whiteSpace: i === 5 ? "normal" : "nowrap", maxWidth: i === 5 ? 700 : undefined }}>{v}</td>)}
        </tr>)}</tbody></table></div>
      <p style={{ opacity: 0.8, marginTop: 8 }}>{report.provenance}</p>
    </>}
  </section>;
}
