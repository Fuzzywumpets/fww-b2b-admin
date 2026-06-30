/**
 * fww-logsink — drop-in error logging for Node/Express services (the VPS apps).
 *
 *   import { installGlobalHandlers, expressErrorMiddleware, reportEvent, logAction } from "./fww-logsink.mjs";
 *   installGlobalHandlers();                  // top of your entrypoint
 *   ...
 *   app.use(expressErrorMiddleware());        // AFTER your routes (last middleware)
 *
 * Config via env (set in the service's .env / systemd unit):
 *   ERROR_SINK_URL, ERROR_SINK_BEARER, FWW_APP_NAME, FWW_UNIT (systemd unit), FWW_REPO
 * Requires Node 18+ (global fetch). Never throws.
 */

const URL_ = process.env.ERROR_SINK_URL;
const BEARER = process.env.ERROR_SINK_BEARER;
const APP = process.env.FWW_APP_NAME || "unknown";
const UNIT = process.env.FWW_UNIT || null;
const REPO = process.env.FWW_REPO || null;
const CWD = process.env.FWW_CWD || process.cwd();

export function reportEvent(payload) {
  if (!URL_) return;
  try {
    const body = JSON.stringify({
      app: APP, host: "vps", env: process.env.NODE_ENV || "prod",
      unit: UNIT, repo: REPO, cwd: CWD, ts: Date.now(), ...payload,
    });
    fetch(URL_.replace(/\/$/, "") + "/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (BEARER || "") },
      body,
      signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
    }).catch(() => {});
  } catch (_) { /* swallow */ }
}

// non-error "action" log line (live activity, not alerted)
export function logAction(message, context) {
  reportEvent({ kind: "action", severity: "info", message, context });
}

export function installGlobalHandlers() {
  process.on("uncaughtException", (err) => {
    reportEvent({ kind: "unhandled", severity: "critical", message: String((err && err.message) || err), stack: err && err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    reportEvent({ kind: "unhandled", severity: "critical", message: "unhandledRejection: " + String((reason && reason.message) || reason), stack: reason && reason.stack });
  });
}

export function expressErrorMiddleware() {
  return (err, req, res, next) => {
    reportEvent({
      kind: "error", severity: "error",
      message: String((err && err.message) || err), stack: err && err.stack,
      url: req && (req.originalUrl || req.url), method: req && req.method,
    });
    next(err);
  };
}
