import streamDeck from "@elgato/streamdeck";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";

/**
 * Connection to the UserVolumeDeck Vencord plugin (native.ts) on
 * 127.0.0.1:<port>.
 *
 * - One Server-Sent-Events stream (/events) carries finished images + state
 *   for every visible key / dial ("view" events). Reconnects with backoff when
 *   Discord is closed.
 * - Every visible action is a "view"; the full list is posted to /views
 *   whenever it changes, after (re)connecting, after Discord reloads ("reset")
 *   and every 30 s as a safety net (cheap: unchanged views aren't re-sent).
 * - Commands (/adjust, /set, /mute, /suggestions, /user) are plain JSON calls.
 */

export const DEFAULT_PORT = 37321;

export type Context = "default" | "stream";

export interface ViewState {
    userId: string;
    known: boolean;
    name: string;
    username: string;
    volume: number;
    max: number;
    muted: boolean;
    speaking: boolean;
    inCall: boolean;
}

export interface ViewSpec {
    id: string;
    userId: string;
    context: Context;
    kind: "key" | "strip";
    look: { showName: boolean; };
}

export interface ViewEvent {
    id: string;
    state: ViewState | null;
    image: string | null;
}

export interface VolumeResult {
    userId: string;
    context: Context;
    volume: number;
    max: number;
    muted: boolean;
    hitDetent?: boolean;
    atLimit?: boolean;
}

export type Status = "offline" | "online";

export class BridgeError extends Error {
    constructor(message: string, readonly offline = false) {
        super(message);
    }
}

class Bridge extends EventEmitter {
    readonly client = `sd-${randomBytes(6).toString("hex")}`;
    port = DEFAULT_PORT;
    status: Status = "offline";
    /** what /status said last (max volume, scale, …) */
    info: Record<string, unknown> | null = null;

    private views = new Map<string, ViewSpec>();
    private stream: http.ClientRequest | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pushTimer: NodeJS.Timeout | null = null;
    private safetyTimer: NodeJS.Timeout | null = null;
    private backoff = 500;
    private agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    private started = false;

    start(): void {
        if (this.started) return;
        this.started = true;
        this.connect();
        this.safetyTimer = setInterval(() => {
            if (this.status === "online" && this.views.size) this.schedulePush();
        }, 30_000);
    }

    setPort(port: number): void {
        const p = Number.isInteger(port) && port > 1024 && port < 65536 ? port : DEFAULT_PORT;
        if (p === this.port) return;
        this.port = p;
        streamDeck.logger.info(`Port changed to ${p}, reconnecting`);
        this.reconnectNow();
    }

    reconnectNow(): void {
        this.backoff = 500;
        this.stream?.destroy();
        this.stream = null;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.connect();
    }

    // ── views ───────────────────────────────────────────────────────────────

    setView(spec: ViewSpec): void {
        const old = this.views.get(spec.id);
        if (old && JSON.stringify(old) === JSON.stringify(spec)) return;
        this.views.set(spec.id, spec);
        this.schedulePush();
    }

    removeView(id: string): void {
        if (this.views.delete(id)) this.schedulePush();
    }

    private schedulePush(): void {
        if (this.pushTimer) return;
        this.pushTimer = setTimeout(() => {
            this.pushTimer = null;
            if (this.status !== "online") return;
            this.request("POST", "/views", { client: this.client, views: [...this.views.values()] }).catch(e => {
                streamDeck.logger.warn(`Could not send views: ${e?.message ?? e}`);
            });
        }, 25);
    }

    // ── event stream ────────────────────────────────────────────────────────

    private setStatus(s: Status): void {
        if (s === this.status) return;
        this.status = s;
        streamDeck.logger.info(`Discord bridge ${s}`);
        this.emit("status", s);
    }

    private connect(): void {
        const req = http.get({
            host: "127.0.0.1",
            port: this.port,
            path: `/events?client=${this.client}`,
            headers: { Accept: "text/event-stream" },
            agent: false
        });
        this.stream = req;

        const fail = () => {
            if (this.stream !== req) return;
            this.stream = null;
            this.setStatus("offline");
            if (this.reconnectTimer) return;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.connect();
            }, this.backoff);
            this.backoff = Math.min(this.backoff * 2, 5000);
        };

        req.on("response", res => {
            if (res.statusCode !== 200) {
                res.resume();
                req.destroy();
                fail();
                return;
            }
            res.setEncoding("utf8");
            // Pings arrive every 15 s; silence for 40 s means the stream is dead.
            res.socket?.setTimeout(40_000, () => req.destroy());
            this.backoff = 500;
            this.setStatus("online");
            this.schedulePush();
            this.refreshInfo();

            let buf = "";
            res.on("data", (chunk: string) => {
                buf += chunk;
                let i: number;
                while ((i = buf.indexOf("\n\n")) >= 0) {
                    const block = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    this.onBlock(block);
                }
            });
            res.on("end", fail);
            res.on("close", fail);
            res.on("error", fail);
        });
        req.on("error", fail);
    }

    private onBlock(block: string): void {
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) return;
        let payload: any;
        try {
            payload = JSON.parse(data.join("\n"));
        } catch {
            return;
        }
        switch (event) {
            case "view":
                this.emit("view", payload as ViewEvent);
                break;
            case "hello":
                this.info = payload;
                this.emit("info", payload);
                break;
            case "reset":
                // Discord reloaded: send the views again.
                this.schedulePush();
                this.refreshInfo();
                break;
            case "status":
                if (payload?.renderer === false) streamDeck.logger.info("Discord is running but the plugin isn't ready yet");
                break;
        }
    }

    private refreshInfo(): void {
        this.request<Record<string, unknown>>("GET", "/status")
            .then(info => {
                this.info = info;
                this.emit("info", info);
            })
            .catch(() => { /* not ready yet */ });
    }

    // ── requests ────────────────────────────────────────────────────────────

    request<T = any>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 3000): Promise<T> {
        return new Promise((resolve, reject) => {
            const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
            const req = http.request({
                host: "127.0.0.1",
                port: this.port,
                method,
                path,
                agent: this.agent,
                headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}
            }, res => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (c: string) => { text += c; });
                res.on("end", () => {
                    let json: any = null;
                    try {
                        json = JSON.parse(text);
                    } catch { /* not JSON */ }
                    if ((res.statusCode ?? 500) >= 400) return reject(new BridgeError(json?.error ?? `HTTP ${res.statusCode}`, res.statusCode === 503));
                    if (json && typeof json === "object" && "error" in json && json.error) return reject(new BridgeError(String(json.error)));
                    resolve(json as T);
                });
                res.on("error", e => reject(new BridgeError(e.message)));
            });
            req.setTimeout(timeoutMs, () => req.destroy(new Error("Timed out")));
            req.on("error", e => reject(new BridgeError(`Discord not reachable (${(e as NodeJS.ErrnoException).code ?? e.message})`, true)));
            if (data) req.write(data);
            req.end();
        });
    }

    adjust(userId: string, context: Context, delta: number, detent?: number): Promise<VolumeResult> {
        return this.request("POST", "/adjust", { userId, context, delta, detent });
    }

    set(userId: string, context: Context, volume: number): Promise<VolumeResult> {
        return this.request("POST", "/set", { userId, context, volume });
    }

    mute(userId: string, context: Context, mode: "toggle" | "on" | "off" = "toggle"): Promise<VolumeResult> {
        return this.request("POST", "/mute", { userId, context, mode });
    }
}

export const bridge = new Bridge();
