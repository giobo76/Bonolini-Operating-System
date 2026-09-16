export * from "./agent";
export * from "./categories";
export * from "./permissions";
export * from "./memory";
export * from "./tasks";
export * from "./registry";
export * from "./pipeline";
export * from "./orchestrator";
export * from "./tools";
export * from "./policy";
export * from "./google-marketing-analyst";

// "./agents" (crmAgent/marketingAgent/nccAgent/financeAgent/contentAgent/
// registerCoreAgents) is deliberately NOT re-exported from the package's
// public surface (package.json's "exports" map only resolves this file) —
// those are fake, no-op-handler example agents (see that file's own header
// comment), never registered by any real caller today. Omitting them from
// the barrel keeps a real BOS Agent consumer from ever accidentally
// importing/registering one instead of a real agent from
// packages/core/src/bos-agent/agents.
