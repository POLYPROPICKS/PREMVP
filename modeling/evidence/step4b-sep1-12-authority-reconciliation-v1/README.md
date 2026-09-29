# Step 4B Sep 1–12 authority reconciliation

Status: `PROVISIONAL_AUDIT`; downstream Structural Authority and P50 evidence at this checkpoint still use stored row snapshot settlement. `NOT_EXECUTION_AUTHORITY`.

The 1.75–2.00 source-soccer population is 302 rows, 296 exact market identities, and 273 physical events. Within those 273 events, the frozen overlay proves 50 ordinary events and leaves 223 market type unresolved. The structural cell's 68 selections have a different denominator: it uses overlay-canonical soccer, including recovered-sport source rows. The full odds-band source has 3,205 rows; 613 overlay-canonical soccer events contain 68 proven ordinary events and 545 unresolved events. The 68 selected rows are 46 source-soccer and 22 source-null, while at event level 50 of the 68 ordinary events occur in the source-soccer population. This distinguishes source-row origin from event-level inclusion.

For the exact 68 selected identities, stored labels are 26 WIN, 24 LOSS, 18 OPEN. The existing `resolveGammaTerminal()` path independently returns 32 WIN, 36 LOSS, 0 OPEN. All 50 stored terminal labels match. Of 18 stored OPEN, Gamma resolves 6 WIN and 12 LOSS. The same selected identities therefore change from 50 settled / −1.45u / −2.9079% to 68 settled / −8.37u / −12.302%. No selection predicate changed.

The Gamma result is frozen in `FRESH_GAMMA_SELECTED_LABELS.json` and is keyed by exact condition/token. This file covers the strict Sep 1–12 1.75–2.00 cell only. It must not silently be treated as refreshed settlement for every historical cell.

The Founder reference `301 / +59.49u / +19.8%` has no recovered repository methodology at this checkpoint. Its `N` being near the 302 raw source rows is a clue, not proof that it counts rows. It remains a non-authoritative reference.
