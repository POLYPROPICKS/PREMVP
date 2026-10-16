// Presentation-only Russian labels and source-linked definitions for the Founder Modeling dashboard.
// Canonical model/strategy IDs stay untouched in data and calculations; this module only adds display text.
// Every rule below is mirrored from the source files named in `source`; tests/research-clone/founderModelingGuide.test.ts
// executes the source predicates at the boundary prices so this text cannot silently drift.
import { ALPHA_PROGRAMS, CONTROL_STRATEGIES, ENTRY_WINDOW_MINUTES_AFTER_SCHEDULED_START, SCOPE_KEY } from "./inplayPaperDecisions";

/** Last commit that touched the SAFE selection sources listed in `SAFE_SOURCES` when these definitions were verified. */
export const DEFINITIONS_VERIFIED_AT_SOURCE_COMMIT = "02eba8d8704978434fb894e85491f8c4f4110a69";

export const SAFE_SOURCES = {
  models: "scripts/modeling/prospective-selection-shadow.ts",
  tiers: "scripts/modeling/quality-fill-portfolio-test.ts",
  broad: "scripts/modeling/daily-portfolio-frontier.ts",
  safeTennis: "scripts/modeling/tennis-safe-comparable-leaderboard.ts",
} as const;

export type SafeModelGuide = {
  id: string;
  labelRu: string;
  ruleRu: string;
  tiersRu: string[];
  allocationRu: string;
  sources: string[];
};

export const SAFE_MODEL_GUIDE: readonly SafeModelGuide[] = [
  {
    id: "P50_52_SAFE",
    labelRu: "Базовая стратегия: цена 50–52 цента",
    ruleRu: "Одно правило: 0.50 ≤ исследовательская цена < 0.52, любой спорт, кроме отсеянного фильтром безопасного тенниса.",
    tiersRu: [],
    allocationRu: "Дневной лимит 30 событий (cap 30), стандартное усечение.",
    sources: [`${SAFE_SOURCES.models} → P50_52_SAFE`],
  },
  {
    id: "PORTFOLIO_BROAD_SAFE",
    labelRu: "Расширенный портфель",
    ruleRu: "Приоритетные ярусы заполняются по порядку, пока не исчерпан лимит 30.",
    tiersRu: [
      "1) Приоритет: теннис с ценой [0.50, 0.52) ИЛИ оценка (score) в диапазоне [63, 65) при цене [0.50, 0.52).",
      "2) Остальные события с ценой [0.50, 0.52).",
      "3) Затем события с ценой [0.52, 0.54).",
    ],
    allocationRu: "Дневной лимит 30 событий (cap 30), стандартное усечение по порядку ярусов.",
    sources: [`${SAFE_SOURCES.models} → PORTFOLIO_BROAD_SAFE`, `${SAFE_SOURCES.broad} → PORTFOLIO_BROAD`],
  },
  {
    id: "QUALITY_FILL_A_SAFE",
    labelRu: "Портфель A: приоритет футбола и тенниса",
    ruleRu: "Три яруса по порядку.",
    tiersRu: [
      "1) Теннис, цена [0.50, 0.52).",
      "2) Футбол, цена [0.50, 0.54).",
      "3) Остальные события, цена [0.50, 0.52).",
    ],
    allocationRu:
      "Cap 30 с живым распределением (live-mix, selectLiveReservationMix): если футбольных кандидатов не меньше 20 — 20 слотов отдаётся футболу, теннис получает не более 7, остаток до 30 заполняют прочие; если футбола меньше 20 — берётся весь футбол, а остаток до 30 заполняют теннис и прочие. Это существующая политика без упрощений и изменений.",
    sources: [`${SAFE_SOURCES.tiers} → QUALITY_FILL_A`, `${SAFE_SOURCES.safeTennis} → QUALITY_FILL_A_SAFE_MIX_CONFIGS[30]`],
  },
  {
    id: "QUALITY_FILL_D_SAFE",
    labelRu: "Портфель D: расширенный футбольный диапазон",
    ruleRu: "Те же три яруса, что в портфеле A, плюс четвёртый — запасной.",
    tiersRu: [
      "1) Теннис, цена [0.50, 0.52).",
      "2) Футбол, цена [0.50, 0.54).",
      "3) Остальные события, цена [0.50, 0.52).",
      "4) Последний резерв: футбол, цена [0.54, 0.60).",
    ],
    allocationRu:
      "Дневной лимит 30 (cap 30) со стандартным усечением по ярусам. Это НЕ то же самое распределение, что у портфеля A: live-mix (20 футбол / 7 теннис) для D в этом конвейере не применяется.",
    sources: [`${SAFE_SOURCES.tiers} → QUALITY_FILL_D`, `${SAFE_SOURCES.models} → capModel`],
  },
  {
    id: "TENNIS_P50_52_SAFE",
    labelRu: "Теннис: цена 50–52 цента",
    ruleRu: "Только теннис, цена [0.50, 0.52), при условии существующих проверок допуска безопасного тенниса (safe-tennis eligibility).",
    tiersRu: [],
    allocationRu: "Дневной лимит 30 (cap 30), стандартное усечение.",
    sources: [`${SAFE_SOURCES.models} → TENNIS_P50_52_SAFE`, `${SAFE_SOURCES.safeTennis} → buildSafeUniverse`],
  },
];

