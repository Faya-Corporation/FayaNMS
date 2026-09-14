import { describe, expect, test } from "bun:test";

import { isLiveWebApiVendor, requiredLiveCredentialType } from "../../src/lib/devices/live-transport";
import {
  extractConfigText,
  WEBAPI_ACTIONS,
  WebApiError,
} from "../../mini-services/worker/webapi-transport";
import { resolveLiveWebApiFlavor } from "../../mini-services/worker/live-webapi";
import { isLiveWebApiVendor as workerIsLiveWebApiVendor } from "../../mini-services/worker/adapter-router";
import { SFOS_HARNESS_CONFIG } from "../../mini-services/worker/harness/sfos-webapi";

/**
 * CERT-006 — Sophos SFOS WebAPI transport unit pins (the full transport +
 * routing certification lives in mini-services/worker/certify.ts, which
 * drives the REAL loopback HTTPS harness; these pins lock the app-side
 * invariant, the vendor↔flavor mapping, the action allowlist identity and
 * the response parsing helpers).
 */

describe("CERT-006: vendor ↔ transport mapping (app + worker agree)", () => {
  test("sophos is a WebAPI vendor on BOTH sides (single source of truth mirrored)", () => {
    expect(isLiveWebApiVendor("sophos")).toBe(true);
    expect(workerIsLiveWebApiVendor("sophos")).toBe(true);
    expect(isLiveWebApiVendor("Sophos ")).toBe(true); // trimmed + case-insensitive
  });

  test("the five CLI vendors stay SSH (zero regression)", () => {
    for (const vendor of ["cisco", "fortinet", "hpe", "juniper", "palo", "generic", ""]) {
      expect(isLiveWebApiVendor(vendor)).toBe(false);
      expect(workerIsLiveWebApiVendor(vendor)).toBe(false);
    }
  });

  test("credential-profile TYPE coupling: sophos ⇒ API_TOKEN, CLI vendors ⇒ SSH_PASSWORD", () => {
    expect(requiredLiveCredentialType("sophos")).toBe("API_TOKEN");
    expect(requiredLiveCredentialType("cisco")).toBe("SSH_PASSWORD");
    expect(requiredLiveCredentialType("fortinet")).toBe("SSH_PASSWORD");
    expect(requiredLiveCredentialType(null)).toBe("SSH_PASSWORD");
  });

  test("the WebAPI flavor registry keys by vendor and maps to the simulator's sfos flavor", () => {
    const flavor = resolveLiveWebApiFlavor("sophos");
    expect(flavor.adapter).toBe("sophos-sfos-webapi");
    expect(flavor.configFlavor).toBe("sfos");
    expect(() => resolveLiveWebApiFlavor("cisco")).toThrow(/No WebAPI flavor/);
  });
});

describe("CERT-006: read-only action allowlist identity", () => {
  test("EXACTLY two actions exist and both are read-only", () => {
    const values = Object.values(WEBAPI_ACTIONS);
    expect(values).toHaveLength(2);
    expect(values).toContain("GetAuthStatus");
    expect(values).toContain("GetConfig");
    // no mutation-flavored action can ever creep in silently
    for (const action of values) {
      expect(/set|add|delete|import|update|apply|execute|restart|reboot/i.test(action)).toBe(false);
    }
  });
});

describe("CERT-006: GetConfig response parsing", () => {
  test("extracts the #cdata-section shape the SFOS envelope uses", () => {
    const text = extractConfigText({
      Configuration: { "#cdata-section": SFOS_HARNESS_CONFIG },
    });
    expect(text).toContain("HARNESS-SFOS-01");
    expect(text).toContain("SFOS-CONFIG-MARKER-HARNESS");
  });

  test("accepts a plain-string Configuration (defensive)", () => {
    expect(extractConfigText({ Configuration: "line1\nline2" })).toBe("line1\nline2");
  });

  test("accepts the ConfigurationData alternate node (defensive)", () => {
    expect(extractConfigText({ ConfigurationData: "alt" })).toBe("alt");
  });

  test("refuses a response without config text (WEBAPI_MALFORMED_RESPONSE)", () => {
    try {
      extractConfigText({ Status: { "@code": "440" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WebApiError);
      expect((error as WebApiError).code).toBe("WEBAPI_MALFORMED_RESPONSE");
    }
  });
});
