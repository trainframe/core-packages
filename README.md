# Trainframe — core packages

A capability-based protocol for distributed model railways. Build smart wooden train sets where any Brio-compatible track piece can become part of an automated railway with schedules, block signals, and arbitrary user-defined behaviours — without modifying the core platform.

This repository (`trainframe/core-packages`) holds the core bundle: protocol, scheduler, simulator, and the default server and visualiser. Satellite capabilities and device implementations live in their own repos under the `trainframe` org or anywhere else.

## Status

Early development. The protocol, capability model, scheduler, and simulator are being designed. No hardware integration yet.

## Repository structure

```
packages/
  protocol/      Wire protocol: schemas, types, topic helpers
  core/          Capability registry, scheduler, layout, clearance logic
  server/        Default server entry point (broker + scheduler + HTTP)
  simulator/     Virtual device population and test harness
  visualiser/    Web UI

examples/
  satellite-turntable/   Sample third-party capability

docs/
  spec/          Protocol specifications (versioned)
  adr/           Architecture decision records
  contributing/  Guides for new device types and capability authors

tools/
  broker/        Local Mosquitto config for development
```

## Quick start

```sh
pnpm install
pnpm broker         # in one terminal: starts Mosquitto via Docker
pnpm dev            # in another: builds and watches all packages
pnpm test           # run all tests with coverage
```

## How it works

Devices connect to an MQTT broker and declare capabilities — `gates_clearance`, `controls_motion`, `displays_aspect`, etc. The server schedules and routes by capability, never by device class. New device classes can be invented by anyone: define a Capability value, register it at platform startup, ship the device. No PR required.

For development without hardware, the simulator hosts virtual devices that speak the same protocol. The scheduler cannot tell the difference.

## Design principles

- **Capability over class.** The platform reasons in terms of what devices can do, not what they are.
- **Default state is safe.** Trains don't move without active clearance.
- **Trains as autonomous agents.** Routes are assigned and executed locally; the server intervenes by modifying plans or withholding clearance.
- **Extensibility from the start.** Built-in capabilities are implemented through the same public API satellite capabilities use.
- **Test against reality.** Integration tests use real brokers, real schedulers, real virtual devices. Mocking is the exception.

## Documentation

- [Implementation status](docs/status.md) — what's built vs. specified, ranked next priorities
- [Protocol spec (latest)](docs/spec/protocol-v0.2.md)
- [Simulator architecture](docs/spec/simulator-v0.1.md)
- [Building a new device type](docs/contributing/new-device.md)
- [Building a new capability](docs/contributing/new-capability.md)
- [Architecture decision records](docs/adr/)

## License

TBD.
