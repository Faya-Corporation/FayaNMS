# FayaNMS physical hardware certification matrix

This is an evidence ledger, not a certification claim. A row is CERTIFIED only when the named model, firmware, transport, operation, and failure tests have a dated attached result.

| Vendor | Platform/model | Firmware | Transport | Backup | Diff | Change | Rollback | Restore | SNMP | Syslog/trap | Flow | Evidence | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Cisco | TBD | TBD | SSH | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | none | TODO |
| Fortinet | TBD | TBD | SSH/API | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | none | TODO |
| Sophos | XGS/SFOS TBD | TBD | WebAPI/SSH | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | none | TODO |
| HPE Aruba | TBD | TBD | SSH/SNMP | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | none | TODO |
| Juniper | TBD | TBD | SSH/NETCONF | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | none | TODO |
| Palo Alto | TBD | TBD | API/SSH | TODO | TODO | TODO | TODO | TODO | TODO | TODO | TODO | none | TODO |

## Required per-vendor cases

- authentication and key/certificate rotation;
- permission failure;
- timeout and reconnect;
- malformed/large output;
- concurrent request and device lock;
- network interruption and reboot;
- backup, normalized/raw diff, typed change;
- rollback and snapshot-exact restore;
- SNMPv3 metrics, syslog, traps, and flow exporter behavior.

Physical hardware was not available to this implementation session. Every row remains TODO until the lab owner supplies model/firmware and evidence.
