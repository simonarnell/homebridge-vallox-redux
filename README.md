# homebridge-vallox-redux

Bring your [Vallox](https://www.vallox.com) MVHR unit into HomeKit: fan, temperatures, humidity, CO2, filter status, supply-air setpoint, fault indication, and profile switching. All device communication lives in [`vallox.js`](https://github.com/simonarnell/vallox.js); this plugin is the thin, typed Homebridge layer on top of it.

Named "Redux" to sit alongside the existing [`homebridge-vallox`](https://github.com/awaescher/homebridge-vallox) plugin, not replace it, see the comparison below if you're choosing between them.

## Why Redux

|                                        | **homebridge-vallox-redux** | [`homebridge-vallox`](https://github.com/awaescher/homebridge-vallox) |
|----------------------------------------|:---:|:---:|
| Fan power + speed                      | ✅ | ✅ |
| Temperature sensors (4x)               | ✅ | ✅ |
| Humidity sensor                        | ✅ | ✅ |
| CO2 sensor                             | ✅ *(configurable alert threshold)* | ❌ |
| Supply-air temperature setpoint control | ✅ *(Thermostat accessory)* | ❌ |
| Filter change indication               | ✅ *(configurable threshold)* | ❌ |
| Profile switches                       | Home / Away / Boost / Custom / Automatic | Away / Boost / Fireplace |
| Multiple units on one Homebridge       | ✅ *(uncommon for MVHR, but supported)* | ❌ *(`singular` platform)* |
| Configurable poll interval             | ✅ | ❌ *(polls on demand, 3s cache)* |
| Config validated at startup            | ✅ *(schema-checked, precise errors)* | ❌ |
| Critical fault logging                 | ✅ | ❌ |
| Auto-detected model/firmware           | ✅ *(read from the unit, used as the default accessory name)* | ❌ |
| Independent per-sensor room placement  | ✅ *(Supply/Outdoor/Exhaust are separate accessories)* | ❌ |
| Eve app history graphs                 | ✅ | ❌ |
| Daily clock sync (unit has no RTC/NTP) | ✅ | ❌ |

Nothing here is a knock on the original, it's a solid, minimal plugin. Redux exists because it targets a slightly wider slice of what a single unit and HAP can expose: more sensors, validated config, richer error handling, and Eve history, depth rather than breadth across many units, since most homes only ever have one.

## Installation

```bash
npm install -g homebridge-vallox-redux
```

## Configuration

Add a platform block to your Homebridge `config.json` (or configure via Homebridge UI X):

```json
{
  "platform": "ValloxRedux",
  "name": "Vallox Redux",
  "host": "192.168.1.100",
  "port": 80,
  "pollingIntervalSeconds":   30,
  "filterAlertDays": 14,
  "co2AlertPpm": 1000,
  "enableCo2Sensor": true,
  "enableHumiditySensor": true,
  "enableEveHistory": false,
  "enableDailyTimeSync": true
}
```

| Field | Default | Description |
|---|---|---|
| `host` | *(required)* | IP address or hostname of the unit's built-in web server |
| `port` | `80` | WebSocket port |
| `name` | *(auto-detected model, e.g. "Vallox 110 MV")* | Override the main accessory's display name |
| `pollingIntervalSeconds` | `30` | How often to poll the unit for state |
| `filterAlertDays` | `14` | Days remaining threshold below which HomeKit shows "Change Filter" |
| `co2AlertPpm` | `1000` | CO2 level (ppm) at which HomeKit's CarbonDioxideDetected flips to abnormal and pushes a device alert. Independent of the unit's own auto-boost trigger threshold (typically lower, and not user-configurable from this plugin) — see Limitations. |
| `enableCo2Sensor` | `true` | Expose a CO2 sensor accessory |
| `enableHumiditySensor` | `true` | Expose a humidity sensor accessory |
| `enableEveHistory` | `false` | Log temp/humidity to Eve app history graphs |
| `enableDailyTimeSync` | `true` | Sync the unit's clock to this computer's clock at startup and once every 24h |

Every field is checked against a strict schema at startup, a typo'd `port` or a missing `host` fails fast with a specific error in the Homebridge log, rather than a mysterious runtime crash.

Multiple units? Just add multiple `ValloxRedux` platform blocks, each gets its own accessory set.

## Accessories

Rather than one accessory carrying every sensor, this plugin splits the unit's four temperature readings across two kinds of accessory, based on what they physically measure and how HomeKit and Eve actually handle multi-sensor accessories in practice:

- **Main accessory** (named after the unit's own model, e.g. "Vallox 110 MV") — Fan, Custom Supply Fan, Extract Air temperature, Humidity, CO2, Filter maintenance, and the five profile switches (Home/Away/Boost/Custom/Automatic). Extract, Humidity, and CO2 stay together deliberately: they're the same physical measurement point (the extract air stream), not three unrelated readings.
- **Supply Air**, **Outdoor Air**, **Exhaust Air** — each its own single-sensor accessory. These three are genuinely different physical locations (indoor supply, outside, exhaust), and both the Home app (room reassignment) and Eve (history graphs) key their behavior off the *accessory*, not the individual service, an accessory bundling several sensors together shares one room placement and one history graph across all of them, whether that's meaningful or not. Splitting these three out gives each independent room placement and, when Eve history is enabled, its own graph. Supply Air also carries the supply air setpoint Thermostat (see Features).

## Features

- **Fan** (`Fanv2`) — power on/off and speed control for the active profile (Home/Away/Boost/Custom), plus a `StatusFault` indicator that flips when the unit reports a critical fault
- **Custom Supply Fan** (`Fanv2`) — a second fan control for Custom mode's independently-settable supply-side speed (see "Custom mode's dual fan speed" below); mirrors the main fan's power state
- **Supply air setpoint** (`Thermostat`, on the Supply Air accessory) — `TargetTemperature` reads/writes the supply-air setpoint for whichever profile (Home/Away/Boost/Custom) is currently active; `CurrentTemperature` reports the live supply air reading. `TargetHeatingCoolingState` is pinned to Heat — the unit doesn't heat or cool, this just repurposes HomeKit's Thermostat service for setpoint control, since HAP has no plain "target number" service.
- **Temperature sensors** — Supply, Extract, Outdoor, and Exhaust air temperature
- **Humidity sensor** — extract air relative humidity
- **CO2 sensor** — level (ppm) and threshold-based detected state, using the plugin's own `co2AlertPpm` config (default 1000ppm) rather than the unit's lower auto-boost trigger threshold — see Limitations. Live reading only, see Limitations also for why it isn't part of the Eve history graph.
- **Filter maintenance** — "Change Filter" indication based on days remaining
- **Profile switches** — Home / Away / Boost / Custom / Automatic, reflecting and controlling the active profile
- **Fault logging** — `getCriticalFaultActive()`/`getFaults()` are polled and logged to the Homebridge log, and surfaced in HomeKit via the main Fan's `StatusFault` characteristic
- **Model/firmware detection** — the unit's model (e.g. "Vallox 110 MV") and firmware version are read at startup and used for the main accessory's default name and its HomeKit Model/FirmwareRevision characteristics
- **Eve app history** *(opt-in)* — temperature (and humidity, on the main accessory) graphs in the Eve app, backfilled at startup from the unit's own on-device log (most recent 500 entries per accessory) rather than starting empty. Eve-only, these graphs don't appear in the stock Home app or other HomeKit clients.
- **Daily clock sync** *(on by default)* — the unit has no RTC or NTP client, so its internal clock free-runs and drifts; this syncs it to this computer's clock at startup and once every 24h, keeping the weekly schedule firing at the right hour.

### Custom mode's dual fan speed

Custom mode is the only profile where the unit supports independent extract and supply fan speeds (`getCustomExtractFanSpeed`/`getCustomSupplyFanSpeed` in `vallox.js`) rather than a single shared value. Since HomeKit's `RotationSpeed` is a single number, this plugin exposes it as two Fanv2 services: the main "Vallox Fan" controls the extract side (paired with the main accessory's own Extract Air sensor), and a second "Custom Supply Fan" service controls the supply side. Both freeze/ignore writes while a different profile is active — Home/Away/Boost only ever had one shared value, so the main fan continues to use it as before.

## Limitations

- WebSocket transport only, Modbus RTU (serial) units are not supported by this plugin.
- The Fanv2 speed slider freezes at its last known value while the unit is in the Extra or Automatic profile: the unit has no fan-speed setting for Extra/Programmable mode (only enable/duration timer registers), and Automatic adjusts fan speed itself. Custom mode is fully controllable — see "Custom mode's dual fan speed" below.
- The unit's own CO2 auto-boost trigger threshold (read via `vallox.js`'s `getCo2Threshold()`) is not exposed or configurable through this plugin — it's a device-level setting, separate from the `co2AlertPpm` HomeKit alert threshold above. Change it via the unit's own web UI/app if needed.
- CO2 is not part of the Eve history graph. Both of Eve's multi-metric graph types were tried (`'room'`'s `ppm` field, and `'room2'`'s `voc` field with CO2 fed into it), including a full remove-and-re-pair to rule out Eve caching a stale accessory-type declaration, and neither produced a graph, just a live reading with no history line. CO2 stays available as a live CarbonDioxideSensor reading; it just isn't graphed.
- Eve history backfill is capped at the 500 most recent entries per accessory. `fakegato-history` triggers a full disk rewrite of an accessory's entire history buffer on every single entry added during backfill; seeding the unit's full multi-month log (thousands of entries) across several accessories at once is enough real CPU/GC work to exhaust Node's heap. Live polling fills in the rest over time regardless.

## License

MIT
