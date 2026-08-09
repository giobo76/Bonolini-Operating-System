import { COMMON_COUNTRIES, COMMON_LANGUAGES } from "@bos/core";

export interface CustomerFormDefaults {
  customerType?: "private" | "company";
  fullName?: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string;
  country?: string | null;
  preferredLanguage?: string | null;
  notes?: string | null;
  marketingConsent?: boolean;
}

export function CustomerFormFields({
  defaultValues,
}: {
  defaultValues?: CustomerFormDefaults;
}) {
  const values = defaultValues ?? {};

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium">Customer type</label>
        <select
          name="customerType"
          defaultValue={values.customerType ?? "private"}
          className="w-full rounded border px-3 py-2"
        >
          <option value="private">Private</option>
          <option value="company">Company</option>
        </select>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Full name *</label>
        <input
          type="text"
          name="fullName"
          defaultValue={values.fullName ?? ""}
          className="w-full rounded border px-3 py-2"
          required
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">
          Company name{" "}
          <span className="font-normal text-neutral-500">
            (required for company customers)
          </span>
        </label>
        <input
          type="text"
          name="companyName"
          defaultValue={values.companyName ?? ""}
          className="w-full rounded border px-3 py-2"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Phone *</label>
          <input
            type="tel"
            name="phone"
            defaultValue={values.phone ?? ""}
            className="w-full rounded border px-3 py-2"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Email</label>
          <input
            type="email"
            name="email"
            defaultValue={values.email ?? ""}
            className="w-full rounded border px-3 py-2"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Country</label>
          <input
            type="text"
            name="country"
            list="country-suggestions"
            defaultValue={values.country ?? ""}
            className="w-full rounded border px-3 py-2"
          />
          <datalist id="country-suggestions">
            {COMMON_COUNTRIES.map((country) => (
              <option key={country} value={country} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">
            Preferred language
          </label>
          <input
            type="text"
            name="preferredLanguage"
            list="language-suggestions"
            defaultValue={values.preferredLanguage ?? ""}
            className="w-full rounded border px-3 py-2"
          />
          <datalist id="language-suggestions">
            {COMMON_LANGUAGES.map((language) => (
              <option key={language} value={language} />
            ))}
          </datalist>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Notes</label>
        <textarea
          name="notes"
          defaultValue={values.notes ?? ""}
          rows={4}
          className="w-full rounded border px-3 py-2"
          placeholder="Internal only — never shown to the client"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="marketingConsent"
          defaultChecked={values.marketingConsent ?? false}
        />
        Marketing consent (opted in to promotional messages)
      </label>
    </div>
  );
}
