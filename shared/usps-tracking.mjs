export function normalizeUspsTracking(value) {
  const tracking = String(value || "").trim().replace(/[ \t-]/g, "").toUpperCase();
  if (/^[A-Z]{2}\d{9}US$/.test(tracking)) return tracking;
  return /^9[2345]\d+$/.test(tracking) && [20, 22, 26, 30, 34].includes(tracking.length)
    ? tracking
    : "";
}

export function barcodeTrackings(value) {
  const raw = String(value || "").trim().replace(/^\]C1/, "").replace(/^\x1d/, "");
  const candidates = [normalizeUspsTracking(raw)];
  // GS1-128 AI 420 is a routing ZIP. The tracking code follows it.
  for (const zipLength of [5, 9]) {
    const match = raw.match(new RegExp(`^420\\d{${zipLength}}\\x1d?(.+)$`));
    if (match) candidates.push(normalizeUspsTracking(match[1]));
  }
  return [...new Set(candidates.filter(Boolean))];
}
