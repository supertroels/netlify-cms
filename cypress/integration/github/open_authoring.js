import '../../utils/dismiss-local-backup';
import {
  login,
  createPostAndExit,
  updateExistingPostAndExit,
  goToWorkflow,
  deleteWorkflowEntry,
  updateWorkflowStatus,
  publishWorkflowEntry,
} from '../../utils/steps';
import { workflowStatus } from '../../utils/constants';
import { entry1, entry2 } from './entries';
import * as specUtils from '../utils/spec_utils';

const backend = 'github';

export default function({ use_graphql }) {
  let taskResult = { data: {} };

  before(() => {
    specUtils.before(backend, taskResult, { use_graphql, open_authoring: true });
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
    login(taskResult.data.user);
    createPostAndExit(entry1);
  });

  it('can update an entry', () => {
    login(taskResult.data.user);
    createPostAndExit(entry1);
    updateExistingPostAndExit(entry1, entry2);
  });

  it('can publish an editorial workflow entry', () => {
    login(taskResult.data.user);
    createPostAndExit(entry1);
    goToWorkflow();
    updateWorkflowStatus(entry1, workflowStatus.draft, workflowStatus.ready);
    publishWorkflowEntry(entry1);
  });

  it('successfully forks repository and loads', () => {
    login(taskResult.data.forkUser);
  });

  it('can create an entry on fork', () => {
    login(taskResult.data.forkUser);
    createPostAndExit(entry1);
  });

  it('can update a draft entry on fork', () => {
    login(taskResult.data.user);
    createPostAndExit(entry1);
    updateExistingPostAndExit(entry1, entry2);
  });

  it('can change entry status from fork', () => {
    login(taskResult.data.forkUser);
    createPostAndExit(entry1);
    goToWorkflow();
    updateWorkflowStatus(entry1, workflowStatus.draft, workflowStatus.review);
  });

  it('can delete review entry from fork', () => {
    login(taskResult.data.forkUser);
    createPostAndExit(entry1);
    goToWorkflow();
    updateWorkflowStatus(entry1, workflowStatus.draft, workflowStatus.review);
    deleteWorkflowEntry(entry1);
  });

  it('can return entry to draft and delete it', () => {
    login(taskResult.data.forkUser);
    createPostAndExit(entry1);
    goToWorkflow();
    updateWorkflowStatus(entry1, workflowStatus.draft, workflowStatus.review);

    updateWorkflowStatus(entry1, workflowStatus.review, workflowStatus.draft);
    deleteWorkflowEntry(entry1);
  });
}
