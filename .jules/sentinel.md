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

## 2025-02-28 - Platform Audit Silently Failing
**Vulnerability:** Audit log insertions failing silently because `try-catch` swallowed the error.
**Learning:** For a secure audit trail, logging failures must be loud. If an audit log insertion fails, the overall transaction/request must fail to prevent actions from occurring without a trace.
**Prevention:** Remove `try-catch` blocks around critical audit logging statements. Let exceptions propagate to abort the transaction.

## 2023-10-25 - IP Spoofing via X-Forwarded-For
**Vulnerability:** Extracted IP address from `x-forwarded-for` header by blindly taking the left-most value, which is spoofable and bypasses rate limits.
**Learning:** `x-forwarded-for` headers can be manipulated by clients. When splitting this header, the real IP is appended by trusted proxies on the right side. Taking the left-most value allows attackers to spoof their IP simply by supplying an arbitrary IP in the header.
**Prevention:** Prefer extracting IP from `request.ip` or `x-real-ip`. If using `x-forwarded-for`, always take the right-most value to prevent IP spoofing, or properly validate against known trusted proxy IP addresses.
