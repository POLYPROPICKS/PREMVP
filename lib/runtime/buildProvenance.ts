// Deployment build-provenance seam for GET /api/build-info.
// Resolution happens once per production build (next.config.ts); the HTTP
// route only reads the already-baked result — never Git state per request.

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export type ProvenanceSource = "env_var" | "git_head" | "unknown";

export interface BuildProvenance {
  commit_sha: string;
  provenance_source: ProvenanceSource;
}

export interface BuildInfoPayload {
  service: "polypropicks-premvp";
  repository: "POLYPROPICKS/PREMVP";
  commit_sha: string;
  provenance_source: ProvenanceSource;
}

export const BUILD_PROVENANCE_MISMATCH_ERROR = "BUILD_PROVENANCE_SOURCE_MISMATCH";

/** Accepts a full 40-char hex SHA (any case) and normalizes it to lowercase.
 *  Anything shorter, longer, or non-hex is rejected outright — never
 *  truncated or padded. */
export function normalizeShaCandidate(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length !== 40) return null;
  const lowered = trimmed.toLowerCase();
  return FULL_SHA_RE.test(lowered) ? lowered : null;
}

/** Build-time resolution: prefers an already-available commit-SHA env var,
 *  falls back to a Git HEAD SHA, and fails closed if both are present but
 *  disagree. Never invoked from the HTTP route. */
export function resolveBuildProvenance(sources: {
  envCommitSha?: string | null;
  gitHeadSha?: string | null;
}): BuildProvenance {
  const fromEnv = normalizeShaCandidate(sources.envCommitSha ?? null);
  const fromGit = normalizeShaCandidate(sources.gitHeadSha ?? null);

  if (fromEnv && fromGit) {
    if (fromEnv !== fromGit) {
      throw new Error(BUILD_PROVENANCE_MISMATCH_ERROR);
    }
    return { commit_sha: fromEnv, provenance_source: "env_var" };
  }
  if (fromEnv) return { commit_sha: fromEnv, provenance_source: "env_var" };
  if (fromGit) return { commit_sha: fromGit, provenance_source: "git_head" };
  return { commit_sha: "unknown", provenance_source: "unknown" };
}

/** Build-config-only helper: shells out to `git rev-parse HEAD` once. Must
 *  never be called from the HTTP route. Returns null on any failure. */
export function resolveGitHeadShaSync(cwd: string = process.cwd()): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync("git rev-parse HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return normalizeShaCandidate(out);
  } catch {
    return null;
  }
}

/** Builds the exact public /api/build-info payload and HTTP status from the
 *  build-baked env values. Reads process.env only — no Git state, no shell. */
export function buildBuildInfoResponse(env: {
  commitSha?: string | null;
  provenanceSource?: string | null;
}): { body: BuildInfoPayload; status: 200 | 503 } {
  const commit_sha = normalizeShaCandidate(env.commitSha ?? null) ?? "unknown";
  const provenanceSourceRaw = env.provenanceSource ?? null;
  const provenance_source: ProvenanceSource =
    commit_sha !== "unknown" && (provenanceSourceRaw === "env_var" || provenanceSourceRaw === "git_head")
      ? provenanceSourceRaw
      : "unknown";

  return {
    body: {
      service: "polypropicks-premvp",
      repository: "POLYPROPICKS/PREMVP",
      commit_sha,
      provenance_source,
    },
    status: commit_sha === "unknown" ? 503 : 200,
  };
}
