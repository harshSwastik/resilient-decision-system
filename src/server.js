const path = require('node:path');
const { DecisionService } = require('./service');
const { createApp } = require('./app');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'decisions.sqlite3');
const port = Number(process.env.PORT || 3000);
const service = new DecisionService(dbPath);
const server = createApp(service).listen(port, () => {
  console.log(`Decision API listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    service.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
