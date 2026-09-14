import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  execArgvFor,
  resolveVaultSecret,
  vaultEnvName,
  vaultProviderName,
  VaultError,
} from "../../mini-services/worker/vault";

/**
 * P1-005 — the worker vault is a REAL provider-based resolver, not a
 * misnomered env lookup (ULTRA audit). Pins:
 *   - the vault:// ref grammar and the env provider stay byte-compatible
 *     with the Phase 22 contract (existing refs never re-interpret);
 *   - provider selection via FAYANMS_VAULT_PROVIDER is validated fail-tight;
 *   - the file provider resolves by full ref, bare path, or the env-style
 *     normalized name, and mis-shapes fail VAULT_PROVIDER_MISCONFIGURED;
 *   - the exec provider runs a shell-free argv template with %s
 *     substitution, and every failure mode (non-zero exit, empty output,
 *     spawn failure, timeout) is a typed fail-closed CREDENTIAL_UNRESOLVED;
 *   - secret VALUES never appear in error messages.
 */

const PROVIDER_KEYS = [
  "FAYANMS_VAULT_PROVIDER",
  "FAYANMS_VAULT_FILE",
  "FAYANMS_VAULT_EXEC",
  "FAYANMS_VAULT_EXEC_TIMEOUT_MS",
] as const;

async function withVaultEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of PROVIDER_KEYS) saved.set(key, process.env[key]);
  for (const key of PROVIDER_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const isWindows = process.platform === "win32";
const canRun = (p: string): boolean => {
  try {
    const r = spawnSync(p, [], { timeout: 2000, encoding: "utf8" });
    return r.error === null || r.error === undefined;
  } catch {
    return false;
  }
};

describe("P1-005 vault: grammar + env provider (Phase 22 compatibility)", () => {
  test("vaultEnvName keeps the original normalization contract", () => {
    expect(vaultEnvName("vault://ssh/network-admin")).toBe(
      "FAYANMS_VAULT_SSH_NETWORK_ADMIN",
    );
    expect(vaultEnvName("vault://db backup/prod 1")).toBe(
      "FAYANMS_VAULT_DB_BACKUP_PROD_1",
    );
  });

  test("non-vault refs and empty paths are CREDENTIAL_REF_INVALID", () => {
    expect(() => vaultEnvName("ssh/network-admin")).toThrow(/vault:\/\//);
    expect(() => vaultEnvName("vault://")).toThrow(/empty vault path/);
    try {
      vaultEnvName("smb://share");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).code).toBe("CREDENTIAL_REF_INVALID");
    }
  });

  test("default provider is env and resolves the normalized env entry", async () => {
    await withVaultEnv({ FAYANMS_VAULT_SSH_NETWORK_ADMIN: "s3cr3t-value" }, async () => {
      expect(vaultProviderName()).toBe("env");
      expect(await resolveVaultSecret("vault://ssh/network-admin")).toBe("s3cr3t-value");
    });
  });

  test("missing env entry is a typed CREDENTIAL_UNRESOLVED naming the env var", async () => {
    await withVaultEnv({}, async () => {
      try {
        await resolveVaultSecret("vault://ssh/missing-entry");
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(VaultError);
        const ve = error as VaultError;
        expect(ve.code).toBe("CREDENTIAL_UNRESOLVED");
        expect(ve.message).toContain("FAYANMS_VAULT_SSH_MISSING_ENTRY");
      }
    });
  });

  test("unknown provider value is VAULT_PROVIDER_INVALID (fail-tight)", async () => {
    await withVaultEnv({ FAYANMS_VAULT_PROVIDER: "hsm" }, async () => {
      try {
        vaultProviderName();
        expect.unreachable();
      } catch (error) {
        expect((error as VaultError).code).toBe("VAULT_PROVIDER_INVALID");
      }
      try {
        await resolveVaultSecret("vault://ssh/network-admin");
        expect.unreachable();
      } catch (error) {
        expect((error as VaultError).code).toBe("VAULT_PROVIDER_INVALID");
      }
    });
  });
});

