import path from "node:path";
import { expect, it } from "vitest";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
  trimmedTextContents,
  uiProofArtifactDir,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const candidateKey = "agent:main:candidate";
const companionKey = "agent:main:companion";
const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
const pinFeatureMethods = ["chat.metadata", "chat.startup", "sessions.patch"];

function unpinnedList() {
  return sessionsListResponse([
    sessionRow(candidateKey, "Pin me", baseTime),
    sessionRow(companionKey, "Stay put", baseTime - 1_000),
  ]);
}

function pinnedList() {
  return sessionsListResponse([
    sessionRow(candidateKey, "Pin me", baseTime, { pinned: true, pinnedAt: baseTime }),
    sessionRow(companionKey, "Stay put", baseTime - 1_000),
  ]);
}

function groupedList(categoryPinnedAt?: number) {
  return sessionsListResponse([
    sessionRow(companionKey, "Stay put", baseTime, { category: "Research" }),
    sessionRow(candidateKey, "Pin me", baseTime - 1_000, {
      category: "Research",
      ...(categoryPinnedAt === undefined ? {} : { categoryPinnedAt }),
    }),
  ]);
}

function globallyPinnedList() {
  return sessionsListResponse([
    sessionRow(candidateKey, "Pin me", baseTime, {
      category: "Research",
      pinned: true,
      pinnedAt: baseTime,
    }),
    sessionRow(companionKey, "Stay put", baseTime - 1_000, { category: "Research" }),
  ]);
}

