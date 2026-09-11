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
## 2026-08-17 - [Secure Randomness in Barcode Generation]
**Vulnerability:** Weak random number generation using `Math.random()` for generating internal barcode payload numbers.
**Learning:** `Math.random()` does not provide cryptographically secure entropy, making internal barcode values predictable and increasing the likelihood of collisions.
**Prevention:** Use `randomInt()` from `node:crypto` for numeric values (and `crypto.randomUUID()` for string identifiers) instead of `Math.random()` for operations requiring unique and unpredictable values.
## 2026-08-20 - Prevent X-Forwarded-For IP Spoofing
**Vulnerability:** IP spoofing via X-Forwarded-For header by trusting the left-most or right-most IP.
**Learning:** In multi-proxy setups without explicit trusted proxies, the right-most IP might erroneously target an internal proxy, but blindly trusting the left-most IP introduces a critical spoofing vulnerability. If an attacker sends a crafted header, the spoofed IP is picked.
**Prevention:** Parse X-Forwarded-For from right to left, checking against private/local network ranges, and select the first public IP.

## 2024-05-18 - Client IP Extraction Spoofing via X-Forwarded-For
**Vulnerability:** `clientIpFrom` in rate limiting trusted proxy counts and unconditionally picked the IP `N` hops away from the right, or the left-most IP. This allowed attackers to append spoofed IPs and bypass rate limiting or log fake IPs.
**Learning:** In environments without strictly configured explicit trusted proxy IPs, picking the left-most or relying on a static hop count is dangerous because intermediate proxies might append to `x-forwarded-for` blindly.
**Prevention:** To reliably get the client IP, iterate the `x-forwarded-for` header right-to-left and pick the first public (non-private) IP.
## 2025-02-28 - Secure Client IP Extraction
**Vulnerability:** Directly extracting `x-forwarded-for` header can allow an attacker to spoof their IP address.
**Learning:** Blindly trusting the `x-forwarded-for` or `x-real-ip` headers can lead to IP address spoofing vulnerabilities.
**Prevention:** Instead of reading the header blindly, use a centralized IP extraction mechanism (e.g. `clientIpFrom`) that securely navigates proxy chains and validates IPs.
## 2026-08-25 - Off-by-one IP Spoofing via X-Forwarded-For Trusted Hops
**Vulnerability:** Rate limiter `clientIpFrom` index calculation had an off-by-one error `parts.length - 1 - trustedHops`, resolving to the IP before the actual client IP.
**Learning:** When navigating `X-Forwarded-For` from right-to-left based on a `trustedHops` count, the correct index of the first untrusted IP is `parts.length - trustedHops`. Off-by-one errors here mean the system trusts an attacker-provided proxy IP instead of locking onto the true client, effectively granting IP spoofing capabilities even when `trustedHops` is correctly configured.
**Prevention:** When skipping N trusted proxies in `X-Forwarded-For` arrays, index by `length - N` to find the last untrusted origin.
