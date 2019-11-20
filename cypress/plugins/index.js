// ***********************************************************
// This example plugins/index.js can be used to load plugins
//
// You can change the location of this file or turn off loading
// the plugins file with the 'pluginsFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/plugins-guide
// ***********************************************************

// This function is called when a project is opened or re-opened (e.g. due to
// the project's config changing)
require('dotenv').config();
const { setupGitHub, teardownGitHub, setupGitHubTest, teardownGitHubTest } = require('./github');
const { setupGitLab, teardownGitLab, setupGitLabTest, teardownGitLabTest } = require('./gitlab');
const { copyBackendFiles } = require('../utils/config');

module.exports = async on => {
  // `on` is used to hook into various events Cypress emits
  on('task', {
    async setupBackend({ backend, options }) {
      console.log('Preparing environment for backend', backend);
      await copyBackendFiles(backend);

      let result = null;
      switch (backend) {
        case 'github':
          result = await setupGitHub(options);
          break;
        case 'gitlab':
          result = await setupGitLab(options);
          break;
      }

      return result;
    },
    async teardownBackend(taskData) {
      const { backend } = taskData;
      console.log('Tearing down backend', backend);

      switch (backend) {
        case 'github':
          await teardownGitHub(taskData);
          break;
        case 'gitlab':
          await teardownGitLab(taskData);
          break;
      }

      console.log('Restoring defaults');
      await copyBackendFiles('test');

      return null;
    },
    async setupBackendTest(taskData) {
      const { backend, testName } = taskData;
      console.log(`Setting up single test '${testName}' for backend`, backend);

      switch (backend) {
        case 'github':
          await setupGitHubTest(taskData);
          break;
        case 'gitlab':
          await setupGitLabTest(taskData);
          break;
      }

      return null;
    },
    async teardownBackendTest(taskData) {
      const { backend, testName } = taskData;

      console.log(`Tearing down single test '${testName}' for backend`, backend);

      switch (backend) {
        case 'github':
          await teardownGitHubTest(taskData);
          break;
        case 'gitlab':
          await teardownGitLabTest(taskData);
          break;
      }

      return null;
    },
  });

  // to allows usage of a mock proxy
  on('before:browser:launch', (browser = {}, args) => {
    if (browser.name === 'chrome') {
      args.push('--ignore-certificate-errors');

      return args;
    }

    if (browser.name === 'electron') {
      args['ignore-certificate-errors'] = true;

      return args;
    }
  });
};
