export {
  processTransferRequestForMessage,
  processTransferRequestForMessageAndPrice,
  getTransferRequest,
  listTransferRequestsForClient,
  computeMissingInformation,
  runPricingForTransferRequest,
  runAvailabilityForTransferRequest,
  acceptTransferRequest,
  rejectTransferRequest,
  modifyPriceForTransferRequest,
} from "./service";
export type { TransferRequestMessageInput } from "./service";
export { transferRequestsRouter } from "./router";
export * from "./schema";
export type { TransferRequest, NewTransferRequest } from "@bos/db";

// Boundary rule (ADR 0002): other modules/apps import only from here —
// service.ts's internal helpers (insertNewTransferRequest, mergeIntoTransferRequest,
// hasRouteConflict, cancelSuperseded, findOpenTransferRequest) are
// deliberately not exported; processTransferRequestForMessage is the only
// entry point that mutates transfer_requests.
