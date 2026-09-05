# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-09-05

### Fixed

- The Supply Air Setpoint `Thermostat`'s `TargetHeatingCoolingState` started at HAP-NodeJS's default value (`0`/Off), which isn't in the `validValues` this plugin restricts it to (`[HEAT]`) — logged a "not contained in valid values array" warning on every startup. Now explicitly initialized to `HEAT`.

## [0.2.0] - 2026-08-31

### Added

- Daily clock sync (`enableDailyTimeSync`, on by default): the unit has no RTC or NTP client, so its internal clock free-runs and drifts, which throws off when the weekly schedule fires. Syncs the unit's clock to this computer's clock (`vallox.js`'s `getDeviceTime()`/`setDeviceTime()`) once at startup and once every 24h, and logs the drift each time.
- `co2AlertPpm` config option (default `1000`), controlling the HomeKit CO2 alert threshold independently of the unit's own auto-boost trigger.

### Changed

- `vallox.js` bumped to `^1.7.1`, correcting several `FAULT_DESCRIPTIONS` entries against the unit's actual firmware text — affects the fault descriptions this plugin logs when `getCriticalFaultActive()`/`getFaults()` reports an active fault.

### Fixed

- The CO2 sensor's `CarbonDioxideDetected` characteristic (which iOS uses to push a device notification) was driven by the unit's own auto-boost trigger threshold (`getCo2Threshold()`, typically ~800ppm and tuned to kick the fan up proactively), not a health-relevant "this needs attention" level — a routine, brief boost-range reading paged a phone as if it were a real air-quality problem. Now uses the new `co2AlertPpm` config option (default 1000ppm) instead, entirely independent of the device's own boost threshold.

## [0.1.0] - 2026-08-31

Initial release.

### Added

- `ValloxRedux` Homebridge platform, built on [`vallox.js`](https://github.com/simonarnell/vallox.js)'s WebSocket transport.
- Fan (`Fanv2`) — power on/off and speed control for the active profile (Home/Away/Boost/Custom), plus a `StatusFault` characteristic driven by the unit's critical fault state.
- Custom Supply Fan (`Fanv2`) — a second fan service for Custom mode's independently-settable supply-side speed, alongside the main fan's extract-side speed.
- Supply air setpoint (`Thermostat`, on the Supply Air accessory) — `TargetTemperature` read/write for the active profile's supply-air setpoint (Home/Away/Boost/Custom); `TargetHeatingCoolingState` pinned to Heat since the unit doesn't heat/cool.
- Temperature sensors — Supply, Extract, Outdoor, and Exhaust air temperature, split across a main accessory (Extract) and three satellite accessories (Supply/Outdoor/Exhaust) for independent room placement and Eve history graphs.
- Humidity sensor (toggleable) and CO2 sensor (toggleable) — extract air readings.
- Filter maintenance — "Change Filter" indication based on a configurable days-remaining threshold.
- Profile switches — Home / Away / Boost / Custom / Automatic, reflecting and controlling the active profile.
- Model/firmware detection, read from the unit at startup and used for the main accessory's default name and HomeKit characteristics.
- Eve app history graphs (opt-in), backfilled at startup from the unit's own on-device log.
- Config validated against a strict schema at startup, with precise startup errors rather than a mysterious runtime crash.
- Critical fault logging to the Homebridge log, and a HomeKit-visible `StatusFault` indicator on the main Fan service.
- Support for multiple units on one Homebridge instance.

[Unreleased]: https://github.com/simonarnell/homebridge-vallox-redux/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/simonarnell/homebridge-vallox-redux/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/simonarnell/homebridge-vallox-redux/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/simonarnell/homebridge-vallox-redux/releases/tag/v0.1.0
