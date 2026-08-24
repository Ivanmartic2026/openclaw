/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { icons } from "../components/icons.ts";
import "../components/modal-dialog.ts";
import { showToast, type ToastSessionScope } from "./toast.ts";

type ToastVariant = NonNullable<Parameters<typeof showToast>[0]["variant"]>;

async function mountGlobalHost() {
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  return host;
}

async function mountSessionHost(scope: Omit<ToastSessionScope, "kind">) {
  const host = document.createElement("openclaw-session-toast-host");
  host.sessionKey = scope.sessionKey;
  host.agentId = scope.agentId;
  host.presentationId = scope.presentationId;
  host.presented = true;
  host.active = true;
  document.body.append(host);
  await host.updateComplete;
  return host;
}

function sessionScope(
  sessionKey = "agent:main:main",
  agentId = "main",
  presentationId = "pane-1",
): ToastSessionScope {
  return { kind: "session", sessionKey, agentId, presentationId };
}

function present(message: string, key = message, variant: ToastVariant = "info") {
  return showToast({ key, message, variant });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared toast", () => {
  it("keeps critical outcomes when a lower-priority event arrives at capacity", async () => {
    const host = await mountGlobalHost();
    const reasons: string[] = [];

    for (const message of ["First failure", "Second failure", "Third failure"]) {
      showToast({
        key: message,
        message,
        onDismiss: (reason) => reasons.push(reason),
        variant: "danger",
      });
    }
    showToast({
      key: "routine",
      message: "Routine update",
      onDismiss: (reason) => reasons.push(reason),
      variant: "success",
    });
    await host.updateComplete;

    expect(
      [...host.querySelectorAll(".app-toast__message")].map((element) => element.textContent),
    ).toEqual(["First failure", "Second failure", "Third failure"]);
    expect(reasons).toEqual(["saturated"]);
  });

  it("evicts the oldest lowest-priority outcome for an equally important one", async () => {
    const host = await mountGlobalHost();

    for (const message of ["First", "Second", "Third", "Fourth"]) {
      present(message);
    }
    await host.updateComplete;

    expect(
      [...host.querySelectorAll(".app-toast__message")].map((element) => element.textContent),
    ).toEqual(["Second", "Third", "Fourth"]);
  });

  it("preserves an action when passive outcomes saturate the stack", async () => {
    const host = await mountGlobalHost();
    const onAction = vi.fn();
    showToast({
      key: "archive",
      message: "Archived",
      actionLabel: "Undo",
      onAction,
      variant: "success",
    });
    for (const message of ["First info", "Second info", "Third info"]) {
      present(message);
    }
    await host.updateComplete;

    expect(host.querySelector('[data-toast-key="archive"]')).not.toBeNull();
    expect(host.textContent).not.toContain("First info");
    host.querySelector<HTMLButtonElement>('[data-toast-key="archive"] .app-toast__action')?.click();
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("admits an action ahead of passive danger outcomes", async () => {
    const host = await mountGlobalHost();
    for (const message of ["First danger", "Second danger", "Third danger"]) {
      present(message, message, "danger");
    }

    showToast({
      key: "archive",
      message: "Archived",
      actionLabel: "Undo",
      onAction: vi.fn(),
      variant: "success",
    });
    await host.updateComplete;

    expect(host.querySelector('[data-toast-key="archive"]')).not.toBeNull();
    expect(host.textContent).not.toContain("First danger");
  });

  it("replaces an outcome with the same scoped key", async () => {
    const host = await mountGlobalHost();
    const reasons: string[] = [];

    showToast({
      key: "connection",
      message: "Connecting",
      onDismiss: (reason) => reasons.push(reason),
      variant: "info",
    });
    showToast({ key: "connection", message: "Connected", variant: "success" });
    await host.updateComplete;

    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
    expect(host.querySelector(".app-toast__message")?.textContent).toBe("Connected");
    expect(reasons).toEqual(["replaced"]);
  });

  it.each([
    ["info", "status", "polite"],
    ["success", "status", "polite"],
    ["warning", "alert", "assertive"],
    ["danger", "alert", "assertive"],
  ] as const)("uses the accessibility contract for %s", async (variant, role, live) => {
    const host = await mountGlobalHost();

    present(variant, variant, variant);
    await host.updateComplete;

    const toast = host.querySelector(`.app-toast--${variant}`);
    expect(toast?.getAttribute("role")).toBe(role);
    expect(toast?.getAttribute("aria-live")).toBe(live);
  });

  it("routes only to the exact agent and pane presentation", async () => {
    const globalHost = await mountGlobalHost();
    const matchingHost = await mountSessionHost(sessionScope("global", "main", "pane-1"));
    const otherAgentHost = await mountSessionHost(sessionScope("global", "other", "pane-2"));

    showToast({
      key: "copy-image",
      message: "Copied",
      scope: sessionScope("global", "main", "pane-1"),
      variant: "success",
    });
    await matchingHost.updateComplete;

    expect(matchingHost.textContent).toContain("Copied");
    expect(otherAgentHost.querySelector(".app-toast")).toBeNull();
    expect(globalHost.querySelector(".app-toast")).toBeNull();
  });

  it("does not route to a session host before its identity is committed", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = document.createElement("openclaw-session-toast-host");
    sessionHost.sessionKey = "agent:main:main";
    sessionHost.agentId = "main";
    sessionHost.presentationId = "pane-1";
    sessionHost.presented = true;
    document.body.append(sessionHost);

    showToast({ key: "early", message: "Early", scope: sessionScope(), variant: "info" });
    await sessionHost.updateComplete;
    await globalHost.updateComplete;

    expect(sessionHost.querySelector(".app-toast")).toBeNull();
    expect(globalHost.textContent).toContain("Early");
  });

  it("routes to a committed session host after it reconnects unchanged", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost(sessionScope());
    sessionHost.remove();
    document.body.append(sessionHost);

    showToast({
      key: "reconnected",
      message: "Reconnected",
      scope: sessionScope(),
      variant: "info",
    });
    await sessionHost.updateComplete;

    expect(sessionHost.textContent).toContain("Reconnected");
    expect(globalHost.querySelector(".app-toast")).toBeNull();
  });

  it("falls back globally when the exact pane presentation is absent", async () => {
    const globalHost = await mountGlobalHost();
    const otherHost = await mountSessionHost(sessionScope("agent:main:main", "main", "pane-2"));

    showToast({
      key: "copy-image",
      message: "Copied",
      scope: sessionScope(),
      variant: "success",
    });
    await globalHost.updateComplete;

    expect(globalHost.textContent).toContain("Copied");
    expect(otherHost.querySelector(".app-toast")).toBeNull();
  });

  it("moves an active session outcome global when its pane is hidden", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost(sessionScope());

    showToast({ key: "copy-image", message: "Copied", scope: sessionScope(), variant: "success" });
    await sessionHost.updateComplete;
    sessionHost.presented = false;
    await sessionHost.updateComplete;
    await globalHost.updateComplete;

    expect(sessionHost.querySelector(".app-toast")).toBeNull();
    expect(globalHost.textContent).toContain("Copied");
  });

  it("moves an active outcome global when its host identity changes", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost(sessionScope());
    showToast({ key: "copy-image", message: "Copied", scope: sessionScope(), variant: "success" });
    await sessionHost.updateComplete;

    sessionHost.agentId = "other";
    await sessionHost.updateComplete;
    await globalHost.updateComplete;

    expect(sessionHost.querySelector(".app-toast")).toBeNull();
    expect(globalHost.textContent).toContain("Copied");
  });

  it("keeps a host unroutable under its pending identity", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost(sessionScope());

    sessionHost.agentId = "other";
    showToast({
      key: "pending-identity",
      message: "Pending identity",
      scope: sessionScope("agent:other:main", "other", "pane-1"),
      variant: "info",
    });
    await sessionHost.updateComplete;
    await globalHost.updateComplete;

    expect(sessionHost.querySelector(".app-toast")).toBeNull();
    expect(globalHost.textContent).toContain("Pending identity");
  });

  it("settles a session outcome when disconnect has no global handoff host", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost(sessionScope());
    const onDismiss = vi.fn();
    showToast({
      key: "copy-image",
      message: "Copied",
      onDismiss,
      scope: sessionScope(),
      variant: "success",
    });
    await sessionHost.updateComplete;

    globalHost.remove();
    sessionHost.remove();

    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("disconnected");
  });

  it("reports only saturation when the global handoff host rejects an outcome", async () => {
    const globalHost = await mountGlobalHost();
    const sessionHost = await mountSessionHost(sessionScope());
    const reasons: string[] = [];
    for (const message of ["First failure", "Second failure", "Third failure"]) {
      showToast({ key: message, message, variant: "danger" });
    }
    showToast({
      key: "routine",
      message: "Routine update",
      onDismiss: (reason) => reasons.push(reason),
      scope: sessionScope(),
      variant: "success",
    });
    await sessionHost.updateComplete;

    sessionHost.remove();
    await globalHost.updateComplete;

    expect(reasons).toEqual(["saturated"]);
  });

  it("preserves anchored geometry and icon presentation", async () => {
    const host = await mountGlobalHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 100, 40));

    showToast({
      anchor,
      anchorTopOffset: 52,
      icon: icons.shieldCheck,
      message: "Applies next run",
    });
    await host.updateComplete;

    const toast = host.querySelector<HTMLElement>(".app-toast--anchored");
    expect(toast?.style.getPropertyValue("--app-toast-anchor-center")).toBe("60px");
    expect(toast?.style.getPropertyValue("--app-toast-anchor-top")).toBe("72px");
    expect(toast?.style.getPropertyValue("--app-toast-anchor-width")).toBe("100px");
    expect(toast?.querySelector(".app-toast__icon")).not.toBeNull();
  });

  it("uses the active modal's toast layer before the app layer", async () => {
    const appHost = await mountGlobalHost();
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    document.body.append(modal);
    await modal.updateComplete;
    const moveBefore = vi.spyOn(Element.prototype, "moveBefore");

    present("Above overlay");
    await appHost.updateComplete;

    expect(moveBefore).toHaveBeenCalledWith(appHost, null);
    expect(moveBefore.mock.contexts).toContain(modal);
    expect(appHost.textContent).toContain("Above overlay");
  });

  it("routes through an active modal inside a shadow root", async () => {
    const appHost = await mountGlobalHost();
    const shadowOwner = document.createElement("div");
    const shadowRoot = shadowOwner.attachShadow({ mode: "open" });
    const modal = document.createElement("openclaw-modal-dialog");
    modal.open = true;
    shadowRoot.append(modal);
    document.body.append(shadowOwner);
    await modal.updateComplete;
    const moveBefore = vi.spyOn(Element.prototype, "moveBefore");

    present("Critical session notice", "critical", "danger");
    await appHost.updateComplete;

    expect(moveBefore).toHaveBeenCalledWith(appHost, null);
    expect(moveBefore.mock.contexts).toContain(modal);
    expect(appHost.textContent).toContain("Critical session notice");
  });

  it("auto-dismisses after the configured duration and exit transition", async () => {
    vi.useFakeTimers();
    const host = await mountGlobalHost();

    showToast({ key: "temporary", message: "Temporary", durationMs: 50, variant: "info" });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(50);
    await host.updateComplete;

    expect(host.querySelector(".app-toast")?.getAttribute("data-state")).toBe("exiting");
    expect(host.querySelector(".app-toast")?.hasAttribute("inert")).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    await host.updateComplete;
    expect(host.querySelector(".app-toast")).toBeNull();
  });

  it.each(["timeout", "dismiss"] as const)(
    "refuses an action after %s settlement",
    async (reason) => {
      vi.useFakeTimers();
      const host = await mountGlobalHost();
      const onAction = vi.fn();
      showToast({
        key: reason,
        message: "Archived",
        actionLabel: "Undo",
        durationMs: 50,
        onAction,
        variant: "success",
      });
      await host.updateComplete;
      const action = host.querySelector<HTMLButtonElement>(".app-toast__action");

      if (reason === "timeout") {
        await vi.advanceTimersByTimeAsync(50);
      } else {
        host.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
      }
      action?.click();

      expect(onAction).not.toHaveBeenCalled();
    },
  );

  it("preserves the dismissal reason when an exiting anchored toast is replaced", async () => {
    vi.useFakeTimers();
    const host = await mountGlobalHost();
    const anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const reasons: string[] = [];

    showToast({ anchor, message: "First", onDismiss: (reason) => reasons.push(reason) });
    await host.updateComplete;
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")?.click();
    await host.updateComplete;
    showToast({ message: "Second" });

    expect(reasons).toEqual(["dismiss"]);
    expect(host.querySelectorAll(".app-toast")).toHaveLength(1);
  });

  it("runs an action at most once even before the host rerenders", async () => {
    const host = await mountGlobalHost();
    const onAction = vi.fn();
    showToast({
      key: "archived",
      message: "Archived",
      actionLabel: "Undo",
      onAction,
      variant: "success",
    });
    await host.updateComplete;

    const action = host.querySelector<HTMLButtonElement>(".app-toast__action");
    action?.click();
    action?.click();

    expect(onAction).toHaveBeenCalledOnce();
  });

  it("settles immediately when reduced motion is requested", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const host = await mountGlobalHost();

    showToast({ key: "reduced", message: "Reduced", durationMs: 50, variant: "info" });
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(50);
    await host.updateComplete;

    expect(host.querySelector(".app-toast")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("reports when no host can present the toast", () => {
    expect(present("Unavailable")).toBe(false);
  });

  it("keeps one neutral startup toast before the host connects", async () => {
    const reasons: string[] = [];
    showToast({ message: "First", onDismiss: (reason) => reasons.push(reason) });
    showToast({ message: "Second" });

    const host = await mountGlobalHost();

    expect(host.querySelectorAll(".app-toast--legacy")).toHaveLength(1);
    expect(host.querySelector(".app-toast--legacy")?.textContent).toContain("Second");
    expect(reasons).toEqual(["replaced"]);
  });
});
