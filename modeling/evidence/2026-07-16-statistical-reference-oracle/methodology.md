# Methodology

The Python CLI validates finite arrays and dimensions, requires the exact approved SPA parameters, rejects implicit block-size defaults, invokes the maintained numerical reference, and emits canonical sorted JSON. `input_sha256` hashes the normalized fixture input. `output_sha256` hashes normalized output before that hash field is added, avoiding self-reference.

Fixtures A and B exercise block selection. A is constant and records the official function's non-finite result as an expected fail-closed error. B is a 64-point AR(1) series (`phi=0.65`) generated with NumPy `default_rng(20260716)`. C has no designed advantage, D has one clear superior model, and E contains inferior, approximately equal, and superior alternatives. SPA fixture arrays use deterministic NumPy seeds `20260717`, `20260718`, and `20260719`; the bootstrap seed remains `20260716`.

Independent checks cover dimensions, finiteness, sample benchmark-minus-model means, p-value bounds/order, and positive block lengths. These checks do not independently prove SPA; `arch==8.0.0` is the numerical oracle.

Official references:

- `arch` package/release: https://pypi.org/project/arch/8.0.0/
- SPA API: https://arch.readthedocs.io/en/latest/multiple-comparison/generated/arch.bootstrap.SPA.html
- `optimal_block_length` API: https://arch.readthedocs.io/en/latest/bootstrap/generated/arch.bootstrap.optimal_block_length.html
- Hansen (2005), “A Test for Superior Predictive Ability”: https://doi.org/10.1198/073500105000000063
- White (2000), “A Reality Check for Data Snooping”: https://doi.org/10.1111/1468-0262.00152
- Politis–White (2004), automatic block-length selection: https://doi.org/10.1081/ETC-120028836
- Patton–Politis–White (2009), correction: https://doi.org/10.1080/07474930802459016
