import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail closed at process start: an invalid selector or a mis-bound passive contour never serves.
    const [{ getActiveContour }, { validateContourRuntime }] = await Promise.all([
      import("./lib/constructor/registry"),
      import("./lib/constructor/runtimeContract"),
    ]);
    validateContourRuntime(getActiveContour());
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
