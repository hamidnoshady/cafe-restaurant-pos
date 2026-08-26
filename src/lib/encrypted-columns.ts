export const ENCRYPTED_COLUMNS: Record<string, Record<string, "Tier A" | "Tier B">> = {
  platform_ai_config: {
    api_key: "Tier A",
  },
  platform_update_config: {
    s3_secret_access_key: "Tier A",
  },
  customers: {
    phone: "Tier B",
    address: "Tier B",
    notes: "Tier B",
  },
  reservations: {
    customer_phone: "Tier B",
  }
};
