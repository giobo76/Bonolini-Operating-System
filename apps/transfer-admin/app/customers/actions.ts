"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClientSchema, createServerCaller, updateClientSchema } from "@bos/core";

function readFormFields(formData: FormData) {
  return {
    customerType: formData.get("customerType") || undefined,
    fullName: formData.get("fullName") || undefined,
    companyName: formData.get("companyName") || undefined,
    email: formData.get("email") || undefined,
    phone: formData.get("phone") || undefined,
    country: formData.get("country") || undefined,
    preferredLanguage: formData.get("preferredLanguage") || undefined,
    notes: formData.get("notes") || undefined,
    marketingConsent: formData.get("marketingConsent") === "on",
  };
}

export async function createCustomerAction(formData: FormData) {
  const parsed = createClientSchema.safeParse(readFormFields(formData));

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    redirect(`/customers/new?error=${encodeURIComponent(message)}`);
  }

  const caller = await createServerCaller();
  const client = await caller.clients.create(parsed.data);

  revalidatePath("/customers");
  redirect(`/customers/${client.id}`);
}

export async function updateCustomerAction(formData: FormData) {
  const id = String(formData.get("id"));
  const parsed = updateClientSchema.safeParse({ id, ...readFormFields(formData) });

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    redirect(`/customers/${id}/edit?error=${encodeURIComponent(message)}`);
  }

  const caller = await createServerCaller();
  await caller.clients.update(parsed.data);

  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  redirect(`/customers/${id}`);
}

export async function archiveCustomerAction(formData: FormData) {
  const id = String(formData.get("id"));
  const caller = await createServerCaller();
  await caller.clients.softDelete({ id });

  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  redirect(`/customers/${id}`);
}

export async function restoreCustomerAction(formData: FormData) {
  const id = String(formData.get("id"));
  const caller = await createServerCaller();
  await caller.clients.restore({ id });

  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  redirect(`/customers/${id}`);
}
