# Locked fixed-1u versus dynamic-active-3% profiles

This package evaluates exactly four arms over the same 231 intended PRIMARY IDs. It uses no new model search, Vault search, parameter tuning, capacity change, or operation-window change. Amounts are units (1u = $100).

The locked Vault policy is one-way-ratcheted `CPPI_0.4_0.5`: alpha `0.4`, multiplier `0.5`, Active-to-Vault only. `four_arm_profiles.json` is the compact table; the two selected CPPI ledgers and curves are separate attributable artifacts.
