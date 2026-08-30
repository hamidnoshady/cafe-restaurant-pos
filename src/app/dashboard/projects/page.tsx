"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  PlusIcon,
  StickyNoteIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { cardClass, EmptyState, PageHeader, PageShell, SectionCard } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";
import { api, inputClass } from "../ui";

interface Project {
  id: string;
  name: string;
  instructions: string;
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
  noteCount: number;
  conversationCount: number;
}

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const qs = showArchived ? "?archived=true" : "";
    api<{ projects: Project[] }>(`/api/ai/projects${qs}`).then(({ ok, data }) => {
      if (ok) setProjects(data.projects);
    });
  }, [showArchived]);

  useEffect(load, [load]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setError("");
    const { ok, data } = await api<{ project: Project }>("/api/ai/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (ok) {
      setNewName("");
      setCreating(false);
      router.push(`/dashboard/projects/${data.project.id}`);
    } else {
      const err = data as unknown as Record<string, string>;
      setError(err.error ?? "خطا در ساخت پروژه");
    }
  }

  async function handleArchive(id: string, archived: boolean) {
    const url = `/api/ai/projects/${id}${archived ? "?unarchive=true" : ""}`;
    await api(url, { method: "DELETE" });
    load();
  }

  const activeProjects = projects.filter((p) => !p.archivedAt);
  const archivedProjects = projects.filter((p) => p.archivedAt);

  return (
    <PageShell className="pb-6">
      <PageHeader
        title="پروژه‌ها"
        description="پوشه‌های هدف: گفت‌وگوها، یادداشت‌ها و دستور ایستا را کنار هم نگه دارید."
        actions={
          <>
            <KnowledgeHelpButton section="projects" />
            <Button onClick={() => setCreating(true)} size="sm">
              <PlusIcon className="size-4" />
              پروژه جدید
            </Button>
          </>
        }
      />

      {creating && (
        <SectionCard title="پروژه جدید">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="نام پروژه"
              className={inputClass}
              autoFocus
            />
            <div className="flex gap-2">
              <Button onClick={handleCreate} disabled={!newName.trim()}>
                ساخت
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setError("");
                }}
              >
                انصراف
              </Button>
            </div>
          </div>
          {error && <p className="px-4 pb-3 text-sm text-destructive">{error}</p>}
        </SectionCard>
      )}

      {activeProjects.length === 0 && !creating ? (
        <EmptyState>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <FolderIcon className="size-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">هنوز پروژه‌ای ندارید.</p>
            <Button variant="outline" onClick={() => setCreating(true)} size="sm">
              <PlusIcon className="size-4" />
              اولین پروژه را بسازید
            </Button>
          </div>
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {activeProjects.map((project) => (
            <Link
              key={project.id}
              href={`/dashboard/projects/${project.id}`}
              className={cn(
                cardClass,
                "group flex flex-col gap-2 p-4 transition hover:border-amber-300/60 hover:shadow-[0_2px_8px_rgb(41_37_36/0.06)]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <FolderOpenIcon className="size-5 shrink-0 text-amber-600" />
                  <h3 className="font-semibold text-stone-900">{project.name}</h3>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleArchive(project.id, false);
                  }}
                  className="rounded p-1 text-muted-foreground opacity-0 transition hover:bg-muted group-hover:opacity-100"
                  title="بایگانی"
                >
                  <ArchiveIcon className="size-4" />
                </button>
              </div>
              {project.instructions && (
                <p className="line-clamp-2 text-xs text-muted-foreground">{project.instructions}</p>
              )}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <MessageSquareIcon className="size-3" />
                  {project.conversationCount}
                </span>
                <span className="flex items-center gap-1">
                  <StickyNoteIcon className="size-3" />
                  {project.noteCount}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {archivedProjects.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArchiveIcon className="size-4" />
            {showArchived ? "مخفی‌کردن بایگانی" : `بایگانی (${archivedProjects.length})`}
          </button>
          {showArchived && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {archivedProjects.map((project) => (
                <div
                  key={project.id}
                  className="flex flex-col gap-2 rounded-2xl border border-stone-200/60 bg-muted/30 p-4 opacity-70"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
                      <h3 className="font-medium text-stone-700">{project.name}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleArchive(project.id, true)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted"
                      title="بازگردانی"
                    >
                      <ArchiveRestoreIcon className="size-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MessageSquareIcon className="size-3" />
                      {project.conversationCount}
                    </span>
                    <span className="flex items-center gap-1">
                      <StickyNoteIcon className="size-3" />
                      {project.noteCount}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
