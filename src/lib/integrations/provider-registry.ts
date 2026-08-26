/**
 * Phase 26 (issue #125) Wave 2 — the provider registry.
 *
 * `integration_connections.provider` used to be a single hard-coded value
 * (`'woocommerce'`), so every code path that consumed a connection could
 * assume the WooCommerce client. Phase 26 adds Holoo as a second provider; this
 * module is the single place that maps the provider string to the adapter that
 * knows how to talk to it, so no other file hard-codes a provider again.
 *
 * Adding a third provider (Sepidar, Hamkaran, …) means registering it here —
 * nowhere else in the integration layer needs to change.
 */
import type { ConnectionRow } from "./connections-service";

export const PROVIDER_WOOCOMMERCE = "woocommerce" as const;
export const PROVIDER_HOLOO = "holoo" as const;

export type ProviderId = typeof PROVIDER_WOOCOMMERCE | typeof PROVIDER_HOLOO;

/** Normalise a stored provider string to a typed ProviderId. */
export function providerIdFor(provider: string): ProviderId {
  if (provider === PROVIDER_HOLOO) return PROVIDER_HOLOO;
  return PROVIDER_WOOCOMMERCE;
}

/** A connection is a WooCommerce connection when its provider is not Holoo. */
export function isWooCommerce(connection: Pick<ConnectionRow, "provider">): boolean {
  return providerIdFor(connection.provider) === PROVIDER_WOOCOMMERCE;
}

export function isHoloo(connection: Pick<ConnectionRow, "provider">): boolean {
  return providerIdFor(connection.provider) === PROVIDER_HOLOO;
}

/** The provider string a new connection should be stored under. */
export function assertSupportedProvider(provider: string): ProviderId {
  if (provider !== PROVIDER_WOOCOMMERCE && provider !== PROVIDER_HOLOO) {
    throw new Error(`unsupported_provider: ${provider}`);
  }
  return provider;
}
