import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { RealPostDataSnapshot } from "./content-source";

// Anthropic mocked at the module boundary — same pattern as
// marketing/weekly-report.test.ts and marketing/strategist.ts's own tests.
// No automated test in this module ever calls the real Anthropic API.
const messagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...args: unknown[]) => messagesCreate(...args) };
  },
}));

const { generatePostContent } = await import("./content-generator");

function snapshot(overrides: Partial<RealPostDataSnapshot> = {}): RealPostDataSnapshot {
  return {
    servedRoutes: [{ pickup: "Milano", destination: "Tirano" }],
    transferTypes: ["regional transfer"],
    serviceAreaPlaces: ["Milano", "Tirano"],
    windowDays: 90,
    ...overrides,
  };
}

describe("generatePostContent — without ANTHROPIC_API_KEY", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    messagesCreate.mockReset();
  });

  it("returns null and never calls Claude — no placeholder text is ever produced", async () => {
    const result = await generatePostContent(snapshot());

    expect(result).toBeNull();
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe("generatePostContent — with ANTHROPIC_API_KEY", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    messagesCreate.mockReset();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns Claude's text, and sends only the real data snapshot — never a client name, phone, or price", async () => {
    messagesCreate.mockResolvedValue({ content: [{ type: "text", text: "  A generated post.  " }] });

    const result = await generatePostContent(snapshot());

    expect(result).toBe("A generated post.");
    expect(messagesCreate).toHaveBeenCalledTimes(1);

    const call = messagesCreate.mock.calls[0]![0] as { system: string; messages: Array<{ content: string }> };
    expect(call.system).toContain("Never invent a fact, number, statistic, testimonial, review, price");
    expect(call.messages[0]!.content).toContain("Milano");
    expect(call.messages[0]!.content).toContain("Tirano");
    expect(call.messages[0]!.content).not.toMatch(/@|\+\d{6,}/); // no email/phone-like content ever sent
  });

  it("returns null when Claude returns no text block", async () => {
    messagesCreate.mockResolvedValue({ content: [{ type: "tool_use" }] });

    expect(await generatePostContent(snapshot())).toBeNull();
  });

  it("returns null when Claude returns an empty string", async () => {
    messagesCreate.mockResolvedValue({ content: [{ type: "text", text: "   " }] });

    expect(await generatePostContent(snapshot())).toBeNull();
  });
});
