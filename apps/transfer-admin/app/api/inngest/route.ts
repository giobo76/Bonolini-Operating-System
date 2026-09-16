import { serve } from "inngest/next";
import { inngest } from "@bos/jobs";
import {
  marketingInngestFunctions,
  calendarInngestFunctions,
  socialPublishingInngestFunctions,
  bosAgentInngestFunctions,
} from "@bos/core";

// Registers the scheduled quick-check/daily-audit/weekly-report functions,
// the Calendar Sync cron (packages/core/src/calendar/inngest-functions.ts),
// the weekly Facebook + Instagram post cron
// (packages/core/src/social-publishing/inngest-functions.ts), and the BOS
// Agent's daily Marketing/Social/Operations advisory checks
// (packages/core/src/bos-agent/inngest-functions.ts). Requires the Inngest
// Dev Server locally (`npx inngest-cli dev`) or Inngest Cloud in
// production — see the README for setup.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    ...marketingInngestFunctions,
    ...calendarInngestFunctions,
    ...socialPublishingInngestFunctions,
    ...bosAgentInngestFunctions,
  ],
});
