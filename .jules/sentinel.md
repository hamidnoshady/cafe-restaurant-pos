## 2025-02-28 - Insecure ID Generation
**Vulnerability:** Use of `Math.random().toString(36).slice(2)` for generating IDs (e.g. Chat Messages, Cart Items).
**Learning:** `Math.random()` does not provide cryptographically secure entropy, making identifiers predictable and increasing the risk of ID collisions across sessions or concurrent users.
**Prevention:** Use `crypto.randomUUID()` to generate standard, cryptographically secure UUIDv4 identifiers.

## 2023-10-25 - IP Spoofing via X-Forwarded-For
**Vulnerability:** Extracted IP address from `x-forwarded-for` header by blindly taking the left-most value, which is spoofable and bypasses rate limits.
**Learning:** `x-forwarded-for` headers can be manipulated by clients. When splitting this header, the real IP is appended by trusted proxies on the right side. Taking the left-most value allows attackers to spoof their IP simply by supplying an arbitrary IP in the header.
**Prevention:** Prefer extracting IP from `request.ip` or `x-real-ip`. If using `x-forwarded-for`, always take the right-most value to prevent IP spoofing, or properly validate against known trusted proxy IP addresses.
