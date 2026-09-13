/**
 * Reading a nav list that has depth.
 *
 * Phase 42 gave the dashboard nav collapsible groups («محصولات» and its
 * sub-sections), but the three surfaces that *consume* the nav kept reading
 * only its top level: the mobile header titled a sub-section's page
 * «داشبورد», the bottom-bar picker could not offer a sub-section at all, and a
 * sub-section pinned by hand was filtered straight back out of the bar as "not
 * a page you can see". One flatten, used by all three.
 *
 * Framework-free on purpose, like `bottom-nav.ts` and `app-shells.ts` beside
 * it: the rules are unit-testable and the sidebar can import them without
 * dragging a client component into a test.
 */

/** The shape both the dashboard nav and an app's own menu satisfy. */
export interface NavNode {
  href?: string;
  children?: NavNode[];
}

/** Every entry that has an href, parents and children alike, in menu order. */
export function flattenNav<T extends NavNode>(items: T[]): (T & { href: string })[] {
  return items.flatMap((item) => [
    ...(item.href ? [item as T & { href: string }] : []),
    ...(item.children ? (flattenNav(item.children as T[]) as (T & { href: string })[]) : []),
  ]);
}

/**
 * Which of `items` is the page you are on — the *longest* matching href.
 *
 * "First match wins" is what made the mobile header call «/dashboard/products/prices»
 * by the name of «/dashboard/products», and what lit two tabs of the bottom bar
 * at once when a member pinned both a section and one of its pages. The longest
 * match is the most specific one, which is always the answer.
 */
export function bestNavMatch<T extends NavNode & { href: string }>(
  items: T[],
  isMatch: (href: string) => boolean,
): T | undefined {
  return items
    .filter((item) => isMatch(item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
