import { redirect } from "next/navigation";

/**
 * The assistant's old standalone address — a compatibility redirect.
 *
 * The assistant is the dashboard now: `/dashboard` is the chat home, the same
 * `AiChatHub` this page used to mount, and the management sections open there
 * as the `?aiPanel=` drawer. The deep-link parameters that meant anything on
 * this page travel with the redirect — `?conversation=` and `?ctx=` were read
 * by the hub then exactly as now, and `?project=` starts new turns inside the
 * same project workspace. `?aiPanel=` passes through untouched for the
 * section redirects beside this one.
 */
export default async function AiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const kept = new URLSearchParams();
  for (const key of ["conversation", "ctx", "project", "aiPanel"]) {
    const value = params[key];
    if (typeof value === "string" && value) kept.set(key, value);
  }
  const query = kept.toString();
  redirect(query ? `/dashboard?${query}` : "/dashboard");
}
