// @vitest-environment jsdom

/**
 * The support banner's «پایان نشست», driven the way an operator drives it:
 * click, confirm, wait. The contract is behavioural — the right request goes
 * out exactly once, the button says it is busy and cannot be pressed again,
 * success leaves for the console, failure says so in Persian and lets the
 * operator try again, and the server's expiry instant ends the session
 * through the same request without anybody clicking.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupportSessionBanner, SupportSessionEnded, supportSessionNavigation } from "./support-session-banner";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const GRANT = "f1d3e569-9248-4d16-86e5-53fc9c208ed2";
const RETURN = "/platform/businesses/7198892a-cca7-4e29-80a1-ff9f5f64fa97/support";

/**
 * An in-memory stand-in for BroadcastChannel: every instance with the same
 * name hears every other instance's messages, the way two tabs of one origin
 * do. (Node's native one rejects jsdom's MessageEvent.)
 */
class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) { FakeBroadcastChannel.open.add(this); }
  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.open) {
      if (other !== this && other.name === this.name) other.onmessage?.({ data } as MessageEvent);
    }
  }
  close() { FakeBroadcastChannel.open.delete(this); }
}

let fetchMock: ReturnType<typeof vi.fn>;
let leave: ReturnType<typeof vi.spyOn>;

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function banner(overrides: Partial<{ expiresAt: string; serverNow: string; mode: "read_only" | "controlled" | "full" }> = {}) {
  const serverNow = overrides.serverNow ?? new Date().toISOString();
  return render(
    <SupportSessionBanner session={{
      grantId: GRANT,
      businessName: "کافه نمونه",
      operatorName: "اپراتور پشتیبانی",
      mode: overrides.mode ?? "read_only",
      expiresAt: overrides.expiresAt ?? new Date(Date.parse(serverNow) + 30 * 60_000).toISOString(),
      serverNow,
    }} />,
  );
}

const endButton = () => screen.getByRole("button", { name: /پایان نشست/ });
const confirmButton = () => screen.getByRole("dialog").querySelector<HTMLButtonElement>("[data-variant=destructive]")!;

