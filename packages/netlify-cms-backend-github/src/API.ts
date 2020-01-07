import { Base64 } from 'js-base64';
import semaphore, { Semaphore } from 'semaphore';
import { flow, get, initial, last, partial, result, differenceBy, trimStart } from 'lodash';
import { map, filter } from 'lodash/fp';
import {
  getAllResponses,
  APIError,
  EditorialWorkflowError,
  flowAsync,
  localForage,
  onlySuccessfulPromises,
  basename,
  AssetProxy,
  Entry as LibEntry,
  PersistOptions,
  readFile,
  CMS_BRANCH_PREFIX,
  generateContentKey,
  DEFAULT_PR_BODY,
  MERGE_COMMIT_MESSAGE,
  PreviewState,
} from 'netlify-cms-lib-util';
import {
  UsersGetAuthenticatedResponse as GitHubUser,
  ReposGetResponse as GitHubRepo,
  ReposGetBranchResponse as GitHubBranch,
  GitGetBlobResponse as GitHubBlob,
  GitCreateTreeResponse as GitHubTree,
  GitCreateTreeResponseTreeItem as GitHubTreeItem,
  GitCreateTreeParamsTree,
  GitCreateCommitResponse as GitHubCommit,
  ReposCompareCommitsResponseCommitsItem as GitHubCompareCommit,
  ReposCompareCommitsResponseFilesItem,
  ReposCompareCommitsResponse as GitHubCompareResponse,
  ReposCompareCommitsResponseBaseCommit as GitHubCompareBaseCommit,
  GitCreateCommitResponseAuthor as GitHubAuthor,
  GitCreateCommitResponseCommitter as GitHubCommiter,
  ReposListStatusesForRefResponseItem,
} from '@octokit/rest';

const CURRENT_METADATA_VERSION = '1';

export interface FetchError extends Error {
  status: number;
}

export interface Config {
  apiRoot?: string;
  token?: string;
  branch?: string;
  useOpenAuthoring?: boolean;
  repo?: string;
  originRepo?: string;
  squashMerges: boolean;
  initialWorkflowStatus: string;
}

interface TreeFile {
  type: 'blob' | 'tree';
  sha: string;
  path: string;
  raw?: string;
}

export interface Entry extends LibEntry {
  sha?: string;
}

type Override<T, U> = Pick<T, Exclude<keyof T, keyof U>> & U;

type TreeEntry = Override<GitCreateTreeParamsTree, { sha: string | null }>;

type GitHubCompareCommits = GitHubCompareCommit[];

type GitHubCompareFile = ReposCompareCommitsResponseFilesItem & { previous_filename?: string };

type GitHubCompareFiles = GitHubCompareFile[];

enum GitHubCommitStatusState {
  Error = 'error',
  Failure = 'failure',
  Pending = 'pending',
  Success = 'success',
}

type GitHubCommitStatus = ReposListStatusesForRefResponseItem & {
  state: GitHubCommitStatusState;
};

export interface PR {
  number: number;
  head: string | { sha: string };
}

interface MetaDataObjects {
  entry: { path: string; sha: string };
  files: MediaFile[];
}

export interface Metadata {
  type: string;
  objects: MetaDataObjects;
  branch: string;
  status: string;
  pr?: PR;
  collection: string;
  commitMessage: string;
  version?: string;
  user: string;
  title?: string;
  description?: string;
  timeStamp: string;
}

export interface Branch {
  ref: string;
}

export interface BlobArgs {
  sha: string;
  repoURL: string;
  parseText: boolean;
}

type Param = string | number | undefined;

type Options = RequestInit & { params?: Record<string, Param | Record<string, Param>> };

const replace404WithEmptyArray = (err: FetchError) => {
  if (err && err.status === 404) {
    console.log('This 404 was expected and handled appropriately.');
    return [];
  } else {
    return Promise.reject(err);
  }
};

type MediaFile = {
  sha: string;
  path: string;
};

export default class API {
  apiRoot: string;
  token: string;
  branch: string;
  useOpenAuthoring?: boolean;
  repo: string;
  originRepo: string;
  repoURL: string;
  originRepoURL: string;
  mergeMethod: string;
  initialWorkflowStatus: string;

  _userPromise?: Promise<GitHubUser>;
  _metadataSemaphore?: Semaphore;

  commitAuthor?: {};

  constructor(config: Config) {
    this.apiRoot = config.apiRoot || 'https://api.github.com';
    this.token = config.token || '';
    this.branch = config.branch || 'master';
    this.useOpenAuthoring = config.useOpenAuthoring;
    this.repo = config.repo || '';
    this.originRepo = config.originRepo || this.repo;
    this.repoURL = `/repos/${this.repo}`;
    // when not in 'useOpenAuthoring' mode originRepoURL === repoURL
    this.originRepoURL = `/repos/${this.originRepo}`;
    this.mergeMethod = config.squashMerges ? 'squash' : 'merge';
    this.initialWorkflowStatus = config.initialWorkflowStatus;
  }

