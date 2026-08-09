## 2025-02-12 - Predictable ID Generation using Math.random()
**Vulnerability:** Found multiple uses of `Math.random()` to generate unique IDs (`uid` functions) and React list keys.
**Learning:** `Math.random()` is not cryptographically secure and can lead to predictable IDs, which might cause ID collisions or be exploitable if the IDs are used for security-sensitive operations (e.g., session identifiers, secret tokens, or action auditing IDs).
**Prevention:** Always use `crypto.randomUUID()` for generating unique, unpredictable identifiers.