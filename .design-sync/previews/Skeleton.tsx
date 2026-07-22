import * as React from "react";
import { Skeleton } from "cafe-restaurant-pos";

export const MenuItemLoading = () => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 360, display: "flex", flexDirection: "column", gap: 12 }}>
    {[0, 1, 2].map((i) => (
      <div key={i} style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Skeleton style={{ width: 48, height: 48, borderRadius: 8 }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          <Skeleton style={{ height: 14, width: "60%" }} />
          <Skeleton style={{ height: 12, width: "35%" }} />
        </div>
        <Skeleton style={{ height: 14, width: 64 }} />
      </div>
    ))}
  </div>
);
