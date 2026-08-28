import { describe, expect, it, vi } from "vitest";
import { runSubmitLeadFlow } from "./submit-lead-flow";

// FASE 5, test 7: generate_lead viene emesso dopo creazione riuscita.
it("7: tracks the conversion only after submitLead has actually resolved", async () => {
  const order: string[] = [];
  const submitLead = vi.fn(async (input: { fullName: string }) => {
    order.push("submitLead");
    return { id: "client-1", ...input };
  });
  const trackConversion = vi.fn(async () => {
    order.push("trackConversion");
  });

  const client = await runSubmitLeadFlow({ fullName: "Test" }, { submitLead, trackConversion });

  expect(client).toEqual({ id: "client-1", fullName: "Test" });
  expect(order).toEqual(["submitLead", "trackConversion"]);
  expect(trackConversion).toHaveBeenCalledWith({ id: "client-1", fullName: "Test" });
});

// FASE 5, test 8: generate_lead non viene emesso due volte per lo stesso submit.
it("8: calls trackConversion exactly once per flow invocation, never twice", async () => {
  const submitLead = vi.fn(async () => ({ id: "client-1" }));
  const trackConversion = vi.fn(async () => {});

  await runSubmitLeadFlow({}, { submitLead, trackConversion });

  expect(trackConversion).toHaveBeenCalledTimes(1);
});

// FASE 5, test 9: errore creazione lead -> nessun falso generate_lead.
it("9: never tracks a conversion when submitLead fails, and the error propagates", async () => {
  const submitLead = vi.fn(async () => {
    throw new Error("DB insert failed");
  });
  const trackConversion = vi.fn(async () => {});

  await expect(runSubmitLeadFlow({}, { submitLead, trackConversion })).rejects.toThrow("DB insert failed");
  expect(trackConversion).not.toHaveBeenCalled();
});

describe("runSubmitLeadFlow — tracking failure isolation", () => {
  it("does not let a tracking failure turn a successful submission into an error", async () => {
    const submitLead = vi.fn(async () => ({ id: "client-1" }));
    const trackConversion = vi.fn(async () => {
      throw new Error("GA4 Measurement Protocol unreachable");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = await runSubmitLeadFlow({}, { submitLead, trackConversion });

    expect(client).toEqual({ id: "client-1" });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
