// Place recognition shared by pricing (which fare applies) and maps-distance
// (how the round trip from the base is built). Conservative on purpose: a
// place is "Sondrio" only when the text names the city itself — never
// another Valtellina town, never a "(Sondrio)"/"provincia di Sondrio" hint.

export const BASE_LOCATION = "Sondrio";

function normalizePlace(place: string): string {
  return place
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Sondrio city, as customers actually write it. Anything else ("Albosaggia",
// "Morbegno", "Sondrio province", an address in another town) is not.
const SONDRIO_CITY_FORMS = new Set([
  "sondrio",
  "sondrio centro",
  "centro sondrio",
  "sondrio citta",
  "citta di sondrio",
  "sondrio so",
  "sondrio italia",
  "sondrio italy",
  "stazione di sondrio",
  "stazione sondrio",
  "sondrio stazione",
  "sondrio fs",
]);

export function isSondrioCity(place: string | null | undefined): boolean {
  if (!place) return false;
  return SONDRIO_CITY_FORMS.has(normalizePlace(place));
}

// Same keywords the airport fare table already uses for Malpensa.
export function isMalpensa(place: string | null | undefined): boolean {
  if (!place) return false;
  return /\b(malpensa|mxp)\b/.test(normalizePlace(place));
}
