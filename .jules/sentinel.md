## 2025-02-28 - Insecure ID Generation
**Vulnerability:** Use of `Math.random().toString(36).slice(2)` for generating IDs (e.g. Chat Messages, Cart Items).
**Learning:** `Math.random()` does not provide cryptographically secure entropy, making identifiers predictable and increasing the risk of ID collisions across sessions or concurrent users.
**Prevention:** Use `crypto.randomUUID()` to generate standard, cryptographically secure UUIDv4 identifiers.
