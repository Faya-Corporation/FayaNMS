import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const root = path.resolve(import.meta.dir, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function composeService(compose: string, service: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === `  ${service}:`);
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[index].trimEnd())) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("Docker image source provenance", () => {
  test("app, worker, and migrator images override inherited base-image revisions", () => {
    for (const file of ["Dockerfile.worker", "Dockerfile.migrator"]) {
      expect(read(file)).toContain("ARG FAYANMS_SOURCE_SHA=unknown");
      expect(read(file)).toContain('LABEL org.opencontainers.image.revision="${FAYANMS_SOURCE_SHA}"');
    }
    const app = read("Dockerfile");
    expect(app.match(/ARG FAYANMS_SOURCE_SHA=unknown/g)?.length).toBe(2);
    expect(app.match(/LABEL org\.opencontainers\.image\.revision="\$\{FAYANMS_SOURCE_SHA\}"/g)?.length).toBe(2);
  });

  test("Compose passes the same explicit source SHA to every buildable service", () => {
    const compose = read("compose.yml");
    for (const service of ["app", "worker", "provision"]) {
      expect(composeService(compose, service)).toContain('FAYANMS_SOURCE_SHA: "${FAYANMS_SOURCE_SHA:-unknown}"');
    }
  });

  test("container certification and CI builds pass their exact candidate SHA", () => {
    const container = read(".github/workflows/container.yml");
    expect(container.match(/--build-arg FAYANMS_SOURCE_SHA=\$\{CANDIDATE_SHA\}/g)?.length).toBe(3);
    expect(container.match(/FAYANMS_SOURCE_SHA=\$\{\{ github\.event\.workflow_run\.head_sha \}\}/g)?.length).toBe(3);
    const ci = read(".github/workflows/ci.yml");
    expect(ci.match(/--build-arg FAYANMS_SOURCE_SHA=\$GITHUB_SHA/g)?.length).toBe(2);
  });

  test("Windows and WSL deployment guidance stamps the checkout before building", () => {
    const runbook = read("docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md");
    expect(runbook).toContain("export FAYANMS_SOURCE_SHA=\"$(git rev-parse HEAD)\"");
    expect(runbook).toContain("$env:FAYANMS_SOURCE_SHA = (git rev-parse HEAD).Trim()");
  });
});
