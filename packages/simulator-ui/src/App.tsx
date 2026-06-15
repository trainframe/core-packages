import { useEffect, useMemo, useState } from 'react';
import { BrokerProvider } from './broker/broker-context.js';
import type { BrokerClient } from './broker/client.js';
import { MqttBrokerClient } from './broker/mqtt-client.js';
import { BranchingSceneView } from './components/BranchingSceneView.js';
import { BridgeRunoffScenarioView } from './components/BridgeRunoffScenarioView.js';
import { CraneDropScenarioView } from './components/CraneDropScenarioView.js';
import { DepotScenarioView } from './components/DepotScenarioView.js';
import { InterestingLayoutView } from './components/InterestingLayoutView.js';
import { LiftBridgeScenarioView } from './components/LiftBridgeScenarioView.js';
import { PhysicsScenarioView } from './components/PhysicsScenarioView.js';
import { RailyardDemoScenarioView } from './components/RailyardDemoScenarioView.js';
import { RailyardPiecesView } from './components/RailyardPiecesView.js';
import { ToyTable } from './components/ToyTable.js';
import { TurntableScenarioView } from './components/TurntableScenarioView.js';
import { YardScenarioView } from './components/YardScenarioView.js';
import './components/ToyTable.css';
import { loadBrokerUrl } from './config/broker-config.js';

interface AppProps {
  client?: BrokerClient;
}

/**
 * Trainframe simulator UI — the operator-facing "toy table" of virtual
 * hardware. The previous developer panel (SimControls / LayoutConfig /
 * Settings) has been retired; everything lives inside `<ToyTable />` now.
 *
 * The broker-URL settings are tucked behind a cog icon in the ToyTable
 * header so the toy-table framing is preserved while the operator can still
 * reach them when needed. `initialUrl` is threaded down to ToyTable so the
 * Settings form knows its starting value.
 */
export function App({ client }: AppProps = {}) {
  const resolvedClient = useMemo(() => client ?? new MqttBrokerClient(), [client]);
  const [initialUrl] = useState(loadBrokerUrl);

  // ADR-030 physics acceptance scenarios run standalone (no broker/core) when the
  // URL carries `?physics=<name>` — the toy table is bypassed entirely.
  const physics =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('physics')
      : null;

  useEffect(() => {
    if (physics !== null) return;
    resolvedClient.connect(initialUrl);
    return () => resolvedClient.disconnect();
  }, [resolvedClient, initialUrl, physics]);

  if (physics === 'branching') return <BranchingSceneView />;
  if (physics === 'railyard-demo') return <RailyardDemoScenarioView />;
  if (physics === 'railyard-pieces') return <RailyardPiecesView />;
  if (physics === 'interesting') return <InterestingLayoutView />;
  if (physics === 'railyard') return <YardScenarioView />;
  if (physics === 'turntable') return <TurntableScenarioView />;
  if (physics === 'depot') return <DepotScenarioView />;
  if (physics === 'crane-drop') return <CraneDropScenarioView />;
  if (physics === 'lift-bridge') return <LiftBridgeScenarioView />;
  if (physics === 'bridge-runoff') return <BridgeRunoffScenarioView />;
  if (physics !== null) return <PhysicsScenarioView name={physics} />;

  return (
    <BrokerProvider client={resolvedClient}>
      <ToyTable initialUrl={initialUrl} />
    </BrokerProvider>
  );
}
