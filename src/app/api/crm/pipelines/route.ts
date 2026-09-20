import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import {
  defaultPipeline,
  listPipelines,
  pipelineVelocity,
  savePipelineStages,
  type SaveStageInput,
} from "@/lib/crm-pipeline-service";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";

/**
 * Pipelines and their stages — «قیف فروش».
 *
 * Stages are rows, not a hardcoded enum, because every business sells
 * differently: a jeweller has «ارزیابی» and «سفارش ساخت» where a café has
 * neither. The enum version of this shipped first and the first question
 * anyone asked was how to rename a stage.
 *
 * What makes renaming safe is that reporting keys on each stage's `outcome`
 * (open / won / lost), never on its name. Rename «برنده» to «فروخته شد» and
 * every historical win rate still means the same thing — which is the property
 * that makes a configurable pipeline more than a way to break your own
 * reports.
 */

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const search = request.nextUrl.searchParams;

  if (search.get("velocity") === "1") {
    const pipelineId = search.get("pipelineId");
    if (pipelineId && !isUuid(pipelineId)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const target = pipelineId ?? (await defaultPipeline(session.businessId))?.id;
    if (!target) return NextResponse.json({ velocity: [] });
    return NextResponse.json({ velocity: await pipelineVelocity(session.businessId, target) });
  }

  // Entering through defaultPipeline, not listPipelines: it lazily seeds the
  // default pipeline for a business that has none. Migration 0157 only
  // backfilled businesses that existed when it ran, and there are three
  // separate provisioning paths that create businesses — self-healing on read
  // is the only version of this that cannot be forgotten by a fourth one.
  await defaultPipeline(session.businessId);
  const pipelines = await listPipelines(session.businessId);
  return NextResponse.json({ pipelines });
});

interface StagesBody {
  pipelineId?: string;
  stages?: {
    id?: string;
    name?: string;
    outcome?: string;
    defaultProbability?: number;
    displayOrder?: number;
    isActive?: boolean;
    requirementNote?: string;
  }[];
}

export const POST = withTenantScope(async (request: NextRequest) => {
  // crmConfigure, not crmManage: reshaping the stage list changes how every
  // historical deal is reported. Working a deal and redesigning the board are
  // different kinds of trust.
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  let body: StagesBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const pipelineId = body.pipelineId;
  if (!pipelineId || !isUuid(pipelineId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!Array.isArray(body.stages) || body.stages.length === 0) {
    return NextResponse.json({ error: "stages_required" }, { status: 400 });
  }

  const stages: SaveStageInput[] = [];
  for (const raw of body.stages) {
    const name = raw.name?.trim();
    if (!name) return NextResponse.json({ error: "stage_name_required" }, { status: 400 });
    if (raw.outcome !== "open" && raw.outcome !== "won" && raw.outcome !== "lost") {
      return NextResponse.json({ error: "stage_outcome_invalid" }, { status: 400 });
    }
    const probability = Number(raw.defaultProbability ?? 0);
    if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
      return NextResponse.json({ error: "stage_probability_invalid" }, { status: 400 });
    }
    if (raw.id !== undefined && !isUuid(raw.id)) {
      return NextResponse.json({ error: "stage_not_found" }, { status: 400 });
    }
    stages.push({
      id: raw.id,
      name,
      outcome: raw.outcome,
      defaultProbability: Math.round(probability),
      // Position in the submitted array is the board order. Trusting an
      // explicit displayOrder from the client means two stages can claim the
      // same slot; the array already expresses the order unambiguously.
      displayOrder: stages.length + 1,
      isActive: raw.isActive !== false,
      requirementNote: raw.requirementNote,
    });
  }

  const result = await savePipelineStages(
    session.businessId,
    pipelineId,
    stages,
    { name: session.fullName, userId: session.sub },
  );

  if (result.error || !result.pipeline) {
    // `stage_in_use` is a 409, not a 400: the request was well-formed and the
    // user is entitled to make it — the conflict is with data that exists.
    // Deleting a stage that still holds deals would orphan them, so the
    // service refuses and names the stage so the UI can say which.
    const status =
      result.error === "not_found" ? 404 : result.error === "stage_in_use" ? 409 : 400;
    return NextResponse.json({ error: result.error ?? "not_found" }, { status });
  }

  return NextResponse.json({ pipeline: result.pipeline });
});