suite.define(() => {
  it("pins within a group from the contextual menu while the patch is in flight", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": groupedList(), "sessions.patch": {} },
      featureMethods: [...pinFeatureMethods, "sessions.groups.list", "sessions.groups.put"],
      sessionGroups: ["Research"],
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Research"]');
      const row = group.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await row.hover();
      await row.getByRole("button", { name: "Open session menu: Pin me" }).click();
      const menu = page.locator("openclaw-session-menu");
      await menu.getByRole("menuitem", { name: "Pin session" }).click();
      await expect
        .poll(() => menu.getByRole("menuitemradio", { name: "Not pinned" }).count())
        .toBe(1);
      await captureUiProof(page, "group-pin-01-context-unpinned.png");

      await gateway.deferNext("sessions.patch");
      await activateSelfRemovingControl(menu.getByRole("menuitemradio", { name: "In Research" }));

      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.patch");
          return requests.at(-1)?.params;
        })
        .toMatchObject({ key: candidateKey, pinScope: "group" });
      expect(await page.locator(`[data-sidebar-entry="session:${candidateKey}"]`).count()).toBe(0);
      await expect
        .poll(() =>
          group
            .locator(".sidebar-recent-session__name")
            .allTextContents()
            .then((labels) => labels.map((label) => label.trim())),
        )
        .toEqual(["Pin me", "Stay put"]);
      await captureUiProof(page, "group-pin-02-pinned-in-group.png");

      await gateway.setMethodResponse("sessions.list", groupedList(baseTime + 1_000));
      await gateway.resolveDeferred("sessions.patch", {
        ok: true,
        key: candidateKey,
        path: "",
        entry: { sessionId: `session:${candidateKey}`, categoryPinnedAt: baseTime + 1_000 },
      });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);

      await row.hover();
      await row.getByRole("button", { name: "Open session menu: Pin me" }).click();
      await menu.getByRole("menuitem", { name: "Pin session" }).click();
      await expect
        .poll(() =>
          menu.getByRole("menuitemradio", { name: "In Research" }).getAttribute("aria-checked"),
        )
        .toBe("true");
      await captureUiProof(page, "group-pin-03-confirmed.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(uiProofArtifactDir, "group-pin-context-menu.webm"));
      }
    }
  });

  it("uses the current group for the row quick-pin action", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": groupedList(), "sessions.patch": {} },
      featureMethods: [...pinFeatureMethods, "sessions.groups.list", "sessions.groups.put"],
      sessionGroups: ["Research"],
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Research"]');
      const row = group.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await gateway.deferNext("sessions.patch");
      await row.hover();
      await row.getByRole("button", { name: "Pin session: Pin me" }).click();

      await expect
        .poll(async () => (await gateway.getRequests("sessions.patch")).at(-1)?.params)
        .toMatchObject({ key: candidateKey, pinScope: "group" });
      await expect
        .poll(() =>
          group
            .locator(".sidebar-recent-session__name")
            .allTextContents()
            .then((labels) => labels.map((label) => label.trim())),
        )
        .toEqual(["Pin me", "Stay put"]);

      await gateway.setMethodResponse("sessions.list", groupedList(baseTime + 1_000));
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("transfers a global pin into the destination group from the session menu", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": globallyPinnedList(), "sessions.patch": {} },
      featureMethods: [...pinFeatureMethods, "sessions.groups.list", "sessions.groups.put"],
      sessionGroups: ["Research", "Planning"],
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(
        `[data-sidebar-entry="session:${candidateKey}"] .sidebar-recent-session`,
      );
      await row.hover();
      await row.getByRole("button", { name: "Open session menu: Pin me" }).click();
      const menu = page.locator("openclaw-session-menu");
      await menu.getByRole("menuitem", { name: "Move to group" }).click();
      await gateway.deferNext("sessions.patch");
      await activateSelfRemovingControl(
        menu.getByRole("menuitemradio", { name: "Planning", exact: true }),
      );

      await expect
        .poll(async () => (await gateway.getRequests("sessions.patch")).at(-1)?.params)
        .toMatchObject({ category: "Planning", key: candidateKey, pinScope: "group" });

      await gateway.setMethodResponse(
        "sessions.list",
        sessionsListResponse([
          sessionRow(candidateKey, "Pin me", baseTime, {
            category: "Planning",
            categoryPinnedAt: baseTime + 1_000,
          }),
          sessionRow(companionKey, "Stay put", baseTime - 1_000, { category: "Research" }),
        ]),
      );
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
      await expect
        .poll(() => page.locator(`[data-sidebar-entry="session:${candidateKey}"]`).count())
        .toBe(0);
      await expect
        .poll(() =>
          page
            .locator('[data-session-section="category:Planning"] .sidebar-recent-session__name')
            .textContent(),
        )
        .toContain("Pin me");
    } finally {
      await context.close();
    }
  });

  it("pins from the row button while the Gateway patch is still in flight", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": unpinnedList(), "sessions.patch": {} },
      featureMethods: pinFeatureMethods,
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const zoneEntry = page.locator(`[data-sidebar-entry="session:${candidateKey}"]`);
      const threads = page.locator('[data-session-section="ungrouped"]');
      const row = threads.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await expect.poll(() => row.count()).toBe(1);
      await expect.poll(() => zoneEntry.count()).toBe(0);
      await captureUiProof(page, "optimistic-pin-01-before-click.png");

      await gateway.deferNext("sessions.patch");
      await row.hover();
      await row.getByRole("button", { name: "Pin session: Pin me" }).click();

      // The Gateway response is still held, so this can only come from the
      // optimistic snapshot write in the mutation owner.
      await expect.poll(() => zoneEntry.count()).toBe(1);
      await expect.poll(() => row.count()).toBe(0);
      expect(await gateway.getRequests("sessions.list")).toHaveLength(1);
      await captureUiProof(page, "optimistic-pin-02-pinned-while-in-flight.png");

      await gateway.setMethodResponse("sessions.list", pinnedList());
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });

      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
      await expect.poll(() => zoneEntry.count()).toBe(1);
      await expect.poll(() => row.count()).toBe(0);
      expect(await page.locator("[data-sidebar-session-error]").count()).toBe(0);
      await captureUiProof(page, "optimistic-pin-03-confirmed-after-refresh.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(uiProofArtifactDir, "optimistic-pin-button.webm"));
      }
    }
  });

  it("rolls a menu unpin back and surfaces the error when the Gateway rejects it", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": pinnedList(), "sessions.patch": {} },
      featureMethods: pinFeatureMethods,
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const zoneEntry = page.locator(`[data-sidebar-entry="session:${candidateKey}"]`);
      const threads = page.locator('[data-session-section="ungrouped"]');
      const row = threads.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await expect.poll(() => zoneEntry.count()).toBe(1);

      await gateway.deferNext("sessions.patch");
      const pinnedRow = zoneEntry.locator(".sidebar-recent-session");
      await pinnedRow.hover();
      await pinnedRow.getByRole("button", { name: "Open session menu: Pin me" }).click();
      const menuHost = page.locator("openclaw-session-menu");
      await menuHost.getByRole("menuitem", { name: "Pin session" }).click();
      await activateSelfRemovingControl(
        menuHost.getByRole("menuitemradio", { name: "Not pinned" }),
      );

      await expect.poll(() => zoneEntry.count()).toBe(0);
      await expect.poll(() => row.count()).toBe(1);
      await captureUiProof(page, "optimistic-pin-04-unpinned-while-in-flight.png");

      await gateway.rejectDeferred("sessions.patch", { message: "pin storage unavailable" });

      await expect.poll(() => zoneEntry.count()).toBe(1);
      await expect.poll(() => row.count()).toBe(0);
      await expect
        .poll(() => trimmedTextContents(page.locator("[data-sidebar-session-error]")))
        .toEqual([expect.stringContaining("pin storage unavailable")]);
      await captureUiProof(page, "optimistic-pin-05-rolled-back-with-error.png");
    } finally {
      await context.close();
    }
  });

  it("keeps the newest pin intent when the older completion refreshes the list first", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": unpinnedList(), "sessions.patch": {} },
      featureMethods: pinFeatureMethods,
      sessionKey: candidateKey,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const zoneEntry = page.locator(`[data-sidebar-entry="session:${candidateKey}"]`);
      const threads = page.locator('[data-session-section="ungrouped"]');
      const row = threads.locator(`.sidebar-recent-session[data-session-key="${candidateKey}"]`);
      await expect.poll(() => row.count()).toBe(1);

      await gateway.deferNext("sessions.patch");
      await row.hover();
      await row.getByRole("button", { name: "Pin session: Pin me" }).click();
      await expect.poll(() => zoneEntry.count()).toBe(1);

      await gateway.deferNext("sessions.patch");
      const pinnedRow = zoneEntry.locator(".sidebar-recent-session");
      await pinnedRow.hover();
      await pinnedRow.getByRole("button", { name: "Unpin session: Pin me" }).click();
      await expect.poll(() => row.count()).toBe(1);
      await expect.poll(() => zoneEntry.count()).toBe(0);

      // The pin commits first; its list refresh still carries the pinned row the
      // unpin already replaced locally.
      await gateway.setMethodResponse("sessions.list", pinnedList());
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(2);
      await expect.poll(() => row.count()).toBe(1);
      expect(await zoneEntry.count()).toBe(0);

      await gateway.setMethodResponse("sessions.list", unpinnedList());
      await gateway.resolveDeferred("sessions.patch", { ok: true, key: candidateKey, path: "" });
      await expect.poll(() => gateway.getRequests("sessions.list")).toHaveLength(3);
      await expect.poll(() => row.count()).toBe(1);
      expect(await zoneEntry.count()).toBe(0);
      await captureUiProof(page, "optimistic-pin-06-newest-intent-wins.png");
    } finally {
      await context.close();
    }
  });
});
