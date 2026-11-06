import streamDeck, {
    action,
    type DialAction,
    type DialDownEvent,
    type DialRotateEvent,
    type DialUpEvent,
    type DidReceiveSettingsEvent,
    type KeyAction,
    type KeyDownEvent,
    type KeyUpEvent,
    type PropertyInspectorDidAppearEvent,
    type SendToPluginEvent,
    SingletonAction,
    type TouchTapEvent,
    type WillAppearEvent,
    type WillDisappearEvent
} from "@elgato/streamdeck";

import { bridge, BridgeError, type Context, type ViewEvent, type ViewState, type VolumeResult } from "../bridge";
import { loadingImage, offlineImage, pickUserImage } from "../fallback";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue; };

// ── settings ────────────────────────────────────────────────────────────────

type PressAction = "mute" | "reset" | "none";

export type Settings = {
    userId?: string;
    /** cached for the offline image */
    userName?: string;
    context?: Context;
    showName?: boolean;

    // key
    tapAction?: PressAction;
    doubleTapAction?: PressAction;
    /** %/s when a hold starts */
    rampStart?: number;
    /** %/s after rampAccel seconds */
    rampTop?: number;
    rampAccel?: number;
    holdDelay?: number;
    doubleTapWindow?: number;
    keyDetent?: boolean;

    // dial
    dialStep?: number;
    dialAccel?: "off" | "low" | "normal" | "high";
    dialPressedStep?: number;
    dialPress?: PressAction;
    dialLongPress?: PressAction;
    touchTap?: PressAction;
    touchHold?: PressAction;
    dialDetent?: boolean;
};

const DEFAULTS: Required<Omit<Settings, "userId" | "userName">> = {
    context: "default",
    showName: false,
    tapAction: "mute",
    doubleTapAction: "reset",
    rampStart: 5,
    rampTop: 40,
    rampAccel: 2.5,
    holdDelay: 300,
    doubleTapWindow: 300,
    keyDetent: true,
    dialStep: 1,
    dialAccel: "normal",
    dialPressedStep: 10,
    dialPress: "mute",
    dialLongPress: "reset",
    touchTap: "mute",
    touchHold: "reset",
    dialDetent: true
};

const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? v as T : d);
const PRESS = ["mute", "reset", "none"] as const;

function resolve(s: Settings) {
    return {
        userId: typeof s.userId === "string" && /^\d{15,22}$/.test(s.userId) ? s.userId : null,
        userName: typeof s.userName === "string" ? s.userName : undefined,
        context: pick(s.context, ["default", "stream"] as const, DEFAULTS.context),
        showName: typeof s.showName === "boolean" ? s.showName : DEFAULTS.showName,
        tapAction: pick(s.tapAction, PRESS, DEFAULTS.tapAction),
        doubleTapAction: pick(s.doubleTapAction, PRESS, DEFAULTS.doubleTapAction),
        rampStart: num(s.rampStart, 1, 200, DEFAULTS.rampStart),
        rampTop: num(s.rampTop, 1, 400, DEFAULTS.rampTop),
        rampAccel: num(s.rampAccel, 0, 10, DEFAULTS.rampAccel),
        holdDelay: num(s.holdDelay, 120, 1000, DEFAULTS.holdDelay),
        doubleTapWindow: num(s.doubleTapWindow, 120, 800, DEFAULTS.doubleTapWindow),
        keyDetent: typeof s.keyDetent === "boolean" ? s.keyDetent : DEFAULTS.keyDetent,
        dialStep: num(s.dialStep, 0.5, 20, DEFAULTS.dialStep),
        dialAccel: pick(s.dialAccel, ["off", "low", "normal", "high"] as const, DEFAULTS.dialAccel),
        dialPressedStep: num(s.dialPressedStep, 1, 50, DEFAULTS.dialPressedStep),
        dialPress: pick(s.dialPress, PRESS, DEFAULTS.dialPress),
        dialLongPress: pick(s.dialLongPress, PRESS, DEFAULTS.dialLongPress),
        touchTap: pick(s.touchTap, PRESS, DEFAULTS.touchTap),
        touchHold: pick(s.touchHold, PRESS, DEFAULTS.touchHold),
        dialDetent: typeof s.dialDetent === "boolean" ? s.dialDetent : DEFAULTS.dialDetent
    };
}
type Resolved = ReturnType<typeof resolve>;

