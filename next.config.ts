import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { resolveBuildProvenance, resolveGitHeadShaSync } from "./lib/runtime/buildProvenance";

const buildProvenance = resolveBuildProvenance({
  envCommitSha: process.env.SOURCE_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
  gitHeadSha: resolveGitHeadShaSync(),
});

const nextConfig: NextConfig = {
  /* config options here */
  env: {
    BUILD_PROVENANCE_COMMIT_SHA: buildProvenance.commit_sha,
    BUILD_PROVENANCE_SOURCE: buildProvenance.provenance_source,
  },
};

export default withSentryConfig(nextConfig, {
  org: "artifactvault",
  project: "polypropicks-premvp",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: false,
});
