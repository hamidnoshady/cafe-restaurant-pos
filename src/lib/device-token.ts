/**
 * Browser-safe storage for a paired terminal's optional device token.
 *
 * Pairing changes which biometric credentials a terminal is offered, so the
 * token must survive a sign-out on that same browser. Keeping the key and the
 * storage failure handling here prevents Settings, the login door, and the
 * self-service biometric panel from silently drifting apart.
 *
 * This is intentionally separate from `device.ts`: that module hashes and
 * mints secrets on the server and must never enter a client bundle.
 */
export const DEVICE_TOKEN_STORAGE_KEY = "pos:deviceToken";

/** A request header is preferable to a query string when Settings identifies this browser's row. */
export const DEVICE_TOKEN_HEADER = "x-pos-device-token";

export function readDeviceToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Checks that this browser can retain a device token before a server row is
 * created. A terminal with blocked storage cannot carry the token back to the
 * login page, so recording it as paired would be misleading and unusable.
 */
export function canStoreDeviceToken(): boolean {
  if (typeof window === "undefined") return false;
  const probeKey = `${DEVICE_TOKEN_STORAGE_KEY}:probe`;
  try {
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

/** Returns false when the browser declined the write (private/blocked storage, quota, …). */
export function storeDeviceToken(token: string): boolean {
  if (!token || typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token);
    return window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY) === token;
  } catch {
    return false;
  }
}

/** Used after this browser's own registration has been revoked. */
export function clearDeviceToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
  } catch {
    // Removing an optional UI-narrowing token must never block revocation.
  }
}
