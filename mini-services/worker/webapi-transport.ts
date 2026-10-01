/**
 * FayaNMS worker — SFOS WebAPI transport (CERT-006, READ-ONLY).
 *
 * The SFOS SSH CLI has no read-only full-config dump, so the sophos flavor
 * rides the device's WebAPI over TLS instead. This module is the ONLY code
 * path that talks to it, and it mirrors live-ssh.ts's discipline:
 *
 *   - the DeviceAdapter contract is unchanged (connect + fetchConfig,
 *     same ConfigResult shape) — the runner treats simulator, SSH-live and
 *     WebAPI-live devices identically downstream;
 *   - the action set is a HARDCODED allowlist of TWO read-only actions
 *     ("GetAuthStatus" for the probe, "GetConfig" for collection) — there
 *     is NO code path here that can mutate device state (apply/restore/
 *     rollback stay simulator-only by design);
 *   - the api-key is resolved worker-side from the vault (the secretRef
 *     pipeline) and never logged, never returned, and only ever placed in
 *     the request body to the validated endpoint.
 *
 * TLS TRUST (the HTTPS analog of SAFE-001's SSH host-key pinning):
 *   - verification is ALWAYS on (there is no rejectUnauthorized:false
 *     anywhere in this module — no bypass flag exists);
 *   - default trust anchor is the worker's system CA store: devices with
 *     publicly-trusted or operator-imported certificates work as-is;
 *   - FAYANMS_WEBAPI_CA_PEM (worker env) pins an additional CA/cert for
 *     devices with private or self-signed certificates — the operator's
 *     enrollment action, worker-side only;
 *   - a TLS failure refuses the request BEFORE the api-key is ever
 *     transmitted (the key only ever travels inside an authenticated and
 *     integrity-protected channel).
 *
 * Wire shape (the in-repo harness speaks it too — harness/sfos-webapi.ts):
 *   POST https://<host>:<port>/webserver/API
 *   body: {"action": "<action>", "api-key": "<key>"}
 *   response: {"Response": {"@id", "Status": {"@code", "@message"}, ...}}
 *     - GetAuthStatus adds "AuthStatus";
 *     - GetConfig adds "Configuration" (device config text, commonly
 *       under "#cdata-section").
 */

import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";

export class WebApiError extends Error {
  constructor(
    public readonly code:
      | "WEBAPI_UNREACHABLE"
      | "WEBAPI_TLS_UNTRUSTED"
      | "WEBAPI_TIMEOUT"
      | "WEBAPI_HTTP_STATUS"
      | "WEBAPI_ACTION_FAILED"
      | "WEBAPI_MALFORMED_RESPONSE"
      | "WEBAPI_TLS_CA_UNREADABLE"
      | "WEBAPI_RESPONSE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "WebApiError";
  }
}

export interface WebApiCredentials {
  host: string;
  port: number;
  apiKey: string;
}

const API_PATH = "/webserver/API";
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * RT-010 / F-011 — response budget for the device-facing WebAPI transport.
 * GetConfig responses are config text; observed SFOS output stays well
 * under 1 MiB. The SSH plane bounds every stream via appendBounded (1 MiB
 * default) — this is the WebAPI plane's equivalent hard cap so a hostile
 * or compromised "device" cannot balloon worker memory with an unbounded
 * or streamed body (fail-closed: the stream is DESTROYED, not truncated —
 * a truncated JSON envelope would be silently corrupt).
 */
export const WEBAPI_MAX_RESPONSE_BYTES = 4 * 1_048_576; // 4 MiB

/** The one and only read-only action allowlist. */
export const WEBAPI_ACTIONS = {
  probe: "GetAuthStatus",
  config: "GetConfig",
} as const;

/**
 * The worker-pinned CA/cert material (operator enrollment for devices with
 * private or self-signed certificates). The env value may be either a
 * PATH to a PEM file (compose-friendly) or INLINE PEM content (single-line
 * env values with escaped newlines are unescaped). Read lazily so tests
 * can set the env per-case; an unreadable PATH fails TYPED — never a
 * silent downgrade to system trust.
 */
