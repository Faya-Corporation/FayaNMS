/**
 * LIVE-plane transport selection (CERT-006).
 *
 * The live plane's TRANSPORT is vendor-determined:
 *   - the five CLI vendors (cisco, fortinet, hpe, juniper, palo) ride SSH
 *     exec with password auth (SAFE-001 host-key pinning applies);
 *   - sophos rides the SFOS WebAPI over TLS (the SFOS SSH CLI has no
 *     read-only full-config dump) — the linked profile therefore carries
 *     an API_TOKEN, whose secret is the WebAPI api-key.
 *
 * The dataSource label ("LIVE_SSH") predates transport selection and is
 * kept for UI/DB stability — the plane is "live", the transport is
 * vendor-determined. The app-side invariant mirrors this: the credential
 * profile TYPE must match the transport the vendor will actually drive
 * (a stronger coupling than the previous SSH_PASSWORD-only rule).
 */

export const LIVE_WEBAPI_VENDORS = ["sophos"] as const;

export function isLiveWebApiVendor(vendorKey: string | null | undefined): boolean {
  const key = (vendorKey ?? "").trim().toLowerCase();
  return (LIVE_WEBAPI_VENDORS as readonly string[]).includes(key);
}

/**
 * The credential profile TYPE the live transport requires for a vendor:
 * API_TOKEN (the WebAPI api-key) for WebAPI vendors, SSH_PASSWORD
 * otherwise.
 */
export function requiredLiveCredentialType(
  vendorKey: string | null | undefined,
): "SSH_PASSWORD" | "API_TOKEN" {
  return isLiveWebApiVendor(vendorKey) ? "API_TOKEN" : "SSH_PASSWORD";
}
