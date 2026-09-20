import type { ReactNode } from "react";
import { FeatureLock } from "@/components/feature-lock";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { AiWorkspaceSubnav } from "./ai-workspace-subnav";

/**
 * The shared frame every AI Workspace management page draws (Phase I): the
 * feature lock the whole workspace sits behind, the page shell, the shared
 * section strip so the sections read as one product, and a header. Each page
 * supplies only its title, help line and body — so a new section is a page plus
 * a registry entry, and the chrome never drifts between them.
 */
export function AiWorkspacePage({
  locked,
  title,
  description,
  children,
}: {
  locked: boolean;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <FeatureLock locked={locked} title="دستیار هوشمند">
      <PageShell>
        <AiWorkspaceSubnav />
        <div className="mt-4">
          <PageHeader title={title} description={description} />
          {children}
        </div>
      </PageShell>
    </FeatureLock>
  );
}
