# FayaNMS — Vendor Glyphs: Legal & Brand Policy

**Status:** Phase B2 deliverable · governing policy for every `vendor-*` glyph
**Scope:** `public/icons/fayanms/vendor-*.svg`, the mapping in `src/lib/icons/vendor-icons.ts`, and every surface that renders a vendor glyph (`DeviceVendorIcon`, drivers view, device inventory).
**Related:** [ICONOGRAPHY.md §4](./ICONOGRAPHY.md) · [ASSET-MANIFEST.md](./ASSET-MANIFEST.md) · [ICON-CATALOG.md](./ICON-CATALOG.md)

---

## 1. The rule (verbatim)

> **These are FayaNMS project adapter glyphs, not official vendor trademarks.**

Every `vendor-*` SVG in `public/icons/fayanms/` is an original FayaNMS project asset: a
uniform, abstract adapter badge drawn in the same 24×24 stroke system as the rest of the
icon kit. It is a visual *reference to a supported adapter key*, not a reproduction,
imitation-for-identification, or endorsement of any vendor's logo.

Consequences of the rule:

- **Do not call them "the Cisco logo", "the Juniper logo", etc.** — in code comments, UI text,
  docs, alt text, tooltips or commit messages. Correct usage: *"Cisco platform adapter badge
  (non-official project glyph)"*, exactly as the icon catalog does.
- Do not use vendor names as the accessible name of the glyph alone; the standalone mode of
  `DeviceVendorIcon` titles it as *"«VendorLabel» adapter glyph"*.
- Do not redraw, approximate or "homage" any real vendor logo inside a FayaNMS glyph.
- Do not present a vendor glyph as vendor certification, partnership, or endorsement — the
  README's honest-status section already makes the adapter-certification state explicit.
- Vendor glyphs use the same neutral `currentColor` treatment as all Tier 2 icons: no vendor
  brand colors, no vendor-dominant styling (see [BRAND-GUIDELINES.md §1.1](./BRAND-GUIDELINES.md)).

## 2. Mapping table (vendor key → glyph file)

Vendor keys are the canonical `Device.vendor.key` codes of the worker adapter contract.
Matching is case-insensitive/trim-tolerant (`vendorIconFor()`); unknown or missing keys fall
back to `vendor-generic` — never a broken image, never an invented mapping.

| Vendor key | Glyph file (`public/icons/fayanms/`) | Kit | Correct description |
|---|---|---|---|
| `cisco` | `vendor-cisco.svg` | v1 | Cisco platform adapter badge (non-official project glyph) |
| `fortinet` | `vendor-fortigate.svg` | v1 | FortiGate platform adapter badge (non-official project glyph) |
| `sophos` | `vendor-sophos.svg` | v1 | Sophos XGS platform adapter badge (non-official project glyph) |
| `hpe` | `vendor-hpe.svg` | v1 | HPE/Aruba platform adapter badge (non-official project glyph) |
| `juniper` | `vendor-juniper.svg` | v2 | Juniper Networks platform adapter badge (non-official project glyph) |
| `palo` | `vendor-palo-alto.svg` | v2 | Palo Alto Networks platform adapter badge (non-official project glyph) |
| `generic` / unknown / missing | `vendor-generic.svg` | v1 | Generic adapter badge |

Runtime mapping SoT: `VENDOR_ICON` in `src/lib/icons/vendor-icons.ts`; the human-readable
labels live in `VENDOR_LABELS` there (used for standalone titles/tooltips).

## 3. Future-upgrade policy (official logos)

FayaNMS deliberately ships **no official vendor logos**. If that policy is ever revisited —
e.g. under a vendor logo/brand-use program — this document is the gate. **Before any official
logo file enters the repository, the table below must be completed for that asset and the
glyph re-classified away from "project adapter glyph".**

| Field | Record (per official logo) |
|---|---|
| Asset source | Where the file came from (exact vendor program/URL, file version/date) |
| License / brand-policy URL | The vendor brand-guidelines or trademark-use policy URL actually relied on |
| Permitted use | What the policy permits (e.g. "identification of interoperability", nominative use) and where FayaNMS uses it |
| Color restrictions | Required colors / monochrome obligations per the policy |
| Clear space & min size | Policy-required exclusion zone and minimum reproduction size |
| Last review date | Date the policy was last checked (re-review at least annually) |

Until such an entry exists for a vendor, that vendor keeps its project adapter glyph and the
§1 rule applies in full. Absence of an entry is itself the audit finding if an official logo
is found in the tree.
