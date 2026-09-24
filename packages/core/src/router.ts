import { router } from "./trpc";
import { clientsRouter } from "./clients";
import { marketingRouter } from "./marketing";
import { quotesRouter } from "./quotes";
import { bookingsRouter } from "./bookings";
import { transferRequestsRouter } from "./transfer-requests";
import { calendarRouter } from "./calendar";
import { socialPublishingRouter } from "./social-publishing";
import { bosAgentRouter } from "./bos-agent";
import { businessRulesRouter } from "./business-rules";
import { quoteApprovalRouter } from "./quote-approval";

// dispatch, drivers, billing, notifications routers merge in here as each
// module is built — see docs/domain/13-api-contracts.md for the intended
// full surface.
export const appRouter = router({
  clients: clientsRouter,
  marketing: marketingRouter,
  quotes: quotesRouter,
  bookings: bookingsRouter,
  transferRequests: transferRequestsRouter,
  calendar: calendarRouter,
  socialPublishing: socialPublishingRouter,
  bosAgent: bosAgentRouter,
  businessRules: businessRulesRouter,
  quoteApproval: quoteApprovalRouter,
});

export type AppRouter = typeof appRouter;