export const SAFE_COMMON_RU = {
  filters: [
    "Единая «безопасная вселенная»: нетеннисные события проходят без изменений; теннисные — только если прошли проверку допуска safe-tennis (одна и та же для всех пяти моделей).",
    "Выбор делается до расчёта (selection-before-settlement): результат матча не используется при отборе.",
    "Лимит cap 30 событий в день на каждую модель; одно физическое событие не может войти в модель дважды.",
  ],
  caveats: [
    "Модели не независимы: одно и то же физическое событие может одновременно присутствовать в нескольких моделях. «Экспозиции моделей» ≠ «уникальные матчи».",
    "Это исторические/теневые (shadow) модели с результатами по записанным ценам. Исполнимого права на покупку (BUY) у них нет — это не торговый сигнал.",
    "Gross P&L считается в условных единицах (1u) по сохранённой цене входа только для расчётных WIN/LOSS; комиссии и net — UNKNOWN.",
  ],
} as const;

export type AlphaGuide = {
  id: string;
  nameEn: string;
  nameRu: string;
  stateText: string;
  stateExplainRu: string;
  summaryRu: string;
  canEmitBet: boolean;
  version: string;
};

const ALPHA_TEXT: Record<string, Omit<AlphaGuide, "id" | "canEmitBet" | "version">> = {
  VALUE_BACKED_TAIL_REPRICING: {
    nameEn: "Value-Backed Tail Repricing",
    nameRu: "Переоценка дешёвых исходов по ходу матча",
    stateText: "NOT_READY",
    stateExplainRu: "Не готово. Направление исследуется; сделок и ROI нет.",
    summaryRu:
      "Расшифровка названия: исследуется, можно ли во время матча находить дешёвые («хвостовые») исходы, цена которых подкреплена независимой оценкой ценности, и как они переоцениваются рынком по ходу игры. В коде это программа версии v0-facts-only: собираются только факты, правила входа нет.",
  },
  STATEWISE_PAYOFF_ARBITRAGE: {
    nameEn: "Structural / Statewise Payoff Arbitrage",
    nameRu: "Структурный арбитраж связанных контрактов",
    stateText: "SCOPED_NO_GO",
    stateExplainRu: "На проверенных данных вердикт «нет» (SCOPED_NO_GO). Исследование, не торговая стратегия.",
    summaryRu:
      "Расшифровка названия: исследуется, существуют ли между связанными контрактами одного события структурные расхождения выплат по состояниям исхода (арбитраж). В коде это программа версии v0-facts-only: правила входа нет; на проверенных данных вердикт SCOPED_NO_GO.",
  },
};

