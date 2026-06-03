import { Panel } from '@trainframe/ui-kit';
import { useMemo } from 'react';
import { useLastScanned } from '../state/use-last-scanned.js';
import { type VisualiserMarker, useLayoutState } from '../state/use-layout-state.js';
import { type RegisteredDevice, useRegisteredDevices } from '../state/use-registered-devices.js';
import { type ScheduleEntry, useScheduleState } from '../state/use-schedule-state.js';
import { useTrainPositions } from '../state/use-train-positions.js';
import { type TrainStatus, useTrainStatuses } from '../state/use-train-statuses.js';
import { trainColor } from '../train-color.js';
import './DevicesPanel.css';

const CAPABILITY_CONTROLS_MOTION = 'core.controls_motion';
const CAPABILITY_GATES_CLEARANCE = 'core.gates_clearance';
const CAPABILITY_ASSIGNS_TAGS = 'core.assigns_tags';

/**
 * Operator-facing roster of every entity on the bus, grouped by what it can
 * do. Renders unconditionally — even an empty railway shows headings so the
 * operator knows the panel is wired up. As fresh scans arrive
 * (`tag_observed` / `tag_assignment`), the matching row briefly highlights
 * so "the visualiser recognises what I just scanned" is visible at a glance.
 */
export function DevicesPanel() {
  const devices = useRegisteredDevices();
  const layout = useLayoutState();
  const schedules = useScheduleState();
  const positions = useTrainPositions();
  const statuses = useTrainStatuses();
  const { entityId: lastScanned } = useLastScanned();

  const { trains, gates, garages } = useMemo(() => groupByCapability(devices), [devices]);
  const markers = layout?.markers ?? [];
  const edgeCounts = useMemo(() => countEdgesPerMarker(layout?.edges ?? []), [layout]);

  return (
    <Panel label="Devices" data-testid="devices-panel">
      <DeviceGroup title="Trains" countLabel={trains.length} testId="devices-trains-group">
        {trains.length === 0 ? (
          <EmptyHint>No trains registered yet.</EmptyHint>
        ) : (
          <ul className="tf-devices__list">
            {trains.map((train) => (
              <TrainRow
                key={train.device_id}
                device={train}
                schedule={schedules.get(train.device_id)}
                marker={positions.get(train.device_id)}
                status={statuses.get(train.device_id)}
                highlighted={train.device_id === lastScanned}
              />
            ))}
          </ul>
        )}
      </DeviceGroup>

      <DeviceGroup title="Gates" countLabel={gates.length} testId="devices-gates-group">
        {gates.length === 0 ? (
          <EmptyHint>No gating devices registered yet.</EmptyHint>
        ) : (
          <ul className="tf-devices__list">
            {gates.map((gate) => (
              <GateRow
                key={gate.device_id}
                device={gate}
                highlighted={gate.device_id === lastScanned}
              />
            ))}
          </ul>
        )}
      </DeviceGroup>

      <DeviceGroup title="Garages" countLabel={garages.length} testId="devices-garages-group">
        {garages.length === 0 ? (
          <EmptyHint>No tag-assigning devices registered yet.</EmptyHint>
        ) : (
          <ul className="tf-devices__list">
            {garages.map((garage) => (
              <GarageRow
                key={garage.device_id}
                device={garage}
                highlighted={garage.device_id === lastScanned}
              />
            ))}
          </ul>
        )}
      </DeviceGroup>

      <DeviceGroup title="Markers" countLabel={markers.length} testId="devices-markers-group">
        {markers.length === 0 ? (
          <EmptyHint>No markers on the layout yet.</EmptyHint>
        ) : (
          <ul className="tf-devices__list">
            {markers.map((marker) => (
              <MarkerRow
                key={marker.id}
                marker={marker}
                inbound={edgeCounts.get(marker.id)?.inbound ?? 0}
                outbound={edgeCounts.get(marker.id)?.outbound ?? 0}
                highlighted={marker.id === lastScanned}
              />
            ))}
          </ul>
        )}
      </DeviceGroup>
    </Panel>
  );
}

interface DeviceGroupProps {
  readonly title: string;
  readonly countLabel: number;
  readonly testId: string;
  readonly children: React.ReactNode;
}

