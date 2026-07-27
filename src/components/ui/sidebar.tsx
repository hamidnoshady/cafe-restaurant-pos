"use client";

import * as React from "react";
import { Slot } from "radix-ui";
import { MenuIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type SidebarState = "expanded" | "collapsed";

type SidebarContextValue = {
  state: SidebarState;
  isMobile: boolean;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider");
  return context;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const [isMobile, setIsMobile] = React.useState(false);
  const [openMobile, setOpenMobile] = React.useState(false);
  const open = openProp ?? internalOpen;

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (openProp === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, openProp],
  );

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) {
      setOpenMobile((value) => !value);
      return;
    }
    setOpen(!open);
  }, [isMobile, open, setOpen]);

  return (
    <TooltipProvider>
      <SidebarContext.Provider
        value={{
          state: open ? "expanded" : "collapsed",
          isMobile,
          openMobile,
          setOpenMobile,
          toggleSidebar,
        }}
      >
        <div className={cn("contents", className)} {...props}>
          {children}
        </div>
      </SidebarContext.Provider>
    </TooltipProvider>
  );
}

function Sidebar({
  side = "right",
  className,
  children,
  ...props
}: React.ComponentProps<"aside"> & { side?: "left" | "right" }) {
  const { state, isMobile, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent side={side} showCloseButton className="w-72 p-0">
          <aside className={cn("flex h-full flex-col bg-sidebar text-sidebar-foreground", className)} {...props}>
            {children}
          </aside>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      data-slot="sidebar"
      data-state={state}
      className={cn(
        "group/sidebar relative hidden h-screen shrink-0 flex-col overflow-hidden border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex",
        state === "expanded" ? "w-64" : "w-16",
        className,
      )}
      {...props}
    >
      {children}
    </aside>
  );
}

function SidebarTrigger({ className, ...props }: React.ComponentProps<typeof Button>) {
  const { state, isMobile, toggleSidebar } = useSidebar();
  const label = isMobile
    ? "باز کردن منو"
    : state === "expanded"
      ? "جمع کردن نوار کناری"
      : "باز کردن نوار کناری";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      className={cn("min-h-11 min-w-11", className)}
      onClick={toggleSidebar}
      {...props}
    >
      {isMobile ? <MenuIcon /> : state === "expanded" ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
    </Button>
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("border-b border-sidebar-border p-4", className)} {...props} />;
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("min-h-0 flex-1 overflow-y-auto p-3", className)} {...props} />;
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("border-t border-sidebar-border p-4", className)} {...props} />;
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("space-y-1", className)} {...props} />;
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={className} {...props} />;
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  tooltip,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string;
}) {
  const { state, isMobile } = useSidebar();
  const Comp = asChild ? Slot.Root : "button";
  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive || undefined}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-sidebar-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-2",
        className,
      )}
      {...props}
    >
      {children}
    </Comp>
  );

  if (!tooltip || isMobile || state === "expanded") return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="left" sideOffset={8}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
};
