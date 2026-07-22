import * as React from "react";
import {
  TooltipProvider, Tooltip, TooltipTrigger, TooltipContent, Button,
} from "cafe-restaurant-pos";
import { Printer } from "lucide-react";

export const Default = () => (
  <TooltipProvider>
    <div dir="rtl" style={{ padding: 48, display: "flex", justifyContent: "center", minHeight: 140 }}>
      <Tooltip open>
        <TooltipTrigger asChild>
          <Button size="icon" variant="outline" aria-label="چاپ رسید">
            <Printer />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">چاپ رسید آشپزخانه</TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);
