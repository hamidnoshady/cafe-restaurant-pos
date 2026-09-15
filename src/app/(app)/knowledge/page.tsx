import { KnowledgeBrowser } from "@/app/dashboard/knowledge/kb-browser";

/**
 * «مرکز آموزش» — the member-facing half of the knowledge base (migration
 * 0131). The super-admin writes the content in the console; this page is
 * where every member reads it: full-text search, the category side menu, tag
 * filtering, and deep-linkable guides (text, images, video and code, with
 * anchored headings).
 *
 * The page itself is thin: server-side it only unwraps search params (the
 * `?tag=` a tag chip carries); the browser owns the catalogue once mounted.
 */
export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tag = typeof params.tag === "string" ? params.tag : "";
  return <KnowledgeBrowser initialTag={tag} />;
}
