// dashboard-core public API.
// Each dashboard depends on this package via a git tag and consumes
// `createDashboardServer` to build its Express app.

const { createDashboardServer } = require('./server');
const helpers = require('./server/helpers');
const cache = require('./server/cache');
const yahoo = require('./server/yahoo');

module.exports = {
  createDashboardServer,
  // Lower-level pieces — exposed for advanced users / tests
  helpers,
  cache,
  yahoo,
};
