import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { formatUiExternalText } from "./format-error.ts";
import { areUiSessionKeysEquivalent, normalizeAgentId } from "./sessions/session-key.ts";

type ToastDismissReason =
  | "action"
  | "dismiss"
  | "disconnected"
  | "replaced"
  | "saturated"
  | "timeout";
type ToastVariant = "danger" | "info" | "success" | "warning";

export type ToastSessionScope = {
  kind: "session";
  sessionKey: string;
  agentId: string;
  presentationId: string;
};

export type ToastOptions = {
  /** A template lets a message name a destination the operator can actually open,
   * instead of spelling out a settings path the toast then makes them find. */
  message: string | TemplateResult;
  /** Positions a compact toast at the top center of the owning surface. */
  anchor?: Element;
  anchorTopOffset?: number;
  icon?: TemplateResult;
  key?: string;
  variant?: ToastVariant;
  scope?: ToastSessionScope;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: (reason: ToastDismissReason) => void;
  durationMs?: number;
};

const DEFAULT_TOAST_DURATION_MS = 6_000;
const TOAST_EXIT_DURATION_MS = 150;
const TOAST_EXIT_FALLBACK_MS = 450;
const TOAST_QUEUE_LIMIT = 3;
const TOAST_PRIORITY: Record<ToastVariant, number> = {
  success: 0,
  info: 1,
  warning: 2,
  danger: 3,
};

type ToastEntry = ToastOptions & {
  deadline: number;
  id: number;
  exiting: boolean;
};
type VariantToast = ToastOptions & { variant: ToastVariant };

let nextToastId = 0;

