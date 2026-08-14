## 2025-02-28 - Insecure ID Generation
**Vulnerability:** Use of `Math.random().toString(36).slice(2)` for generating IDs (e.g. Chat Messages, Cart Items).
**Learning:** `Math.random()` does not provide cryptographically secure entropy, making identifiers predictable and increasing the risk of ID collisions across sessions or concurrent users.
**Prevention:** Use `crypto.randomUUID()` to generate standard, cryptographically secure UUIDv4 identifiers.

## 2026-08-14 - Insecure ID Generation in POS Cart Lines
**Vulnerability:** Use of `Math.random().toString(36).slice(2)` for generating cart line keys in `src/app/dashboard/pos/retail-invoice-screen.tsx`.
**Learning:** `Math.random()` lacks cryptographically secure entropy, which makes cart line identifiers predictable and increases the risk of ID collisions in concurrent browser sessions.
**Prevention:** Use `crypto.randomUUID()` in React clients when generating unique keys for lists or payloads.

## 2026-08-12 - Next.js Middleware Platform Authentication Bypass
**Vulnerability:** A hardcoded `NextResponse.next()` bypass was incorrectly placed before the `PLATFORM_SESSION_COOKIE` verification logic for any path starting with `/api/platform`.
**Learning:** Early returns in authentication middleware functions bypass critical security checks, allowing unauthenticated requests to access super-admin platform routes.
**Prevention:** Always verify token and establish session before returning `NextResponse.next()` for protected API route prefixes.
