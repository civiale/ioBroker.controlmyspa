# ioBroker.controlmyspa

Balboa-Whirlpools mit **ControlMySpa** (CMS, z. B. Gateway Ultra 59303 / WLAN-Modul 59304)
über die ControlMySpa-Cloud in ioBroker steuern.

> Inoffizieller Adapter, nicht von Balboa. Die Cloud-API ist nicht dokumentiert und kann sich ändern.
> API-Verhalten nachgebildet nach `@homebridge-plugins/homebridge-controlmyspa` (ISC, bwp91).

## Voraussetzungen
- Spa ist in der ControlMySpa-App eingerichtet und funktioniert dort
- ioBroker mit js-controller ≥ 5, Node.js ≥ 20

## Installation (ohne offizielles Repo)

**Variante A – GitHub (privates oder öffentliches Repo)**
1. Ordner als Repo `ioBroker.controlmyspa` auf GitHub pushen
2. ioBroker Admin → Adapter → Symbol «Katze/GitHub» → «Benutzerdefiniert» → Repo-URL eintragen
   (oder im Container: `iobroker url https://github.com/<user>/ioBroker.controlmyspa`)
3. Instanz hinzufügen

**Variante B – Tarball direkt im Docker-Container**
```bash
# auf dem Rechner mit dem Quellcode
npm pack                          # erzeugt iobroker.controlmyspa-0.1.0.tgz
# Datei in ein Volume des ioBroker-Containers kopieren, dann im Container:
cd /opt/iobroker
npm install /pfad/iobroker.controlmyspa-0.1.0.tgz --omit=dev
iobroker upload controlmyspa
iobroker add controlmyspa
```

## Konfiguration
- E-Mail / Passwort des ControlMySpa-Kontos (Passwort wird verschlüsselt gespeichert)
- Abfrageintervall: Standard 120 s, Minimum 30 s. Bei Fehlern verlängert sich das Intervall automatisch (max. 15 min).

## Datenpunkte (pro Spa: `controlmyspa.0.<spaId>.`)

| Datenpunkt | Typ | Schreibbar | Beschreibung |
|---|---|---|---|
| `temperature.current` | number °C | – | Wassertemperatur |
| `temperature.target` | number °C | ✔ | Solltemperatur (10–40, Schritt 0.5) |
| `heater.mode` | string | ✔ | `READY` / `REST` |
| `heater.tempRange` | string | – | `HIGH` / `LOW` |
| `panelLocked` | boolean | ✔ | Bedienpanel sperren |
| `refresh` | button | ✔ | Sofort neu abfragen |
| `components.<typ>_<port>.state` | string | ✔* | z. B. `OFF` / `LOW` / `HIGH` |
| `components.<typ>_<port>.on` | boolean | ✔* | ein/aus (ein = `HIGH`) |
| `info.online`, `info.firmware`, `info.fault`, `info.totalAlerts`, `info.lastUpdate`, `info.raw` | | – | Status / Diagnose |

\* schaltbar sind `PUMP`, `BLOWER`, `LIGHT`. Andere Komponenten (Heizer, Umwälzpumpe, Ozon …) nur lesend.

**Zweistufige Pumpen:** Die Cloud bewegt die Pumpe pro Befehl nur eine Stufe
(OFF → LOW → HIGH → OFF). Der Adapter geht automatisch Schritt für Schritt zum Ziel
(4 s Pause pro Schritt), z. B. OFF → HIGH dauert ca. 8 s.

**Hinweis:** Befehle werden von der Cloud sofort quittiert, das Spa setzt sie aber erst
nach einigen Sekunden um. Der Adapter fragt 6 s nach einem Befehl automatisch neu ab;
erst dann werden die Werte mit `ack=true` bestätigt.

## Test ohne echtes Spa
```bash
node test/mockTest.js
```
