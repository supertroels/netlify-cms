const Octokit = require('@octokit/rest');
const fs = require('fs-extra');
const path = require('path');
const simpleGit = require('simple-git/promise');
const { updateConfig } = require('../utils/config');
const { escapeRegExp } = require('../utils/regexp');
const { getExpectationsFilename, transformRecordedData: transformData } = require('./common');
const { retrieveRecordedExpectations, resetMockServerState } = require('../utils/mock-server');

const GIT_SSH_COMMAND = 'ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no';
const GIT_SSL_NO_VERIFY = true;

const GITLAB_REPO_OWNER_SANITIZED_VALUE = 'owner';
const GITLAB_REPO_NAME_SANITIZED_VALUE = 'repo';
const GITLAB_REPO_TOKEN_SANITIZED_VALUE = 'fakeToken';

const FAKE_OWNER_USER = {
  login: 'owner',
  id: 1,
  avatar_url: 'https://avatars1.githubusercontent.com/u/7892489?v=4',
  name: 'owner',
};

function getGitHubClient(token) {
  const client = new Octokit({
    auth: `token ${token}`,
    baseUrl: 'https://api.github.com',
  });
  return client;
}

function getEnvs() {
  const {
    GITLAB_REPO_OWNER: owner,
    GITLAB_REPO_NAME: repo,
    GITLAB_REPO_TOKEN: token,
  } = process.env;
  if (!owner || !repo || !token) {
    throw new Error(
      'Please set GITLAB_REPO_OWNER, GITLAB_REPO_NAME, GITLAB_REPO_TOKEN environment variables',
    );
  }
  return { owner, repo, token };
}

async function prepareTestGitLabRepo() {
  const { owner, repo, token } = getEnvs();

  // postfix a random string to avoid collisions
  const postfix = Math.random()
    .toString(32)
    .substring(2);
  const testRepoName = `${repo}-${Date.now()}-${postfix}`;

  const client = getGitHubClient(token);

  console.log('Creating repository', testRepoName);
  await client.repos.createForAuthenticatedUser({
    name: testRepoName,
  });

  const tempDir = path.join('.temp', testRepoName);
  await fs.remove(tempDir);
  let git = simpleGit().env({ ...process.env, GIT_SSH_COMMAND, GIT_SSL_NO_VERIFY });

  const repoUrl = `git@github.com:${owner}/${repo}.git`;

  console.log('Cloning repository', repoUrl);
  await git.clone(repoUrl, tempDir);
  git = simpleGit(tempDir).env({ ...process.env, GIT_SSH_COMMAND, GIT_SSL_NO_VERIFY });

  console.log('Pushing to new repository', testRepoName);

  await git.removeRemote('origin');
  await git.addRemote(
    'origin',
    `https://${token}:x-oauth-basic@github.com/${owner}/${testRepoName}`,
  );
  await git.push(['-u', 'origin', 'master']);

  return { owner, repo: testRepoName, tempDir };
}

async function getAuthenticatedUser(token) {
  const client = getGitHubClient(token);
  const { data: user } = await client.users.getAuthenticated();
  return { ...user, token, backendName: 'github' };
}

async function getUser() {
  const { token } = getEnvs();
  return getAuthenticatedUser(token);
}

async function deleteRepositories({ owner, repo, tempDir }) {
  const { token } = getEnvs();

  const errorHandler = e => {
    if (e.status !== 404) {
      throw e;
    }
  };

  console.log('Deleting repository', `${owner}/${repo}`);
  await fs.remove(tempDir);

  let client = getGitHubClient(token);
  await client.repos
    .delete({
      owner,
      repo,
    })
    .catch(errorHandler);
}

async function resetOriginRepo({ owner, repo, tempDir }) {
  console.log('Resetting origin repo:', `${owner}/repo`);
  const { token } = getEnvs();
  const client = getGitHubClient(token);

  const { data: prs } = await client.pulls.list({
    repo,
    owner,
    state: 'open',
  });
  const numbers = prs.map(pr => pr.number);
  console.log('Closing prs:', numbers);
  await Promise.all(
    numbers.map(pull_number =>
      client.pulls.update({
        owner,
        repo,
        pull_number,
      }),
    ),
  );

  const { data: branches } = await client.repos.listBranches({ owner, repo });
  const refs = branches.filter(b => b.name !== 'master').map(b => `heads/${b.name}`);

  console.log('Deleting refs', refs);
  await Promise.all(
    refs.map(ref =>
      client.git.deleteRef({
        owner,
        repo,
        ref,
      }),
    ),
  );

  console.log('Resetting master');
  const git = simpleGit(tempDir).env({ ...process.env, GIT_SSH_COMMAND, GIT_SSL_NO_VERIFY });
  await git.push(['--force', 'origin', 'master']);
  console.log('Done resetting origin repo:', `${owner}/repo`);
}

