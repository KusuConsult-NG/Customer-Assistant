/**
 * PLASCHEMA Accredited Healthcare Facilities by LGA
 * Sarah reads from this list — she does NOT accept free-text hospital names.
 */

export interface AccreditedFacility {
  name: string;
  type: string;
  address: string;
}

export const PLASCHEMA_FACILITIES: Record<string, AccreditedFacility[]> = {
  "Jos North": [
    { name: "Plateau Specialist Hospital", type: "Specialist Hospital", address: "Plateau Road, Jos" },
    { name: "Jos University Teaching Hospital", type: "Specialist Hospital", address: "Lamingo Road, Jos" },
    { name: "Bingham University Teaching Hospital", type: "Specialist Hospital", address: "Gindiri Road, Jos" },
    { name: "Gwong Primary Health Centre", type: "Primary Health Centre", address: "Gwong, Jos North" },
    { name: "Nasarawa Primary Health Centre", type: "Primary Health Centre", address: "Nasarawa GRA, Jos North" },
    { name: "Anglo Jos Clinic", type: "General Hospital", address: "Anglo Jos, Jos North" },
  ],
  "Jos South": [
    { name: "Du General Hospital", type: "General Hospital", address: "Du, Jos South" },
    { name: "Vwang Health Centre", type: "Primary Health Centre", address: "Vwang, Jos South" },
    { name: "Kuru Primary Health Centre", type: "Primary Health Centre", address: "Kuru, Jos South" },
  ],
  "Jos East": [
    { name: "Vom Christian Hospital", type: "General Hospital", address: "Vom, Jos East" },
    { name: "Naraguta Primary Health Centre", type: "Primary Health Centre", address: "Naraguta, Jos East" },
    { name: "Heipang General Hospital", type: "General Hospital", address: "Heipang, Jos East" },
  ],
  "Barkin Ladi": [
    { name: "Barkin Ladi General Hospital", type: "General Hospital", address: "Barkin Ladi LGA" },
    { name: "Maiyanga Primary Health Centre", type: "Primary Health Centre", address: "Maiyanga, Barkin Ladi" },
    { name: "Ganawuri Primary Health Centre", type: "Primary Health Centre", address: "Ganawuri, Barkin Ladi" },
  ],
  "Bassa": [
    { name: "Bassa General Hospital", type: "General Hospital", address: "Bassa LGA Headquarters" },
    { name: "Jengre Primary Health Centre", type: "Primary Health Centre", address: "Jengre, Bassa" },
  ],
  "Bokkos": [
    { name: "Bokkos General Hospital", type: "General Hospital", address: "Bokkos Town" },
    { name: "Manguna Primary Health Centre", type: "Primary Health Centre", address: "Manguna, Bokkos" },
  ],
  "Kanam": [
    { name: "Shendam General Hospital", type: "General Hospital", address: "Shendam, Kanam" },
    { name: "Dengi Primary Health Centre", type: "Primary Health Centre", address: "Dengi, Kanam" },
  ],
  "Kanke": [
    { name: "Kabwir General Hospital", type: "General Hospital", address: "Kabwir, Kanke" },
    { name: "Kanke Primary Health Centre", type: "Primary Health Centre", address: "Kanke Headquarters" },
  ],
  "Langtang North": [
    { name: "Langtang General Hospital", type: "General Hospital", address: "Langtang Town" },
    { name: "Piapung Primary Health Centre", type: "Primary Health Centre", address: "Piapung, Langtang North" },
  ],
  "Langtang South": [
    { name: "Shendam General Hospital", type: "General Hospital", address: "Shendam" },
    { name: "Yelwa Primary Health Centre", type: "Primary Health Centre", address: "Yelwa, Langtang South" },
  ],
  "Mangu": [
    { name: "Mangu General Hospital", type: "General Hospital", address: "Mangu Town" },
    { name: "Gindiri Hospital", type: "General Hospital", address: "Gindiri, Mangu" },
    { name: "Ampang Primary Health Centre", type: "Primary Health Centre", address: "Ampang East, Mangu" },
  ],
  "Mikang": [
    { name: "Mikang General Hospital", type: "General Hospital", address: "Mikang LGA" },
    { name: "Shendam Cottage Hospital", type: "Cottage Hospital", address: "Shendam Road, Mikang" },
  ],
  "Pankshin": [
    { name: "Pankshin General Hospital", type: "General Hospital", address: "Pankshin Town" },
    { name: "Pamtok Primary Health Centre", type: "Primary Health Centre", address: "Pamtok, Pankshin" },
  ],
  "Riyom": [
    { name: "Riyom General Hospital", type: "General Hospital", address: "Riyom Town" },
    { name: "Hoss Primary Health Centre", type: "Primary Health Centre", address: "Hoss, Riyom" },
  ],
  "Shendam": [
    { name: "Shendam General Hospital", type: "General Hospital", address: "Shendam" },
    { name: "Namu Primary Health Centre", type: "Primary Health Centre", address: "Namu, Shendam" },
    { name: "Dadin Kowa Primary Health Centre", type: "Primary Health Centre", address: "Dadin Kowa, Shendam" },
  ],
  "Wase": [
    { name: "Wase General Hospital", type: "General Hospital", address: "Wase Town" },
    { name: "Wase Primary Health Centre", type: "Primary Health Centre", address: "Wase Headquarters" },
    { name: "Gimba Primary Health Centre", type: "Primary Health Centre", address: "Gimba, Wase" },
  ],
};

export const PLATEAU_LGAS = Object.keys(PLASCHEMA_FACILITIES).sort();

export function getFacilitiesForLGA(lga: string): AccreditedFacility[] {
  const key = Object.keys(PLASCHEMA_FACILITIES).find(
    k => k.toLowerCase() === lga.toLowerCase()
  );
  return key ? PLASCHEMA_FACILITIES[key] : [];
}

export function isAccreditedFacility(lga: string, hospitalName: string): boolean {
  const facilities = getFacilitiesForLGA(lga);
  const cleaned = hospitalName.trim().toLowerCase();
  return facilities.some(f => f.name.toLowerCase() === cleaned);
}

export function facilitiesForLGAAsText(lga: string): string {
  const facilities = getFacilitiesForLGA(lga);
  if (facilities.length === 0) return 'your nearest General Hospital or Primary Health Centre';
  if (facilities.length === 1) return facilities[0].name;
  const names = facilities.map(f => f.name);
  const last = names.pop();
  return names.join(', ') + ', or ' + last;
}
