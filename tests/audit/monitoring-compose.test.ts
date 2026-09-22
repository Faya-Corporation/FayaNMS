import { expect, test } from "bun:test";

const compose = await Bun.file("deploy/oci/compose.monitoring.yml").text();
const composeLines = compose.split("\n");

function imageFor(service: string): string {
  const start = composeLines.indexOf("  " + service + ":");
  const imageLine = composeLines.slice(start + 1).find((line) => line.startsWith("    image: "));
  return imageLine?.slice("    image: ".length) ?? "";
}

test("monitoring profile uses reviewed immutable image references", () => {
  const images = ["prometheus", "otel-collector", "grafana"].map(imageFor);

  expect(images).toHaveLength(3);
  for (const image of images) {
    expect(image.split("@sha256:")).toHaveLength(2);
    expect(image.split("@sha256:")[1]).toMatch(/^[0-9a-f]{64}$/);
  }

  expect(images[0]).toBe(
    "prom/prometheus:v3.5.0@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996"
  );
  expect(images[1]).toBe(
    "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.136.0@sha256:45392d534c1edcc809c2d112394029246bc679d2ae5ea7081414a1fc74f2c621"
  );
  expect(images[2]).toBe(
    "grafana/grafana:12.1.1@sha256:a1701c2180249361737a99a01bc770db39381640e4d631825d38ff4535efa47d"
  );
});

test("monitoring services stay isolated from public host publishing", () => {
  expect(composeLines.some((line) => line.trimStart().startsWith("ports:"))).toBe(false);
  expect(compose).toContain(["monitoring:", "    internal: true"].join("\n"));
  expect(compose).toContain("cap_drop: [ALL]");
  expect(compose).toContain("no-new-privileges:true");
});
