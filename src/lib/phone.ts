export function normalizePhone(phone: string): string | null {
  // Convert Persian/Arabic digits to Latin
  let latin = phone.replace(/[۰-۹]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 1728));
  latin = latin.replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 1584));

  // Remove whitespace, dashes, parens
  latin = latin.replace(/[\s\-\(\)]/g, "");

  // Must end in 9 followed by 9 digits
  const match = latin.match(/(?:^|\+|00)?(?:98|0)?(9\d{9})$/);
  if (!match) return null;
  return `+98${match[1]}`;
}
