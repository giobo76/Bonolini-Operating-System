import { z } from "zod";

export const customerTypeSchema = z.enum(["private", "company"]);

const baseClientFields = {
  customerType: customerTypeSchema.default("private"),
  fullName: z.string().trim().min(1, "Full name is required"),
  companyName: z.string().trim().min(1).optional(),
  email: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.string().email("Invalid email address").optional(),
  ),
  phone: z.string().trim().min(3, "Phone is required"),
  country: z.string().trim().optional(),
  preferredLanguage: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  marketingConsent: z.boolean().default(false),
};

function requireCompanyName(
  data: { customerType: string; companyName?: string },
  ctx: z.RefinementCtx,
) {
  if (data.customerType === "company" && !data.companyName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["companyName"],
      message: "Company name is required for company customers",
    });
  }
}

export const createClientSchema = z
  .object(baseClientFields)
  .superRefine(requireCompanyName);

export const updateClientSchema = z
  .object({ id: z.string().uuid(), ...baseClientFields })
  .superRefine(requireCompanyName);

export const clientIdSchema = z.object({ id: z.string().uuid() });

export const listClientsSchema = z.object({
  search: z.string().trim().optional(),
  customerType: customerTypeSchema.optional(),
  country: z.string().optional(),
  status: z.enum(["active", "archived", "all"]).default("active"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ListClientsInput = z.infer<typeof listClientsSchema>;

// ── Public lead capture ──────────────────────────────────────────────
// Deliberately narrow: a public visitor can only ever create a bare
// private-customer lead with contact info + first-touch attribution — not
// set role, consent, or anything a staff-only field could. See
// clients.submitLead (publicProcedure) in router.ts.
export const leadSubmissionSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required"),
  email: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.string().email("Invalid email address").optional(),
  ),
  phone: z.string().trim().min(3, "Phone is required"),
  message: z.string().trim().max(2000).optional(),
  utmSource: z.string().trim().optional(),
  utmMedium: z.string().trim().optional(),
  utmCampaign: z.string().trim().optional(),
  utmTerm: z.string().trim().optional(),
  utmContent: z.string().trim().optional(),
  gclid: z.string().trim().optional(),
  landingPage: z.string().trim().optional(),
});

export type LeadSubmissionInput = z.infer<typeof leadSubmissionSchema>;
