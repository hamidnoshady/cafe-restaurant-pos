import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tradeGoodsItemSellPost } from "@/lib/trade-goods-routes";

const writeGuard = () => requirePermission(PERMISSIONS.ordersCreate);

export const POST = tradeGoodsItemSellPost("tools_fittings", writeGuard);