export const ALPHA_GUIDE: readonly AlphaGuide[] = ALPHA_PROGRAMS.map((p) => ({
  id: p.id,
  canEmitBet: p.canEmitBet,
  version: p.version,
  ...(ALPHA_TEXT[p.id] ?? { nameEn: p.id, nameRu: p.id, stateText: "UNKNOWN", stateExplainRu: "Нет описания.", summaryRu: "" }),
}));

export const LEVEL_LADDER_RU: ReadonlyArray<{ level: string; titleRu: string; textRu: string }> = [
  { level: "1", titleRu: "Утверждённое направление исследования", textRu: "Идея, которую разрешено изучать. Не стратегия, не сделки и не прибыль. Оба альфа-направления находятся здесь и не могут создавать ставки (canEmitBet=false)." },
  { level: "2", titleRu: "Историческая теневая модель (SAFE)", textRu: "Правило отбора, применяемое к записанным данным. Показывает, что бы выбрала модель; результаты считаются по ценам из записи, а не по исполненным ордерам." },
  { level: "3", titleRu: "Виртуальный контроль A/B/C", textRu: "Бумажные позиции по 1u по простым ценовым корзинам — эталон для сравнения. Деньги не используются." },
  { level: "4", titleRu: "Подтверждённая проспективная торговля", textRu: "Решения, зафиксированные заранее и проверенные независимо по часам БД и исполнимой цене покупки. Пока не достигнуто." },
  { level: "5", titleRu: "Production LIVE", textRu: "Реальные деньги. Требует отдельного разрешения основателя после проспективных доказательств. Данная страница его не даёт." },
];

const CONTROL_RU: Record<string, { labelRu: string; textRu: string }> = {
  CONTROL_PRICE_BUCKET_A: { labelRu: "Контроль A", textRu: "ценовая корзина" },
  CONTROL_PRICE_BUCKET_B: { labelRu: "Контроль B", textRu: "ценовая корзина" },
  CONTROL_PRICE_BUCKET_C: { labelRu: "Контроль C", textRu: "ценовая корзина" },
};

export const CONTROL_GUIDE = CONTROL_STRATEGIES.map((s) => ({
  id: s.id,
  version: s.version,
  canEmitBet: s.canEmitBet,
  range: s.range,
  ...(CONTROL_RU[s.id] ?? { labelRu: s.id, textRu: "" }),
}));

export const CONTROL_COMMON_RU = {
  scope: `Рынок: ${SCOPE_KEY} (победитель матча, весь матч). Вход допускается в течение ${ENTRY_WINDOW_MINUTES_AFTER_SCHEDULED_START} минут после запланированного старта.`,
  price: "Диапазон цены включительный и применяется к цене полной покупки (full-stake BUY VWAP).",
  note: "Контроли — эксперимент для сравнения, а не альфа и не торговый сигнал. Комиссии и net — UNKNOWN.",
} as const;

export const LIVE_RU = {
  summary: "Production LIVE — раздел с реальным исполнением. Ниже показан встроенный легаси-дашборд (исторические модели и режим чтения live-данных, только чтение).",
  caveat: "Присутствие LIVE-данных здесь не означает, что SAFE-модели, контроли или альфа-направления разрешены к торговле. Разрешение на реальные деньги — отдельный шаг.",
} as const;

/** Russian label for a canonical id; unknown ids pass through unchanged. */
export function modelLabelRu(id: string): string {
  const safe = SAFE_MODEL_GUIDE.find((m) => m.id === id);
  if (safe) return safe.labelRu;
  const alpha = ALPHA_GUIDE.find((a) => a.id === id);
  if (alpha) return alpha.nameRu;
  const ctl = CONTROL_GUIDE.find((c) => c.id === id);
  if (ctl) return ctl.labelRu;
  return id;
}