function pinnedCaPem(): string | undefined {
  const raw = (process.env.FAYANMS_WEBAPI_CA_PEM ?? "").trim();
  if (!raw) return undefined;
  if (raw.startsWith("-----BEGIN")) {
    return raw.includes("\\n") ? raw.replaceAll("\\n", "\n") : raw;
  }
  try {
    return readFileSync(raw, "utf8");
  } catch (error) {
    throw new WebApiError(
      "WEBAPI_TLS_CA_UNREADABLE",
      `FAYANMS_WEBAPI_CA_PEM "${raw}" is not readable: ${(error as Error)?.message ?? "unknown"}`,
    );
  }
}

interface WebApiRawResponse {
  status: number;
  body: string;
  negotiated: string | null;
}

function postJson(
  creds: WebApiCredentials,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<WebApiRawResponse> {
  const body = JSON.stringify(payload);
  const ca = pinnedCaPem();
  return new Promise<WebApiRawResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: creds.host,
        port: creds.port,
        path: API_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        // TLS verification is ALWAYS on. `ca` ADDS a worker-pinned anchor
        // (operator enrollment); it never disables verification.
        ca,
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        // RT-010 / F-011 — bounded accumulation: a running byte count, and
        // any chunk that crosses the cap aborts the connection and rejects
        // with the typed WEBAPI_RESPONSE_TOO_LARGE error. The error message
        // carries ONLY the byte count — never a device data excerpt (log
        // hygiene).
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > WEBAPI_MAX_RESPONSE_BYTES) {
            // Abort the connection and reject typed. Reject is first-settle:
            // a late resolve (Bun can deliver the response "end" event
            // while data events are still draining) can no longer override
            // the typed failure, and a truncated body can never be parsed
            // as a valid envelope.
            req.destroy();
            reject(
              new WebApiError(
                "WEBAPI_RESPONSE_TOO_LARGE",
                `WebAPI response exceeded ${WEBAPI_MAX_RESPONSE_BYTES} bytes`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          // Belt-and-braces for runtimes where "end" is delivered before
          // the final "data" handler has run its cap check: the accumulated
          // byte count is the authority, not the event order.
          if (bytes > WEBAPI_MAX_RESPONSE_BYTES) {
            reject(
              new WebApiError(
                "WEBAPI_RESPONSE_TOO_LARGE",
                `WebAPI response exceeded ${WEBAPI_MAX_RESPONSE_BYTES} bytes`,
              ),
            );
            return;
          }
          const socket = res.socket as { getProtocol?: () => string | null } | null;
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            negotiated: typeof socket?.getProtocol === "function" ? socket.getProtocol() : null,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new WebApiError("WEBAPI_TIMEOUT", `WebAPI request timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err: NodeJS.ErrnoException & { code?: string }) => {
      if (err instanceof WebApiError) {
        reject(err);
        return;
      }
      const code = err.code ?? "";
      if (/CERT|TLS|SSL|EPROTO|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_GET|EXPIRED/i.test(code) || /certificate|TLS|SSL/i.test(err.message ?? "")) {
        reject(
          new WebApiError(
            "WEBAPI_TLS_UNTRUSTED",
            `TLS trust failed for ${creds.host}:${creds.port} — the endpoint certificate is not trusted by the worker (no credential was sent). Enroll the device CA via FAYANMS_WEBAPI_CA_PEM (fail-closed; there is no verification bypass): ${err.message}`,
          ),
        );
        return;
      }
      if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN/.test(code)) {
        reject(new WebApiError("WEBAPI_UNREACHABLE", `WebAPI endpoint ${creds.host}:${creds.port} is unreachable: ${err.message}`));
        return;
      }
      reject(new WebApiError("WEBAPI_UNREACHABLE", `WebAPI request to ${creds.host}:${creds.port} failed: ${err.message}`));
    });
    req.end(body);
  });
}

function parseEnvelope(raw: WebApiRawResponse): Record<string, unknown> {
  if (raw.status !== 200) {
    throw new WebApiError("WEBAPI_HTTP_STATUS", `WebAPI endpoint answered HTTP ${raw.status} (expected 200)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.body);
  } catch {
    throw new WebApiError("WEBAPI_MALFORMED_RESPONSE", "WebAPI response is not valid JSON");
  }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const response = root && typeof root["Response"] === "object" && root["Response"] !== null
    ? (root["Response"] as Record<string, unknown>)
    : null;
  if (!response) {
    throw new WebApiError("WEBAPI_MALFORMED_RESPONSE", "WebAPI response lacks the Response envelope");
  }
  return response;
}

function assertStatusOk(response: Record<string, unknown>, action: string): void {
  const status = response["Status"];
  const statusObj = status && typeof status === "object" && !Array.isArray(status)
    ? (status as Record<string, unknown>)
    : null;
  const code = typeof statusObj?.["@code"] === "string" ? statusObj["@code"] : "";
  const message = typeof statusObj?.["@message"] === "string" ? statusObj["@message"] : "";
  // The SFOS envelope codes device success as "440" ("Action succeeded");
  // anything else — notably authentication failures — is a typed refusal.
  if (code !== "440") {
    throw new WebApiError(
      "WEBAPI_ACTION_FAILED",
      `WebAPI action ${action} was refused by the device (Status ${code || "none"}${message ? `: ${message}` : ""})`,
    );
  }
}

/** Extract the configuration text from a GetConfig response. */
export function extractConfigText(response: Record<string, unknown>): string {
  const config = response["Configuration"];
  if (typeof config === "string") return config;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const cdata = (config as Record<string, unknown>)["#cdata-section"];
    if (typeof cdata === "string") return cdata;
  }
  const alt = response["ConfigurationData"];
  if (typeof alt === "string") return alt;
  throw new WebApiError("WEBAPI_MALFORMED_RESPONSE", "GetConfig response carries no Configuration text");
}

async function callApi(
  creds: WebApiCredentials,
  action: string,
  timeoutMs: number,
): Promise<{ response: Record<string, unknown>; negotiated: string | null }> {
  const raw = await postJson(creds, { action, "api-key": creds.apiKey }, timeoutMs);
  const response = parseEnvelope(raw);
  assertStatusOk(response, action);
  return { response, negotiated: raw.negotiated };
}

export interface WebApiProbe {
  latencyMs: number;
  model: string | null;
  firmware: string | null;
  /** e.g. "TLSv1.3" — the negotiated protocol of the verified channel */
  negotiated: string | null;
}

/** Read-only connectivity probe (GetAuthStatus). */
export async function webApiProbe(creds: WebApiCredentials, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<WebApiProbe> {
  const started = Date.now();
  const { response, negotiated } = await callApi(creds, WEBAPI_ACTIONS.probe, timeoutMs);
  const auth = response["AuthStatus"];
  const authObj = auth && typeof auth === "object" && !Array.isArray(auth)
    ? (auth as Record<string, unknown>)
    : null;
  const device = authObj && typeof authObj["DeviceInfo"] === "object" && authObj["DeviceInfo"] !== null
    ? (authObj["DeviceInfo"] as Record<string, unknown>)
    : null;
  return {
    latencyMs: Date.now() - started,
    model: typeof device?.["Model"] === "string" ? device["Model"] : null,
    firmware: typeof device?.["FirmwareVersion"] === "string" ? device["FirmwareVersion"] : null,
    negotiated,
  };
}

/** Read-only full-config collection (GetConfig) — the ONLY fetch path. */
export async function webApiFetchConfigText(creds: WebApiCredentials, timeoutMs = 20000): Promise<string> {
  const { response } = await callApi(creds, WEBAPI_ACTIONS.config, timeoutMs);
  const text = extractConfigText(response);
  return text.endsWith("\n") ? text : `${text}\n`;
}