function activeModalToastLayer() {
  return [...(document.openClawModalToastLayers ?? [])].findLast(
    (candidate) => candidate.isConnected,
  );
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function isVariantToast(toast: ToastOptions): toast is VariantToast {
  return toast.variant !== undefined;
}

function variantToast(options: ToastOptions): VariantToast {
  if (!isVariantToast(options)) {
    throw new Error("variant toast required");
  }
  return options;
}

function compareToastPriority(left: VariantToast, right: VariantToast): number {
  const actionable = (toast: ToastOptions) => Number(Boolean(toast.actionLabel && toast.onAction));
  const actionPriority = actionable(left) - actionable(right);
  return actionPriority || TOAST_PRIORITY[left.variant] - TOAST_PRIORITY[right.variant];
}

function sameToastKey(left: ToastOptions, right: ToastOptions): boolean {
  if (!left.key || left.key !== right.key) {
    return false;
  }
  if (!left.scope || !right.scope) {
    return left.scope === right.scope;
  }
  return (
    left.scope.presentationId === right.scope.presentationId &&
    normalizeAgentId(left.scope.agentId) === normalizeAgentId(right.scope.agentId) &&
    areUiSessionKeysEquivalent(left.scope.sessionKey, right.scope.sessionKey)
  );
}

function selectSaturationVictim<T extends VariantToast>(
  active: T[],
  incoming: VariantToast,
): T | null {
  const candidate = active.toSorted(compareToastPriority)[0];
  return candidate && compareToastPriority(incoming, candidate) >= 0 ? candidate : null;
}

// Startup outcomes can race the shell host. Admission applies the same replacement
// and priority policy as the connected host so startup cannot silently reorder it.
let queuedToasts: ToastOptions[] = [];
const sessionToastHosts = new Set<OpenClawSessionToastHost>();

abstract class OpenClawToastStackHost extends OpenClawLightDomContentsElement {
  @state() private toasts: ToastEntry[] = [];
  private readonly dismissTimers = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
  private readonly exitTimers = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
  protected abstract readonly stackKind: "global" | "session";

  protected dismissAll(reason: ToastDismissReason) {
    for (const toast of this.toasts) {
      this.settle(toast, reason, false);
    }
  }

  show(options: ToastOptions): boolean {
    if (!options.variant) {
      for (const legacyToast of this.toasts.filter((candidate) => !candidate.variant)) {
        if (legacyToast.exiting) {
          this.removeToast(legacyToast);
        } else {
          this.settle(legacyToast, "replaced", false);
        }
      }
    }

    const duplicate = this.toasts.find((toast) => !toast.exiting && sameToastKey(toast, options));
    if (duplicate) {
      this.settle(duplicate, "replaced", false);
    } else if (options.variant) {
      const active = this.toasts.filter(
        (toast): toast is ToastEntry & VariantToast => !toast.exiting && isVariantToast(toast),
      );
      if (active.length >= TOAST_QUEUE_LIMIT) {
        const victim = selectSaturationVictim(active, variantToast(options));
        if (!victim) {
          options.onDismiss?.("saturated");
          return false;
        }
        this.settle(victim, "saturated", false);
      }
    }

    const durationMs = options.durationMs ?? DEFAULT_TOAST_DURATION_MS;
    const entry: ToastEntry = {
      ...options,
      deadline: Date.now() + durationMs,
      id: ++nextToastId,
      exiting: false,
    };
    this.toasts = [...this.toasts, entry];
    this.dismissTimers.set(
      entry.id,
      globalThis.setTimeout(() => this.settle(entry, "timeout", true), durationMs),
    );
    return true;
  }

  protected takeActiveToasts(): ToastOptions[] {
    const now = Date.now();
    const active = this.toasts.filter((toast) => !toast.exiting);
    for (const toast of active) {
      this.clearTimers(toast);
    }
    this.toasts = this.toasts.filter((toast) => toast.exiting);
    return active.map(({ deadline, exiting: _exiting, id: _id, ...toast }) =>
      Object.assign(toast, { durationMs: Math.max(0, deadline - now) }),
    );
  }

  private clearTimers(toast: ToastEntry) {
    const dismissTimer = this.dismissTimers.get(toast.id);
    if (dismissTimer !== undefined) {
      globalThis.clearTimeout(dismissTimer);
      this.dismissTimers.delete(toast.id);
    }
    const exitTimer = this.exitTimers.get(toast.id);
    if (exitTimer !== undefined) {
      globalThis.clearTimeout(exitTimer);
      this.exitTimers.delete(toast.id);
    }
  }

  private removeToast(toast: ToastEntry) {
    this.clearTimers(toast);
    this.toasts = this.toasts.filter((candidate) => candidate.id !== toast.id);
  }

  private settle(toast: ToastEntry, reason: ToastDismissReason, animate: boolean): boolean {
    const current = this.toasts.find((candidate) => candidate.id === toast.id);
    if (!current || current.exiting) {
      return false;
    }

    this.clearTimers(current);
    const canAnimate = current.variant || current.anchor?.isConnected === true;
    if (!animate || !canAnimate || prefersReducedMotion() || !this.isConnected) {
      this.removeToast(current);
      current.onDismiss?.(reason);
      return true;
    }

    current.exiting = true;
    current.onAction = undefined;
    this.toasts = [...this.toasts];
    const anchored = current.anchor?.isConnected === true;
    const exitDuration = anchored ? TOAST_EXIT_FALLBACK_MS : TOAST_EXIT_DURATION_MS;
    this.exitTimers.set(
      current.id,
      globalThis.setTimeout(() => this.removeToast(current), exitDuration),
    );
    current.onDismiss?.(reason);
    return true;
  }

  private invokeAction(toast: ToastEntry) {
    const action = toast.onAction;
    if (action && this.settle(toast, "action", false)) {
      action();
    }
  }

  private renderToast(toast: ToastEntry, kind: "global" | "legacy" | "session") {
    const anchorRect = toast.anchor?.isConnected ? toast.anchor.getBoundingClientRect() : null;
    const anchored = anchorRect !== null && anchorRect.width > 0;
    const assertive = toast.variant === "warning" || toast.variant === "danger";
    return html`
      <div
        class="app-toast app-toast--${kind}${toast.variant
          ? ` app-toast--${toast.variant}`
          : ""}${anchored ? " app-toast--anchored" : ""}"
        data-toast-key=${toast.key ?? toast.id}
        data-state=${toast.exiting ? "exiting" : "open"}
        data-active=${toast.exiting ? "false" : "true"}
        style=${styleMap(
          anchored
            ? {
                "--app-toast-anchor-center": `${anchorRect.left + anchorRect.width / 2}px`,
                "--app-toast-anchor-top": `${anchorRect.top + (toast.anchorTopOffset ?? 0)}px`,
                "--app-toast-anchor-width": `${anchorRect.width}px`,
              }
            : {},
        )}
        role=${assertive ? "alert" : "status"}
        aria-live=${assertive ? "assertive" : "polite"}
        aria-atomic="true"
        aria-hidden=${toast.exiting ? "true" : "false"}
        ?inert=${toast.exiting}
        @transitionend=${(event: TransitionEvent) => {
          if (
            event.target === event.currentTarget &&
            event.propertyName === "opacity" &&
            toast.exiting
          ) {
            this.removeToast(toast);
          }
        }}
      >
        ${toast.icon
          ? html`<span class="app-toast__icon" aria-hidden="true">${toast.icon}</span>`
          : toast.variant
            ? html`<span class="app-toast__indicator" aria-hidden="true"></span>`
            : nothing}
        <span class="app-toast__message"
          >${typeof toast.message === "string"
            ? formatUiExternalText(toast.message)
            : toast.message}</span
        >
        ${toast.actionLabel && toast.onAction
          ? html`<button
              type="button"
              class="app-toast__action"
              @click=${() => this.invokeAction(toast)}
            >
              ${toast.actionLabel}
            </button>`
          : nothing}
        <button
          type="button"
          class="app-toast__dismiss"
          aria-label=${t("common.dismiss")}
          @click=${() => this.settle(toast, "dismiss", true)}
        >
          ${icons.x}
        </button>
      </div>
    `;
  }

  override render() {
    const modern = this.toasts.filter((toast) => toast.variant);
    const legacy = this.toasts.filter((toast) => !toast.variant);
    const renderStack = (toasts: ToastEntry[], kind: "global" | "legacy" | "session") =>
      toasts.length === 0
        ? nothing
        : html`<div class="app-toast-stack app-toast-stack--${kind}">
            ${toasts.map((toast) => this.renderToast(toast, kind))}
          </div>`;
    return html`${renderStack(modern, this.stackKind)}${renderStack(legacy, "legacy")}`;
  }
}

class OpenClawToastHost extends OpenClawToastStackHost {
  protected readonly stackKind = "global";

  override connectedCallback() {
    super.connectedCallback();
    const pending = queuedToasts;
    queuedToasts = [];
    for (const toast of pending) {
      this.show(toast);
    }
  }

  override disconnectedCallback() {
    const target = activeModalToastLayer() ?? document.querySelector(".shell");
    if (!this.isConnected && this.parentElement?.localName === "openclaw-modal-dialog" && target) {
      target.append(this);
    } else {
      this.dismissAll("disconnected");
    }
    super.disconnectedCallback();
  }

  /** Keep active outcomes intact while moveBefore() crosses top-layer owners. */
  connectedMoveCallback() {}
}

class OpenClawSessionToastHost extends OpenClawToastStackHost {
  protected readonly stackKind = "session";
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) agentId = "";
  @property({ attribute: false }) presentationId = "";
  @property({ attribute: false }) presented = false;
  @property({ attribute: false }) active = false;
  private committedScope: ToastSessionScope | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      sessionToastHosts.add(this);
    }
  }

  override disconnectedCallback() {
    sessionToastHosts.delete(this);
    this.handoffActiveToasts();
    super.disconnectedCallback();
  }

  protected override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    const identityCommitted = sessionToastHosts.has(this);
    const identityChanged =
      changedProperties.has("sessionKey") ||
      changedProperties.has("agentId") ||
      changedProperties.has("presentationId");
    if (
      identityCommitted &&
      ((changedProperties.has("presented") && !this.presented) || identityChanged)
    ) {
      this.handoffActiveToasts();
    }
    this.committedScope = {
      kind: "session",
      sessionKey: this.sessionKey,
      agentId: this.agentId,
      presentationId: this.presentationId,
    };
    sessionToastHosts.add(this);
  }

  matchesScope(scope: ToastSessionScope): boolean {
    const committed = this.committedScope;
    return (
      committed !== null &&
      committed.presentationId === scope.presentationId &&
      normalizeAgentId(committed.agentId) === normalizeAgentId(scope.agentId) &&
      areUiSessionKeysEquivalent(committed.sessionKey, scope.sessionKey)
    );
  }

  private handoffActiveToasts() {
    for (const toast of this.takeActiveToasts()) {
      const globalHost = document.querySelector<OpenClawToastHost>("openclaw-toast-host");
      if (globalHost) {
        globalHost.show(toast);
      } else {
        toast.onDismiss?.("disconnected");
      }
    }
  }
}

