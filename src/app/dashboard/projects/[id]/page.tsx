"use client";

import { DashboardPageSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  StickyNoteIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader, PageShell, SectionCard, cardClass } from "../../page-chrome";
import { api, inputClass } from "../../ui";
import {
  PROJECT_INSTRUCTION_CHAR_LIMIT,
  instructionWeight,
} from "@/lib/ai-projects-shared";

interface Project {
  id: string;
  name: string;
  instructions: string;
  createdBy: string;
  archivedAt: string | null;
  createdAt: string;
}

interface Note {
  id: string;
  projectId: string;
  title: string;
  content: string;
  createdBy: string;
  createdAt: string;
}

interface Conversation {
  id: string;
  mode: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
  projectId: string | null;
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState("");
  const [showAddNote, setShowAddNote] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [projRes, notesRes, convsRes] = await Promise.all([
      api<{ project: Project }>(`/api/ai/projects/${id}`),
      api<{ notes: Note[] }>(`/api/ai/projects/${id}/notes`),
      api<{ conversations: Conversation[] }>(`/api/ai/conversations?limit=50`),
    ]);
    if (projRes.ok) setProject(projRes.data.project);
    if (notesRes.ok) setNotes(notesRes.data.notes);
    if (convsRes.ok) {
      setConversations(
        convsRes.data.conversations.filter((c: Conversation) => c.projectId === id),
      );
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSaveInstructions() {
    setError("");
    const { ok, data } = await api<{ project: Project }>(
      `/api/ai/projects/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ instructions: instructionsDraft }),
      },
    );
    if (ok) {
      setProject(data.project);
      setEditingInstructions(false);
    } else {
      const err = data as unknown as Record<string, string>;
      setError(err.error ?? "خطا در ذخیره");
    }
  }

  async function handleAddNote() {
    const title = noteTitle.trim();
    if (!title) return;
    setError("");
    const { ok, data } = await api<{ note: Note }>(
      `/api/ai/projects/${id}/notes`,
      {
        method: "POST",
        body: JSON.stringify({ title, content: noteContent }),
      },
    );
    if (ok) {
      setNotes((prev) => [...prev, data.note]);
      setNoteTitle("");
      setNoteContent("");
      setShowAddNote(false);
    } else {
      const err = data as unknown as Record<string, string>;
      setError(err.error ?? "خطا در افزودن یادداشت");
    }
  }

  async function handleDeleteNote(noteId: string) {
    await api(`/api/ai/projects/${id}/notes/${noteId}`, { method: "DELETE" });
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
  }

  if (!project) return <DashboardPageSkeleton />;

  const titlesWeight = notes.map((n) => n.title);
  const currentWeight = instructionWeight(project.instructions, titlesWeight);
  const remaining = PROJECT_INSTRUCTION_CHAR_LIMIT - currentWeight;

  return (
    <PageShell className="pb-6">
      <PageHeader
        title={project.name}
        description={project.instructions || undefined}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/projects">
              <Button variant="outline" size="sm">
                <ArrowRightIcon className="size-4 rtl:rotate-180" />
                بازگشت
              </Button>
            </Link>
            <Button
              size="sm"
              onClick={() =>
                router.push(`/dashboard?ctx=پروژه: ${project.name}`)
              }
            >
              <MessageSquareIcon className="size-4" />
              گفت‌وگوی جدید
            </Button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          {/* Instructions */}
          <SectionCard
            title="دستور ایستا"
            description="این دستور در متن راهنمای همهٔ گفت‌وگوهای این پروژه می‌نشیند."
            actions={
              !editingInstructions ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setInstructionsDraft(project.instructions);
                    setEditingInstructions(true);
                  }}
                >
                  <PencilIcon className="size-3" />
                  ویرایش
                </Button>
              ) : undefined
            }
          >
            <div className="p-4">
              {editingInstructions ? (
                <div className="space-y-3">
                  <textarea
                    value={instructionsDraft}
                    onChange={(e) => setInstructionsDraft(e.target.value)}
                    rows={6}
                    className={inputClass}
                    placeholder="دستور ایستای پروژه…"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {remaining} نویسه باقی‌مانده
                    </span>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleSaveInstructions}>
                        <SaveIcon className="size-3" />
                        ذخیره
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingInstructions(false)}
                      >
                        انصراف
                      </Button>
                    </div>
                  </div>
                </div>
              ) : project.instructions ? (
                <p className="whitespace-pre-wrap text-sm">{project.instructions}</p>
              ) : (
                <p className="text-sm text-muted-foreground">هنوز دستوری تنظیم نشده.</p>
              )}
            </div>
          </SectionCard>

          {/* Conversations */}
          <SectionCard title={`گفت‌وگوها (${conversations.length})`}>
            <div className="p-4">
              {conversations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  هنوز گفت‌وگویی در این پروژه نیست.
                </p>
              ) : (
                <ul className="space-y-2">
                  {conversations.map((conv) => (
                    <li key={conv.id}>
                      <Link
                        href={`/dashboard?conversation=${conv.id}`}
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition hover:bg-muted/50"
                      >
                        <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{conv.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SectionCard>
        </div>

        {/* Notes sidebar */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              یادداشت‌ها ({notes.length})
            </h2>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddNote(true)}
            >
              <PlusIcon className="size-3" />
              یادداشت
            </Button>
          </div>

          {showAddNote && (
            <div className={`${cardClass} p-3`}>
              <input
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="عنوان یادداشت"
                className={`${inputClass} mb-2`}
                autoFocus
              />
              <textarea
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                rows={3}
                placeholder="متن یادداشت (اختیاری)"
                className={`${inputClass} mb-2`}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddNote} disabled={!noteTitle.trim()}>
                  ذخیره
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowAddNote(false);
                    setNoteTitle("");
                    setNoteContent("");
                  }}
                >
                  انصراف
                </Button>
              </div>
            </div>
          )}

          {notes.length === 0 && !showAddNote ? (
            <p className="text-xs text-muted-foreground">یادداشتی نیست.</p>
          ) : (
            <div className="space-y-2">
              {notes.map((note) => (
                <div
                  key={note.id}
                  className="group rounded-xl border border-border/80 bg-card p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <StickyNoteIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <h3 className="text-sm font-medium">{note.title}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteNote(note.id)}
                      className="rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                      title="حذف"
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  </div>
                  {note.content && (
                    <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">
                      {note.content}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