// ── tuning ──────────────────────────────────────────────────────────────────

/** The 100 % "detent": holds and dials stop there briefly. */
const DETENT = 100;
const RAMP_TICK_MS = 30;
const RAMP_DETENT_PAUSE_MS = 500;
const DIAL_DETENT_LOCK_MS = 350;
const DIAL_LONG_PRESS_MS = 600;
const DIAL_RATE_WINDOW_MS = 300;
const DIAL_MAX_MULT = 10;
const ACCEL_K = { off: 0, low: 0.5, normal: 1, high: 2 } as const;
const MIN_DRAW_MS = 40;

// ── per-instance state ──────────────────────────────────────────────────────

interface Ramp {
    dir: 1 | -1;
    t0: number;
    last: number;
    pauseUntil: number;
    timer: NodeJS.Timeout;
}

interface Inst {
    id: string;
    action: KeyAction<Settings> | DialAction<Settings>;
    dial: boolean;
    raw: Settings;
    s: Resolved;

    state: ViewState | null;
    image: string | null;
    drawn: string | null;
    drawTimer: NodeJS.Timeout | null;
    lastDraw: number;

    // adjust queue: one request in flight, deltas pile up meanwhile
    pending: number;
    inflight: boolean;
    detent: boolean;

    // key gestures
    phase: "idle" | "first" | "wait" | "second";
    holdTimer: NodeJS.Timeout | null;
    tapTimer: NodeJS.Timeout | null;
    holdFired: boolean;
    ramp: Ramp | null;

    // dial
    ticks: { t: number; n: number; }[];
    lastDir: number;
    detentLockUntil: number;
    detentDir: number;
    longTimer: NodeJS.Timeout | null;
    longFired: boolean;
    rotatedWhilePressed: boolean;
}

@action({ UUID: "com.darkside1305.user-volume.volume" })
export class UserVolumeAction extends SingletonAction<Settings> {
    private insts = new Map<string, Inst>();

