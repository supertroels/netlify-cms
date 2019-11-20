import * as specUtils from '../utils/spec_utils';
import { login } from '../../utils/steps';

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
});
