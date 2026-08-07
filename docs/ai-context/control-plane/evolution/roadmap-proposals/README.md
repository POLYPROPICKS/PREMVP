Persisted Automation Roadmap Governor results and their rendered Founder reports land
here as <result_id>.json and <result_id>.report.md, valid against
../schemas/GOVERNOR_RESULT.schema.json. Empty until the first real Governor run —
Stage 2 landing does not generate a historical result.

A result's `roadmap_delta` field, when present, is always `accepted: false`. It is a
proposal for the Architect Promotion Gate, never a decision recorded by this directory.
