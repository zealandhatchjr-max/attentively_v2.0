import type { OpeningHours } from "../core/types.js";
import type { PlaceResult, PlacesProvider } from "./types.js";

/**
 * Google Places API (New), used only to VERIFY vendors the user's assistant found:
 * the business is still open (businessStatus), and its real phone and hours.
 * Called only after the user has agreed to use Attentively; results are cached.
 * PHASE 0 VERIFY: confirm licensing terms for storing place data in vendor memory.
 */
export class GooglePlaces implements PlacesProvider {
  private fields = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.internationalPhoneNumber",
    "places.location",
    "places.regularOpeningHours",
    "places.types",
    "places.rating",
    "places.businessStatus",
  ].join(",");

  constructor(private apiKey: string) {}

  async findPlace(query: string): Promise<PlaceResult | null> {
    return (await this.search(query))[0] ?? null;
  }

  private async search(query: string): Promise<PlaceResult[]> {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": this.fields,
      },
      body: JSON.stringify({ textQuery: query, regionCode: "AU", pageSize: 3 }),
    });
    if (!res.ok) throw new Error(`Places search failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { places?: any[] };
    return (body.places ?? []).map(toResult);
  }

  async lookupPhone(phone: string): Promise<PlaceResult | null> {
    const results = await this.search(phone);
    const digits = (s: string) => s.replace(/\D/g, "");
    return results.find((r) => digits(r.phone).endsWith(digits(phone).slice(-9))) ?? null;
  }
}

function toResult(p: any): PlaceResult {
  const hours: OpeningHours | undefined = p.regularOpeningHours?.periods
    ?.filter((per: any) => per.open && per.close && per.open.day === per.close.day)
    .map((per: any) => ({
      day: per.open.day,
      open: `${String(per.open.hour).padStart(2, "0")}:${String(per.open.minute ?? 0).padStart(2, "0")}`,
      close: `${String(per.close.hour).padStart(2, "0")}:${String(per.close.minute ?? 0).padStart(2, "0")}`,
    }));
  return {
    name: p.displayName?.text ?? "Unknown",
    phone: p.internationalPhoneNumber ?? "",
    businessStatus: p.businessStatus,
    address: p.formattedAddress,
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    placeId: p.id,
    hours,
    types: p.types,
    rating: p.rating,
  };
}
