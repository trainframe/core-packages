import mqtt from 'mqtt';
const c = mqtt.connect('mqtt://localhost:1883', { protocolVersion: 4, reconnectPeriod: 0 });
c.on('connect', () => c.subscribe('railway/events/#', { qos: 1 }));
c.on('message', (t, p) => {
  if (
    t.includes('zone_state_changed') ||
    t.includes('zone_train_released') ||
    t.startsWith('railway/events/device_registered/YARD')
  ) {
    try {
      console.log(t, '::', JSON.stringify(JSON.parse(p.toString()).payload));
    } catch {
      console.log(t);
    }
  }
});