function matchingSessionToastHost(scope: ToastSessionScope): OpenClawSessionToastHost | undefined {
  return [...sessionToastHosts].find(
    (host) => host.presented && host.isConnected && host.matchesScope(scope),
  );
}

export function renderSessionToastHost(
  params: Omit<ToastSessionScope, "kind"> & {
    presented: boolean;
    active: boolean;
  },
) {
  return html`<openclaw-session-toast-host
    .sessionKey=${params.sessionKey}
    .agentId=${params.agentId}
    .presentationId=${params.presentationId}
    .presented=${params.presented}
    .active=${params.active}
  ></openclaw-session-toast-host>`;
}

function queueToast(options: ToastOptions): void {
  if (!options.variant) {
    for (const toast of queuedToasts.filter((candidate) => !candidate.variant)) {
      toast.onDismiss?.("replaced");
    }
    queuedToasts = queuedToasts.filter((toast) => toast.variant);
  }
  const duplicate = queuedToasts.find((toast) => sameToastKey(toast, options));
  if (duplicate) {
    duplicate.onDismiss?.("replaced");
    queuedToasts = queuedToasts.filter((toast) => toast !== duplicate);
  } else if (
    options.variant &&
    queuedToasts.filter((toast) => toast.variant).length >= TOAST_QUEUE_LIMIT
  ) {
    const active = queuedToasts.filter(isVariantToast);
    const victim = selectSaturationVictim(active, variantToast(options));
    if (!victim) {
      options.onDismiss?.("saturated");
      return;
    }
    victim.onDismiss?.("saturated");
    queuedToasts = queuedToasts.filter((toast) => toast !== victim);
  }
  queuedToasts.push(options);
}

