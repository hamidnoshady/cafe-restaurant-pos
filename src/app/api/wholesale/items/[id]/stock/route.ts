import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tradeGoodsItemStockPost } from "@/lib/trade-goods-routes";

const writeGuard = () => requirePermission(PERMISSIONS.inventoryAdjust);

export const POST = tradeGoodsItemStockPost("wholesale", writeGuard);
