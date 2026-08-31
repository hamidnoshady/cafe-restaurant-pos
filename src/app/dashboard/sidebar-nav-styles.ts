/**
 * One button skin for every entry in the dashboard's navigation column — the
 * workspace rail, the classic flat nav, and an app's own main sidebar.
 *
 * It lives apart from `dashboard-sidebar.tsx` because an app's nav component
 * (e.g. `growth/growth-app-nav.tsx`) has to wear it too, and importing the shell
 * that imports the app would close a cycle. Amber is selection
 * (docs/design-system.md §Colour roles), so all three menus agree on what
 * "you are here" looks like.
 */
export const APP_NAV_BUTTON_CLASS =
  "min-h-12 rounded-xl text-foreground/80 hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300 data-[active=true]:bg-amber-100 data-[active=true]:font-semibold data-[active=true]:text-amber-700";
