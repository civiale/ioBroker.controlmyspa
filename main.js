'use strict';

/*
 * ioBroker.controlmyspa
 * Balboa ControlMySpa (CMS) über die Cloud in ioBroker einbinden.
 */

const utils = require('@iobroker/adapter-core');
const { CmsClient, fToC, cToF } = require('./lib/cmsClient');

const MIN_POLL_S = 30;
const DEFAULT_POLL_S = 120;
const MAX_BACKOFF_S = 900;
const COMMAND_SETTLE_MS = 6000; // Spa braucht einige Sekunden, bis ein Befehl wirkt
const STEP_DELAY_MS = 4000; // Pause zwischen Pumpen-Stufen
const MAX_STEPS = 4;
const PUMP_CYCLE = ['OFF', 'LOW', 'HIGH'];
const CONTROLLABLE = { PUMP: 'jet', BLOWER: 'blower', LIGHT: 'light' };
const MIN_TEMP_C = 10;
const MAX_TEMP_C = 40;

class ControlMySpa extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'controlmyspa' });
        this.client = null;
        this.spas = new Map(); // id -> { base, dashboard }
        this.createdObjects = new Set();
        this.pollTimer = null;
        this.settleTimers = new Map();
        this.componentQueues = new Map();
        this.failures = 0;
        this.unloading = false;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);

        const { email, password } = this.config;
        if (!email || !password) {
            this.log.error('E-Mail und Passwort in der Instanz-Konfiguration eintragen.');
            return;
        }
        this.pollSeconds = Math.max(MIN_POLL_S, Number(this.config.pollInterval) || DEFAULT_POLL_S);

        this.client = new CmsClient(
            email,
            password,
            { debug: m => this.log.debug(m), warn: m => this.log.warn(m) },
            process.env.CMS_BASE_URL,
        );

        this.subscribeStates('*');
        await this.discover();
        await this.pollAll();
    }

    async discover() {
        try {
            const spas = await this.client.getSpas();
            if (!spas.length) {
                this.log.warn('Keine Spas im ControlMySpa-Konto gefunden.');
            }
            for (const spa of spas) {
                const base = this.sanitize(spa._id);
                this.spas.set(spa._id, { base, dashboard: null });
                await this.ensureObject(base, 'device', spa.alias || spa.serialNumber || spa._id, {});
                await this.createSpaObjects(base);
                await this.setStateChangedAsync(`${base}.info.alias`, spa.alias || '', true);
                await this.setStateChangedAsync(`${base}.info.serialNumber`, spa.serialNumber || '', true);
                this.log.info(`Spa gefunden: ${spa.alias || spa.serialNumber || spa._id}`);
            }
        } catch (e) {
            this.log.error(`Spa-Erkennung fehlgeschlagen: ${e.message}`);
        }
    }

    // ---------- Polling ----------

    async pollAll() {
        if (this.unloading) {
            return;
        }
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (!this.spas.size) {
            await this.discover();
        }
        let ok = this.spas.size > 0;
        for (const spaId of this.spas.keys()) {
            ok = (await this.pollSpa(spaId)) && ok;
        }

        if (ok) {
            if (this.failures > 0) {
                this.log.info('Verbindung zur ControlMySpa-Cloud wiederhergestellt.');
            }
            this.failures = 0;
        } else {
            this.failures++;
        }
        await this.setStateChangedAsync('info.connection', ok, true);

        const delay = ok
            ? this.pollSeconds
            : Math.min(MAX_BACKOFF_S, this.pollSeconds * 2 ** Math.min(this.failures, 4));
        this.pollTimer = this.setTimeout(() => this.pollAll(), delay * 1000);
    }

    /** @returns {Promise<boolean>} */
    async pollSpa(spaId) {
        const spa = this.spas.get(spaId);
        try {
            const d = await this.client.getDashboard(spaId);
            spa.dashboard = d;
            await this.applyDashboard(spa.base, d);
            return true;
        } catch (e) {
            // Erste Störung als Warnung, Wiederholungen nur im Debug
            const level = this.failures === 0 ? 'warn' : 'debug';
            this.log[level](`Abfrage fehlgeschlagen: ${e.message}`);
            return false;
        }
    }

    async applyDashboard(base, d) {
        const set = (id, val) => this.setStateChangedAsync(`${base}.${id}`, val, true);

        await set('info.online', d.isOnline !== false);
        await set('info.firmware', (d.systemInfo && d.systemInfo.controllerSoftwareVersion) || '');
        await set('info.totalAlerts', Number(d.totalAlerts) || 0);
        await set('info.fault', d.currentFaultMessage ? JSON.stringify(d.currentFaultMessage) : '');
        await set('info.displayCelsius', !!d.isCelsius);
        await set('info.lastUpdate', Date.now());
        await set('info.raw', JSON.stringify(d));

        await set('temperature.current', fToC(d.currentTemp, 0.1));
        const target = fToC(d.desiredTemp, 0.5);
        await set('temperature.target', target === null ? null : clamp(target, MIN_TEMP_C, MAX_TEMP_C));
        await set('heater.mode', d.heaterMode || '');
        await set('heater.tempRange', d.tempRange || '');
        await set('panelLocked', !!d.isPanelLocked);

        for (const c of d.components || []) {
            const key = componentKey(c);
            if (!key) {
                continue;
            }
            const id = `components.${key}`;
            await this.ensureComponentObjects(base, id, c);
            const value = c.value === undefined || c.value === null ? '' : String(c.value);
            await set(`${id}.state`, value);
            await set(`${id}.on`, value !== '' && value !== 'OFF');
        }
    }

    // ---------- Befehle ----------

    async onStateChange(id, state) {
        if (!state || state.ack || !this.client) {
            return;
        }
        const rel = id.substring(this.namespace.length + 1);
        const [base, ...rest] = rel.split('.');
        const path = rest.join('.');
        const spaId = [...this.spas.entries()].find(([, s]) => s.base === base)?.[0];
        if (!spaId) {
            return;
        }

        try {
            if (path === 'temperature.target') {
                const c = clamp(Math.round(Number(state.val) * 2) / 2, MIN_TEMP_C, MAX_TEMP_C);
                const f = cToF(c);
                this.log.info(`Solltemperatur ${c} °C (${f} °F)`);
                await this.client.setDesiredTemp(spaId, f);
            } else if (path === 'heater.mode') {
                const mode = String(state.val).toUpperCase();
                if (mode !== 'READY' && mode !== 'REST') {
                    throw new Error(`Ungültiger Heizmodus "${state.val}" (READY oder REST)`);
                }
                this.log.info(`Heizmodus ${mode}`);
                await this.client.setHeaterMode(spaId, mode);
            } else if (path === 'panelLocked') {
                this.log.info(`Bedienpanel ${state.val ? 'sperren' : 'entsperren'}`);
                await this.client.setPanelLock(spaId, !!state.val);
            } else if (path === 'refresh') {
                await this.setStateAsync(id, false, true);
                await this.pollSpa(spaId);
                return;
            } else if (path.startsWith('components.') && (path.endsWith('.state') || path.endsWith('.on'))) {
                const key = rest[1];
                await this.handleComponentWrite(spaId, key, path.endsWith('.on') ? 'on' : 'state', state.val);
            } else {
                return;
            }
            this.scheduleSettle(spaId);
        } catch (e) {
            this.log.error(`Befehl für ${path} fehlgeschlagen: ${e.message}`);
            this.scheduleSettle(spaId); // ioBroker wieder auf den echten Zustand bringen
        }
    }

    async handleComponentWrite(spaId, key, kind, val) {
        const comp = this.findComponent(spaId, key);
        if (!comp) {
            throw new Error(`Komponente ${key} unbekannt`);
        }
        const apiType = CONTROLLABLE[comp.componentType];
        if (!apiType || comp.port === undefined || comp.port === null) {
            throw new Error(`${key} ist nicht schaltbar`);
        }
        const available = comp.availableValues || [];
        let target;
        if (kind === 'on') {
            target = val ? 'HIGH' : 'OFF';
        } else {
            target = String(val).toUpperCase();
            if (!['OFF', 'LOW', 'HIGH'].includes(target) || (available.length && !available.includes(target))) {
                throw new Error(`Ungültiger Wert "${val}" für ${key} (erlaubt: ${available.join(', ') || 'OFF, HIGH'})`);
            }
        }

        // Pro Komponente seriell abarbeiten
        const qKey = `${spaId}/${key}`;
        const prev = this.componentQueues.get(qKey) || Promise.resolve();
        const next = prev
            .catch(() => undefined)
            .then(() => (isTwoSpeed(comp) ? this.walkToState(spaId, key, apiType, target) : this.sendComponent(spaId, key, apiType, comp.port, target)));
        this.componentQueues.set(qKey, next);
        await next;
    }

    async sendComponent(spaId, key, apiType, port, target) {
        this.log.info(`${key} -> ${target}`);
        await this.client.setComponentState(spaId, apiType, port, target);
    }

    /**
     * Zweistufige Pumpen bewegen sich pro Befehl höchstens eine Stufe im Zyklus
     * OFF -> LOW -> HIGH -> OFF. Darum Schritt für Schritt bis zum Ziel.
     */
    async walkToState(spaId, key, apiType, target) {
        for (let i = 0; i < MAX_STEPS && !this.unloading; i++) {
            await this.pollSpa(spaId);
            const comp = this.findComponent(spaId, key);
            const current = comp && comp.value;
            if (current === target) {
                return;
            }
            const pos = PUMP_CYCLE.indexOf(current);
            const step = pos === -1 ? target : PUMP_CYCLE[(pos + 1) % PUMP_CYCLE.length];
            if (step !== target) {
                this.log.info(`${key}: ${current} -> ${step} (unterwegs zu ${target})`);
            }
            await this.sendComponent(spaId, key, apiType, comp.port, step);
            await this.sleep(STEP_DELAY_MS);
        }
    }

    scheduleSettle(spaId) {
        const t = this.settleTimers.get(spaId);
        if (t) {
            this.clearTimeout(t);
        }
        this.settleTimers.set(
            spaId,
            this.setTimeout(() => {
                this.settleTimers.delete(spaId);
                this.pollSpa(spaId);
            }, COMMAND_SETTLE_MS),
        );
    }

    findComponent(spaId, key) {
        const d = this.spas.get(spaId)?.dashboard;
        return ((d && d.components) || []).find(c => componentKey(c) === key);
    }

    // ---------- Objekte ----------

    async createSpaObjects(base) {
        const ch = (id, name) => this.ensureObject(`${base}.${id}`, 'channel', name, {});
        const st = (id, common) => this.ensureObject(`${base}.${id}`, 'state', common.name, common);

        await ch('info', 'Informationen');
        await st('info.alias', { name: 'Name', type: 'string', role: 'info.name', read: true, write: false });
        await st('info.serialNumber', { name: 'Seriennummer', type: 'string', role: 'info.serial', read: true, write: false });
        await st('info.online', { name: 'Spa online', type: 'boolean', role: 'indicator.reachable', read: true, write: false });
        await st('info.firmware', { name: 'Controller-Firmware', type: 'string', role: 'info.firmware', read: true, write: false });
        await st('info.totalAlerts', { name: 'Anzahl Meldungen', type: 'number', role: 'value', read: true, write: false });
        await st('info.fault', { name: 'Aktuelle Störung (JSON)', type: 'string', role: 'json', read: true, write: false });
        await st('info.displayCelsius', { name: 'Spa-Anzeige in °C', type: 'boolean', role: 'indicator', read: true, write: false });
        await st('info.lastUpdate', { name: 'Letzte Aktualisierung', type: 'number', role: 'value.time', read: true, write: false });
        await st('info.raw', { name: 'Dashboard roh (JSON)', type: 'string', role: 'json', read: true, write: false });

        await ch('temperature', 'Temperatur');
        await st('temperature.current', { name: 'Wassertemperatur', type: 'number', role: 'value.temperature', unit: '°C', read: true, write: false });
        await st('temperature.target', {
            name: 'Solltemperatur',
            type: 'number',
            role: 'level.temperature',
            unit: '°C',
            min: MIN_TEMP_C,
            max: MAX_TEMP_C,
            step: 0.5,
            read: true,
            write: true,
        });

        await ch('heater', 'Heizung');
        await st('heater.mode', {
            name: 'Heizmodus',
            type: 'string',
            role: 'level.mode',
            states: { READY: 'READY', REST: 'REST' },
            read: true,
            write: true,
        });
        await st('heater.tempRange', { name: 'Temperaturbereich', type: 'string', role: 'text', read: true, write: false });

        await st('panelLocked', { name: 'Bedienpanel gesperrt', type: 'boolean', role: 'switch.lock', read: true, write: true });
        await st('refresh', { name: 'Jetzt aktualisieren', type: 'boolean', role: 'button', read: false, write: true, def: false });
        await ch('components', 'Komponenten');
    }

    async ensureComponentObjects(base, id, c) {
        const full = `${base}.${id}`;
        if (this.createdObjects.has(full)) {
            return;
        }
        const label = c.name || `${c.componentType}${c.port !== undefined && c.port !== null ? ` ${Number(c.port) + 1}` : ''}`;
        const writable = !!CONTROLLABLE[c.componentType] && c.port !== undefined && c.port !== null;
        const values = (c.availableValues && c.availableValues.length ? c.availableValues : null);

        await this.ensureObject(full, 'channel', label, {});
        await this.ensureObject(`${full}.state`, 'state', `${label} Zustand`, {
            name: `${label} Zustand`,
            type: 'string',
            role: writable ? 'level.mode' : 'text',
            read: true,
            write: writable,
            ...(values ? { states: Object.fromEntries(values.map(v => [v, v])) } : {}),
        });
        await this.ensureObject(`${full}.on`, 'state', `${label} ein`, {
            name: `${label} ein`,
            type: 'boolean',
            role: writable ? (c.componentType === 'LIGHT' ? 'switch.light' : 'switch') : 'indicator',
            read: true,
            write: writable,
        });
    }

    async ensureObject(id, type, name, common) {
        if (this.createdObjects.has(id)) {
            return;
        }
        await this.extendObjectAsync(id, { type, common: { ...common, name }, native: {} });
        this.createdObjects.add(id);
    }

    sanitize(s) {
        return String(s).replace(this.FORBIDDEN_CHARS, '_').replace(/[.\s]/g, '_');
    }

    sleep(ms) {
        return new Promise(resolve => this.setTimeout(resolve, ms));
    }

    onUnload(callback) {
        try {
            this.unloading = true;
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
            }
            for (const t of this.settleTimers.values()) {
                this.clearTimeout(t);
            }
            callback();
        } catch {
            callback();
        }
    }
}

function componentKey(c) {
    if (!c || !c.componentType) {
        return null;
    }
    const type = String(c.componentType).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    return c.port !== undefined && c.port !== null && c.port !== '' ? `${type}_${c.port}` : type;
}

function isTwoSpeed(c) {
    return c.componentType !== 'LIGHT' && (c.availableValues || []).includes('LOW');
}

function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
}

if (require.main !== module) {
    module.exports = options => new ControlMySpa(options);
} else {
    new ControlMySpa();
}
