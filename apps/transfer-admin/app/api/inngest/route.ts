import { serve } from "inngest/next";
import { inngest } from "@bos/jobs";
import { marketingInngestFunctions, calendarInngestFunctions } from "@bos/core";

// Registers the scheduled quick-check/daily-audit/weekly-report functions,
// plus the Calendar Sync cron (packages/core/src/calendar/inngest-functions.ts).
// Requires the Inngest Dev Server locally (`npx inngest-cli dev`) or
// Inngest Cloud in production — see the README for setup.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...marketingInngestFunctions, ...calendarInngestFunctions],
});
