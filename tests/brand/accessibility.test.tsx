import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { deviceIconLabelFor } from "../../src/lib/icons/device-icons";
import { vendorIconFor } from "../../src/lib/icons/vendor-icons";

/**
 * Icon/brand accessibility contracts (task R3-a) — mixed unit + source
 * contract tests in the repo convention (readFileSync + assertions; no DOM
 * renderer is installed, so component behavior is pinned at the source
 * level, mirroring scripts/validate-brand-consumers.ts).
 *
 * Covers re-audit findings:
 *  - B2-020 — standalone device glyphs expose MEANINGFUL accessible names
 *    (deviceIconLabelFor: role labels, family names, generic "Device");
 *    the old constant placeholder "Device type glyph" is gone;
 *  - B2-021 — FayanmsIcon standalone semantics: title → role="img" +
 *    aria-label (the primary accessible-name API) + native title (hover
 *    affordance only); absent title keeps the glyph decorative;
 *  - B2-018 — brand components paint through the `text-primary` design
 *    token; the raw brand hex never appears in app components;
 *  - B2-022 — the documented 14px glyph minimum exists as the xs size;
 *  - RTL/theme invariants — the CSS-mask renderer paints currentColor
 *    (theme-adaptive), the mobile drawer flips side with the reading
 *    direction, and directional chrome mirrors under RTL while the brand
 *    mark never does;
 *  - B2-027 — dedicated automated accessibility tests exist in-repo.
 */

const ROOT = join(import.meta.dir, "..", "..");

function read(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), "utf8");
}

describe("unit — accessible label resolution (B2-020)", () => {
  test("known role codes resolve to their canonical role labels", () => {
    expect(deviceIconLabelFor("CORE_ROUTER")).toBe("Core router");
    expect(deviceIconLabelFor("TOP_OF_RACK")).toBe("Top of rack");
    expect(deviceIconLabelFor("WIRELESS_CONTROLLER")).toBe("Wireless controller");
    expect(deviceIconLabelFor("LOAD_BALANCER")).toBe("Load balancer");
  });

  test("free-form strings resolve to their substring family name", () => {
    expect(deviceIconLabelFor("router")).toBe("Router");
    expect(deviceIconLabelFor("linux server")).toBe("Server");
    expect(deviceIconLabelFor("firewall-router")).toBe("Firewall");
  });

  test("missing input falls back to the generic 'Device' label", () => {
    expect(deviceIconLabelFor(undefined)).toBe("Device");
    expect(deviceIconLabelFor(null)).toBe("Device");
    expect(deviceIconLabelFor("")).toBe("Device");
    expect(deviceIconLabelFor("totally-unknown-thing")).toBe("Device");
  });

  test("vendor resolution honors canonical adapter codes", () => {
    expect(vendorIconFor("cisco")).toBe("vendor-cisco");
    expect(vendorIconFor("FORTINET")).toBe("vendor-fortigate");
    expect(vendorIconFor("palo")).toBe("vendor-palo-alto");
  });
});

describe("source contract — FayanmsIcon standalone semantics (B2-021)", () => {
  const source = read("src", "components", "icons", "fayanms-icon.tsx");

  test("title renders role=img with aria-label as the primary accessible name", () => {
    expect(source).toContain(`aria-label={title}`);
    expect(source).toContain(`role={title ? "img" : undefined}`);
  });

  test("native title is only the hover affordance, never the sole naming channel", () => {
    // The contract REQUIRES the aria-label (B2-021); the title attribute alone
    // is not an acceptable accessible-name API.
    expect(source).toContain(`title={title}`);
    expect(source).toContain(`aria-label={title}`);
  });

  test("absent title keeps the glyph decorative (aria-hidden)", () => {
    expect(source).toContain(`aria-hidden={title ? undefined : true}`);
  });

  test("the CSS mask paints currentColor so glyphs adapt to theme and direction", () => {
    expect(source).toContain(`backgroundColor: "currentColor"`);
  });
});

describe("source contract — meaningful standalone device naming (B2-020)", () => {
  test("NetworkDeviceIcon names itself via deviceIconLabelFor", () => {
    const source = read("src", "components", "icons", "network-device-icon.tsx");
    expect(source).toContain(`deviceIconLabelFor(`);
  });

  test("the stale generic placeholder label is gone", () => {
    const source = read("src", "components", "icons", "network-device-icon.tsx");
    expect(source).not.toContain("Device type glyph");
  });

  test("DeviceVendorIcon standalone naming follows the 'adapter glyph' policy", () => {
    const source = read("src", "components", "icons", "device-vendor-icon.tsx");
    expect(source).toContain("adapter glyph");
  });
});

describe("source contract — brand components use design tokens (B2-018/B2-022)", () => {
  test("FayaNMSMark ships the documented named sizes 14/20/24/32/40/64", () => {
    const source = read("src", "components", "brand", "fayanms-mark.tsx");
    const sizesBlock = source.match(/MARK_SIZES\s*=\s*\{[^}]*\}/)?.[0];
    expect(sizesBlock).toBeDefined();
    for (const px of [14, 20, 24, 32, 40, 64]) {
      expect(sizesBlock).toContain(String(px));
    }
  });

  test("the brand tone paints through the text-primary token, never raw hex", () => {
    const source = read("src", "components", "brand", "fayanms-mark.tsx");
    expect(source).toContain("text-primary");
    expect(source).not.toContain("text-[#2563EB]");
    expect(source).not.toContain("#2563EB");
  });

  test("standalone mark carries the accessible-name API (aria-label when accessible)", () => {
    const source = read("src", "components", "brand", "fayanms-mark.tsx");
    expect(source).toContain(`aria-label={accessible ? title : undefined}`);
  });

  test("FayaNMSWordmark never hardcodes the brand hex", () => {
    const source = read("src", "components", "brand", "fayanms-wordmark.tsx");
    expect(source).not.toContain("#2563EB");
  });
});

describe("source contract — RTL/theme invariants", () => {
  test("mobile drawer side flips with the reading direction", () => {
    const source = read("src", "components", "shell", "app-shell.tsx");
    expect(source).toContain(`side={isRtl ? "right" : "left"}`);
  });

  test("directional sidebar chrome mirrors under RTL (brand marks never do)", () => {
    const source = read("src", "components", "shell", "app-sidebar.tsx");
    // The PanelLeft toggle glyphs are directional chrome → mirrored under RTL.
    expect(source).toContain("rtl:-scale-x-100");
    expect(source).toContain("PanelLeftOpen");
    expect(source).toContain("PanelLeftClose");
  });
});
