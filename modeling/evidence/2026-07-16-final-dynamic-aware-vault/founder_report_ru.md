# Финальный Dynamic-aware Vault frontier

Историческое pseudo-OOS evidence, не forward/live validation. 1u = $100. Fixed CPPI нельзя автоматически переносить в Dynamic: его отдельный risk budget создаёт skips и подавляет compounding. Buffered Profit Harvest сохраняет stake ровно 3% и переводит только settled peak profit сверх buffer, в пределах Minsk-cycle cap.

Контроль: 169.32412195u PnL, max fall 33.96564534u, CVaR95 43.85905932u. Winner: DYNAMIC_NO_VAULT; PnL 169.32412195u; Vault 0u; skips 1.

Все семь arms, development/confirmation/full-history и transfer events находятся в machine evidence. Итог: NO_DYNAMIC_VAULT_PASSED_PREDECLARED_GATES. Следующий шаг — founder decision и atomic freeze без нового исследования.
