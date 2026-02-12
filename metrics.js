import { createRequire } from 'module';
import client from 'prom-client';
import services from './config/rules.js';

const require = createRequire(import.meta.url);
const { version } = require('./package.json');

const register = new client.Registry();

// --- Info metrics ---

const info = new client.Gauge({
  name: 'deltanotifier_info',
  help: 'Delta-notifier service info',
  labelNames: ['version'],
  registers: [register]
});
info.set({ version }, 1);

const configuredRulesTotal = new client.Gauge({
  name: 'deltanotifier_configured_rules_total',
  help: 'Number of configured rules',
  registers: [register]
});
configuredRulesTotal.set(services.length);

// --- Deltas received ---

const deltasReceivedTotal = new client.Counter({
  name: 'deltanotifier_deltas_received_total',
  help: 'Total POST / requests received',
  registers: [register]
});

const changesetsReceivedTotal = new client.Counter({
  name: 'deltanotifier_changesets_received_total',
  help: 'Total changesets across all deltas',
  registers: [register]
});

// --- Notifications ---

const notificationsTotal = new client.Counter({
  name: 'deltanotifier_notifications_total',
  help: 'Notifications sent per target service',
  labelNames: ['target', 'status'],
  registers: [register]
});

const notificationDurationSeconds = new client.Histogram({
  name: 'deltanotifier_notification_duration_seconds',
  help: 'Notification send latency per target service',
  labelNames: ['target'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

// --- Pending bundles ---

const pendingBundles = new client.Gauge({
  name: 'deltanotifier_pending_bundles',
  help: 'Number of grace-period bundles waiting to be sent',
  registers: [register]
});

// --- Recording functions ---

export function recordDeltaReceived(changesetCount) {
  deltasReceivedTotal.inc();
  changesetsReceivedTotal.inc(changesetCount);
}

export function recordNotification(target, status, durationSeconds) {
  notificationsTotal.inc({ target, status });
  notificationDurationSeconds.observe({ target }, durationSeconds);
}

export function incPendingBundles() {
  pendingBundles.inc();
}

export function decPendingBundles() {
  pendingBundles.dec();
}

// --- Handler ---

export async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
}
