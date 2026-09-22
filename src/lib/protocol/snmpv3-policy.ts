export type SnmpV3EngineState = {
  engineIdHex: string | null;
  boots: number | null;
  time: number | null;
};

export type SnmpV3EngineObservation = {
  engineIdHex: string;
  boots: number;
  time: number;
};

export type SnmpV3EngineDecision =
  | { ok: true; next: SnmpV3EngineState }
  | { ok: false; code: string; message: string };

export function normalizeEngineIdHex(value: Uint8Array | string): string {
  const hex =
    typeof value === "string"
      ? value.replace(/^0x/i, "").replace(/\s+/g, "")
      : Buffer.from(value).toString("hex");
  if (!/^[0-9a-fA-F]{10,128}$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("SNMPv3 engine ID must be 5–64 octets of hex");
  }
  return hex.toLowerCase();
}

export function evaluateSnmpV3EngineObservation(
  state: SnmpV3EngineState,
  observation: SnmpV3EngineObservation,
): SnmpV3EngineDecision {
  let engineIdHex: string;
  try {
    engineIdHex = normalizeEngineIdHex(observation.engineIdHex);
  } catch {
    return {
      ok: false,
      code: "SNMP_ENGINE_ID_INVALID",
      message: "SNMPv3 engine ID is not a valid 5–64 octet hex value.",
    };
  }
  if (state.engineIdHex === null) {
    return {
      ok: false,
      code: "SNMP_ENGINE_UNENROLLED",
      message: "SNMPv3 engine ID is not operator-enrolled for this device.",
    };
  }
  if (state.engineIdHex.toLowerCase() !== engineIdHex) {
    return {
      ok: false,
      code: "SNMP_ENGINE_ID_MISMATCH",
      message: "SNMPv3 engine ID does not match the enrolled device state.",
    };
  }
  if (
    !Number.isSafeInteger(observation.boots) ||
    observation.boots < 0 ||
    !Number.isSafeInteger(observation.time) ||
    observation.time < 0
  ) {
    return {
      ok: false,
      code: "SNMP_ENGINE_STATE_INVALID",
      message: "SNMPv3 engine boots/time must be non-negative safe integers.",
    };
  }
  if (
    state.boots !== null &&
    state.time !== null &&
    (observation.boots < state.boots ||
      (observation.boots === state.boots && observation.time <= state.time))
  ) {
    return {
      ok: false,
      code: "SNMP_REPLAY_REJECTED",
      message: "SNMPv3 engine boots/time is not newer than the last accepted packet.",
    };
  }
  return {
    ok: true,
    next: {
      engineIdHex,
      boots: observation.boots,
      time: observation.time,
    },
  };
}