    constructor() {
        super();
        bridge.on("view", (ev: ViewEvent) => {
            const inst = this.insts.get(ev.id);
            if (!inst) return;
            inst.state = ev.state;
            if (ev.image) inst.image = ev.image;
            // Remember the name for the offline image.
            if (ev.state?.known && ev.state.name && ev.state.name !== inst.s.userName) {
                inst.raw = { ...inst.raw, userName: ev.state.name };
                inst.s = resolve(inst.raw);
                inst.action.setSettings(inst.raw).catch(() => { });
            }
            this.draw(inst);
        });
        bridge.on("status", () => {
            for (const inst of this.insts.values()) {
                if (bridge.status === "offline") this.stopGestures(inst);
                this.draw(inst);
            }
        });
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    override onWillAppear(ev: WillAppearEvent<Settings>): void {
        const raw = ev.payload.settings ?? {};
        const inst: Inst = {
            id: ev.action.id,
            action: ev.action as KeyAction<Settings> | DialAction<Settings>,
            dial: ev.action.isDial(),
            raw,
            s: resolve(raw),
            state: null,
            image: null,
            drawn: null,
            drawTimer: null,
            lastDraw: 0,
            pending: 0,
            inflight: false,
            detent: false,
            phase: "idle",
            holdTimer: null,
            tapTimer: null,
            holdFired: false,
            ramp: null,
            ticks: [],
            lastDir: 0,
            detentLockUntil: 0,
            detentDir: 0,
            longTimer: null,
            longFired: false,
            rotatedWhilePressed: false
        };
        this.insts.set(inst.id, inst);
        this.applySettings(inst);
    }

    override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
        const inst = this.insts.get(ev.action.id);
        if (!inst) return;
        this.stopGestures(inst);
        if (inst.drawTimer) clearTimeout(inst.drawTimer);
        bridge.removeView(inst.id);
        this.insts.delete(inst.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
        const inst = this.insts.get(ev.action.id);
        if (!inst) return;
        const userChanged = (ev.payload.settings?.userId ?? null) !== (inst.raw.userId ?? null);
        inst.raw = ev.payload.settings ?? {};
        inst.s = resolve(inst.raw);
        if (userChanged) {
            inst.state = null;
            inst.image = null;
        }
        this.applySettings(inst);
    }

    private applySettings(inst: Inst): void {
        const s = inst.s;
        if (s.userId) {
            bridge.setView({ id: inst.id, userId: s.userId, context: s.context, kind: inst.dial ? "strip" : "key", look: { showName: s.showName } });
        } else {
            bridge.removeView(inst.id);
        }
        if (inst.dial) {
            const label = (a: PressAction) => (a === "mute" ? "Mute" : a === "reset" ? "100 %" : "–");
            (inst.action as DialAction<Settings>).setTriggerDescription({
                rotate: "Volume (faster = bigger steps)",
                push: `${label(s.dialPress)} · hold: ${label(s.dialLongPress)}`,
                touch: `${label(s.touchTap)} · hold: ${label(s.touchHold)}`,
                longTouch: label(s.touchHold)
            }).catch(() => { });
        }
        this.draw(inst);
    }

    // ── drawing ─────────────────────────────────────────────────────────────

    private imageFor(inst: Inst): string {
        if (!inst.s.userId) return pickUserImage(inst.dial);
        if (bridge.status !== "online") return offlineImage(inst.state?.name ?? inst.s.userName, inst.dial);
        return inst.image ?? loadingImage(inst.s.userName, inst.dial);
    }

    /** Coalesced: at most one image per MIN_DRAW_MS, always the newest. */
    private draw(inst: Inst): void {
        if (inst.drawTimer) return;
        const wait = Math.max(0, inst.lastDraw + MIN_DRAW_MS - Date.now());
        inst.drawTimer = setTimeout(() => {
            inst.drawTimer = null;
            if (!this.insts.has(inst.id)) return;
            const img = this.imageFor(inst);
            if (img === inst.drawn) return;
            inst.drawn = img;
            inst.lastDraw = Date.now();
            const p = inst.action.isKey()
                ? inst.action.setImage(img)
                : (inst.action as DialAction<Settings>).setFeedback({ canvas: img });
            p.catch(e => streamDeck.logger.warn(`Drawing failed: ${e?.message ?? e}`));
        }, wait);
    }

    // ── commands ────────────────────────────────────────────────────────────

    private usable(inst: Inst): boolean {
        if (!inst.s.userId || bridge.status !== "online") {
            inst.action.showAlert().catch(() => { });
            return false;
        }
        return true;
    }

    private fail(inst: Inst, e: unknown): void {
        streamDeck.logger.warn(`Command failed: ${(e as Error)?.message ?? e}`);
        inst.action.showAlert().catch(() => { });
        if (e instanceof BridgeError && e.offline) bridge.reconnectNow();
    }

    private async press(inst: Inst, what: PressAction): Promise<void> {
        if (what === "none" || !this.usable(inst)) return;
        const { userId, context } = inst.s;
        try {
            if (what === "mute") await bridge.mute(userId!, context);
            else await bridge.set(userId!, context, 100);
        } catch (e) {
            this.fail(inst, e);
        }
    }

    private queueAdjust(inst: Inst, delta: number, detent: boolean): void {
        if (!inst.s.userId) return;
        inst.pending += delta;
        inst.detent = detent;
        void this.flush(inst);
    }

    private async flush(inst: Inst): Promise<void> {
        if (inst.inflight || Math.abs(inst.pending) < 0.01 || !inst.s.userId) return;
        const delta = inst.pending;
        inst.pending = 0;
        inst.inflight = true;
        let r: VolumeResult | null = null;
        try {
            r = await bridge.adjust(inst.s.userId, inst.s.context, delta, inst.detent ? DETENT : undefined);
        } catch (e) {
            inst.pending = 0;
            this.stopRamp(inst);
            this.fail(inst, e);
        } finally {
            inst.inflight = false;
        }
        if (r) {
            if (r.hitDetent) {
                inst.pending = 0;
                this.onDetent(inst, Math.sign(delta));
            } else if (r.atLimit && inst.ramp) {
                this.stopRamp(inst);
            }
        }
        if (Math.abs(inst.pending) >= 0.01) void this.flush(inst);
    }

    private onDetent(inst: Inst, dir: number): void {
        const now = Date.now();
        if (inst.ramp) {
            // Rest at 100 %, then start gently again.
            inst.ramp.pauseUntil = now + RAMP_DETENT_PAUSE_MS;
            inst.ramp.t0 = inst.ramp.pauseUntil;
            inst.ramp.last = inst.ramp.pauseUntil;
        } else {
            inst.detentLockUntil = now + DIAL_DETENT_LOCK_MS;
            inst.detentDir = dir;
        }
    }

    // ── key: tap / double tap / hold / double-tap-and-hold ───────────────────

    override onKeyDown(ev: KeyDownEvent<Settings>): void {
        const inst = this.insts.get(ev.action.id);
        if (!inst || !this.usable(inst)) return;
        if (inst.tapTimer) {
            clearTimeout(inst.tapTimer);
            inst.tapTimer = null;
        }
        if (inst.holdTimer) clearTimeout(inst.holdTimer);
        inst.holdFired = false;

        const second = inst.phase === "wait";
        inst.phase = second ? "second" : "first";
        inst.holdTimer = setTimeout(() => {
            inst.holdTimer = null;
            inst.holdFired = true;
            this.startRamp(inst, second ? -1 : 1);
        }, inst.s.holdDelay);
    }

    override onKeyUp(ev: KeyUpEvent<Settings>): void {
        const inst = this.insts.get(ev.action.id);
        if (!inst) return;
        if (inst.holdTimer) {
            clearTimeout(inst.holdTimer);
            inst.holdTimer = null;
        }
        if (inst.holdFired || inst.ramp) {
            this.stopRamp(inst);
            inst.holdFired = false;
            inst.phase = "idle";
            return;
        }
        if (inst.phase === "first") {
            inst.phase = "wait";
            inst.tapTimer = setTimeout(() => {
                inst.tapTimer = null;
                inst.phase = "idle";
                void this.press(inst, inst.s.tapAction);
            }, inst.s.doubleTapWindow);
        } else if (inst.phase === "second") {
            inst.phase = "idle";
            void this.press(inst, inst.s.doubleTapAction);
        } else {
            inst.phase = "idle";
        }
    }

    private startRamp(inst: Inst, dir: 1 | -1): void {
        this.stopRamp(inst);
        const now = Date.now();
        inst.ramp = { dir, t0: now, last: now, pauseUntil: 0, timer: setInterval(() => this.rampTick(inst), RAMP_TICK_MS) };
    }

    private rampTick(inst: Inst): void {
        const r = inst.ramp;
        if (!r) return;
        const now = Date.now();
        if (now < r.pauseUntil) {
            r.last = now;
            return;
        }
        const { rampStart, rampAccel } = inst.s;
        const top = Math.max(rampStart, inst.s.rampTop);
        const x = rampAccel > 0 ? Math.min(1, Math.max(0, (now - r.t0) / (rampAccel * 1000))) : 1;
        const ease = x * x * (3 - 2 * x); // smoothstep: soft start, soft arrival at top speed
        const speed = rampStart + (top - rampStart) * ease;
        const dt = Math.min(200, now - r.last);
        r.last = now;
        if (dt <= 0) return;
        this.queueAdjust(inst, r.dir * speed * dt / 1000, inst.s.keyDetent);
    }

    private stopRamp(inst: Inst): void {
        if (!inst.ramp) return;
        clearInterval(inst.ramp.timer);
        inst.ramp = null;
    }

    private stopGestures(inst: Inst): void {
        this.stopRamp(inst);
        for (const t of [inst.holdTimer, inst.tapTimer, inst.longTimer]) if (t) clearTimeout(t);
        inst.holdTimer = inst.tapTimer = inst.longTimer = null;
        inst.phase = "idle";
        inst.holdFired = false;
        inst.pending = 0;
    }

    // ── dial ────────────────────────────────────────────────────────────────

    override onDialRotate(ev: DialRotateEvent<Settings>): void {
        const inst = this.insts.get(ev.action.id);
        if (!inst || !inst.s.userId || bridge.status !== "online") return;
        const { ticks, pressed } = ev.payload;
        if (!ticks) return;
        const now = Date.now();
        const dir = Math.sign(ticks);

        let delta: number;
        if (pressed) {
            // Pressed + turn: coarse jumps, no acceleration, no long-press.
            inst.rotatedWhilePressed = true;
            if (inst.longTimer) {
                clearTimeout(inst.longTimer);
                inst.longTimer = null;
            }
            delta = ticks * inst.s.dialPressedStep;
        } else {
            // Speed = ticks per second over the last 300 ms, same direction only.
            if (dir !== inst.lastDir) inst.ticks = [];
            inst.lastDir = dir;
            inst.ticks.push({ t: now, n: Math.abs(ticks) });
            inst.ticks = inst.ticks.filter(x => now - x.t <= DIAL_RATE_WINDOW_MS);
            const count = inst.ticks.reduce((a, x) => a + x.n, 0);
            const rate = count / (DIAL_RATE_WINDOW_MS / 1000);
            const k = ACCEL_K[inst.s.dialAccel];
            const mult = Math.min(DIAL_MAX_MULT, 1 + k * Math.pow(rate / 10, 1.5));
            delta = ticks * inst.s.dialStep * mult;
        }

        if (now < inst.detentLockUntil && dir === inst.detentDir) return;
        this.queueAdjust(inst, delta, inst.s.dialDetent && !pressed);
    }

    override onDialDown(ev: DialDownEvent<Settings>): void {
        const inst = this.insts.get(ev.action.id);
        if (!inst) return;
        inst.rotatedWhilePressed = false;
        inst.longFired = false;
        if (inst.longTimer) clearTimeout(inst.longTimer);
        inst.longTimer = setTimeout(() => {
            inst.longTimer = null;
            inst.longFired = true;
            void this.press(inst, inst.s.dialLongPress);
        }, DIAL_LONG_PRESS_MS);
    }

    override onDialUp(ev: DialUpEvent<Settings>): void {
        const inst = this.insts.get(ev.action.id);
        if (!inst) return;
        if (inst.longTimer) {
            clearTimeout(inst.longTimer);
            inst.longTimer = null;
        }
        if (!inst.longFired && !inst.rotatedWhilePressed) void this.press(inst, inst.s.dialPress);
        inst.longFired = false;
        inst.rotatedWhilePressed = false;
    }

    override onTouchTap(ev: TouchTapEvent<Settings>): void {
        const inst = this.insts.get(ev.action.id);
        if (!inst) return;
        void this.press(inst, ev.payload.hold ? inst.s.touchHold : inst.s.touchTap);
    }

    // ── property inspector ──────────────────────────────────────────────────

    override onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<Settings>): void {
        void this.sendStatus();
    }

