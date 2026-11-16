'use strict';
/*
 * Offline-Test: simulierte ControlMySpa-Cloud + Fake-adapter-core.
 * Aufruf: node test/mockTest.js
 */
const http = require('node:http');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const assert = require('node:assert');

// ---------- Fake-Cloud ----------
const spaState = {
    currentTemp: '98.6',
    desiredTemp: '100',
    isCelsius: true,
    isOnline: true,
    isPanelLocked: false,
    heaterMode: 'REST',
    tempRange: 'HIGH',
    systemInfo: { controllerSoftwareVersion: 'M100_226 V43' },
    totalAlerts: 0,
    components: [
        { componentType: 'HEATER', port: '0', value: 'OFF' },
        { componentType: 'PUMP', port: '0', value: 'OFF', availableValues: ['OFF', 'LOW', 'HIGH'] },
        { componentType: 'PUMP', port: '1', value: 'OFF', availableValues: ['OFF', 'HIGH'] },
        { componentType: 'LIGHT', port: '0', value: 'OFF', availableValues: ['OFF', 'HIGH'] },
        { componentType: 'CIRCULATION_PUMP', port: null, value: 'HIGH' },
    ],
};
const commands = [];
const CYCLE = ['OFF', 'LOW', 'HIGH'];

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
        const json = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        if (req.url === '/auth/login') {
            const b = JSON.parse(body);
            return b.password === 'geheim' ? json(200, { data: { accessToken: 'tok' } }) : json(401, {});
        }
        if (req.headers.authorization !== 'Bearer tok') {
            return json(401, {});
        }
        if (req.url === '/spas/owned') {
            return json(200, { data: { spas: [{ _id: 'abc123', alias: 'Whirlpool', serialNumber: 'SN1' }] } });
        }
        if (req.url === '/spas/abc123/dashboard') {
            return json(200, { data: spaState });
        }
        if (req.url.startsWith('/spa-commands/')) {
            const b = JSON.parse(body);
            commands.push({ ep: req.url.replace('/spa-commands/', ''), ...b });
            const ep = req.url.replace('/spa-commands/', '');
            if (ep === 'temperature/value') spaState.desiredTemp = String(b.value);
            if (ep === 'temperature/heater-mode') spaState.heaterMode = b.mode;
            if (ep === 'panel/state') spaState.isPanelLocked = b.state === 'LOCK_PANEL';
            if (ep === 'component-state') {
                const type = { jet: 'PUMP', blower: 'BLOWER', light: 'LIGHT' }[b.componentType];
                const c = spaState.components.find(x => x.componentType === type && Number(x.port) === b.deviceNumber);
                if (c.availableValues.includes('LOW')) {
                    // echtes Verhalten: max. ein Schritt im Zyklus
                    c.value = CYCLE[(CYCLE.indexOf(c.value) + 1) % 3];
                } else {
                    c.value = b.state;
                }
            }
            return json(200, {});
        }
        json(404, {});
    });
});

// ---------- Fake adapter-core ----------
const states = {};
const objects = {};
class FakeAdapter extends EventEmitter {
    constructor(opts) {
        super();
        this.namespace = `${opts.name}.0`;
        this.config = { email: 'a@b.ch', password: 'geheim', pollInterval: 600 };
        this.FORBIDDEN_CHARS = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;
        this.log = {
            info: m => console.log('  [info]', m),
            warn: m => console.log('  [warn]', m),
            error: m => console.log('  [ERROR]', m),
            debug: () => {},
        };
        this.timers = new Set();
    }
    full(id) {
        return id.startsWith(this.namespace) ? id : `${this.namespace}.${id}`;
    }
    async setStateAsync(id, val, ack) {
        states[this.full(id)] = { val, ack };
    }
    async setStateChangedAsync(id, val, ack) {
        states[this.full(id)] = { val, ack };
    }
    async extendObjectAsync(id, obj) {
        objects[this.full(id)] = obj;
    }
    subscribeStates() {}
    setTimeout(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, ms);
        this.timers.add(t);
        return t;
    }
    clearTimeout(t) {
        clearTimeout(t);
        this.timers.delete(t);
    }
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...args) {
    if (req === '@iobroker/adapter-core') return 'fake-core';
    return origResolve.call(this, req, ...args);
};
require.cache['fake-core'] = { id: 'fake-core', filename: 'fake-core', loaded: true, exports: { Adapter: FakeAdapter } };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const S = id => states[`controlmyspa.0.abc123.${id}`]?.val;
const write = (adapter, id, val) => adapter.onStateChange(`controlmyspa.0.abc123.${id}`, { val, ack: false });

(async () => {
    await new Promise(r => server.listen(0, r));
    process.env.CMS_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const adapter = require('../main.js')({});
    adapter.emit('ready');
    await sleep(500);

    console.log('Polling:');
    assert.strictEqual(states['controlmyspa.0.info.connection'].val, true);
    assert.strictEqual(S('temperature.current'), 37);
    assert.strictEqual(S('temperature.target'), 38);
    assert.strictEqual(S('heater.mode'), 'REST');
    assert.strictEqual(S('components.pump_0.state'), 'OFF');
    assert.strictEqual(S('components.circulation_pump.on'), true);
    assert.strictEqual(objects['controlmyspa.0.abc123.components.circulation_pump.state'].common.write, false);
    assert.strictEqual(objects['controlmyspa.0.abc123.components.pump_0.state'].common.write, true);
    console.log('  ok');

    console.log('Temperatur + Heizmodus + Panel:');
    await write(adapter, 'temperature.target', 37.5);
    await write(adapter, 'heater.mode', 'READY');
    await write(adapter, 'panelLocked', true);
    assert.deepStrictEqual(commands.find(c => c.ep === 'temperature/value').value, 99.5);
    await sleep(6500); // settle-Poll
    assert.strictEqual(S('temperature.target'), 37.5);
    assert.strictEqual(S('heater.mode'), 'READY');
    assert.strictEqual(S('panelLocked'), true);
    console.log('  ok');

    console.log('Zweistufige Pumpe OFF -> HIGH (Schrittweise):');
    commands.length = 0;
    await write(adapter, 'components.pump_0.state', 'HIGH');
    const steps = commands.filter(c => c.ep === 'component-state').map(c => c.state);
    assert.deepStrictEqual(steps, ['LOW', 'HIGH']);
    console.log('  Schritte:', steps.join(' -> '), ' ok');

    console.log('Einstufige Pumpe + Licht über .on:');
    commands.length = 0;
    await write(adapter, 'components.pump_1.on', true);
    await write(adapter, 'components.light_0.on', true);
    assert.deepStrictEqual(commands.map(c => [c.componentType, c.deviceNumber, c.state]), [
        ['jet', 1, 'HIGH'],
        ['light', 0, 'HIGH'],
    ]);
    console.log('  ok');

    console.log('Ungültige Werte:');
    commands.length = 0;
    await write(adapter, 'components.pump_1.state', 'LOW'); // nicht verfügbar
    await write(adapter, 'heater.mode', 'TURBO');
    await write(adapter, 'components.circulation_pump.on', false); // nicht schaltbar
    assert.strictEqual(commands.length, 0);
    console.log('  ok (abgelehnt)');

    adapter.emit('unload', () => {});
    for (const t of adapter.timers) clearTimeout(t);
    server.close();
    console.log('\nAlle Tests bestanden.');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
