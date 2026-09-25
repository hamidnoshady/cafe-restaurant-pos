// @vitest-environment jsdom

/**
 * The crop tool inside the asset drawer (migration 0175's `/transform`
 * backend already existed; this is the drag-to-select UI on top of it).
 *
 * What matters is not that a rectangle is drawn but that the numbers it
 * produces are right: the operator drags in *displayed* CSS pixels over a
 * possibly-scaled-down `<img>`, and the request the drawer sends must be in
 * the image's *natural* pixels — the same space `applyMediaTransform`
 * measures server-side after its own EXIF auto-orient. A scale bug here would
 * silently crop the wrong region with no error to notice.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetDrawer, type AssetRow } from "./media-manager";

afterEach(cleanup);

function baseAsset(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset-1",
    folderId: null,
    kind: "image",
    fileName: "product.jpg",
    mimeType: "image/jpeg",
    byteSize: 12345,
    category: null,
    tags: [],
    aiStatus: "none",
    aiLabels: {},
    variant: "original",
    sourceAssetId: null,
    source: "upload",
    createdByAi: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A 400×200-natural image displayed at 200×100 — a plain 2× downscale, the
 * common case (a big upload shown small in the drawer). */
function stubImageGeometry(img: HTMLImageElement) {
  Object.defineProperty(img, "naturalWidth", { value: 400, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 200, configurable: true });
  Object.defineProperty(img, "clientWidth", { value: 200, configurable: true });
  Object.defineProperty(img, "clientHeight", { value: 100, configurable: true });
  img.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON() {} }) as DOMRect;
}

function drag(overlay: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  act(() => {
    overlay.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: from.x, clientY: from.y }),
    );
    overlay.dispatchEvent(
      new window.PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: to.x, clientY: to.y }),
    );
    overlay.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  });
}

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ message: "ok" }),
  });
}

describe("AssetDrawer crop tool", () => {
  it("hides the crop button for non-image assets", () => {
    render(
      <AssetDrawer
        asset={baseAsset({ kind: "document", mimeType: "application/pdf" })}
        folders={[]}
        collections={[]}
        enhancePriceRial={0}
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );
    expect(screen.queryByText("برش تصویر")).toBeNull();
  });

  it("keeps «اعمال برش» disabled until a real rectangle is drawn, then sends natural-pixel coordinates", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AssetDrawer
        asset={baseAsset()}
        folders={[]}
        collections={[]}
        enhancePriceRial={0}
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );

    const img = screen.getByAltText("product.jpg") as HTMLImageElement;
    stubImageGeometry(img);

    fireEvent.click(screen.getByText("برش تصویر"));
    const applyButton = screen.getByText("اعمال برش").closest("button")!;
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);

    const overlay = img.parentElement!;

    // A drag smaller than the 12px minimum must not arm the apply button —
    // an accidental click-and-release must not be treated as "crop everything".
    drag(overlay, { x: 10 + 20, y: 20 + 20 }, { x: 10 + 24, y: 20 + 22 });
    expect((applyButton as HTMLButtonElement).disabled).toBe(true);

    // Drag from displayed (30,20) to (110,70) inside a 200×100-displayed,
    // 400×200-natural image whose rect origin is (10,20): a clean 2× scale
    // puts the natural-pixel crop at (60,40) sized 160×100.
    drag(overlay, { x: 10 + 30, y: 20 + 20 }, { x: 10 + 110, y: 20 + 70 });
    expect((applyButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(applyButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/media/asset-1/transform",
      expect.objectContaining({ method: "POST" }),
    );
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/media/asset-1/transform");
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toEqual({ operation: "crop", params: { x: 60, y: 40, width: 160, height: 100 } });

    // Applying resets crop mode — the button set collapses back to "برش تصویر".
    expect(screen.queryByText("اعمال برش")).toBeNull();
    expect(screen.getByText("برش تصویر")).not.toBeNull();
  });

  it("«انصراف» discards the drawn rectangle without calling the API", () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AssetDrawer
        asset={baseAsset()}
        folders={[]}
        collections={[]}
        enhancePriceRial={0}
        onClose={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    );

    const img = screen.getByAltText("product.jpg") as HTMLImageElement;
    stubImageGeometry(img);

    fireEvent.click(screen.getByText("برش تصویر"));
    drag(img.parentElement!, { x: 10 + 30, y: 20 + 20 }, { x: 10 + 110, y: 20 + 70 });
    expect((screen.getByText("اعمال برش").closest("button") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText("انصراف"));

    expect(screen.queryByText("اعمال برش")).toBeNull();
    // The drawer's own mount-time fetches (collections, usage) are fine —
    // what "انصراف" must never trigger is a call to the transform endpoint.
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/media/asset-1/transform")).toBe(false);
  });
});
