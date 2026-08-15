import {EventEmitter} from 'node:events';
import type {ClientOptions} from 'ws';

declare namespace LGTV {
    type Callback<T = any> = (err: Error | null | undefined, result?: T) => void;

    interface Options {
        /** hostname or IP of the TV; used with `secure`/`port`/`ports` to build the URL */
        host?: string;
        /** `true` → wss://host:3001, `false` → ws://host:3000; omitted → try both, wss first */
        secure?: boolean;
        /** fixed port (disables the automatic fallback) */
        port?: number;
        /** ports used for wss/ws, default `{secure: 3001, insecure: 3000}` */
        ports?: {secure?: number; insecure?: number};
        /** complete websocket URL; takes precedence over host/secure/port */
        url?: string;
        /** verify the TV's TLS certificate against public CAs, default false */
        rejectUnauthorized?: boolean;
        /**
         * additional certificate check: `'lg'` (chain must contain LG's TV certificate or intermediate CA),
         * `'tofu'` (pin the first seen certificate in `certFile`), or one/several SHA-256 fingerprints
         */
        verifyCert?: false | 'lg' | 'tofu' | string | string[];
        /** file for the tofu fingerprint, default `<keyFile>.cert` */
        certFile?: string;
        /** request timeout in ms, default 15000 */
        timeout?: number;
        /** websocket handshake timeout in ms, default 10000, 0 disables */
        handshakeTimeout?: number;
        /** reconnect interval in ms, default 5000; false/0 disables */
        reconnect?: number | false;
        /** ping the TV regularly and drop the connection when it stops answering, default true */
        keepalive?: boolean;
        /** ms between pings, default 10000 */
        keepaliveInterval?: number;
        /** ms to wait for the pong, default 5000 */
        keepaliveGracePeriod?: number;
        /** client key file, default `~/.lgtv2/keyfile-<host>` (or $LGTV2_KEY_DIR) */
        keyFile?: string;
        /** custom key storage */
        saveKey?: (key: string, cb: (err?: Error | null) => void) => void;
        /** supply the client key directly */
        clientKey?: string;
        /** MAC address for `wake()`; overrides the MACs learned from the TV */
        mac?: string;
        /** learn wired/Wi-Fi MACs from the TV after pairing and cache them in `macFile`, default true */
        learnMac?: boolean;
        /** file for the learned MACs, default `<keyFile>.mac` */
        macFile?: string;
        /** extra options for the underlying `ws` client (e.g. `ca`, `cert`, `headers`) */
        wsOptions?: ClientOptions;
        /** @deprecated 1.x name: keepalive settings and `tlsOptions` are still understood */
        wsconfig?: Record<string, any>;
    }

    interface WakeOptions {
        /** default '255.255.255.255' */
        address?: string;
        /** default 9 */
        port?: number;
        /** packets to send, default 3 */
        count?: number;
        /** ms between packets, default 100 */
        interval?: number;
    }

    type PowerState = 'on' | 'standby' | 'screen_off' | 'screen_saver' | 'off' | 'unknown';

    interface PowerStateResult {
        state: PowerState;
        raw: any;
    }

    interface SpecializedSocket {
        send(type: string, payload?: Record<string, string | number>): void;
        close(): void;
    }

    interface SsapError extends Error {
        code: 'ESSAP';
        errorCode?: number | string;
        errorText?: string;
        payload?: any;
    }

    interface Events {
        connecting: (url: string) => void;
        prompt: () => void;
        connect: () => void;
        close: (info: {code: number; reason: string}) => void;
        error: (err: Error) => void;
        /** every raw frame received from the TV, as text */
        message: (raw: string) => void;
        certificate: (info: {fingerprint: string; stored: boolean}) => void;
        mac: (macs: {wired?: string; wifi?: string}) => void;
    }
}

declare class LGTV extends EventEmitter {
    constructor(options?: LGTV.Options);

    /** URLs that will be tried, in order */
    readonly urls: string[];
    /** true while connected and paired */
    readonly connected: boolean;
    readonly keyFile: string | undefined;
    readonly certFile: string;
    readonly macFile: string;
    /** MACs learned from the TV */
    readonly macs: {wired?: string; wifi?: string};
    /** MAC `wake()` will use first: the `mac` option, else the learned wired, else Wi-Fi MAC */
    readonly mac: string | undefined;
    clientKey: string | undefined;
    readonly wsOptions: ClientOptions;
    readonly keepalive: {keepalive: boolean; keepaliveInterval: number; keepaliveGracePeriod: number};

    request<T = any>(uri: string, payload?: Record<string, any>): Promise<T>;
    request<T = any>(uri: string, cb: LGTV.Callback<T>): string | undefined;
    request<T = any>(uri: string, payload: Record<string, any>, cb: LGTV.Callback<T>): string | undefined;

    subscribe<T = any>(uri: string, cb: LGTV.Callback<T>): string | undefined;
    subscribe<T = any>(uri: string, payload: Record<string, any>, cb: LGTV.Callback<T>): string | undefined;
    unsubscribe(id: string): boolean;

    send(
        type: 'request' | 'subscribe' | 'register',
        uri: string | undefined,
        payload?: any,
        cb?: LGTV.Callback,
    ): string | undefined;

    getSocket(uri: string): Promise<LGTV.SpecializedSocket>;
    getSocket(uri: string, cb: LGTV.Callback<LGTV.SpecializedSocket>): void;

    getPowerState(): Promise<LGTV.PowerStateResult>;
    getPowerState(cb: LGTV.Callback<LGTV.PowerStateResult>): void;
    subscribePowerState(cb: LGTV.Callback<LGTV.PowerStateResult>): string | undefined;

    /** without `mac`: the `mac` option, or every MAC learned from the TV */
    wake(mac?: string | string[], options?: LGTV.WakeOptions): Promise<void>;
    wake(options: LGTV.WakeOptions): Promise<void>;
    wake(mac: string | string[] | undefined, options: LGTV.WakeOptions, cb: (err?: Error | null) => void): void;

    connect(url?: string): void;
    register(): void;
    disconnect(): Promise<void>;
    disconnect(cb: () => void): void;

    on<E extends keyof LGTV.Events>(event: E, listener: LGTV.Events[E]): this;
    once<E extends keyof LGTV.Events>(event: E, listener: LGTV.Events[E]): this;
    off<E extends keyof LGTV.Events>(event: E, listener: LGTV.Events[E]): this;

    /** send a Wake-on-LAN magic packet */
    static wake(mac: string | string[], options?: LGTV.WakeOptions): Promise<void>;
    static wake(mac: string | string[], options: LGTV.WakeOptions, cb: (err?: Error | null) => void): void;
    static readonly LG_ISSUER_FINGERPRINTS: string[];
    static readonly POWER_STATES: Record<string, LGTV.PowerState>;
}

/** `LGTV.wake` as a named export */
declare function wake(mac: string | string[], options?: LGTV.WakeOptions): Promise<void>;
declare function wake(mac: string | string[], options: LGTV.WakeOptions, cb: (err?: Error | null) => void): void;
declare const LG_ISSUER_FINGERPRINTS: string[];
declare const POWER_STATES: Record<string, LGTV.PowerState>;

export default LGTV;
export {LGTV, wake, LG_ISSUER_FINGERPRINTS, POWER_STATES};
