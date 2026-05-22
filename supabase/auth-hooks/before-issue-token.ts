// Supabase Auth `before-issue-token` hook
//
// Purpose: copy Microsoft Entra ID claims (`tid`, `oid`, `name`, `email`) from
// the provider token (the original Microsoft JWT) into Supabase's session JWT
// `app_metadata` so that Postgres RLS policies can read them via
// `auth.jwt() ->> 'tid'` and `auth.jwt() -> 'app_metadata' ->> 'oid'`
// (see specs/001-authentication-and-participant/research.md §R-3 and
// data-model.md §"Reusable RLS Predicate").
//
// Runtime: Deno (Supabase Edge Function / Auth hook runtime).
//
// Hook contract: this implementation targets the Supabase Auth Hooks v1
// `before-issue-token` payload as documented April 2026. If Supabase updates
// the contract, the team should reconcile the `HookPayload` / `HookResponse`
// types below. The hook is intentionally tolerant: any unexpected shape
// degrades gracefully by returning the original claims unchanged.
//
// Safety:
// - Does NOT verify the inner Microsoft JWT (Supabase already validated it).
// - Does NOT write to the database or call out to the network.
// - Does NOT log PII (no email/oid/tid contents) — only structured non-PII
//   metadata flags for observability.
// - Idempotent and side-effect-free.

/** Microsoft Entra ID claims we forward into Supabase `app_metadata`. */
type MicrosoftClaims = {
  tid?: string;
  oid?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
};

/** Subset of the user record passed to the hook. */
type HookUser = {
  id: string;
  email?: string;
  raw_app_meta_data?: Record<string, unknown>;
  raw_user_meta_data?: Record<string, unknown>;
};

/** Best-effort shape of the v1 `before-issue-token` payload. */
type HookPayload = {
  user: HookUser;
  claims: Record<string, unknown>;
};

/** What we return to Supabase — merged into the issued session JWT. */
type HookResponse = {
  claims: Record<string, unknown>;
};

/**
 * Decode a JWT payload without verification. We only need the claims; the
 * provider token has already been verified by Supabase Auth upstream.
 * Returns `null` if the token is missing or unparseable.
 */
function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    // base64url -> base64 -> decode
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    // `atob` is available in the Deno / Edge runtime.
    const json = atob(padded);
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the Microsoft `provider_token` from the user record. Supabase stores
 * the raw OAuth provider token under `raw_app_meta_data.provider_token` (and
 * historically under `raw_user_meta_data` in some versions). We try both.
 */
function extractProviderToken(user: HookUser): unknown {
  const appMeta = user.raw_app_meta_data;
  if (appMeta && typeof appMeta === "object") {
    const candidate = (appMeta as Record<string, unknown>)["provider_token"];
    if (candidate !== undefined) return candidate;
  }
  const userMeta = user.raw_user_meta_data;
  if (userMeta && typeof userMeta === "object") {
    const candidate = (userMeta as Record<string, unknown>)["provider_token"];
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/** Narrow an arbitrary value to `string` if it is a non-empty string. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Pull the Microsoft claims we care about out of a decoded JWT payload. */
function pickMicrosoftClaims(
  payload: Record<string, unknown> | null,
): MicrosoftClaims {
  if (!payload) return {};
  return {
    tid: asString(payload["tid"]),
    oid: asString(payload["oid"]),
    name: asString(payload["name"]),
    email: asString(payload["email"]),
    preferred_username: asString(payload["preferred_username"]),
  };
}

export default async function beforeIssueToken(
  payload: HookPayload,
): Promise<HookResponse> {
  const existingClaims: Record<string, unknown> =
    payload.claims && typeof payload.claims === "object"
      ? { ...payload.claims }
      : {};

  // If anything is malformed, return claims unchanged. The Postgres-level
  // provisioning function will reject (per FC-1) any session lacking `tid` /
  // `oid`, so failing closed at the DB layer is safe.
  if (!payload.user || typeof payload.user !== "object") {
    return { claims: existingClaims };
  }

  const providerToken = extractProviderToken(payload.user);
  const decoded = decodeJwtPayload(providerToken);
  const ms = pickMicrosoftClaims(decoded);

  // Merge: preserve any existing app_metadata, then layer the Microsoft claims
  // on top (under the `app_metadata` namespace which is server-trusted).
  const existingAppMeta =
    existingClaims["app_metadata"] &&
    typeof existingClaims["app_metadata"] === "object"
      ? (existingClaims["app_metadata"] as Record<string, unknown>)
      : {};

  const nextAppMeta: Record<string, unknown> = { ...existingAppMeta };
  if (ms.tid !== undefined) nextAppMeta["tid"] = ms.tid;
  if (ms.oid !== undefined) nextAppMeta["oid"] = ms.oid;
  if (ms.name !== undefined) nextAppMeta["name"] = ms.name;
  if (ms.email !== undefined) nextAppMeta["email"] = ms.email;
  if (ms.preferred_username !== undefined) {
    nextAppMeta["preferred_username"] = ms.preferred_username;
  }

  // Also expose `tid` as a top-level claim because research §R-3 specifies
  // `auth.jwt() ->> 'tid'` (top-level) for the tenant check, while `oid` is
  // accessed via `auth.jwt() -> 'app_metadata' ->> 'oid'`.
  const nextClaims: Record<string, unknown> = {
    ...existingClaims,
    app_metadata: nextAppMeta,
  };
  if (ms.tid !== undefined) nextClaims["tid"] = ms.tid;

  return { claims: nextClaims };
}
