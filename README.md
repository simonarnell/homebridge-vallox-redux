# homebridge-vallox-redux

Bring your [Vallox](https://www.vallox.com) MVHR unit into HomeKit: fan, temperatures, humidity,
CO2, filter status, and profile switching. All device communication lives in
[`vallox.js`](https://github.com/simonarnell/vallox.js); this plugin is the thin, typed Homebridge
layer on top of it.

Named "Redux" to sit alongside the existing
[`homebridge-vallox`](https://github.com/awaescher/homebridge-vallox) plugin, not replace it, see
the comparison below if you're choosing between them.

## Why Redux

|                                        | **homebridge-vallox-redux** | [`homebridge-vallox`](https://github.com/awaescher/homebridge-vallox) |
|----------------------------------------|:---:|:---:|
| Fan power + speed                      | ✅ | ✅ |
| Temperature sensors (4x)               | ✅ | ✅ |
| Humidity sensor                        | ✅ *(toggleable)* | ✅ |
| CO2 sensor                             | ✅ *(toggleable)* | ❌ |
| Filter change indication               | ✅ *(configurable threshold)* | ❌ |
| Profile switches                       | Home / Away / Boost / Fireplace | Away / Boost / Fireplace |
| Multiple units on one Homebridge       | ✅ *(uncommon for MVHR, but supported)* | ❌ *(`singular` platform)* |
| Configurable poll interval             | ✅ | ❌ *(polls on demand, 3s cache)* |
| Config validated at startup            | ✅ *(schema-checked, precise errors)* | ❌ |
| Critical fault logging                 | ✅ | ❌ |
| Auto-detected model/firmware           | ✅ *(read from the unit, used as the default accessory name)* | ❌ |
| Independent per-sensor room placement  | ✅ *(Supply/Outdoor/Exhaust are separate accessories)* | ❌ |
| Eve app history graphs                 | ✅ *(toggleable, backfilled from the unit's own log)* | ❌ |
| Language                               | TypeScript 7, strict | TypeScript |

Nothing here is a knock on the original, it's a solid, minimal plugin. Redux exists because it
targets a slightly wider slice of what a single unit and HAP can expose: more sensors, validated
config, richer error handling, and Eve history, depth rather than breadth across many units, since
most homes only ever have one.

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
  "pollingIntervalSeconds": 30,
  "filterAlertDays": 14,
  "enableCo2Sensor": true,
  "enableHumiditySensor": true,
  "enableEveHistory": false
}
```

| Field | Default | Description |
|---|---|---|
| `host` | *(required)* | IP address or hostname of the unit's built-in web server |
| `port` | `80` | WebSocket port |
| `name` | *(auto-detected model, e.g. "Vallox 110 MV")* | Override the main accessory's display name |
| `pollingIntervalSeconds` | `30` | How often to poll the unit for state |
| `filterAlertDays` | `14` | Days remaining threshold below which HomeKit shows "Change Filter" |
| `enableCo2Sensor` | `true` | Expose a CO2 sensor accessory |
| `enableHumiditySensor` | `true` | Expose a humidity sensor accessory |
| `enableEveHistory` | `false` | Log temp/humidity to Eve app history graphs |

Every field is checked against a strict schema at startup, a typo'd `port` or a missing `host`
fails fast with a specific error in the Homebridge log, rather than a mysterious runtime crash.

Multiple units? Just add multiple `ValloxRedux` platform blocks, each gets its own accessory set.

## Accessories

Rather than one accessory carrying every sensor, this plugin splits the unit's four temperature
readings across two kinds of accessory, based on what they physically measure and how HomeKit and
Eve actually handle multi-sensor accessories in practice:

- **Main accessory** (named after the unit's own model, e.g. "Vallox 110 MV") — Fan, Extract Air
  temperature, Humidity, CO2, Filter maintenance, and the four profile switches (Home/Away/Boost/
  Fireplace). Extract, Humidity, and CO2 stay together deliberately: they're the same physical
  measurement point (the extract air stream), not three unrelated readings.
- **Supply Air**, **Outdoor Air**, **Exhaust Air** — each its own single-sensor accessory. These
  three are genuinely different physical locations (indoor supply, outside, exhaust), and both the
  Home app (room reassignment) and Eve (history graphs) key their behavior off the *accessory*,
  not the individual service, an accessory bundling several sensors together shares one room
  placement and one history graph across all of them, whether that's meaningful or not. Splitting
  these three out gives each independent room placement and, when Eve history is enabled, its own
  graph.

## Features

- **Fan** (`Fanv2`) — power on/off and speed control for the active profile (Home/Away/Boost)
- **Temperature sensors** — Supply, Extract, Outdoor, and Exhaust air temperature
- **Humidity sensor** — extract air relative humidity
- **CO2 sensor** — level (ppm) and threshold-based detected state (live reading only, see
  Limitations for why it isn't part of the Eve history graph)
- **Filter maintenance** — "Change Filter" indication based on days remaining
- **Profile switches** — Home / Away / Boost / Fireplace, reflecting and controlling the active profile
- **Model/firmware detection** — the unit's model (e.g. "Vallox 110 MV") and firmware version are
  read at startup and used for the main accessory's default name and its HomeKit
  Model/FirmwareRevision characteristics
- **Eve app history** *(opt-in)* — temperature (and humidity, on the main accessory) graphs in the
  Eve app, backfilled at startup from the unit's own on-device log (most recent 500 entries per
  accessory) rather than starting empty. Eve-only, these graphs don't appear in the stock Home app
  or other HomeKit clients.

## Limitations

- WebSocket transport only, Modbus RTU (serial) units are not supported by this plugin.
- No supply-air-temperature setpoint control (no Thermostat accessory) in this version.
- Unit faults (`getCriticalFaultActive`/`getFaults`) are logged to the Homebridge log only,
  there's no HomeKit-visible fault indicator yet.
- The Fanv2 speed slider freezes at its last known value while the unit is in the Fireplace or
  Extra profile, since the library has no fan-speed getter/setter for those profiles.
- CO2 is not part of the Eve history graph. Both of Eve's multi-metric graph types were tried
  (`'room'`'s `ppm` field, and `'room2'`'s `voc` field with CO2 fed into it), including a full
  remove-and-re-pair to rule out Eve caching a stale accessory-type declaration, and neither
  produced a graph, just a live reading with no history line. CO2 stays available as a live
  CarbonDioxideSensor reading; it just isn't graphed.
- Eve history backfill is capped at the 500 most recent entries per accessory. `fakegato-history`
  triggers a full disk rewrite of an accessory's entire history buffer on every single entry added
  during backfill; seeding the unit's full multi-month log (thousands of entries) across several
  accessories at once is enough real CPU/GC work to exhaust Node's heap. Live polling fills in the
  rest over time regardless.

## License

MIT