beforeEach(() => {
  fetchMock = vi.fn(async () => respond(200, { ok: true, sessionId: GRANT, status: "ended", redirectTo: RETURN }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  FakeBroadcastChannel.open.clear();
  leave = vi.spyOn(supportSessionNavigation, "leave").mockImplementation(() => {});
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SupportSessionBanner — ending the session", () => {
  it("renders the mode, the operator and a real «پایان نشست» button", () => {
    banner();
    expect(screen.getByText(/نشست پشتیبانی · فقط خواندنی/)).toBeTruthy();
    expect(screen.getByText(/اپراتور: اپراتور پشتیبانی/)).toBeTruthy();
    expect(endButton().tagName).toBe("BUTTON");
    expect(screen.getByRole("timer").textContent).toBe("۳۰ دقیقه باقی‌مانده");
  });

  it("asks for confirmation first, and «انصراف» sends nothing", async () => {
    const user = userEvent.setup();
    banner();
    await user.click(endButton());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("پایان نشست پشتیبانی")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirming sends DELETE to the canonical endpoint for this grant and leaves for the console", async () => {
    const user = userEvent.setup();
    banner();
    await user.click(endButton());
    await user.click(confirmButton());
    await waitFor(() => expect(leave).toHaveBeenCalledWith(RETURN));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/support-access?grantId=${GRANT}`);
    expect(init.method).toBe("DELETE");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("is keyboard-operable: Enter opens the dialog and confirms", async () => {
    const user = userEvent.setup();
    banner();
    endButton().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    confirmButton().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(leave).toHaveBeenCalledWith(RETURN));
  });

  it("while the request is pending: busy label, disabled buttons, and a second press sends nothing", async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    banner();
    await user.click(endButton());
    const confirm = confirmButton();
    await user.click(confirm);

    await waitFor(() => expect(confirm.textContent).toBe("در حال پایان نشست…"));
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "انصراف" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => release(respond(200, { ok: true, sessionId: GRANT, status: "ended", redirectTo: RETURN })));
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
  });

  it("a failed request shows a Persian error, stays in place and can be retried", async () => {
    fetchMock.mockResolvedValueOnce(respond(500, { error: "internal" }));
    const user = userEvent.setup();
    banner();
    await user.click(endButton());
    await user.click(confirmButton());

    const message = "پایان نشست پشتیبانی انجام نشد. دوباره تلاش کنید.";
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message));
    expect(screen.getByRole("dialog").textContent).toContain(message);
    expect(leave).not.toHaveBeenCalled();
    expect(confirmButton().disabled).toBe(false);

    await user.click(confirmButton());
    await waitFor(() => expect(leave).toHaveBeenCalledWith(RETURN));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a network failure is reported, not swallowed", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    banner();
    await user.click(endButton());
    await user.click(confirmButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(leave).not.toHaveBeenCalled();
  });

  it("an already-ended session (idempotent 200 not_active) still leaves for the console", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { ok: true, sessionId: GRANT, status: "not_active", redirectTo: RETURN }));
    const user = userEvent.setup();
    banner();
    await user.click(endButton());
    await user.click(confirmButton());
    await waitFor(() => expect(leave).toHaveBeenCalledWith(RETURN));
  });
});

describe("SupportSessionBanner — more than one tab", () => {
  it("ending in one tab moves every other tab of the same session out too", async () => {
    const user = userEvent.setup();
    banner();
    banner();
    const [tabA] = screen.getAllByRole("button", { name: /پایان نشست/ });
    await user.click(tabA);
    await user.click(confirmButton());
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(2));
    expect(leave).toHaveBeenNthCalledWith(1, RETURN);
    expect(leave).toHaveBeenNthCalledWith(2, RETURN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("SupportSessionBanner — expiry", () => {
  it("counts down on the server's clock, even when the browser's is wrong", () => {
    // The browser is ten minutes ahead of the server; the server says 12 minutes remain.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-09-25T12:10:00.000Z"));
    banner({ serverNow: "2026-09-25T12:00:00.000Z", expiresAt: "2026-09-25T12:12:00.000Z" });
    expect(screen.getByRole("timer").textContent).toBe("۱۲ دقیقه باقی‌مانده");
  });

  it("at the expiry instant it ends the session through the same request, with no click", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const serverNow = new Date("2026-09-25T12:00:00.000Z");
    vi.setSystemTime(serverNow);
    banner({ serverNow: serverNow.toISOString(), expiresAt: "2026-09-25T12:02:00.000Z" });

    await act(async () => { vi.advanceTimersByTime(75_000); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("timer").textContent).toBe("کمتر از یک دقیقه باقی‌مانده");

    await act(async () => { vi.advanceTimersByTime(45_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe("DELETE");
    vi.useRealTimers();
    await waitFor(() => expect(leave).toHaveBeenCalledWith(RETURN));
  });
});

describe("SupportSessionEnded — a page that found a support cookie whose session is over", () => {
  it("closes it through the same endpoint and returns to the console", async () => {
    render(<SupportSessionEnded grantId={GRANT} />);
    expect(screen.getByText("نشست پشتیبانی پایان یافته است")).toBeTruthy();
    await waitFor(() => expect(leave).toHaveBeenCalledWith(RETURN));
    expect(fetchMock).toHaveBeenCalledWith(`/api/support-access?grantId=${GRANT}`, expect.objectContaining({ method: "DELETE" }));
  });

  it("offers a retry when the request fails", async () => {
    fetchMock.mockResolvedValueOnce(respond(503, { error: "unavailable" }));
    const user = userEvent.setup();
    render(<SupportSessionEnded grantId={GRANT} />);
    const retry = await screen.findByRole("button", { name: "تلاش دوباره" });
    expect(leave).not.toHaveBeenCalled();
    await user.click(retry);
    await waitFor(() => expect(leave).toHaveBeenCalledWith(RETURN));
  });
});
