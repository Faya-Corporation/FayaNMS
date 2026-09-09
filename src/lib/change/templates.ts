/**
 * FayaNMS — Change templates (Task 4-a).
 *
 * STATIC data — one template per managed vendor flavor. Templates are
 * starting points: the wizard prefills title/plans/steps from them and the
 * user edits freely (enforced by the UI note on the templates view).
 *
 * Step types map to the ChangeStep.type column:
 *   CHECK | BACKUP | APPLY | VALIDATE | ROLLBACK
 */

import type { ChangeType } from "./risk";

export type ChangeStepType = "CHECK" | "BACKUP" | "APPLY" | "VALIDATE" | "ROLLBACK";

export interface ChangeTemplateStep {
  name: string;
  type: ChangeStepType;
}

export interface ChangeTemplate {
  id: string;
  name: string;
  /** Vendor key as stored on Vendor.key (cisco | fortinet | sophos | hpe). */
  vendorKey: string;
  description: string;
  defaultTitle: string;
  implementationPlan: string;
  validationPlan: string;
  rollbackPlan: string;
  defaultSteps: ChangeTemplateStep[];
  /** Wizard prefill: templates start as NORMAL changes. */
  defaultType: ChangeType;
}

export const CHANGE_TEMPLATES: ChangeTemplate[] = [
  {
    id: "cisco-ios-firmware-upgrade",
    name: "Cisco IOS — Staged Firmware Upgrade",
    vendorKey: "cisco",
    description:
      "Rolling firmware upgrade for Cisco IOS/IOS-XE devices with per-member reload, checksum staging and partition rollback.",
    defaultTitle: "Staged firmware upgrade on Cisco device",
    implementationPlan:
      "1. Stage the new image to flash and verify the MD5/SHA checksum against the vendor hash.\n2. Confirm the device is reachable and the standby supervisor/stack member is healthy.\n3. Point the boot variable at the new image and reload the standby member first.\n4. After standby convergence, reload the active member (traffic fails over to the standby).\n5. Confirm version, redundancy state and interface status before closing.",
    validationPlan:
      "Post-upgrade: show version matches the target release, redundancy/stack state OK, all uplinks and PoE members up, CPU/memory within 10% of the pre-change baseline.",
    rollbackPlan:
      "Restore the previous boot variable (auto-boot from the retained old partition), reload, and re-apply the pre-change configuration backup captured in step 2.",
    defaultSteps: [
      { name: "Verify reachability and stage image checksum", type: "CHECK" },
      { name: "Pre-upgrade configuration backup", type: "BACKUP" },
      { name: "Install image and reload standby member", type: "APPLY" },
      { name: "Post-upgrade validation (version, PoE, uplinks)", type: "VALIDATE" },
      { name: "Post-upgrade configuration backup", type: "BACKUP" },
    ],
    defaultType: "NORMAL",
  },
  {
    id: "fortios-policy-change",
    name: "FortiOS — Firewall Policy Change",
    vendorKey: "fortinet",
    description:
      "Controlled firewall policy change on FortiGate with HA sync pre-checks, session-parity validation and address/policy rollback.",
    defaultTitle: "Firewall policy change on FortiGate cluster",
    implementationPlan:
      "1. Verify HA sync status and cluster health (both members in sync).\n2. Capture the current policy block for the affected section.\n3. Apply the policy change (address objects, service objects or policy row) on the primary.\n4. Confirm the config synced to the secondary member.\n5. Test the intended traffic flow end to end.",
    validationPlan:
      "Post-change: policy hit counters increment for the new/updated rule, HA sync status in-sync, session count parity within 5% of baseline, no denied-log spike for legitimate flows.",
    rollbackPlan:
      "Delete the added policy/objects (or restore the saved policy block) and re-verify HA sync; if sync breaks, force a config resync from the primary before closing.",
    defaultSteps: [
      { name: "Verify HA sync status and session baseline", type: "CHECK" },
      { name: "Pre-change configuration backup", type: "BACKUP" },
      { name: "Apply firewall policy change", type: "APPLY" },
      { name: "Validate policy hits and session parity", type: "VALIDATE" },
      { name: "Post-change configuration backup", type: "BACKUP" },
    ],
    defaultType: "NORMAL",
  },
  {
    id: "sfos-firmware-patch",
    name: "Sophos SFOS — Firmware Patch Rollout",
    vendorKey: "sophos",
    description:
      "Staged SFOS patch install with tunnel-failover monitoring during the reboot window and partition rollback.",
    defaultTitle: "SFOS firmware patch rollout on Sophos XGS",
    implementationPlan:
      "1. Download the patch to the appliance and verify the advisory applies to the current firmware.\n2. Check HA state and take a pre-patch configuration backup.\n3. Schedule the reboot window and confirm the HA peer/tunnel can absorb traffic.\n4. Install the patch and reboot into the new partition.\n5. Monitor WAN tunnels, RED links and policy counters during reconvergence.",
    validationPlan:
      "Post-patch: firmware version shows the patched build, WAN tunnels up, NAT pools active, throughput within 10% of baseline, no new threat-feed errors.",
    rollbackPlan:
      "Boot the previous partition (pre-patch firmware) and restore the last encrypted configuration backup; re-verify HA and tunnel state after rollback.",
    defaultSteps: [
      { name: "Verify HA state and staged patch advisory", type: "CHECK" },
      { name: "Pre-patch configuration backup", type: "BACKUP" },
      { name: "Install patch and reboot into new partition", type: "APPLY" },
      { name: "Validate tunnels, NAT pools and throughput", type: "VALIDATE" },
      { name: "Post-patch configuration backup", type: "BACKUP" },
    ],
    defaultType: "NORMAL",
  },
  {
    id: "aos-cx-vlan-provisioning",
    name: "AOS-CX — VLAN Provisioning",
    vendorKey: "hpe",
    description:
      "Provision a new VLAN on AOS-CX switches: VLAN definition, trunk extension and SVI reachability validation.",
    defaultTitle: "VLAN provisioning on AOS-CX switch",
    implementationPlan:
      "1. Confirm the VLAN ID is unused and the naming convention is applied.\n2. Capture the current VLAN and trunk configuration for the affected interfaces.\n3. Create the VLAN and description, then extend the trunk allowed list on the uplink/LAG.\n4. If an SVI is required, configure it with the agreed gateway address.\n5. Verify the VLAN propagates to the peer switch over the MLAG/LACP pair.",
    validationPlan:
      "Post-change: show vlan lists the new VLAN, trunk allowed list updated on both peers, SVI pings from the ToR pair, end-host traffic tags correctly.",
    rollbackPlan:
      "Remove the VLAN from the trunk allowed list, delete the SVI and the VLAN definition, then re-apply the pre-change configuration backup if any delta remains.",
    defaultSteps: [
      { name: "Verify switch reachable and VLAN ID free", type: "CHECK" },
      { name: "Pre-change configuration backup", type: "BACKUP" },
      { name: "Provision VLAN and extend trunks", type: "APPLY" },
      { name: "Validate SVI reachability and trunk list", type: "VALIDATE" },
      { name: "Post-change configuration backup", type: "BACKUP" },
    ],
    defaultType: "NORMAL",
  },
];

export function templatesForVendor(vendorKey: string): ChangeTemplate[] {
  return CHANGE_TEMPLATES.filter((t) => t.vendorKey === vendorKey);
}

export function templateById(id: string): ChangeTemplate | undefined {
  return CHANGE_TEMPLATES.find((t) => t.id === id);
}