    private async sendStatus(): Promise<void> {
        await streamDeck.ui.sendToPropertyInspector({
            type: "status",
            status: bridge.status,
            port: bridge.port,
            info: (bridge.info ?? null) as JsonValue
        });
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
        const msg = (ev.payload ?? {}) as { type?: string; id?: string; port?: number; };
        const reply = (p: Record<string, JsonValue>) => streamDeck.ui.sendToPropertyInspector(p);
        try {
            switch (msg.type) {
                case "status":
                    return await this.sendStatus();
                case "suggestions": {
                    const data = await bridge.request("GET", "/suggestions");
                    return await reply({ type: "suggestions", ok: true, data });
                }
                case "lookup": {
                    const id = String(msg.id ?? "");
                    const data = await bridge.request("GET", `/user?id=${encodeURIComponent(id)}`, undefined, 8000);
                    return await reply({ type: "lookup", ok: true, data });
                }
                case "setPort": {
                    const port = Number(msg.port);
                    const g = await streamDeck.settings.getGlobalSettings<{ port?: number; }>();
                    await streamDeck.settings.setGlobalSettings({ ...g, port });
                    bridge.setPort(port);
                    return await this.sendStatus();
                }
                case "reconnect":
                    bridge.reconnectNow();
                    return await this.sendStatus();
            }
        } catch (e) {
            await reply({ type: msg.type ?? "error", ok: false, error: String((e as Error)?.message ?? e) });
        }
    }
}
