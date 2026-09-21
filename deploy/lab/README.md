# Network protocol lab

This directory defines the isolation boundary for future real monitoring protocol tests. It is not a simulation claim and it is not connected to production device ranges.

## Current state

- Isolated Docker internal network bootstrap: repository automation present.
- SNMPv3 polling: NOT IMPLEMENTED in the product collector.
- SNMP trap receiver: NOT IMPLEMENTED.
- Syslog receiver: NOT IMPLEMENTED.
- NetFlow/IPFIX/sFlow receiver: NOT IMPLEMENTED.
- Real discovery/topology: NOT IMPLEMENTED.
- SSH vendor harnesses: existing worker certification harness only; physical hardware is not certified.
- Sophos WebAPI write harness: external/hardware certification pending.

Do not open UDP 162, UDP 514, TCP 514, UDP 2055, UDP 4739, or UDP 6343 on OCI until the corresponding receiver is implemented, authenticated/restricted, and tested.

## Start the isolation boundary

~~~bash
sudo ./bootstrap.sh
docker network inspect fayanms-lab
~~~

The network uses Docker internal mode and no host port publication. Attach only disposable protocol agents and test fixtures. Never attach production devices or the production management VLAN.

## Promotion requirement

A protocol lab capability becomes DONE only with code, unit/contract tests, a packet/protocol harness, CI evidence, staging evidence, and—where the capability claims hardware support—physical-device evidence.
