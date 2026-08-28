// Orchestrates "insert the lead, then track the conversion" for
// submitLeadAction. Lives here (app layer), not inside packages/core,
// deliberately: it composes clients' submitLead with marketing's
// trackLeadConversion, and per ADR 0002 a packages/core module must not
// reach into another module's internals — an app route composing two
// modules' public exports is exactly what the app layer is for.
//
// Dependency-injected (rather than importing @bos/core's real functions
// directly) purely so this can be unit-tested without a browser or a real
// network/DB — actions.ts wires the real functions in.
export interface SubmitLeadFlowDeps<TInput, TClient> {
  submitLead: (input: TInput) => Promise<TClient>;
  trackConversion: (client: TClient) => Promise<unknown>;
}

// FASE 3's core requirement, structurally guaranteed by this control flow:
// - trackConversion runs only after submitLead has actually resolved (a
//   real row exists) — never on click, never speculatively.
// - if submitLead throws, trackConversion never runs at all — no false
//   generate_lead on a failed submission.
// - trackConversion's own failure (network hiccup, missing MP secret) is
//   caught here and never surfaces as a submission failure — a tracking
//   problem must not turn a real, successful lead into an error page.
// - called exactly once per invocation — no loop, no retry — so exactly
//   one tracking attempt happens per real submission.
export async function runSubmitLeadFlow<TInput, TClient>(
  input: TInput,
  deps: SubmitLeadFlowDeps<TInput, TClient>,
): Promise<TClient> {
  const client = await deps.submitLead(input);

  try {
    await deps.trackConversion(client);
  } catch (error) {
    console.error("generate_lead tracking failed after a successful lead submission", error);
  }

  return client;
}
