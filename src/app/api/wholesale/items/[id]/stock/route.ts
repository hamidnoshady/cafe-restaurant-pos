import { requireRole } from "@/lib/auth";
import { tradeGoodsItemStockPost } from "@/lib/trade-goods-routes";

const writeGuard = () => requireRole("owner", "manager");

export const POST = tradeGoodsItemStockPost("wholesale", writeGuard);
