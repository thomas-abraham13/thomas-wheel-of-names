// Pure wheel logic shared by the browser app and the automated tests.
// Nothing in here may touch the DOM, storage, or the network.

export const DEFAULT_TITLE = "Wheel of Names";
export const CENTER_COLORS = new Set(["#ffffff", "#1d211f", "#0f766e", "#f2c94c", "#7a4fb3"]);
export const TAU = Math.PI * 2;
export const NAME_MAX_LENGTH = 80;
export const TITLE_MAX_LENGTH = 60;
export const SPIN_DURATION_MIN = 9500;
export const SPIN_DURATION_VARIANCE = 1000;
export const SPIN_TURNS_MIN = 7;
export const SPIN_TURNS_VARIANCE = 3;
export const SPIN_EASE_POWER = 4;
export const LANDING_EDGE_INSET = 0.08;

// Collapses user-entered whitespace, trims padding, and enforces the name length limit.
export function normalizeName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX_LENGTH);
}

// Cleans a title and enforces its shared maximum length.
export function normalizeTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_LENGTH);
}

// Accepts only supported center colors or safe image data URLs.
export function normalizeCenterImage(value) {
  const image = typeof value === "string" ? value : "";
  if (image.startsWith("color:") && CENTER_COLORS.has(image.slice(6))) return image;
  return /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(image) ? image : "";
}

// Allows only wheel IDs that are safe to place in URLs and API paths.
export function sanitizeWheelId(value) {
  const cleaned = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{6,32}$/.test(cleaned) ? cleaned : "";
}

// Generates a readable, unguessable wheel ID from cryptographically random bytes.
export function createWheelId(getRandomValues = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

// Converts untrusted persisted or remote data into the client state shape used by the UI.
export function normalizeServerState(value) {
  const parsedNames = Array.isArray(value?.names)
    ? value.names
        .map((item) => ({
          id: String(item?.id || ""),
          text: String(item?.text || "").trim(),
          createdAt: Number(item?.createdAt || 0)
        }))
        .filter((item) => item.id && item.text)
        .sort((a, b) => a.createdAt - b.createdAt)
    : [];

  return {
    title: normalizeTitle(value?.title) || DEFAULT_TITLE,
    centerImage: normalizeCenterImage(value?.centerImage),
    names: parsedNames,
    lastWinner: String(value?.lastWinner || ""),
    lastWinnerAt: Number(value?.lastWinnerAt || 0),
    lastWinnerId: String(value?.lastWinnerId || "")
  };
}

// Wraps any rotation into the canonical range from zero up to one full turn.
export function normalizeAngle(value) {
  return ((value % TAU) + TAU) % TAU;
}

// Returns the index of the slice under the top pointer for a given rotation and slice size.
export function sliceUnderPointer(angle, slice) {
  return Math.floor(normalizeAngle(-angle) / slice);
}

// Eases spin progress (0..1) so the wheel starts fast and crawls through the final slices.
export function easeOutSpin(progress) {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - Math.pow(1 - clamped, SPIN_EASE_POWER);
}

// Picks a winner and a forward landing rotation that stops inside the winner's slice.
export function planSpin(nameCount, currentRotation, random = Math.random) {
  const slice = TAU / nameCount;
  const winnerIndex = Math.floor(random() * nameCount);
  const landingRange = slice * (0.5 - LANDING_EDGE_INSET);
  const landingOffset = (random() * 2 - 1) * landingRange;
  const targetAngle = normalizeAngle(-(winnerIndex + 0.5) * slice + landingOffset);
  const fullTurns = SPIN_TURNS_MIN + Math.floor(random() * SPIN_TURNS_VARIANCE);
  const travel = ((targetAngle - normalizeAngle(currentRotation) + TAU) % TAU) + TAU * fullTurns;

  return {
    winnerIndex,
    slice,
    targetRotation: currentRotation + travel,
    duration: SPIN_DURATION_MIN + random() * SPIN_DURATION_VARIANCE
  };
}
