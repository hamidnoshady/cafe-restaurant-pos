import { WorkspacePageBody } from "./workspace-page-body";

/**
 * `/workspace` — «میز کار من».
 *
 * The module home is the overview, rendered here rather than redirected to
 * `/workspace/overview`: the overview IS the home, and a home that bounces
 * costs every visitor a round trip to reach the screen they asked for. The
 * section routes beside this file answer for the other nine.
 */
export default async function WorkspaceHomePage() {
  return <WorkspacePageBody section="overview" />;
}