async function resetRepositories({ owner, repo, tempDir }) {
  await resetOriginRepo({ owner, repo, tempDir });
}

async function setupGitLab(options) {
  if (process.env.RECORD_FIXTURES) {
    console.log('Running tests in "record" mode - live data with be used!');
    const [user, repoData] = await Promise.all([getUser(), prepareTestGitLabRepo()]);

    await updateConfig(config => {
      config.backend = {
        ...config.backend,
        repo: `${repoData.owner}/${repoData.repo}`,
      };
    });

    return { ...repoData, user, mockResponses: false };
  } else {
    console.log('Running tests in "playback" mode - local data with be used');

    await updateConfig(config => {
      config.backend = {
        ...config.backend,
        ...options,
        repo: `${GITLAB_REPO_OWNER_SANITIZED_VALUE}/${GITLAB_REPO_NAME_SANITIZED_VALUE}`,
      };
    });

    return {
      owner: GITLAB_REPO_OWNER_SANITIZED_VALUE,
      repo: GITLAB_REPO_NAME_SANITIZED_VALUE,
      user: { ...FAKE_OWNER_USER, token: GITLAB_REPO_TOKEN_SANITIZED_VALUE, backendName: 'gitlab' },

      mockResponses: true,
    };
  }
}

async function teardownGitLab(taskData) {
  if (process.env.RECORD_FIXTURES) {
    await deleteRepositories(taskData);
  }

  return null;
}

async function setupGitLabTest(taskData) {
  if (process.env.RECORD_FIXTURES) {
    await resetRepositories(taskData);
    await resetMockServerState();
  }

  return null;
}

const sanitizeString = (str, { owner, repo, token, ownerName }) => {
  let replaced = str
    .replace(new RegExp(escapeRegExp(owner), 'g'), GITLAB_REPO_OWNER_SANITIZED_VALUE)
    .replace(new RegExp(escapeRegExp(repo), 'g'), GITLAB_REPO_NAME_SANITIZED_VALUE)
    .replace(new RegExp(escapeRegExp(token), 'g'), GITLAB_REPO_TOKEN_SANITIZED_VALUE)
    .replace(new RegExp('https://avatars.+?/u/.+?v=\\d', 'g'), `${FAKE_OWNER_USER.avatar_url}`);

  if (ownerName) {
    replaced = replaced.replace(new RegExp(escapeRegExp(ownerName), 'g'), FAKE_OWNER_USER.name);
  }

  return replaced;
};

const transformRecordedData = (expectation, toSanitize) => {
  const requestBodySanitizer = httpRequest => {
    let body;
    if (httpRequest.body && httpRequest.body.string) {
      const bodyObject = JSON.parse(httpRequest.body.string);
      if (bodyObject.encoding === 'base64') {
        // sanitize encoded data
        const decodedBody = Buffer.from(bodyObject.content, 'base64').toString();
        bodyObject.content = Buffer.from(sanitizeString(decodedBody, toSanitize)).toString(
          'base64',
        );
        body = JSON.stringify(bodyObject);
      } else {
        body = httpRequest.body.string;
      }
    }
    return body;
  };

  const responseBodySanitizer = (httpRequest, httpResponse) => {
    let responseBody = null;
    if (httpResponse.body && httpResponse.body.string) {
      responseBody = httpResponse.body.string;
    }

    // replace recorded user with fake one
    if (
      responseBody &&
      httpRequest.path === '/user' &&
      httpRequest.headers.Host.includes('api.github.com')
    ) {
      responseBody = JSON.stringify(FAKE_OWNER_USER);
    }
    return responseBody;
  };

  const cypressRouteOptions = transformData(
    expectation,
    requestBodySanitizer,
    responseBodySanitizer,
  );

  return cypressRouteOptions;
};

async function teardownGitLabTest(taskData) {
  if (process.env.RECORD_FIXTURES) {
    await resetRepositories(taskData);

    try {
      const filename = getExpectationsFilename(taskData);

      console.log('Persisting recorded data for test:', path.basename(filename));

      const { owner, token, forkOwner, forkToken } = getEnvs();

      const expectations = await retrieveRecordedExpectations();

      const toSanitize = {
        owner,
        repo: taskData.repo,
        token,
        forkOwner,
        forkToken,
        ownerName: taskData.user.name,
        forkOwnerName: taskData.forkUser.name,
      };
      // transform the mock proxy recorded requests into Cypress route format
      const toPersist = expectations.map(expectation =>
        transformRecordedData(expectation, toSanitize),
      );

      const toPersistString = sanitizeString(JSON.stringify(toPersist, null, 2), toSanitize);

      await fs.writeFile(filename, toPersistString);
    } catch (e) {
      console.log(e);
    }

    await resetMockServerState();
  }

  return null;
}

module.exports = {
  setupGitLab,
  teardownGitLab,
  setupGitLabTest,
  teardownGitLabTest,
};