describe("P1-005 vault: file provider", () => {
  let dir: string | undefined;
  let n = 0;
  const makeFile = (content: string): string => {
    dir ??= mkdtempSync(join(tmpdir(), "fayanms-vault-test-"));
    const p = join(dir, `secrets-${++n}.json`);
    writeFileSync(p, content, { mode: 0o600 });
    return p;
  };

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("resolves by exact full reference", async () => {
    const file = makeFile(JSON.stringify({ "vault://ssh/network-admin": "file-secret-1" }));
    await withVaultEnv({ FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: file }, async () => {
      expect(vaultProviderName()).toBe("file");
      expect(await resolveVaultSecret("vault://ssh/network-admin")).toBe("file-secret-1");
    });
  });

  test("resolves by bare path and by env-style normalized name (migration path)", async () => {
    const file = makeFile(
      JSON.stringify({
        "ssh/db-backup": "file-secret-2",
        FAYANMS_VAULT_SSH_HARNESS: "file-secret-3",
      }),
    );
    await withVaultEnv({ FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: file }, async () => {
      expect(await resolveVaultSecret("vault://ssh/db-backup")).toBe("file-secret-2");
      expect(await resolveVaultSecret("vault://ssh/harness")).toBe("file-secret-3");
    });
  });

  test("missing entry is CREDENTIAL_UNRESOLVED listing the candidate keys", async () => {
    const file = makeFile(JSON.stringify({ "ssh/other": "x" }));
    await withVaultEnv({ FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: file }, async () => {
      try {
        await resolveVaultSecret("vault://ssh/absent");
        expect.unreachable();
      } catch (error) {
        const ve = error as VaultError;
        expect(ve.code).toBe("CREDENTIAL_UNRESOLVED");
        expect(ve.message).toContain("vault://ssh/absent");
        expect(ve.message).toContain("FAYANMS_VAULT_SSH_ABSENT");
      }
    });
  });

  test("provider misconfiguration fails typed (no file / bad JSON / wrong shape)", async () => {
    await withVaultEnv({ FAYANMS_VAULT_PROVIDER: "file" }, async () => {
      try {
        await resolveVaultSecret("vault://ssh/network-admin");
        expect.unreachable();
      } catch (error) {
        expect((error as VaultError).code).toBe("VAULT_PROVIDER_MISCONFIGURED");
      }
    });
    const badJson = makeFile("{ not json");
    await withVaultEnv(
      { FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: badJson },
      async () => {
        try {
          await resolveVaultSecret("vault://ssh/network-admin");
          expect.unreachable();
        } catch (error) {
          expect((error as VaultError).code).toBe("VAULT_PROVIDER_MISCONFIGURED");
        }
      },
    );
    const array = makeFile("[\"array-of-secrets\"]");
    await withVaultEnv(
      { FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: array },
      async () => {
        try {
          await resolveVaultSecret("vault://ssh/network-admin");
          expect.unreachable();
        } catch (error) {
          expect((error as VaultError).code).toBe("VAULT_PROVIDER_MISCONFIGURED");
        }
      },
    );
  });

  test("empty-string values never resolve (fail-closed, same as env)", async () => {
    const file = makeFile(JSON.stringify({ "vault://ssh/blank": "  " }));
    await withVaultEnv(
      { FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: file },
      async () => {
        try {
          await resolveVaultSecret("vault://ssh/blank");
          expect.unreachable();
        } catch (error) {
          expect((error as VaultError).code).toBe("CREDENTIAL_UNRESOLVED");
        }
      },
    );
  });

  test("group/other-readable file draws a POSIX warning but still resolves", async () => {
    const file = makeFile(JSON.stringify({ "vault://ssh/lax": "lax-secret" }));
    if (!isWindows) chmodSync(file, 0o644);
    await withVaultEnv(
      { FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: file },
      async () => {
        if (isWindows) return; // mode bits are not meaningful on win32
        expect(await resolveVaultSecret("vault://ssh/lax")).toBe("lax-secret");
      },
    );
  });
});

