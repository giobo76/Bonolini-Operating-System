import { describe, expect, it } from "vitest";
import { briefForTheme, NoopImageGenerator, getConfiguredImageGenerator } from "./image-generator";

describe("briefForTheme", () => {
  it("matches the Bernina Express theme", () => {
    expect(briefForTheme("Milano -> Tirano (Bernina Express)")).toContain("Bernina Express");
  });

  it("matches a Lake Como theme", () => {
    expect(briefForTheme("Lake Como transfer")).toContain("Lake Como");
  });

  it("matches a wine tour / Valtellina theme", () => {
    expect(briefForTheme("Wine Tour Valtellina")).toContain("vineyards");
  });

  it("matches an airport transfer theme", () => {
    expect(briefForTheme("Airport Transfer Malpensa")).toContain("airport transfer");
  });

  it("returns null for a theme with no known match — never invents a brief", () => {
    expect(briefForTheme("Some unrelated theme")).toBeNull();
  });
});

describe("NoopImageGenerator", () => {
  it("never claims success and never returns a fabricated URL", async () => {
    const generator = new NoopImageGenerator();
    const result = await generator.generate({ theme: "Lake Como", tenantId: "tenant-1" });

    expect(result.ok).toBe(false);
    expect(result.url).toBeNull();
    expect(result.provider).toBe("noop");
    expect(result.theme).toBe("Lake Como");
  });
});

describe("getConfiguredImageGenerator", () => {
  it("defaults to the safe no-op provider — never a real paid external call by default", () => {
    expect(getConfiguredImageGenerator().name).toBe("noop");
  });
});