  static DEFAULT_COMMIT_MESSAGE = 'Automatically generated by Netlify CMS';

  user(): Promise<{ name: string; login: string }> {
    if (!this._userPromise) {
      this._userPromise = this.request('/user') as Promise<GitHubUser>;
    }
    return this._userPromise;
  }

  hasWriteAccess() {
    return this.request(this.repoURL)
      .then((repo: GitHubRepo) => repo.permissions.push)
      .catch((error: Error) => {
        console.error('Problem fetching repo data from GitHub');
        throw error;
      });
  }

  reset() {
    // no op
  }

  requestHeaders(headers = {}) {
    const baseHeader: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    };

    if (this.token) {
      baseHeader.Authorization = `token ${this.token}`;
      return Promise.resolve(baseHeader);
    }

    return Promise.resolve(baseHeader);
  }

  parseJsonResponse(response: Response) {
    return response.json().then(json => {
      if (!response.ok) {
        return Promise.reject(json);
      }

      return json;
    });
  }

  urlFor(path: string, options: Options) {
    const cacheBuster = new Date().getTime();
    const params = [`ts=${cacheBuster}`];
    if (options.params) {
      for (const key in options.params) {
        params.push(`${key}=${encodeURIComponent(options.params[key] as string)}`);
      }
    }
    if (params.length) {
      path += `?${params.join('&')}`;
    }
    return this.apiRoot + path;
  }

  parseResponse(response: Response) {
    const contentType = response.headers.get('Content-Type');
    if (contentType && contentType.match(/json/)) {
      return this.parseJsonResponse(response);
    }
    const textPromise = response.text().then(text => {
      if (!response.ok) {
        return Promise.reject(text);
      }
      return text;
    });
    return textPromise;
  }

  handleRequestError(error: FetchError, responseStatus: number) {
    throw new APIError(error.message, responseStatus, 'GitHub');
  }

  async request(
    path: string,
    options: Options = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parser = (response: Response) => this.parseResponse(response),
  ) {
    const headers = await this.requestHeaders(options.headers || {});
    const url = this.urlFor(path, options);
    let responseStatus: number;
    return fetch(url, { ...options, headers })
      .then(response => {
        responseStatus = response.status;
        return parser(response);
      })
      .catch(error => this.handleRequestError(error, responseStatus));
  }

  async requestAllPages<T>(url: string, options: Options = {}) {
    const headers = await this.requestHeaders(options.headers || {});
    const processedURL = this.urlFor(url, options);
    const allResponses = await getAllResponses(processedURL, { ...options, headers });
    const pages: T[][] = await Promise.all(
      allResponses.map((res: Response) => this.parseResponse(res)),
    );
    return ([] as T[]).concat(...pages);
  }

  generateContentKey(collectionName: string, slug: string) {
    if (!this.useOpenAuthoring) {
      generateContentKey(collectionName, slug);
    }

    return `${this.repo}/${collectionName}/${slug}`;
  }

  slugFromContentKey(contentKey: string, collectionName: string) {
    if (!this.useOpenAuthoring) {
      return contentKey.substring(collectionName.length + 1);
    }

    return contentKey.substring(this.repo.length + collectionName.length + 2);
  }

  generateBranchName(contentKey: string) {
    return `${CMS_BRANCH_PREFIX}/${contentKey}`;
  }

  branchNameFromRef(ref: string) {
    return ref.substring('refs/heads/'.length);
  }

  contentKeyFromRef(ref: string) {
    return ref.substring(`refs/heads/${CMS_BRANCH_PREFIX}/`.length);
  }

  checkMetadataRef() {
    return this.request(`${this.repoURL}/git/refs/meta/_netlify_cms`, {
      cache: 'no-store',
    })
      .then(response => response.object)
      .catch(() => {
        // Meta ref doesn't exist
        const readme = {
          raw:
            '# Netlify CMS\n\nThis tree is used by the Netlify CMS to store metadata information for specific files and branches.',
        };

        return this.uploadBlob(readme)
          .then(item =>
            this.request(`${this.repoURL}/git/trees`, {
              method: 'POST',
              body: JSON.stringify({
                tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: item.sha }],
              }),
            }),
          )
          .then(tree => this.commit('First Commit', tree))
          .then(response => this.createRef('meta', '_netlify_cms', response.sha))
          .then(response => response.object);
      });
  }

  async storeMetadata(key: string, data: Metadata) {
    // semaphore ensures metadata updates are always ordered, even if
    // calls to storeMetadata are not. concurrent metadata updates
    // will result in the metadata branch being unable to update.
    if (!this._metadataSemaphore) {
      this._metadataSemaphore = semaphore(1);
    }
    return new Promise((resolve, reject) =>
      this._metadataSemaphore?.take(async () => {
        try {
          const branchData = await this.checkMetadataRef();
          const file = { path: `${key}.json`, raw: JSON.stringify(data) };

          await this.uploadBlob(file);
          const changeTree = await this.updateTree(branchData.sha, [file as TreeFile]);
          const { sha } = await this.commit(`Updating “${key}” metadata`, changeTree);
          await this.patchRef('meta', '_netlify_cms', sha);
          localForage.setItem(`gh.meta.${key}`, {
            expires: Date.now() + 300000, // In 5 minutes
            data,
          });
          this._metadataSemaphore?.leave();
          resolve();
        } catch (err) {
          reject(err);
        }
      }),
    );
  }

  deleteMetadata(key: string) {
    if (!this._metadataSemaphore) {
      this._metadataSemaphore = semaphore(1);
    }
    return new Promise(resolve =>
      this._metadataSemaphore?.take(async () => {
        try {
          const branchData = await this.checkMetadataRef();
          const file = { path: `${key}.json`, sha: null };

          const changeTree = await this.updateTree(branchData.sha, [file]);
          const { sha } = await this.commit(`Deleting “${key}” metadata`, changeTree);
          await this.patchRef('meta', '_netlify_cms', sha);
          this._metadataSemaphore?.leave();
          resolve();
        } catch (err) {
          this._metadataSemaphore?.leave();
          resolve();
        }
      }),
    );
  }

  retrieveMetadata(key: string): Promise<Metadata> {
    const cache = localForage.getItem<{ data: Metadata; expires: number }>(`gh.meta.${key}`);
    return cache.then(cached => {
      if (cached && cached.expires > Date.now()) {
        return cached.data as Metadata;
      }
      console.log(
        '%c Checking for MetaData files',
        'line-height: 30px;text-align: center;font-weight: bold',
      );

      const metadataRequestOptions = {
        params: { ref: 'refs/meta/_netlify_cms' },
        headers: { Accept: 'application/vnd.github.v3.raw' },
        cache: 'no-store' as RequestCache,
      };

      const errorHandler = (err: Error) => {
        if (err.message === 'Not Found') {
          console.log(
            '%c %s does not have metadata',
            'line-height: 30px;text-align: center;font-weight: bold',
            key,
          );
        }
        throw err;
      };

      if (!this.useOpenAuthoring) {
        return this.request(`${this.repoURL}/contents/${key}.json`, metadataRequestOptions)
          .then((response: string) => JSON.parse(response))
          .catch(errorHandler);
      }

      const [user, repo] = key.split('/');
      return this.request(`/repos/${user}/${repo}/contents/${key}.json`, metadataRequestOptions)
        .then((response: string) => JSON.parse(response))
        .catch(errorHandler);
    });
  }

  async readFile(
    path: string,
    sha?: string | null,
    {
      branch = this.branch,
      repoURL = this.repoURL,
      parseText = true,
    }: {
      branch?: string;
      repoURL?: string;
      parseText?: boolean;
    } = {},
  ) {
    if (!sha) {
      sha = await this.getFileSha(path, { repoURL, branch });
    }
    const fetchContent = () => this.fetchBlobContent({ sha: sha as string, repoURL, parseText });
    const content = await readFile(sha, fetchContent, localForage, parseText);
    return content;
  }

  async fetchBlobContent({ sha, repoURL, parseText }: BlobArgs) {
    const result: GitHubBlob = await this.request(`${repoURL}/git/blobs/${sha}`);

    if (parseText) {
      // treat content as a utf-8 string
      const content = Base64.decode(result.content);
      return content;
    } else {
      // treat content as binary and convert to blob
      const content = Base64.atob(result.content);
      const byteArray = new Uint8Array(content.length);
      for (let i = 0; i < content.length; i++) {
        byteArray[i] = content.charCodeAt(i);
      }
      const blob = new Blob([byteArray]);
      return blob;
    }
  }

  async listFiles(
    path: string,
    { repoURL = this.repoURL, branch = this.branch, depth = 1 } = {},
  ): Promise<{ type: string; id: string; name: string; path: string; size: number }[]> {
    const folder = trimStart(path, '/');
    return this.request(`${repoURL}/git/trees/${branch}:${folder}`, {
      // GitHub API supports recursive=1 for getting the entire recursive tree
      // or omitting it to get the non-recursive tree
      params: depth > 1 ? { recursive: 1 } : {},
    })
      .then((res: GitHubTree) =>
        res.tree
          // filter only files and up to the required depth
          .filter(file => file.type === 'blob' && file.path.split('/').length <= depth)
          .map(file => ({
            type: file.type,
            id: file.sha,
            name: basename(file.path),
            path: `${folder}/${file.path}`,
            size: file.size,
          })),
      )
      .catch(replace404WithEmptyArray);
  }

  async readUnpublishedBranchFile(contentKey: string) {
    try {
      const metaData = await this.retrieveMetadata(contentKey).then(data =>
        data.objects.entry.path ? data : Promise.reject(null),
      );
      const repoURL = this.useOpenAuthoring
        ? `/repos/${contentKey
            .split('/')
            .slice(0, 2)
            .join('/')}`
        : this.repoURL;

      const [fileData, isModification] = await Promise.all([
        this.readFile(metaData.objects.entry.path, null, {
          branch: metaData.branch,
          repoURL,
        }) as Promise<string>,
        this.isUnpublishedEntryModification(metaData.objects.entry.path),
      ]);

      return {
        metaData,
        fileData,
        isModification,
        slug: this.slugFromContentKey(contentKey, metaData.collection),
      };
    } catch (e) {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    }
  }

  isUnpublishedEntryModification(path: string) {
    return this.readFile(path, null, {
      branch: this.branch,
      repoURL: this.originRepoURL,
    })
      .then(() => true)
      .catch((err: Error) => {
        if (err.message && err.message === 'Not Found') {
          return false;
        }
        throw err;
      });
  }

  getPRsForBranchName = (branchName: string) => {
    // Get PRs with a `head` of `branchName`. Note that this is a
    // substring match, so we need to check that the `head.ref` of
    // at least one of the returned objects matches `branchName`.
    return this.requestAllPages<{ head: { ref: string } }>(`${this.repoURL}/pulls`, {
      params: {
        head: branchName,
        state: 'open',
        base: this.branch,
      },
    });
  };

  getUpdatedOpenAuthoringMetadata = async (
    contentKey: string,
    { metadata: metadataArg }: { metadata?: Metadata } = {},
  ) => {
    const metadata = metadataArg || (await this.retrieveMetadata(contentKey)) || {};
    const { pr: prMetadata, status } = metadata;

    // Set the status to draft if no corresponding PR is recorded
    if (!prMetadata && status !== 'draft') {
      const newMetadata = { ...metadata, status: 'draft' };
      this.storeMetadata(contentKey, newMetadata);
      return newMetadata;
    }

    // If no status is recorded, but there is a PR, check if the PR is
    // closed or not and update the status accordingly.
    if (prMetadata) {
      const { number: prNumber } = prMetadata;
      const originPRInfo = await this.getPullRequest(prNumber);
      const { state: currentState, merged_at: mergedAt } = originPRInfo;
      if (currentState === 'closed' && mergedAt) {
        // The PR has been merged; delete the unpublished entry
        const { collection } = metadata;
        const slug = this.slugFromContentKey(contentKey, collection);
        this.deleteUnpublishedEntry(collection, slug);
        return;
      } else if (currentState === 'closed' && !mergedAt) {
        if (status !== 'draft') {
          const newMetadata = { ...metadata, status: 'draft' };
          await this.storeMetadata(contentKey, newMetadata);
          return newMetadata;
        }
      } else {
        if (status !== 'pending_review') {
          // PR is open and has not been merged
          const newMetadata = { ...metadata, status: 'pending_review' };
          await this.storeMetadata(contentKey, newMetadata);
          return newMetadata;
        }
      }
    }

    return metadata;
  };

  async migrateToVersion1(branch: Branch, metaData: Metadata) {
    // hard code key/branch generation logic to ignore future changes
    const oldContentKey = branch.ref.substring(`refs/heads/cms/`.length);
    const newContentKey = `${metaData.collection}/${oldContentKey}`;
    const newBranchName = `cms/${newContentKey}`;

    // create new branch and pull request in new format
    const newBranch = await this.createBranch(newBranchName, (metaData.pr as PR).head as string);
    const pr = await this.createPR(metaData.commitMessage, newBranchName);

    // store new metadata
    await this.storeMetadata(newContentKey, {
      ...metaData,
      pr: {
        number: pr.number,
        head: pr.head.sha,
      },
      branch: newBranchName,
      version: '1',
    });

    // remove old data
    await this.closePR(metaData.pr as PR);
    await this.deleteBranch(metaData.branch);
    await this.deleteMetadata(oldContentKey);

    return newBranch;
  }

  async migrateBranch(branch: Branch) {
    const metadata = await this.retrieveMetadata(this.contentKeyFromRef(branch.ref));
    if (!metadata.version) {
      // migrate branch from cms/slug to cms/collection/slug
      branch = await this.migrateToVersion1(branch, metadata);
    }

    return branch;
  }

  async listUnpublishedBranches(): Promise<Branch[]> {
    console.log(
      '%c Checking for Unpublished entries',
      'line-height: 30px;text-align: center;font-weight: bold',
    );

    try {
      const branches: Branch[] = await this.request(`${this.repoURL}/git/refs/heads/cms`).catch(
        replace404WithEmptyArray,
      );

      let filterFunction;
      if (this.useOpenAuthoring) {
        const getUpdatedOpenAuthoringBranches = flow([
          map(async (branch: Branch) => {
            const contentKey = this.contentKeyFromRef(branch.ref);
            const metadata = await this.getUpdatedOpenAuthoringMetadata(contentKey);
            // filter out removed entries
            if (!metadata) {
              return Promise.reject('Unpublished entry was removed');
            }
            return branch;
          }),
          onlySuccessfulPromises,
        ]);
        filterFunction = getUpdatedOpenAuthoringBranches;
      } else {
        const prs = await this.getPRsForBranchName(CMS_BRANCH_PREFIX);
        const onlyBranchesWithOpenPRs = flowAsync([
          filter(({ ref }: Branch) => prs.some(pr => pr.head.ref === this.branchNameFromRef(ref))),
          map((branch: Branch) => this.migrateBranch(branch)),
          onlySuccessfulPromises,
        ]);

        filterFunction = onlyBranchesWithOpenPRs;
      }

      return await filterFunction(branches);
    } catch (err) {
      console.log(
        '%c No Unpublished entries',
        'line-height: 30px;text-align: center;font-weight: bold',
      );
      throw err;
    }
  }

  /**
   * Retrieve statuses for a given SHA. Unrelated to the editorial workflow
   * concept of entry "status". Useful for things like deploy preview links.
   */
  async getStatuses(sha: string) {
    try {
      const resp: { statuses: GitHubCommitStatus[] } = await this.request(
        `${this.originRepoURL}/commits/${sha}/status`,
      );
      return resp.statuses.map(s => ({
        context: s.context,
        // eslint-disable-next-line @typescript-eslint/camelcase
        target_url: s.target_url,
        state:
          s.state === GitHubCommitStatusState.Success ? PreviewState.Success : PreviewState.Other,
      }));
    } catch (err) {
      if (err && err.message && err.message === 'Ref not found') {
        return [];
      }
      throw err;
    }
  }

  async persistFiles(entry: Entry | null, mediaFiles: AssetProxy[], options: PersistOptions) {
    const files = entry ? mediaFiles.concat(entry) : mediaFiles;
    const uploadPromises = files.map(file => this.uploadBlob(file));
    await Promise.all(uploadPromises);

    if (!options.useWorkflow) {
      return this.getDefaultBranch()
        .then(branchData =>
          this.updateTree(branchData.commit.sha, files as { sha: string; path: string }[]),
        )
        .then(changeTree => this.commit(options.commitMessage, changeTree))
        .then(response => this.patchBranch(this.branch, response.sha));
    } else {
      const mediaFilesList = (mediaFiles as { sha: string; path: string }[]).map(
        ({ sha, path }) => ({
          path: trimStart(path, '/'),
          sha,
        }),
      );
      return this.editorialWorkflowGit(
        files as TreeFile[],
        entry as Entry,
        mediaFilesList,
        options,
      );
    }
  }

  getFileSha(path: string, { repoURL = this.repoURL, branch = this.branch } = {}) {
    /**
     * We need to request the tree first to get the SHA. We use extended SHA-1
     * syntax (<rev>:<path>) to get a blob from a tree without having to recurse
     * through the tree.
     */

    const pathArray = path.split('/');
    const filename = last(pathArray);
    const directory = initial(pathArray).join('/');
    const fileDataPath = encodeURIComponent(directory);
    const fileDataURL = `${repoURL}/git/trees/${branch}:${fileDataPath}`;

    return this.request(fileDataURL, { cache: 'no-store' }).then((resp: GitHubTree) => {
      const { sha } = resp.tree.find(file => file.path === filename) as GitHubTreeItem;
      return sha;
    });
  }

  deleteFile(path: string, message: string) {
    if (this.useOpenAuthoring) {
      return Promise.reject('Cannot delete published entries as an Open Authoring user!');
    }

    const branch = this.branch;

    return this.getFileSha(path, { branch }).then(sha => {
      const params: { sha: string; message: string; branch: string; author?: { date: string } } = {
        sha,
        message,
        branch,
      };
      const opts = { method: 'DELETE', params };
      if (this.commitAuthor) {
        opts.params.author = {
          ...this.commitAuthor,
          date: new Date().toISOString(),
        };
      }
      const fileURL = `${this.repoURL}/contents/${path}`;
      return this.request(fileURL, opts);
    });
  }

  async createBranchAndPullRequest(branchName: string, sha: string, commitMessage: string) {
    await this.createBranch(branchName, sha);
    return this.createPR(commitMessage, branchName);
  }

  async editorialWorkflowGit(
    files: TreeFile[],
    entry: Entry,
    mediaFilesList: MediaFile[],
    options: PersistOptions,
  ) {
    const contentKey = this.generateContentKey(options.collectionName as string, entry.slug);
    const branchName = this.generateBranchName(contentKey);
    const unpublished = options.unpublished || false;
    if (!unpublished) {
      // Open new editorial review workflow for this entry - Create new metadata and commit to new branch
      const userPromise = this.user();
      const branchData = await this.getDefaultBranch();
      const changeTree = await this.updateTree(branchData.commit.sha, files);
      const commitResponse = await this.commit(options.commitMessage, changeTree);

      let pr;
      if (this.useOpenAuthoring) {
        await this.createBranch(branchName, commitResponse.sha);
      } else {
        pr = await this.createBranchAndPullRequest(
          branchName,
          commitResponse.sha,
          options.commitMessage,
        );
      }

      const user = await userPromise;
      return this.storeMetadata(contentKey, {
        type: 'PR',
        pr: pr
          ? {
              number: pr.number,
              head: pr.head && pr.head.sha,
            }
          : undefined,
        user: user.name || user.login,
        status: options.status || this.initialWorkflowStatus,
        branch: branchName,
        collection: options.collectionName as string,
        commitMessage: options.commitMessage,
        title: options.parsedData && options.parsedData.title,
        description: options.parsedData && options.parsedData.description,
        objects: {
          entry: {
            path: entry.path,
            sha: entry.sha as string,
          },
          files: mediaFilesList,
        },
        timeStamp: new Date().toISOString(),
        version: CURRENT_METADATA_VERSION,
      });
    } else {
      // Entry is already on editorial review workflow - just update metadata and commit to existing branch
      const metadata = await this.retrieveMetadata(contentKey);
      // mark media files to remove
      const metadataMediaFiles: MediaFile[] = get(metadata, 'objects.files', []);
      const mediaFilesToRemove: { path: string; sha: string | null }[] = differenceBy(
        metadataMediaFiles,
        mediaFilesList,
        'path',
      ).map(file => ({ ...file, type: 'blob', sha: null }));

      // rebase the branch before applying new changes
      const rebasedHead = await this.rebaseBranch(branchName);
      const treeFiles = mediaFilesToRemove.concat(files);
      const changeTree = await this.updateTree(rebasedHead.sha, treeFiles);
      const commit = await this.commit(options.commitMessage, changeTree);
      const { title, description } = options.parsedData || {};

      const pr = metadata.pr ? { ...metadata.pr, head: commit.sha } : undefined;
      const objects = {
        entry: { path: entry.path, sha: entry.sha as string },
        files: mediaFilesList,
      };

      const updatedMetadata = { ...metadata, pr, title, description, objects };

      await this.storeMetadata(contentKey, updatedMetadata);
      return this.patchBranch(branchName, commit.sha, { force: true });
    }
  }

  async compareBranchToDefault(
    branchName: string,
  ): Promise<{ baseCommit: GitHubCompareBaseCommit; commits: GitHubCompareCommits }> {
    const headReference = await this.getHeadReference(branchName);
    const { base_commit: baseCommit, commits }: GitHubCompareResponse = await this.request(
      `${this.originRepoURL}/compare/${this.branch}...${headReference}`,
    );
    return { baseCommit, commits };
  }

  async getCommitsDiff(baseSha: string, headSha: string): Promise<GitHubCompareFiles> {
    const { files }: GitHubCompareResponse = await this.request(
      `${this.repoURL}/compare/${baseSha}...${headSha}`,
    );
    return files;
  }

  async rebaseSingleCommit(baseCommit: GitHubCompareCommit, commit: GitHubCompareCommit) {
    // first get the diff between the commits
    const files = await this.getCommitsDiff(commit.parents[0].sha, commit.sha);
    const treeFiles = files.reduce((arr, file) => {
      if (file.status === 'removed') {
        // delete the file
        arr.push({ sha: null, path: file.filename });
      } else if (file.status === 'renamed') {
        // delete the previous file
        arr.push({ sha: null, path: file.previous_filename as string });
        // add the renamed file
        arr.push({ sha: file.sha, path: file.filename });
      } else {
        // add the  file
        arr.push({ sha: file.sha, path: file.filename });
      }
      return arr;
    }, [] as { sha: string | null; path: string }[]);

    // create a tree with baseCommit as the base with the diff applied
    const tree = await this.updateTree(baseCommit.sha, treeFiles);
    const { message, author, committer } = commit.commit;

    // create a new commit from the updated tree
    return (this.createCommit(
      message,
      tree.sha,
      [baseCommit.sha],
      author,
      committer,
    ) as unknown) as GitHubCompareCommit;
  }

  /**
   * Rebase an array of commits one-by-one, starting from a given base SHA
   */
  async rebaseCommits(baseCommit: GitHubCompareCommit, commits: GitHubCompareCommits) {
    /**
     * If the parent of the first commit already matches the target base,
     * return commits as is.
     */
    if (commits.length === 0 || commits[0].parents[0].sha === baseCommit.sha) {
      const head = last(commits) as GitHubCompareCommit;
      return head;
    } else {
      /**
       * Re-create each commit over the new base, applying each to the previous,
       * changing only the parent SHA and tree for each, but retaining all other
       * info, such as the author/committer data.
       */
      const newHeadPromise = commits.reduce((lastCommitPromise, commit) => {
        return lastCommitPromise.then(newParent => {
          const parent = newParent;
          const commitToRebase = commit;
          return this.rebaseSingleCommit(parent, commitToRebase);
        });
      }, Promise.resolve(baseCommit));
      return newHeadPromise;
    }
  }

  async rebaseBranch(branchName: string) {
    try {
      // Get the diff between the default branch the published branch
      const { baseCommit, commits } = await this.compareBranchToDefault(branchName);
      // Rebase the branch based on the diff
      const rebasedHead = await this.rebaseCommits(baseCommit, commits);
      return rebasedHead;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Get a pull request by PR number.
   */
  getPullRequest(prNumber: number) {
    return this.request(`${this.originRepoURL}/pulls/${prNumber} }`);
  }

  async updateUnpublishedEntryStatus(collectionName: string, slug: string, status: string) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const metadata = await this.retrieveMetadata(contentKey);

    if (!this.useOpenAuthoring) {
      return this.storeMetadata(contentKey, {
        ...metadata,
        status,
      });
    }

    if (status === 'pending_publish') {
      throw new Error('Open Authoring entries may not be set to the status "pending_publish".');
    }

    const { pr: prMetadata } = metadata;
    if (prMetadata) {
      const { number: prNumber } = prMetadata;
      const originPRInfo = await this.getPullRequest(prNumber);
      const { state } = originPRInfo;
      if (state === 'open' && status === 'draft') {
        await this.closePR(prMetadata);
        return this.storeMetadata(contentKey, {
          ...metadata,
          status,
        });
      }

      if (state === 'closed' && status === 'pending_review') {
        await this.openPR(prMetadata);
        return this.storeMetadata(contentKey, {
          ...metadata,
          status,
        });
      }
    }

    if (!prMetadata && status === 'pending_review') {
      const branchName = this.generateBranchName(contentKey);
      const commitMessage = metadata.commitMessage || API.DEFAULT_COMMIT_MESSAGE;
      const { number, head } = await this.createPR(commitMessage, branchName);
      return this.storeMetadata(contentKey, {
        ...metadata,
        pr: { number, head },
        status,
      });
    }
  }

  async deleteUnpublishedEntry(collectionName: string, slug: string) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const branchName = this.generateBranchName(contentKey);
    return this.retrieveMetadata(contentKey)
      .then(metadata => (metadata && metadata.pr ? this.closePR(metadata.pr) : Promise.resolve()))
      .then(() => this.deleteBranch(branchName))
      .then(() => this.deleteMetadata(contentKey));
  }

  async publishUnpublishedEntry(collectionName: string, slug: string) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const branchName = this.generateBranchName(contentKey);
    const metadata = await this.retrieveMetadata(contentKey);
    await this.mergePR(metadata.pr as PR, metadata.objects);
    await this.deleteBranch(branchName);
    await this.deleteMetadata(contentKey);

    return metadata;
  }

  createRef(type: string, name: string, sha: string) {
    return this.request(`${this.repoURL}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/${type}/${name}`, sha }),
    });
  }

  patchRef(type: string, name: string, sha: string, opts: { force?: boolean } = {}) {
    const force = opts.force || false;
    return this.request(`${this.repoURL}/git/refs/${type}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha, force }),
    });
  }

  deleteRef(type: string, name: string) {
    return this.request(`${this.repoURL}/git/refs/${type}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  }

  getDefaultBranch(): Promise<GitHubBranch> {
    return this.request(`${this.originRepoURL}/branches/${encodeURIComponent(this.branch)}`);
  }

  createBranch(branchName: string, sha: string) {
    return this.createRef('heads', branchName, sha);
  }

  assertCmsBranch(branchName: string) {
    return branchName.startsWith(`${CMS_BRANCH_PREFIX}/`);
  }

  patchBranch(branchName: string, sha: string, opts: { force?: boolean } = {}) {
    const force = opts.force || false;
    if (force && !this.assertCmsBranch(branchName)) {
      throw Error(`Only CMS branches can be force updated, cannot force update ${branchName}`);
    }
    return this.patchRef('heads', branchName, sha, { force });
  }

  deleteBranch(branchName: string) {
    return this.deleteRef('heads', branchName).catch((err: Error) => {
      // If the branch doesn't exist, then it has already been deleted -
      // deletion should be idempotent, so we can consider this a
      // success.
      if (err.message === 'Reference does not exist') {
        return Promise.resolve();
      }
      console.error(err);
      return Promise.reject(err);
    });
  }

  async getHeadReference(head: string) {
    const headReference = this.useOpenAuthoring ? `${(await this.user()).login}:${head}` : head;
    return headReference;
  }

  async createPR(title: string, head: string) {
    const headReference = await this.getHeadReference(head);
    return this.request(`${this.originRepoURL}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        body: DEFAULT_PR_BODY,
        head: headReference,
        base: this.branch,
      }),
    });
  }

  async openPR(pullRequest: PR) {
    const { number } = pullRequest;
    console.log('%c Re-opening PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.originRepoURL}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'open',
      }),
    });
  }

  closePR(pullRequest: PR) {
    const { number } = pullRequest;
    console.log('%c Deleting PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.originRepoURL}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({
        state: 'closed',
      }),
    });
  }

  mergePR(pullrequest: PR, objects: MetaDataObjects) {
    const { head: headSha, number } = pullrequest;
    console.log('%c Merging PR', 'line-height: 30px;text-align: center;font-weight: bold');
    return this.request(`${this.originRepoURL}/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        // eslint-disable-next-line @typescript-eslint/camelcase
        commit_message: MERGE_COMMIT_MESSAGE,
        sha: headSha,
        // eslint-disable-next-line @typescript-eslint/camelcase
        merge_method: this.mergeMethod,
      }),
    }).catch(error => {
      if (error instanceof APIError && error.status === 405) {
        return this.forceMergePR(objects);
      } else {
        throw error;
      }
    });
  }

  forceMergePR(objects: MetaDataObjects) {
    const files = objects.files.concat(objects.entry);
    let commitMessage = 'Automatically generated. Merged on Netlify CMS\n\nForce merge of:';
    files.forEach(file => {
      commitMessage += `\n* "${file.path}"`;
    });
    console.log(
      '%c Automatic merge not possible - Forcing merge.',
      'line-height: 30px;text-align: center;font-weight: bold',
    );
    return this.getDefaultBranch()
      .then(branchData => this.updateTree(branchData.commit.sha, files))
      .then(changeTree => this.commit(commitMessage, changeTree))
      .then(response => this.patchBranch(this.branch, response.sha));
  }

  toBase64(str: string) {
    return Promise.resolve(Base64.encode(str));
  }

  uploadBlob(item: { raw?: string; sha?: string; toBase64?: () => Promise<string> }) {
    const content = result(item, 'toBase64', partial(this.toBase64, item.raw as string));

    return content.then(contentBase64 =>
      this.request(`${this.repoURL}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({
          content: contentBase64,
          encoding: 'base64',
        }),
      }).then(response => {
        item.sha = response.sha;
        return item;
      }),
    );
  }

  async updateTree(baseSha: string, files: { path: string; sha: string | null }[]) {
    const tree: TreeEntry[] = files.map(file => ({
      path: trimStart(file.path, '/'),
      mode: '100644',
      type: 'blob',
      sha: file.sha,
    }));

    const newTree = await this.createTree(baseSha, tree);
    return { ...newTree, parentSha: baseSha };
  }

  createTree(baseSha: string, tree: TreeEntry[]): Promise<GitHubTree> {
    return this.request(`${this.repoURL}/git/trees`, {
      method: 'POST',
      // eslint-disable-next-line @typescript-eslint/camelcase
      body: JSON.stringify({ base_tree: baseSha, tree }),
    });
  }

  commit(message: string, changeTree: { parentSha?: string; sha: string }) {
    const parents = changeTree.parentSha ? [changeTree.parentSha] : [];
    return this.createCommit(message, changeTree.sha, parents);
  }

  createCommit(
    message: string,
    treeSha: string,
    parents: string[],
    author?: GitHubAuthor,
    committer?: GitHubCommiter,
  ): Promise<GitHubCommit> {
    return this.request(`${this.repoURL}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: treeSha, parents, author, committer }),
    });
  }
}