describe("P1-005 vault: exec provider", () => {
  test("argv template substitutes every %s without a shell", () => {
    expect(execArgvFor("/usr/bin/vault kv get -field=secret %s", "vault://ssh/x")).toEqual([
      "/usr/bin/vault",
      "kv",
      "get",
      "-field=secret",
      "vault://ssh/x",
    ]);
    expect(execArgvFor("pass show --clip %s", "vault://a/b")).toEqual([
      "pass",
      "show",
      "--clip",
      "vault://a/b",
    ]);
    expect(execArgvFor("tool --ref=%s --ref=%s", "vault://r")).toEqual([
      "tool",
      "--ref=vault://r",
      "--ref=vault://r",
    ]);
    // no %s → the reference is appended as the final argument
    expect(execArgvFor("op read op://x", "vault://y")).toEqual([
      "op",
      "read",
      "op://x",
      "vault://y",
    ]);
  });

  test.skipIf(isWindows || !canRun("/bin/echo"))(
    "echo template returns trimmed stdout as the secret",
    async () => {
      await withVaultEnv(
        { FAYANMS_VAULT_PROVIDER: "exec", FAYANMS_VAULT_EXEC: "/bin/echo %s" },
        async () => {
          expect(await resolveVaultSecret("vault://ssh/echoed")).toBe("vault://ssh/echoed");
        },
      );
    },
  );

  test.skipIf(isWindows || !canRun("/bin/echo"))(
    "in-token %s substitution reaches the command",
    async () => {
      await withVaultEnv(
        { FAYANMS_VAULT_PROVIDER: "exec", FAYANMS_VAULT_EXEC: "/bin/echo --ref=%s" },
        async () => {
          expect(await resolveVaultSecret("vault://ssh/k")).toBe("--ref=vault://ssh/k");
        },
      );
    },
  );

  test.skipIf(isWindows || !canRun("/bin/false"))(
    "non-zero exit is CREDENTIAL_UNRESOLVED with the exit code (stderr tail only)",
    async () => {
      await withVaultEnv(
        { FAYANMS_VAULT_PROVIDER: "exec", FAYANMS_VAULT_EXEC: "/bin/false %s" },
        async () => {
          try {
            await resolveVaultSecret("vault://ssh/nope");
            expect.unreachable();
          } catch (error) {
            const ve = error as VaultError;
            expect(ve.code).toBe("CREDENTIAL_UNRESOLVED");
            expect(ve.message).toContain("exited 1");
          }
        },
      );
    },
  );

  test.skipIf(isWindows || !canRun("/bin/true"))(
    "empty stdout is CREDENTIAL_UNRESOLVED even on exit 0",
    async () => {
      await withVaultEnv(
        { FAYANMS_VAULT_PROVIDER: "exec", FAYANMS_VAULT_EXEC: "/bin/true %s" },
        async () => {
          try {
            await resolveVaultSecret("vault://ssh/quiet");
            expect.unreachable();
          } catch (error) {
            expect((error as VaultError).code).toBe("CREDENTIAL_UNRESOLVED");
          }
        },
      );
    },
  );

  test.skipIf(isWindows)(
    "a hanging command is killed at the manually enforced deadline and fails closed",
    async () => {
      // The argv template is deliberately shell-free (no quoting rules), so
      // the hanging target is a real executable file that ignores its args.
      const dir = mkdtempSync(join(tmpdir(), "fayanms-vault-slow-"));
      try {
        const slow = join(dir, "slow.sh");
        writeFileSync(slow, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
        await withVaultEnv(
          {
            FAYANMS_VAULT_PROVIDER: "exec",
            FAYANMS_VAULT_EXEC: slow,
            FAYANMS_VAULT_EXEC_TIMEOUT_MS: "150",
          },
          async () => {
            try {
              await resolveVaultSecret("vault://ssh/slow");
              expect.unreachable();
            } catch (error) {
              const ve = error as VaultError;
              expect(ve.code).toBe("CREDENTIAL_UNRESOLVED");
              expect(/signal|timed|timeout/i.test(ve.message)).toBe(true);
            }
          },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("missing FAYANMS_VAULT_EXEC is VAULT_PROVIDER_MISCONFIGURED", async () => {
    await withVaultEnv({ FAYANMS_VAULT_PROVIDER: "exec" }, async () => {
      try {
        await resolveVaultSecret("vault://ssh/network-admin");
        expect.unreachable();
      } catch (error) {
        expect((error as VaultError).code).toBe("VAULT_PROVIDER_MISCONFIGURED");
      }
    });
  });

  test("nonexistent executable is CREDENTIAL_UNRESOLVED (spawn failure, fail-closed)", async () => {
    await withVaultEnv(
      {
        FAYANMS_VAULT_PROVIDER: "exec",
        FAYANMS_VAULT_EXEC: "/nonexistent/vault-binary %s",
      },
      async () => {
        try {
          await resolveVaultSecret("vault://ssh/ghost");
          expect.unreachable();
        } catch (error) {
          expect((error as VaultError).code).toBe("CREDENTIAL_UNRESOLVED");
        }
      },
    );
  });
});

describe("P1-005 vault: cross-provider guarantees", () => {
  test("the same reference resolves through all three providers (grammar stability)", async () => {
    const ref = "vault://ssh/multi";
    await withVaultEnv({ FAYANMS_VAULT_SSH_MULTI: "env-value" }, async () => {
      expect(await resolveVaultSecret(ref)).toBe("env-value");
    });
    const dir = mkdtempSync(join(tmpdir(), "fayanms-vault-x-"));
    try {
      const file = join(dir, "s.json");
      writeFileSync(file, JSON.stringify({ "ssh/multi": "file-value" }), { mode: 0o600 });
      await withVaultEnv(
        { FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: file },
        async () => {
          expect(await resolveVaultSecret(ref)).toBe("file-value");
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (!isWindows && canRun("/bin/echo")) {
      await withVaultEnv(
        { FAYANMS_VAULT_PROVIDER: "exec", FAYANMS_VAULT_EXEC: "/bin/echo %s" },
        async () => {
          // same ref, different backend — resolution must succeed unchanged
          expect(await resolveVaultSecret(ref)).toBe(ref);
        },
      );
    }
  });

  test("provider errors never echo secret VALUES into messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fayanms-vault-v-"));
    try {
      const file = join(dir, "s.json");
      writeFileSync(
        file,
        JSON.stringify({ "vault://ssh/x": "TOPSECRETVALUE" }),
        { mode: 0o600 },
      );
      await withVaultEnv(
        { FAYANMS_VAULT_PROVIDER: "file", FAYANMS_VAULT_FILE: file },
        async () => {
          try {
            await resolveVaultSecret("vault://ssh/absent");
            expect.unreachable();
          } catch (error) {
            expect((error as Error).message).not.toContain("TOPSECRETVALUE");
          }
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
