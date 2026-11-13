const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { loadWorkflow, ConfigError } = require('./config');
const { ConflictError, InvalidTransition, NotFoundError } = require('./service');

function loadCatalog(configDir) {
  const catalog = new Map();
  for (const filename of fs.readdirSync(configDir).filter(name => name.endsWith('.json'))) {
    const config = loadWorkflow(path.join(configDir, filename));
    if (!catalog.has(config.workflow_id)) catalog.set(config.workflow_id, new Map());
    const versions = catalog.get(config.workflow_id);
    if (versions.has(config.version)) throw new ConfigError(`Duplicate workflow/version: ${config.workflow_id}/${config.version}`);
    versions.set(config.version, config);
  }
  return catalog;
}

function createApp(service, configDir = path.join(__dirname, '..', 'configs')) {
  const app = express();
  const catalog = loadCatalog(configDir);
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/workflows', (req, res) => {
    res.json([...catalog].map(([workflow_id, versions]) => ({
      workflow_id, versions: [...versions.keys()].sort()
    })));
  });

  app.post('/workflows/:workflowId/requests', (req, res) => {
    const versions = catalog.get(req.params.workflowId);
    if (!versions) return res.status(404).json({ error: 'Unknown workflow' });
    const requestedVersion = req.query.version;
    const version = requestedVersion || [...versions.keys()].sort().at(-1);
    const config = versions.get(version);
    if (!config) return res.status(404).json({ error: 'Unknown workflow version' });
    const record = service.submit(config, req.body, req.get('Idempotency-Key'),
      req.get('X-Simulated-Dependency-Outcome') || 'success');
    return res.status(record.status === 'INVALID' ? 422 : 200).json(record);
  });

  app.get('/requests', (req, res) => res.json(service.list()));
  app.get('/requests/:id', (req, res) => res.json(service.get(req.params.id)));
  app.post('/requests/:id/retry', (req, res) => {
    res.json(service.retry(req.params.id, req.body?.dependencyOutcome || 'success'));
  });
  app.post('/requests/:id/resolve', (req, res) => {
    res.json(service.resolve(req.params.id, req.body?.decision, req.body?.reason));
  });

  app.use((error, req, res, next) => {
    if (error instanceof ConflictError) return res.status(409).json({ error: error.message });
    if (error instanceof NotFoundError) return res.status(404).json({ error: error.message });
    if (error instanceof InvalidTransition) return res.status(409).json({ error: error.message });
    if (error instanceof TypeError || error instanceof ConfigError || error instanceof SyntaxError) {
      return res.status(400).json({ error: error.message });
    }
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

module.exports = { createApp, loadCatalog };