function DeviceGroup({ title, countLabel, testId, children }: DeviceGroupProps) {
  return (
    <section className="tf-devices__group" data-testid={testId}>
      <header className="tf-devices__group-header">
        <h3 className="tf-devices__group-title">{title}</h3>
        <span className="tf-devices__group-count" data-testid={`${testId}-count`}>
          {countLabel}
        </span>
      </header>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { readonly children: React.ReactNode }) {
  return <p className="tf-devices__empty">{children}</p>;
}

interface TrainRowProps {
  readonly device: RegisteredDevice;
  readonly schedule: ScheduleEntry | undefined;
  readonly marker: string | undefined;
  readonly status: TrainStatus | undefined;
  readonly highlighted: boolean;
}

function TrainRow({ device, schedule, marker, status, highlighted }: TrainRowProps) {
  const where = describeTrainPosition(marker, status);
  return (
    <li
      className={rowClass(highlighted)}
      data-testid={`device-row-${device.device_id}`}
      data-entity-id={device.device_id}
      data-highlighted={highlighted ? 'true' : undefined}
    >
      <span
        className="tf-devices__row-id"
        style={{ color: trainColor(device.device_id), fontWeight: 'bold' }}
      >
        {device.device_id}
      </span>
      <span className="tf-devices__row-meta">
        {schedule ? `route ${schedule.stops.join(' → ')}` : 'no schedule'}
      </span>
      <span className="tf-devices__row-meta">{where}</span>
    </li>
  );
}

interface GateRowProps {
  readonly device: RegisteredDevice;
  readonly highlighted: boolean;
}

function GateRow({ device, highlighted }: GateRowProps) {
  // Gate state isn't published as retained state today; surface that
  // honestly rather than guess. TODO(gates_clearance): wire this up once a
  // retained `railway/state/gates/+` (or equivalent) exists.
  return (
    <li
      className={rowClass(highlighted)}
      data-testid={`device-row-${device.device_id}`}
      data-entity-id={device.device_id}
      data-highlighted={highlighted ? 'true' : undefined}
    >
      <span className="tf-devices__row-id">{device.device_id}</span>
      <span className="tf-devices__row-meta">state unknown</span>
    </li>
  );
}

interface GarageRowProps {
  readonly device: RegisteredDevice;
  readonly highlighted: boolean;
}

function GarageRow({ device, highlighted }: GarageRowProps) {
  // TODO(garage_counts): tally `tag_assignment` events per garage once a
  // hook for that lands. Today we surface the device id alone — still useful
  // for confirming the garage is on the bus.
  return (
    <li
      className={rowClass(highlighted)}
      data-testid={`device-row-${device.device_id}`}
      data-entity-id={device.device_id}
      data-highlighted={highlighted ? 'true' : undefined}
    >
      <span className="tf-devices__row-id">{device.device_id}</span>
      <span className="tf-devices__row-meta">assigns tags</span>
    </li>
  );
}

interface MarkerRowProps {
  readonly marker: VisualiserMarker;
  readonly inbound: number;
  readonly outbound: number;
  readonly highlighted: boolean;
}

function MarkerRow({ marker, inbound, outbound, highlighted }: MarkerRowProps) {
  return (
    <li
      className={rowClass(highlighted)}
      data-testid={`device-row-${marker.id}`}
      data-entity-id={marker.id}
      data-highlighted={highlighted ? 'true' : undefined}
    >
      <span className="tf-devices__row-id">{marker.id}</span>
      <span className="tf-devices__row-meta">{marker.kind}</span>
      <span className="tf-devices__row-meta">
        {inbound} in / {outbound} out
      </span>
    </li>
  );
}

function rowClass(highlighted: boolean): string {
  return highlighted ? 'tf-devices__row tf-devices__row--highlighted' : 'tf-devices__row';
}

function describeTrainPosition(
  marker: string | undefined,
  status: TrainStatus | undefined,
): string {
  if (status?.current_edge) {
    const { from_marker_id, to_marker_id } = status.current_edge;
    return `on edge ${from_marker_id} → ${to_marker_id}`;
  }
  if (marker) return `at ${marker}`;
  return 'position unknown';
}

interface CapabilityBuckets {
  readonly trains: ReadonlyArray<RegisteredDevice>;
  readonly gates: ReadonlyArray<RegisteredDevice>;
  readonly garages: ReadonlyArray<RegisteredDevice>;
}

function groupByCapability(devices: ReadonlyMap<string, RegisteredDevice>): CapabilityBuckets {
  const trains: RegisteredDevice[] = [];
  const gates: RegisteredDevice[] = [];
  const garages: RegisteredDevice[] = [];
  for (const device of devices.values()) {
    if (device.capabilities.includes(CAPABILITY_CONTROLS_MOTION)) trains.push(device);
    if (device.capabilities.includes(CAPABILITY_GATES_CLEARANCE)) gates.push(device);
    if (device.capabilities.includes(CAPABILITY_ASSIGNS_TAGS)) garages.push(device);
  }
  const byId = (a: RegisteredDevice, b: RegisteredDevice) => a.device_id.localeCompare(b.device_id);
  trains.sort(byId);
  gates.sort(byId);
  garages.sort(byId);
  return { trains, gates, garages };
}

function countEdgesPerMarker(
  edges: ReadonlyArray<{ readonly from_marker_id: string; readonly to_marker_id: string }>,
): ReadonlyMap<string, { inbound: number; outbound: number }> {
  const counts = new Map<string, { inbound: number; outbound: number }>();
  const bump = (id: string, key: 'inbound' | 'outbound') => {
    const existing = counts.get(id);
    if (existing) {
      existing[key] += 1;
    } else {
      counts.set(id, key === 'inbound' ? { inbound: 1, outbound: 0 } : { inbound: 0, outbound: 1 });
    }
  };
  for (const edge of edges) {
    bump(edge.from_marker_id, 'outbound');
    bump(edge.to_marker_id, 'inbound');
  }
  return counts;
}
