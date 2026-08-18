import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Same mocking pattern as packages/core/src/marketing/weekly-report.test.ts
// and strategist.ts's own untested-but-mirrored shape: @anthropic-ai/sdk is
// mocked at the module boundary, never called for real in tests.

const messagesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: (...args: unknown[]) => messagesCreate(...args) };
  },
}));

const { parseWhatsappMessage } = await import("./parser");

function toolUseResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", id: "tu_1", name: "report_extracted_data", input }] };
}

const REFERENCE_DATE = new Date("2026-08-18T10:00:00Z");

describe("parseWhatsappMessage", () => {
  beforeEach(() => {
    messagesCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // 2. all data present
  it("2: returns every field Claude reports when the message contains all of them", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        fullName: "Mario Rossi",
        pickup: "Milan Malpensa Airport",
        destination: "Tirano",
        date: "2026-08-19",
        time: "09:00",
        passengers: 4,
        flight: "LX1820",
        intent: "transfer_request",
      }),
    );

    const result = await parseWhatsappMessage("full message text", REFERENCE_DATE);

    expect(result).toMatchObject({
      fullName: "Mario Rossi",
      pickup: "Milan Malpensa Airport",
      destination: "Tirano",
      date: "2026-08-19",
      time: "09:00",
      passengers: 4,
      flight: "LX1820",
      intent: "transfer_request",
    });
  });

  // 3. missing data — only what's present comes back
  it("3: fields Claude omits are simply absent from the result, not filled with defaults", async () => {
    messagesCreate.mockResolvedValue(
      toolUseResponse({
        pickup: "Milan",
        destination: "Tirano",
        passengers: 4,
        missingInformation: ["date", "time"],
      }),
    );

    const result = await parseWhatsappMessage("Hi, I need a transfer from Milan to Tirano tomorrow for 4 people", REFERENCE_DATE);

    expect(result.pickup).toBe("Milan");
    expect(result.destination).toBe("Tirano");
    expect(result.passengers).toBe(4);
    expect(result.date).toBeUndefined();
    expect(result.time).toBeUndefined();
    expect(result.hotel).toBeUndefined();
    expect(result.flight).toBeUndefined();
    expect(result.missingInformation).toEqual(["date", "time"]);
  });

  // 4. no invention — API key missing
  it("4a: returns {} and never calls Claude when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await parseWhatsappMessage("some message", REFERENCE_DATE);

    expect(result).toEqual({});
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  // 4. no invention — Claude call fails
  it("4b: returns {} (fails soft) instead of fabricating data when the Anthropic call throws", async () => {
    messagesCreate.mockRejectedValue(new Error("network error"));

    const result = await parseWhatsappMessage("some message", REFERENCE_DATE);

    expect(result).toEqual({});
  });

  // 4. no invention — malformed tool output is dropped, not partially trusted
  it("4c: returns {} when Claude's tool_use input fails schema validation", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({ passengers: "a lot" }));

    const result = await parseWhatsappMessage("some message", REFERENCE_DATE);

    expect(result).toEqual({});
  });

  it("passes the reference date and raw message text to Claude so relative dates can be resolved", async () => {
    messagesCreate.mockResolvedValue(toolUseResponse({}));

    await parseWhatsappMessage("transfer tomorrow please", REFERENCE_DATE);

    const sentContent = messagesCreate.mock.calls[0]![0].messages[0].content as string;
    expect(sentContent).toContain(REFERENCE_DATE.toISOString());
    expect(sentContent).toContain("transfer tomorrow please");
  });
});
