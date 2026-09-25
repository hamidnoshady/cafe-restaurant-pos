import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tradeGoodsItemsGet, tradeGoodsItemsPost } from "@/lib/trade-goods-routes";

const readGuard = () => requirePermission(PERMISSIONS.inventoryView);
const writeGuard = () => requirePermission(PERMISSIONS.inventoryAdjust);

export const GET = tradeGoodsItemsGet("tools_fittings", readGuard);
export const POST = tradeGoodsItemsPost("tools_fittings", writeGuard);
