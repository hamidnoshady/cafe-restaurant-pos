import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "./sidebar";

describe("SidebarProvider", () => {
  test("renders a collapsed menu button with a tooltip without requiring callers to add a tooltip provider", () => {
    const collapsedMenu = createElement(
      SidebarProvider,
      { open: false },
      createElement(
        Sidebar,
        null,
        createElement(
          SidebarContent,
          null,
          createElement(
            SidebarMenu,
            null,
            createElement(
              SidebarMenuItem,
              null,
              createElement(SidebarMenuButton, { tooltip: "داشبورد" }, "داشبورد"),
            ),
          ),
        ),
      ),
    );

    expect(() => renderToStaticMarkup(collapsedMenu)).not.toThrow();
  });
});
