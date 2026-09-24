/**
 * The super-admin console's composed component kit — one import surface for the
 * platform-specific components built on top of the central design system
 * (`@/components/ui/**`). These do NOT reimplement generic primitives; they
 * compose them into the console's recurring operational patterns so all 16
 * sections share one visual language (task sections 4 + 26).
 */
export * from "./page-header";
export * from "./states";
export * from "./status-badge";
export * from "./stat";
export * from "./toolbar";
export * from "./pagination";
export * from "./data-table";
export * from "./detail-drawer";
export * from "./dialogs";
export * from "./secret-field";
export * from "./form";
export * from "./permission-gate";
