import * as specUtils from './utils/spec_utils';
import { login, createPostAndExit, assertNotification, assertPublishedEntry } from '../utils/steps';
import { entry1 } from './gitlab/entries';
const { notifications } = require('../utils/constants');

const backend = 'gitlab';

describe('GitLab Backend Non Editorial Workflow', () => {
  let taskResult = { data: {} };

  before(() => {
    specUtils.before(backend, taskResult, {});
  });

  after(() => {
    specUtils.after(backend, taskResult);
  });

  beforeEach(() => {
    specUtils.beforeEach(backend, taskResult);
  });

  afterEach(() => {
    specUtils.afterEach(backend, taskResult);
  });

  it('successfully loads', () => {
    login(taskResult.data.user);
  });

  it('can create an entry', () => {
    login();
    createPostAndExit(entry1);
    assertNotification(notifications.published);
    assertPublishedEntry(entry1);
  });
});
