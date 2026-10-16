import {
  ALPHA_GUIDE, CONTROL_COMMON_RU, CONTROL_GUIDE, DEFINITIONS_VERIFIED_AT_SOURCE_COMMIT, LEVEL_LADDER_RU, LIVE_RU,
  SAFE_COMMON_RU, SAFE_MODEL_GUIDE,
} from "@/lib/research/founderModelingGuide";

const box = { background: "#0d141c", color: "#e9eef5", padding: 24, fontSize: 14, lineHeight: 1.5 } as const;
const card = { border: "1px solid #303c4a", borderRadius: 8, padding: 12, margin: "8px 0", background: "#121b25" } as const;
const mono = { fontFamily: "monospace", fontSize: 12, opacity: 0.85 } as const;
const badge = { display: "inline-block", padding: "2px 8px", borderRadius: 999, border: "1px solid #596575", fontSize: 12, marginLeft: 8 } as const;

export function LevelLadder() {
  return <section aria-label="Уровни доказательности" style={box}>
    <h2 style={{ fontSize: 18 }}>Как читать эту страницу: пять разных уровней</h2>
    <p>Это разные вещи. Не путайте их: успех на одном уровне ничего не говорит о следующем.</p>
    <ol style={{ paddingLeft: 20 }}>{LEVEL_LADDER_RU.map(l => <li key={l.level} style={{ margin: "6px 0" }}><strong>{l.titleRu}.</strong> {l.textRu}</li>)}</ol>
  </section>;
}

export function SafeGuide() {
  return <div style={box} aria-label="Определения SAFE-моделей">
    <h3 style={{ fontSize: 16 }}>Пять SAFE-моделей: что каждая делает</h3>
    <p style={{ opacity: 0.8 }}>Идентификаторы (например P50_52_SAFE) — канонические имена в данных и расчётах, русские названия — только подписи. Определения проверены по исходникам (последний коммит этих файлов: <span style={mono}>{DEFINITIONS_VERIFIED_AT_SOURCE_COMMIT.slice(0, 10)}</span>).</p>
    {SAFE_MODEL_GUIDE.map(m => <article key={m.id} style={card}>
      <h4 style={{ fontSize: 15, margin: 0 }}>{m.labelRu}<span style={badge}>{m.id}</span></h4>
      <p style={{ margin: "6px 0" }}>{m.ruleRu}</p>
      {m.tiersRu.length > 0 && <ul style={{ margin: "4px 0", paddingLeft: 20 }}>{m.tiersRu.map(t => <li key={t}>{t}</li>)}</ul>}
      <p style={{ margin: "6px 0" }}><strong>Распределение:</strong> {m.allocationRu}</p>
      <p style={{ ...mono, margin: 0 }}>Источник: {m.sources.join(" · ")}</p>
    </article>)}
    <h4 style={{ fontSize: 15 }}>Общие фильтры</h4>
    <ul style={{ paddingLeft: 20 }}>{SAFE_COMMON_RU.filters.map(f => <li key={f}>{f}</li>)}</ul>
    <h4 style={{ fontSize: 15 }}>Важные оговорки</h4>
    <ul style={{ paddingLeft: 20 }} role="note">{SAFE_COMMON_RU.caveats.map(f => <li key={f}>{f}</li>)}</ul>
  </div>;
}

export function AlphaGuide() {
  return <section aria-label="Альфа-направления" style={box}>
    <p>Это два отдельных исследовательских направления. Они <strong>не</strong> заменяют и не переименовывают пять SAFE-моделей. Движок исследований сейчас запрещает обоим создавать ставки (canEmitBet=false), поэтому здесь нет ни числа сделок, ни ROI — и они не выдумываются.</p>
    {ALPHA_GUIDE.map(a => <article key={a.id} style={card}>
      <h3 style={{ fontSize: 16, margin: 0 }}>{a.nameRu}<span style={badge}>{a.stateText}</span><span style={badge}>только исследование</span></h3>
      <p style={{ ...mono, margin: "4px 0" }}>{a.nameEn} · {a.id} · {a.version} · canEmitBet={String(a.canEmitBet)}</p>
      <p style={{ margin: "6px 0" }}><strong>Состояние:</strong> {a.stateExplainRu}</p>
      <p style={{ margin: "6px 0" }}>{a.summaryRu}</p>
      <p style={{ margin: "6px 0" }}>Сделки: нет · ROI: нет · P&amp;L: нет (не рассчитывается).</p>
    </article>)}
  </section>;
}

export function ControlsGuide() {
  return <div style={box} aria-label="Контроли A/B/C">
    <p>Виртуальные контроли A/B/C — бумажные позиции по 1u по простым ценовым корзинам. Они нужны как эталон для сравнения и не являются ни SAFE-моделями, ни альфа-направлениями.</p>
    <ul style={{ paddingLeft: 20 }}>{CONTROL_GUIDE.map(c => <li key={c.id}><strong>{c.labelRu}</strong> <span style={mono}>({c.id} {c.version})</span>: {c.textRu}{c.range ? ` ${c.range.min.toFixed(2)}–${c.range.max.toFixed(2)}` : ""}.</li>)}</ul>
    <p>{CONTROL_COMMON_RU.scope}</p>
    <p>{CONTROL_COMMON_RU.price}</p>
    <p style={{ opacity: 0.85 }}>{CONTROL_COMMON_RU.note}</p>
  </div>;
}

export function LiveGuide() {
  return <div style={box}>
    <p>{LIVE_RU.summary}</p>
    <p role="note" style={{ opacity: 0.85 }}>{LIVE_RU.caveat}</p>
  </div>;
}
