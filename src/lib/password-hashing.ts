/**
 * The one place that decides how strong a stored credential hash is.
 *
 * Every password, staff PIN, employee shared secret and MFA recovery code in
 * this app is bcrypt, and every one of them used to pass a literal `10` at its
 * own call site — eleven of them, so raising the factor meant finding all
 * eleven and a missed one would have been invisible.
 *
 * 12 rather than 10: the cost is a power of two, so 12 is four times the work
 * of 10 for an offline attacker holding a stolen `platform_users` dump, and
 * still well under 100ms on the hardware this runs on — a cost paid once per
 * login, never per request. It matters most for the short secrets: a 4-digit
 * PIN has ~13 bits of entropy and its only real defence against an offline
 * attack is the hash's own cost.
 *
 * Raising this is safe and needs no migration. bcrypt stores the cost inside
 * the hash, so `bcrypt.compare` keeps verifying every credential written at
 * the old factor; each one moves up the next time it is set.
 */
export const BCRYPT_COST = 12;
