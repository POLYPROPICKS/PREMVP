import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Fail closed at process start: an invalid selector or a mis-bound passive contour never serves.
    const { bootProcessRuntime } = await import("./lib/constructor/bootstrap");
    bootProcessRuntime();
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
