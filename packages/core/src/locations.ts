// Place recognition shared by pricing (which fare applies) and maps-distance
// (how the round trip from the base is built). Conservative on purpose: a
// place is "Sondrio" only when the text names the city itself or an address
// in it — never another Valtellina town, never a "provincia di Sondrio"
// hint, never a "Via Sondrio" in another town.

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

const SONDRIO_TOWN_SUFFIXES = new Set(["sondrio", "sondrio so"]);
const COUNTRY_SEGMENTS = new Set(["italia", "italy"]);

// What comes before ", Sondrio" must be an actual address (a street, a
// number, a station/hotel), otherwise "Albosaggia, Sondrio" — a Valtellina
// town plus its province — would pass as the city.
const ADDRESS_HINT =
  /(\d|\b(via|viale|piazza|piazzale|p za|corso|largo|vicolo|contrada|localita|lungo mallero|stazione|hotel|albergo|ospedale)\b)/;

export function isSondrioCity(place: string | null | undefined): boolean {
  if (!place) return false;
  if (SONDRIO_CITY_FORMS.has(normalizePlace(place))) return true;

  const segments = place.split(",").map(normalizePlace).filter((segment) => segment.length > 0);
  while (segments.length > 0 && COUNTRY_SEGMENTS.has(segments[segments.length - 1]!)) segments.pop();
  if (segments.length === 0) return false;
  const text = segments.join(" ");

  // 23100 is Sondrio's postcode; when a town follows it, it must be Sondrio
  // ("Via Sondrio 10, 23100 Milano" is contradictory, not the city).
  const postcode = /\b23100\b(.*)$/.exec(text);
  if (postcode) {
    const after = postcode[1]!.trim();
    return after === "" || after === "so" || SONDRIO_TOWN_SUFFIXES.has(after);
  }

  // "..., Sondrio" / "..., Sondrio (SO)": the town is the last comma part.
  // "Via Sondrio 10, Milano" ends with Milano, so it never gets here.
  const last = segments[segments.length - 1]!;
  if (segments.length > 1 && SONDRIO_TOWN_SUFFIXES.has(last)) {
    return ADDRESS_HINT.test(segments.slice(0, -1).join(" "));
  }

  // "Via Roma 1 Sondrio SO" without a comma: the province code marks the town.
  const noComma = /^(.*) sondrio so$/.exec(last);
  return noComma !== null && ADDRESS_HINT.test(noComma[1]!);
}

// Same keywords the airport fare table already uses for Malpensa.
export function isMalpensa(place: string | null | undefined): boolean {
  if (!place) return false;
  return /\b(malpensa|mxp)\b/.test(normalizePlace(place));
}

// Whole-word match on the normalized text: "mxp" matches "Aeroporto MXP T1",
// "como" does not match "Comolli". Used for route rules configured as data
// (e.g. calendar.minimum_event_duration's placeKeywords).
export function mentionsPlace(place: string | null | undefined, keyword: string): boolean {
  if (!place) return false;
  const normalizedKeyword = normalizePlace(keyword);
  if (!normalizedKeyword) return false;
  return ` ${normalizePlace(place)} `.includes(` ${normalizedKeyword} `);
}
