import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createScheduledExport,
  listScheduledExports,
} from "@/lib/data-transfer/schedule-service";
import type { ExportFormat, ScheduleFrequency } from "@/lib/data-transfer/types";
import { dataOwner, entityAccess, handleDataError, PERMISSIONS, readBody } from "../guard";

/**
 * Scheduled exports — «فروش روزانه»، «مشتریان هفتگی»، «حسابداری ماهانه».
 *
 * A schedule is a standing instruction to read the business's data and email
 * it out, so creating one needs the same entity permission a manual export of
 * the same entity needs. Checked here at creation AND again when the scheduler
 * runs it, because a permission can be revoked after the schedule exists.
 */

const FORMATS: ExportFormat[] = ["csv", "xlsx", "pdf", "json"];
const FREQUENCIES: ScheduleFrequency[] = ["daily", "weekly", "monthly"];

export const GET = withTenantScope(async () => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
  if (error) return error;
  try {
    return NextResponse.json({ schedules: await listScheduledExports(owner.businessId) });
  } catch (err) {
    return handleDataError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
  if (error) return error;

  try {
    const body = await readBody(request);
    const { entity, error: entityError } = await entityAccess(
      owner,
      typeof body.entity === "string" ? body.entity : null,
      "export",
    );
    if (entityError) return entityError;

    const format = (FORMATS.includes(body.format as ExportFormat) ? body.format : "xlsx") as ExportFormat;
    const frequency = (
      FREQUENCIES.includes(body.frequency as ScheduleFrequency) ? body.frequency : "daily"
    ) as ScheduleFrequency;

    const locationId = entity.locationScoped
      ? (await resolveActiveLocation(owner.session))?.id ?? null
      : owner.locationId;

    const schedule = await createScheduledExport({
      businessId: owner.businessId,
      locationId,
      entityKey: entity.key,
      name: String(body.name ?? ""),
      format,
      frequency,
      hourLocal: typeof body.hourLocal === "number" ? body.hourLocal : 7,
      weekday: typeof body.weekday === "number" ? body.weekday : null,
      dayOfMonth: typeof body.dayOfMonth === "number" ? body.dayOfMonth : null,
      fields: Array.isArray(body.fields)
        ? (body.fields as unknown[]).filter((f): f is string => typeof f === "string")
        : [],
      filters:
        body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
          ? (body.filters as Record<string, unknown>)
          : {},
      deliverEmail: typeof body.deliverEmail === "string" ? body.deliverEmail : "",
      deliverStore: body.deliverStore !== false,
      actorUserId: owner.actorUserId,
    });
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (err) {
    return handleDataError(err);
  }
});
