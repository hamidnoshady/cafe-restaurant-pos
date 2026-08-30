import { requireRole } from "@/lib/auth";
import { tradeGoodsItemSellPost } from "@/lib/trade-goods-routes";

const writeGuard = () => requireRole("owner", "manager");

export const POST = tradeGoodsItemSellPost("wholesale", writeGuard);