export function showToast(options: ToastOptions): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const host = document.querySelector<OpenClawToastHost>("openclaw-toast-host");
  if (!host) {
    queueToast(options);
    return false;
  }
  const modal = activeModalToastLayer();
  if (modal && host.parentElement !== modal) {
    modal.moveBefore(host, null);
    const handoff = (event: Event) => {
      if (event.target !== modal) {
        return;
      }
      modal.removeEventListener("wa-after-hide", handoff);
      queueMicrotask(() =>
        (activeModalToastLayer() ?? document.querySelector(".shell"))?.moveBefore(host, null),
      );
    };
    modal.addEventListener("wa-after-hide", handoff);
  }
  if (!modal && options.scope) {
    const sessionHost = matchingSessionToastHost(options.scope);
    if (sessionHost) {
      return sessionHost.show(options);
    }
  }
  return presentGlobalToast(options, host);
}

function presentGlobalToast(
  options: ToastOptions,
  host = document.querySelector<OpenClawToastHost>("openclaw-toast-host"),
): boolean {
  return host?.show(options) ?? false;
}

// Guarded so DOM-free (node) consumers of send-failure surfacing can load this module.
if (typeof customElements !== "undefined" && !customElements.get("openclaw-toast-host")) {
  customElements.define("openclaw-toast-host", OpenClawToastHost);
}
if (typeof customElements !== "undefined" && !customElements.get("openclaw-session-toast-host")) {
  customElements.define("openclaw-session-toast-host", OpenClawSessionToastHost);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-toast-host": OpenClawToastHost;
    "openclaw-session-toast-host": OpenClawSessionToastHost;
  }
}
