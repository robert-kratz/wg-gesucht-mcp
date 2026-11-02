import type { Page } from "playwright";
import { z } from "zod";
import { AppError } from "./errors.js";

const listingGroups = {
  start: ["ad_title", "autocompinp", "category", "rent_type"],
  location: ["district_id", "district_custom", "street_only", "housenumber", "postcode"],
  property: [
    "house_type",
    "floor_level",
    "property_size",
    "flatshare_property_size",
    "handicap_accessible",
    "flatshare_friendly",
    "parking_option",
    "public_transport_in_minutes",
    "offer_in_exchange",
    "online_tour",
    "housing_protection_number",
  ],
  dates: [
    "available_from_day",
    "available_from_month",
    "available_from_year",
    "available_to_day",
    "available_to_month",
    "available_to_year",
  ],
  costs: ["rent_costs", "utility_costs", "bond_costs", "equipment_costs", "other_costs"],
  household: [
    "flatshare_inhabitants_total",
    "flatshare_females",
    "flatshare_males",
    "flatshare_divers",
    "flatshare_not_specified",
    "flatmates_aged_from",
    "flatmates_aged_to",
    "searching_for_gender",
    "searching_for_age_from",
    "searching_for_age_to",
    "smoking_is_allowed",
    "languages",
    "pets_present",
    "flatshare_type_0",
    "flatshare_type_1",
    "flatshare_type_2",
    "flatshare_type_3",
    "flatshare_type_4",
    "flatshare_type_5",
    "flatshare_type_6",
    "flatshare_type_7",
    "flatshare_type_8",
    "flatshare_type_9",
    "flatshare_type_10",
    "flatshare_type_11",
    "flatshare_type_12",
    "flatshare_type_13",
    "flatshare_type_14",
    "flatshare_type_15",
    "flatshare_type_16",
    "flatshare_type_17",
    "flatshare_type_18",
    "flatshare_type_19",
    "flatshare_type_20",
    "flatshare_type_21",
    "flatshare_type_22",
    "flatshare_type_23",
  ],
  description: [
    "freetext_property_description",
    "freetext_area_description",
    "freetext_flatshare",
    "freetext_other",
  ],
  contact: ["offer_telephone", "offer_mobile", "use_profile_telephone", "i_am"],
  energy: [
    "energy_certificate_type",
    "energy_consumption",
    "energy_source",
    "energy_building_year",
    "energy_efficiency_class",
    "green_energy",
    "heating",
  ],
  amenities: [
    "internet_dsl",
    "internet_flatrate",
    "internet_wlan",
    "internet_fiber_optic",
    "internet_dsl_speed",
    "internet_provider_change",
    "phone_analog",
    "phone_isdn",
    "phone_voip",
    "phone_flatrate",
    "furnished",
    "partly_furnished",
    "bath_availability",
    "bath",
    "shower",
    "guest_toilet",
    "kitchen_availability",
    "floorboards",
    "parquet",
    "laminate",
    "carpet",
    "tiles",
    "linoleum",
    "underfloor_heating",
    "cable_tv",
    "satellite_tv",
    "washing_machine",
    "dishwasher",
    "terrace",
    "balcony",
    "garden",
    "shared_garden",
    "cellar",
    "elevator",
    "pets_allowed",
    "bike_cellar",
    "attic",
  ],
} as const;
export const LISTING_FIELDS = Object.values(listingGroups).flat();
export const PROFILE_FIELDS = [
  "first_name",
  "last_name",
  "title",
  "name_display_status",
  "birthday",
  "employment_status",
  "course_code",
  "street_only",
  "housenumber",
  "postcode",
  "city",
  "country_code",
  "telephone_main",
  "mobile_main",
] as const;
const fieldValueSchema = z.union([
  z.string().max(30_000),
  z.number().finite().min(0).max(1_000_000_000),
  z.boolean(),
  z.array(z.string().max(200)).max(100),
]);
export type FieldValue = z.infer<typeof fieldValueSchema>;
export type ListingPatch = Partial<Record<(typeof LISTING_FIELDS)[number], FieldValue>>;
export type ProfilePatch = Partial<Record<(typeof PROFILE_FIELDS)[number], FieldValue>>;
export const listingPatchSchema = z
  .partialRecord(z.enum(LISTING_FIELDS), fieldValueSchema)
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field.");
export const profilePatchSchema = z
  .partialRecord(z.enum(PROFILE_FIELDS), fieldValueSchema)
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field.");
export interface FormField {
  label: string;
  type: string;
  value: FieldValue;
  options?: { value: string; label: string }[];
  maxLength?: number;
  required?: boolean;
}
export async function readFields(
  page: Page,
  names: readonly string[],
): Promise<Record<string, FormField>> {
  return page.evaluate(
    (keys) => {
      const result: Record<string, FormField> = {};
      for (const name of keys) {
        const elements = Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            `[name="${name}"]`,
          ),
        );
        const e = elements[0];
        if (!e || e.type === "hidden") continue;
        let value: FieldValue = e.value;
        let options: FormField["options"];
        if (e instanceof HTMLSelectElement) {
          value = e.multiple ? Array.from(e.selectedOptions).map((o) => o.value) : e.value;
          options = Array.from(e.options).map((o) => ({
            value: o.value,
            label: o.textContent?.trim() || o.value,
          }));
        }
        if (e instanceof HTMLInputElement && e.type === "checkbox") value = e.checked;
        if (e.type === "radio") {
          value = elements.find((e) => (e as HTMLInputElement).checked)?.value || "";
          options = elements.map((e) => ({
            value: e.value,
            label: e.labels?.[0]?.textContent?.trim() || e.value,
          }));
        }
        result[name] = {
          label: e.labels?.[0]?.textContent?.trim() || name,
          type: e.type,
          value,
          ...(options ? { options } : {}),
          ...((e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) &&
          e.maxLength >= 0
            ? { maxLength: e.maxLength }
            : {}),
          required: e.required,
        };
      }
      return result;
    },
    [...names],
  );
}

