import { requireRole } from "@/lib/auth";
import { tradeGoodsItemsGet, tradeGoodsItemsPost } from "@/lib/trade-goods-routes";

const readGuard = () => requireRole("owner", "manager", "cashier");
const writeGuard = () => requireRole("owner", "manager");

export const GET = tradeGoodsItemsGet("tools_fittings", readGuard);
export const POST = tradeGoodsItemsPost("tools_fittings", writeGuard);
