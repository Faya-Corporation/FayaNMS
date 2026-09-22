# Authenticated SNMPv3 polling runbook

This runbook covers the repository-side SNMP_POLL job path. It is an authPriv
poller, not a discovery shortcut: the worker resolves the configured
vault:// reference locally, and the application/database carry only the
credential profile reference.

## Operator prerequisites

1. Create a CredentialProfile with type SNMPV3, the device's USM username,
   UDP port (normally 161), and a vault://... secretRef.
2. Put the matching secret in the worker-side vault provider. The default
   provider maps vault://snmp/poll-profile to
   FAYANMS_VAULT_SNMP_POLL_PROFILE; file and exec providers are documented in
   README.md and mini-services/worker/vault.ts.
3. Out-of-band verify the target's authoritative SNMPv3 engine ID, then PATCH
   the device with snmpEngineIdHex. Enrollment resets boots/time state.
4. Permit only the worker's approved egress to the device's UDP/161 path. No
   inbound telemetry listener is required for polling.

## Queue a poll

With a session principal that has device.read, call:

    POST /api/v1/devices/{deviceId}/snmp/poll
    {
      "maxInterfaces": 8,
      "interfaceIndexes": [1, 2]
    }

interfaceIndexes is optional. Without it, the worker reads ifNumber.0 and
polls indexes 1 through the bounded maxInterfaces cap. The API rejects a
second queued/running poll for the same device.

## Evidence and failure behavior

The worker sends sysDescr.0, sysName.0, sysUpTime.0, ifNumber.0, ifDescr,
ifOperStatus, ifHCInOctets, and ifHCOutOctets requests using authPriv. Each
request has a bounded timeout, exponential retry backoff, and bounded jitter.
The response engine identity is accepted through the existing boots/time replay
policy before completion.

Successful completion updates Device.lastSeen, uptime/status, DeviceInterface
operational state, a latency sample, the job result, and an audit event. Raw
packets, plaintext secrets, and secret values are not persisted. Counter values
remain in the bounded job result as decimal strings; rate derivation and
counter-reset handling are exposed by the worker counterDelta helper for the
next metrics slice.

This path is repository implemented and loopback protocol-harness tested. It
is not staging tested, physical-hardware tested, or production proven until an
operator supplies a real device, vault binding, network path, and retained
evidence.
