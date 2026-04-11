'use strict';

// lib.js — Connector + shared utilities
// This file is rarely changed. App logic lives in index.js.

// URL hash flags — combine with & e.g. #dev&noconnect
// Exported as named constants for clean imports in index.js.
const _flags = new Set(location.hash.replace(/^#/, '').split('&'));
export const DEV      = _flags.has('dev');       // enables LESS watch, hiliter, verbose logging
export const NO_RETRY = _flags.has('noretry');   // one connect attempt only, then give up (no retrying)


// ---------------------------------------------------------------------------
// Utilities

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate a short random UUID-like ID. Default format: xxxxxx-xxxx-xx
export function make_uuid(parts) {
    const pad = '000000000000';
    return (parts || [3, 2, 1]).map(len => {
        const num = Math.floor(Math.random() * Math.pow(256, len));
        return (pad + num.toString(16)).slice(-len * 2);
    }).join('-');
}

// Encode a byte array (Uint8Array or similar) to lowercase hex string.
export function toHex(byteArray) {
    return Array.from(byteArray, x => x.toString(16).padStart(2, '0')).join('');
}

// Decode a hex string to Uint8Array.
export function fromHex(hex) {
    return Uint8Array.from(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
}


// ---------------------------------------------------------------------------
// Logger — timestamped console wrapper
//
// Wraps each console method to prepend HH:MM:SS.mmm local time.
// Usage:  window.console = new Logger(console);
// DISABLED: needs improvement for printing objects cleanly before enabling.
// (The native console prints objects interactively; wrapping them as
//  string args loses that, showing "[object Object]" instead.)

/*
class Logger {
    constructor(orig) {
        this.con = {
            debug: orig.debug.bind(orig),
            log:   orig.log.bind(orig),
            info:  orig.info.bind(orig),
            warn:  orig.warn.bind(orig),
            error: orig.error.bind(orig),
        };
    }

    static tzoff = (new Date).getTimezoneOffset() * 60000;
    static ts() {
        return (new Date(Date.now() - Logger.tzoff)).toJSON().slice(11, -1);
    }

    _log(level, ...args) { this.con[level](Logger.ts(), ...args); }

    debug(...args) { this._log('debug', ...args); }
    log(  ...args) { this._log('log',   ...args); }
    info( ...args) { this._log('info',  ...args); }
    warn( ...args) { this._log('warn',  ...args); }
    error(...args) { this._log('error', ...args); }
}

// To activate: window.console = new Logger(console);
*/


// ---------------------------------------------------------------------------
// get_promise — DEPRECATED in favour of native Promise.withResolvers()
//
// Creates a Promise with externally accessible resolve/reject.
// Modern equivalent (Chrome 119+, Firefox 121+):
//
//   const { promise, resolve, reject } = Promise.withResolvers();
//
// Use that instead of get_promise().

/*
function get_promise() {
    let funcs;
    const p = new Promise((resolve, reject) => { funcs = { resolve, reject }; });
    return Object.assign(p, funcs);
}
*/


// ---------------------------------------------------------------------------
// Connector
//
// Manages a WebSocket connection to the backend with automatic reconnection.
//
// Usage:
//   this.conn = new Connector(this);            // Vue instance as owner
//   this.conn.addEventListener('state', e => console.log(e.state));
//   this.conn.open('/myapp.ws');
//   this.conn.emit('hello', { name: 'world' }); // sends {_t:'hello', name:'world'}
//   this.conn.close();                          // stop reconnecting
//
// State transitions:
//   connecting → connected → reconnecting → ... → disconnected (gave up)
//
// The owner object receives inbound messages as method calls:
//   owner._msg_TYPE(msg)   called for each {_t: TYPE, ...} message received
//
// Binary messages: if a binary ArrayBuffer is received, it is held and
// attached as msg._binary to the next JSON message. To send binary, set
// data._binary = ArrayBuffer on an emit() call.

export class Connector extends EventTarget {

    // giveUpMinutes: stop retrying after this many minutes of failed attempts.
    //   Pass Infinity to retry forever.
    // noRetry: make one attempt only, then give up with a console warning.
    //   Useful with #noretry URL flag during development without a backend.
    constructor(owner, { giveUpMinutes = 15, noRetry = false } = {}) {
        super();
        this.owner = owner;
        this.giveUpMs = giveUpMinutes * 60 * 1000;
        this.noRetry = noRetry;

        this.state = 'disconnected';
        this.ws = null;
        this._binary = null;
        this._stopped = true;
    }

    // Start connecting. Call with a URL the first time; subsequent calls
    // (e.g. from a Reconnect button) reuse the stored URL.
    open(url) {
        if (url) this.url = url;
        this._stopped = false;
        this._run();
    }

    // Permanently stop — does not reconnect.
    close() {
        this._stopped = true;
        if (this.ws) this.ws.close();
    }

    // Send a message. Silent no-op if not connected.
    emit(msg, data) {
        if (!this.ws) return;
        if (data?._binary) {
            this.ws.send(data._binary);
            const { _binary, ...rest } = data;
            data = rest;
        }
        this.ws.send(JSON.stringify({ _t: msg, ...data }));
    }

    // ---- internals --------------------------------------------------------

    _setState(s) {
        this.state = s;
        const evt = new Event('state');
        evt.state = s;
        this.dispatchEvent(evt);
    }

    async _run() {
        let attempts = 0;
        let firstAttempt = true;
        let giveUpAt = Date.now() + this.giveUpMs;

        while (!this._stopped) {
            this._setState(firstAttempt ? 'connecting' : 'reconnecting');
            firstAttempt = false;

            try {
                await this._connect();
            } catch (e) {
                if (this._stopped) break;
                if (this.noRetry) {
                    console.warn('Connector: connection failed and #noretry is set — not retrying.');
                    this._setState('disconnected');
                    return;
                }
                attempts++;
                if (Date.now() >= giveUpAt) {
                    this._setState('disconnected');
                    return;
                }
                await sleep(Math.min(100 * 3 ** attempts, 15000));
                continue;
            }

            // Connected.
            this._setState('connected');
            const connectedAt = Date.now();

            try {
                await this._process();
            } catch (e) {
                if (this.ws) { this.ws.close(); this.ws = null; }
            }

            this.ws = null;
            if (this._stopped) break;

            // If we were connected long enough, reset to fast retries.
            // Don't reset the give-up clock — that would allow infinite cycling.
            if (Date.now() - connectedAt > 5000) {
                attempts = 0;
            }

            await sleep(500);
        }

        this._setState('disconnected');
    }

    _connect() {
        return new Promise((resolve, reject) => {
            const ws = this.ws = new WebSocket(this.url);
            ws.binaryType = 'arraybuffer';
            ws.onopen  = ()  => resolve();
            ws.onclose = (e) => reject(new Error(`close ${e.code}`));
            ws.onerror = ()  => reject(new Error('error'));
        });
    }

    _process() {
        return new Promise((resolve) => {
            this.ws.onmessage = (e) => this._dispatch(e.data);
            this.ws.onclose   = ()  => resolve();
            this.ws.onerror   = ()  => { this.ws.close(); };
        });
    }

    _dispatch(data) {
        if (data instanceof ArrayBuffer) {
            this._binary = data;
            return;
        }
        let msg;
        try { msg = JSON.parse(data); }
        catch (e) { console.error('bad message:', e); return; }

        if (this._binary) { msg._binary = this._binary; this._binary = null; }

        const handler = this.owner['_msg_' + msg._t];
        if (handler) {
            try { handler.call(this.owner, msg); }
            catch (e) { console.error(`_msg_${msg._t} threw:`, e); }
        } else {
            console.warn('no handler for _msg_' + msg._t);
        }
    }
}
