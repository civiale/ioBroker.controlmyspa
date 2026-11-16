'use strict';

/**
 * Client für die ControlMySpa-Cloud (iot.controlmyspa.com).
 *
 * Endpunkte und Verhalten nachgebildet nach dem API-Client von
 * @homebridge-plugins/homebridge-controlmyspa (ISC-Lizenz, (c) 2026 bwp91),
 * der wiederum auf der Protokoll-Dokumentation von @haresik basiert.
 *
 * Wichtig: Die API arbeitet immer in Fahrenheit, unabhängig von der
 * Anzeigeeinheit des Spas.
 */

const DEFAULT_BASE_URL = 'https://iot.controlmyspa.com';
const REQUEST_TIMEOUT_MS = 30000;
const TOKEN_LIFETIME_S = 3600;
// Die API erwartet den User-Agent der offiziellen App
const USER_AGENT = 'cms/34 CFNetwork/3826.500.111.2.2 Darwin/24.4.0';

class CmsClient {
    /**
     * @param {string} email
     * @param {string} password
     * @param {{debug: Function, warn: Function}} log
     * @param {string} [baseUrl]
     */
    constructor(email, password, log, baseUrl) {
        this.email = email;
        this.password = password;
        this.log = log;
        this.baseUrl = baseUrl || DEFAULT_BASE_URL;
        this.token = null;
        this.tokenTs = 0;
        this.inflightLogin = null;
    }

    isLoggedIn() {
        return !!this.token && this.tokenTs + (TOKEN_LIFETIME_S - 60) * 1000 > Date.now();
    }

    async login() {
        if (this.inflightLogin) {
            return this.inflightLogin;
        }
        this.inflightLogin = (async () => {
            const { status, body } = await this.request('POST', '/auth/login', {
                email: this.email,
                password: this.password,
            });
            if (status < 200 || status >= 400) {
                throw new Error(
                    `Login fehlgeschlagen (HTTP ${status})${[400, 401].includes(status) ? ' – E-Mail/Passwort prüfen' : ''}`,
                );
            }
            const token = body && body.data && body.data.accessToken;
            if (!token) {
                throw new Error('Login-Antwort enthält kein Access-Token');
            }
            this.token = token;
            this.tokenTs = Date.now();
            this.log.debug('Bei ControlMySpa angemeldet');
        })();
        try {
            await this.inflightLogin;
        } finally {
            this.inflightLogin = null;
        }
    }

    async authed(method, path, payload) {
        if (!this.isLoggedIn()) {
            await this.login();
        }
        let res = await this.request(method, path, payload, this.token);
        if (res.status === 401) {
            this.log.debug('Token abgelehnt, melde neu an');
            this.token = null;
            await this.login();
            res = await this.request(method, path, payload, this.token);
        }
        return res;
    }

    /** @returns {Promise<Array<{_id: string, alias?: string, serialNumber?: string}>>} */
    async getSpas() {
        const { status, body } = await this.authed('GET', '/spas/owned');
        if (status < 200 || status >= 400) {
            throw new Error(`Spa-Liste fehlgeschlagen (HTTP ${status})`);
        }
        return (body && body.data && body.data.spas) || [];
    }

    async getDashboard(spaId) {
        const { status, body } = await this.authed('GET', `/spas/${encodeURIComponent(spaId)}/dashboard`);
        if (status < 200 || status >= 400) {
            throw new Error(`Dashboard-Abfrage fehlgeschlagen (HTTP ${status})`);
        }
        if (!body || !body.data) {
            throw new Error('Dashboard-Antwort ohne Daten');
        }
        return body.data;
    }

    async command(endpoint, spaId, data) {
        const { status, body } = await this.authed('POST', `/spa-commands/${endpoint}`, {
            spaId,
            via: 'MOBILE',
            ...data,
        });
        if (status < 200 || status >= 400) {
            const msg = body && typeof body.message === 'string' ? `: ${body.message}` : '';
            throw new Error(`Befehl ${endpoint} fehlgeschlagen (HTTP ${status})${msg}`);
        }
    }

    /** @param {number} tempF Solltemperatur in °F */
    setDesiredTemp(spaId, tempF) {
        return this.command('temperature/value', spaId, { value: tempF });
    }

    /** @param {'READY'|'REST'} mode */
    setHeaterMode(spaId, mode) {
        return this.command('temperature/heater-mode', spaId, { mode });
    }

    /**
     * @param {'jet'|'blower'|'light'} componentType
     * @param {string|number} deviceNumber Port laut Dashboard
     * @param {'OFF'|'LOW'|'HIGH'} state
     */
    setComponentState(spaId, componentType, deviceNumber, state) {
        return this.command('component-state', spaId, {
            deviceNumber: Number.parseInt(String(deviceNumber), 10),
            componentType,
            state,
        });
    }

    setPanelLock(spaId, locked) {
        return this.command('panel/state', spaId, { state: locked ? 'LOCK_PANEL' : 'UNLOCK_PANEL' });
    }

    async request(method, path, payload, token) {
        const headers = {
            Accept: '*/*',
            'Accept-Language': 'en-GB,en;q=0.9',
            'User-Agent': USER_AGENT,
        };
        if (payload !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
        let res;
        try {
            res = await fetch(this.baseUrl + path, {
                method,
                headers,
                body: payload !== undefined ? JSON.stringify(payload) : undefined,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (e) {
            if (e && e.name === 'TimeoutError') {
                throw new Error(`Timeout nach ${REQUEST_TIMEOUT_MS / 1000}s bei ${path}`);
            }
            throw e;
        }
        const text = await res.text();
        let body = {};
        try {
            body = text ? JSON.parse(text) : {};
        } catch {
            // Manche Fehlerantworten sind kein JSON
        }
        return { status: res.status, body };
    }
}

/** °F (API) -> °C, 0 bedeutet "kein Messwert" */
function fToC(value, step = 0.1) {
    const f = typeof value === 'string' ? Number.parseFloat(value) : value;
    if (f === undefined || f === null || Number.isNaN(f) || f === 0) {
        return null;
    }
    const c = ((f - 32) * 5) / 9;
    return Number((Math.round(c / step) * step).toFixed(2));
}

/** °C -> °F, auf 0.5 °F gerundet (wie die App) */
function cToF(c) {
    return Math.round(((c * 9) / 5 + 32) * 2) / 2;
}

module.exports = { CmsClient, fToC, cToF };
