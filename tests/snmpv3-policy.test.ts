import { expect, test } from "bun:test";
import {
  evaluateSnmpV3EngineObservation,
  normalizeEngineIdHex,
} from "../src/lib/protocol/snmpv3-policy";

const ENGINE_ID = "80001f8880090807060504";

test("SNMPv3 engine policy requires enrollment and rejects mismatches", () => {
  expect(
    evaluateSnmpV3EngineObservation(
      { engineIdHex: null, boots: null, time: null },
      { engineIdHex: ENGINE_ID, boots: 1, time: 10 },
    ),
  ).toMatchObject({ ok: false, code: "SNMP_ENGINE_UNENROLLED" });
  expect(
    evaluateSnmpV3EngineObservation(
      { engineIdHex: ENGINE_ID, boots: 1, time: 10 },
      { engineIdHex: "80001f8880090807060505", boots: 1, time: 11 },
    ),
  ).toMatchObject({ ok: false, code: "SNMP_ENGINE_ID_MISMATCH" });
});

test("SNMPv3 engine policy advances boots/time and rejects replay", () => {
  const state = { engineIdHex: ENGINE_ID, boots: 7, time: 100 };
  expect(
    evaluateSnmpV3EngineObservation(state, {
      engineIdHex: ENGINE_ID,
      boots: 7,
      time: 100,
    }),
  ).toMatchObject({ ok: false, code: "SNMP_REPLAY_REJECTED" });
  expect(
    evaluateSnmpV3EngineObservation(state, {
      engineIdHex: ENGINE_ID,
      boots: 8,
      time: 1,
    }),
  ).toEqual({
    ok: true,
    next: { engineIdHex: ENGINE_ID, boots: 8, time: 1 },
  });
});

test("SNMPv3 engine IDs normalize only bounded even-length hex", () => {
  expect(normalizeEngineIdHex("0x80001F8880090807060504")).toBe(ENGINE_ID);
  expect(() => normalizeEngineIdHex("abcd")).toThrow();
  expect(() => normalizeEngineIdHex("80001f888009080706050")).toThrow();
});