export function validatePatch(
  fields: Record<string, FormField>,
  patch: Record<string, FieldValue>,
): void {
  for (const [name, value] of Object.entries(patch)) {
    const field = fields[name];
    if (!field)
      throw new AppError(
        "UNSUPPORTED_FIELD",
        `The current form does not expose ${name}. Read its available fields first.`,
      );
    if (
      typeof value === "string" &&
      field.maxLength !== undefined &&
      value.length > field.maxLength
    )
      throw new AppError(
        "INVALID_FIELD",
        `${name} exceeds the website's maximum length of ${field.maxLength}.`,
      );
    if (field.required && value === "")
      throw new AppError("INVALID_FIELD", `${name} is required by the website.`);
    if (
      field.type === "checkbox"
        ? typeof value !== "boolean"
        : field.type === "select-multiple"
          ? !Array.isArray(value)
          : Array.isArray(value) || typeof value === "boolean"
    )
      throw new AppError("INVALID_FIELD", `Invalid value type for ${name}.`);
    if (
      field.options &&
      (Array.isArray(value) ? value : [String(value)]).some(
        (v) => !field.options?.some((o) => o.value === v),
      )
    )
      throw new AppError("INVALID_FIELD", `Use one of the advertised option values for ${name}.`);
    if (
      field.type === "tel" &&
      /costs|size|minutes|aged|age_|consumption|year/.test(name) &&
      String(value) !== "" &&
      !/^\d+(?:[.,]\d{1,2})?$/.test(String(value))
    )
      throw new AppError("INVALID_FIELD", `${name} must be a non-negative numeric value.`);
  }
}

export async function revealField(page: Page, name: string): Promise<void> {
  const locator = page.locator(`[name="${name}"]`).first();
  const formId = await locator.evaluate((e) => e.closest("form")?.id);
  if (formId) {
    const tab = page.locator(`.form_nav_item[data-form_block="${formId}"]`);
    if (await tab.count()) await tab.first().click();
  }
  if (name.startsWith("freetext_")) {
    const tab = page.locator(`a[href="#${name}_panel"]`);
    if (!(await locator.isVisible()) && (await tab.count())) await tab.first().click();
  }
}

export async function fillPatch(
  page: Page,
  fields: Record<string, FormField>,
  patch: Record<string, FieldValue>,
): Promise<void> {
  validatePatch(fields, patch);
  for (const [name, value] of Object.entries(patch)) {
    await revealField(page, name);
    const locator = page.locator(`[name="${name}"]`).first();
    const field = fields[name];
    if (!field) continue;
    if (field.type.startsWith("select"))
      await locator.selectOption(Array.isArray(value) ? value : String(value), { force: true });
    else if (field.type === "checkbox") {
      if ((await locator.isChecked()) !== value)
        await locator.evaluate((e) => (e as HTMLInputElement).click());
    } else if (field.type === "radio")
      await page.locator(`[name="${name}"]`).evaluateAll((xs, desired) => {
        const e = xs.find((x) => (x as HTMLInputElement).value === desired) as
          | HTMLInputElement
          | undefined;
        e?.click();
      }, String(value));
    else {
      await locator.fill(String(value));
      if (name === "autocompinp") {
        const suggestion = page
          .locator(".autocomplete-suggestion, .ui-autocomplete .ui-menu-item")
          .filter({ hasText: String(value) })
          .first();
        await suggestion.waitFor({ state: "visible" });
        await suggestion.click();
      }
      await locator.blur();
    }
  }
}

export function patchMatches(
  fields: Record<string, FormField>,
  patch: Record<string, FieldValue>,
): boolean {
  return Object.entries(patch).every(([name, value]) => {
    const actual = fields[name]?.value;
    return Array.isArray(value)
      ? Array.isArray(actual) && [...actual].sort().join("\0") === [...value].sort().join("\0")
      : typeof value === "boolean"
        ? actual === value
        : String(actual) === String(value);
  });
}
