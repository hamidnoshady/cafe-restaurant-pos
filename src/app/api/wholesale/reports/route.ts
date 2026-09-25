import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tradeGoodsReportsGet } from "@/lib/trade-goods-routes";

const readGuard = () => requirePermission(PERMISSIONS.reportsView);

export const GET = tradeGoodsReportsGet("wholesale", readGuard);
