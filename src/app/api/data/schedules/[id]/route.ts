import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteScheduledExport,
  listScheduledExports,
  runScheduledExport,
  updateScheduledExport,
} from "@/lib/data-transfer/schedule-service";
import type { ExportFormat, ScheduleFrequency } from "@/lib/data-transfer/types";
import { dataOwner, entityAccess, handleDataError, PERMISSIONS, readBody } from "../../guard";

/** Edit (PATCH), run now (POST) or delete (DELETE) one scheduled export. */

async function loadSchedule(businessId: string, id: string) {
  const schedules = await listScheduledExports(businessId);
  return schedules.find((schedule) => schedule.id === id) ?? null;
}

export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
    if (error) return error;
    try {
      const { id } = await params;
      const existing = await loadSchedule(owner.businessId, id);
      if (!existing) return NextResponse.json({ error: "schedule_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(owner, existing.entityKey, "export");
      if (entityError) return entityError;

      const body = await readBody(request);
      const schedule = await updateScheduledExport(owner.businessId, id, {
        name: typeof body.name === "string" ? body.name : undefined,
        format: typeof body.format === "string" ? (body.format as ExportFormat) : undefined,
        frequency:
          typeof body.frequency === "string"
            ? (body.frequency as ScheduleFrequency)
            : undefined,
        hourLocal: typeof body.hourLocal === "number" ? body.hourLocal : undefined,
        weekday: typeof body.weekday === "number" ? body.weekday : undefined,
        dayOfMonth: typeof body.dayOfMonth === "number" ? body.dayOfMonth : undefined,
        fields: Array.isArray(body.fields)
          ? (body.fields as unknown[]).filter((f): f is string => typeof f === "string")
          : undefined,
        filters:
          body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
            ? (body.filters as Record<string, unknown>)
            : undefined,
        deliverEmail: typeof body.deliverEmail === "string" ? body.deliverEmail : undefined,
        deliverStore: typeof body.deliverStore === "boolean" ? body.deliverStore : undefined,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      });
      return NextResponse.json({ schedule });
    } catch (err) {
      return handleDataError(err);
    }
  },
);

export const POST = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
    if (error) return error;
    try {
      const { id } = await params;
      const existing = await loadSchedule(owner.businessId, id);
      if (!existing) return NextResponse.json({ error: "schedule_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(owner, existing.entityKey, "export");
      if (entityError) return entityError;

      // «اجرای دستی» runs exactly the code the scheduler runs — a "run now"
      // that took a different path would test nothing about the scheduled one.
      const result = await runScheduledExport(owner.businessId, id);
      return NextResponse.json(result);
    } catch (err) {
      return handleDataError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
    if (error) return error;
    try {
      const { id } = await params;
      const existing = await loadSchedule(owner.businessId, id);
      if (!existing) return NextResponse.json({ error: "schedule_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(owner, existing.entityKey, "export");
      if (entityError) return entityError;
      return NextResponse.json({ ok: await deleteScheduledExport(owner.businessId, id) });
    } catch (err) {
      return handleDataError(err);
    }
  },
);
