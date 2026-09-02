import { TRPCError } from "@trpc/server";
import { router, staffProcedure } from "../trpc";
import {
  transferRequestIdSchema,
  rejectTransferRequestSchema,
  modifyPriceForTransferRequestSchema,
} from "./schema";
import * as transferRequestService from "./service";

// staffProcedure (admin + dispatcher) for all four — same authorization
// tier already approved for "manual price override" in
// docs/domain/09-roles-permissions.md's permission matrix. No ownership
// check beyond tenant scoping: transfer_requests has no per-staff-user
// assignment concept, same as quotes/clients.
//
// Deliberately minimal: only what this milestone needs to exercise the
// pending_admin_approval -> decision boundary. No `list`/`listPendingApproval`
// yet — an admin UI is out of scope until a later milestone.
export const transferRequestsRouter = router({
  get: staffProcedure.input(transferRequestIdSchema).query(async ({ ctx, input }) => {
    const request = await transferRequestService.getTransferRequest(ctx.session.profile.tenantId, input.id);
    if (!request) throw new TRPCError({ code: "NOT_FOUND" });
    return request;
  }),

  accept: staffProcedure.input(transferRequestIdSchema).mutation(async ({ ctx, input }) => {
    try {
      return await transferRequestService.acceptTransferRequest(
        ctx.session.profile.tenantId,
        input.id,
        ctx.session.profile.id,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("no transfer_request found")) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      // "booking creation failed" (Booking Snapshot milestone) marks a
      // transient external-dependency failure (Maps unavailable, or a
      // malformed requestedDate/requestedTime), never a bad state
      // transition — the transfer_request may already be 'approved' at
      // this point, with the booking still missing, and a retry is the
      // correct next step. Distinguished from the generic CONFLICT below,
      // which represents an actual invalid state transition.
      if (error instanceof Error && error.message.includes("booking creation failed")) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      }
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "accept failed" });
    }
  }),

  reject: staffProcedure.input(rejectTransferRequestSchema).mutation(async ({ ctx, input }) => {
    try {
      return await transferRequestService.rejectTransferRequest(
        ctx.session.profile.tenantId,
        input.id,
        input.reason,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("no transfer_request found")) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "reject failed" });
    }
  }),

  modifyPrice: staffProcedure.input(modifyPriceForTransferRequestSchema).mutation(async ({ ctx, input }) => {
    try {
      return await transferRequestService.modifyPriceForTransferRequest(
        ctx.session.profile.tenantId,
        input.id,
        ctx.session.profile.id,
        input.amountCents,
        input.reason,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("no transfer_request found")) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      // See accept's identical branch above for why this is distinguished
      // from the generic CONFLICT case.
      if (error instanceof Error && error.message.includes("booking creation failed")) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      }
      throw new TRPCError({ code: "CONFLICT", message: error instanceof Error ? error.message : "modifyPrice failed" });
    }
  }),
});
