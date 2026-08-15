/// <reference types="node" />
import {EventEmitter} from 'node:events';

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
         * additional certificate check: `'lg'` (chain must contain LG's intermediate CA),
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
        /** client key file, default `~/.lgtv2/keyfile-<host>` (or $LGTV2_KEY_DIR) */
        keyFile?: string;
        /** custom key storage */
        saveKey?: (key: string, cb: (err?: Error | null) => void) => void;
        /** supply the client key directly */
        clientKey?: string;
        /** MAC address for `wake()` */
        mac?: string;
        /** options for the underlying `websocket` client, merged over the defaults */
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
        close: (event?: any) => void;
        error: (err: Error) => void;
        message: (raw: any) => void;
        certificate: (info: {fingerprint: string; stored: boolean}) => void;
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
    clientKey: string | undefined;
    wsconfig: Record<string, any>;

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

    wake(mac?: string, options?: LGTV.WakeOptions): Promise<void>;
    wake(options: LGTV.WakeOptions): Promise<void>;
    wake(mac: string | undefined, options: LGTV.WakeOptions, cb: (err?: Error | null) => void): void;

    connect(url?: string): void;
    register(): void;
    disconnect(): Promise<void>;
    disconnect(cb: () => void): void;

    on<E extends keyof LGTV.Events>(event: E, listener: LGTV.Events[E]): this;
    once<E extends keyof LGTV.Events>(event: E, listener: LGTV.Events[E]): this;
    off<E extends keyof LGTV.Events>(event: E, listener: LGTV.Events[E]): this;

    /** send a Wake-on-LAN magic packet */
    static wake(mac: string, options?: LGTV.WakeOptions): Promise<void>;
    static wake(mac: string, options: LGTV.WakeOptions, cb: (err?: Error | null) => void): void;
    static readonly LG_ISSUER_FINGERPRINTS: string[];
    static readonly POWER_STATES: Record<string, LGTV.PowerState>;
}

export = LGTV;
