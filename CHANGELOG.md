# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/simonarnell/homebridge-vallox-redux/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/simonarnell/homebridge-vallox-redux/releases/tag/v0.1.0
