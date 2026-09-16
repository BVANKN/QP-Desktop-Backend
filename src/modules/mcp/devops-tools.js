// Azure DevOps MCP tools.
//
// Every tool here executes on the Quicker Portal desktop as the Microsoft
// account signed in there, and only inside the organizations and projects the
// user granted to this connection. The server attaches that grant to each job
// from the connection record; nothing in these schemas can supply or widen it.
//
// Names read as sentences a model can choose between without guessing, and
// each description says when to use the tool, not only what it returns.

export function devOpsTools({ tool, object, string, boolean, array, number }) {
  const read = { group: 'devops' };
  const write = { group: 'devops', readOnly: false };
  const destructive = { group: 'devops', readOnly: false, destructive: true };
  const integer = (description, minimum = 1, maximum = 1000) => ({ type: 'integer', description, minimum, maximum });

  const organization = { ...string('Azure DevOps organization name, as returned by list_devops_organizations.'), pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$' };
  const project = { ...string('Project name, as returned by list_devops_projects.'), minLength: 1, maxLength: 64 };
  const repository = { ...string('Repository name or id, as returned by list_devops_repositories.'), minLength: 1, maxLength: 128 };
  const workItemId = integer('Work item id.', 1, 2_147_483_647);
  const fieldValues = {
    type: 'object',
    description: 'Field values keyed by reference name, for example {"System.Title": "Fix login", "System.State": "Active", "System.AssignedTo": "person@contoso.com"}. Use list_devops_work_item_types for valid types and states. HTML fields such as System.Description accept HTML.',
    additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    maxProperties: 60
  };
  const mention = object({
    id: { ...string('Identity id returned by search_devops_people.'), pattern: '^[0-9a-fA-F-]{36}$' },
    displayName: { ...string('Display name, shown in the comment.'), maxLength: 200 }
  }, ['id', 'displayName']);
  const branch = { ...string('Branch name, for example main or feature/login.'), maxLength: 250 };
  const path = { ...string('Absolute path inside the repository, for example /src/app.js.'), maxLength: 1024 };
  const confirm = { type: 'boolean', const: true, description: 'Must be true after the user explicitly approves this deletion.' };

  return [
    tool('get_devops_operation', 'mcpOperationStatus',
      'Check the operation ID returned by a pending Azure DevOps tool call. Poll after pollAfterMs; never repeat the original change to obtain a result. An unknown outcome requires reading current state before any retry.',
      object({ operationId: { ...string('Operation ID returned by this same MCP connection.'), minLength: 1, maxLength: 128 }, waitMs:{ type:'integer',minimum:0,maximum:20000,description:'Wait up to 20 seconds for the existing operation. Continue until terminal without repeating the original change.' } }, ['operationId']),
      { ...read, execution: 'server', idempotent: true }),
    tool('get_devops_connection', 'mcpConnectionStatus',
      'Check whether the Quicker Portal desktop is online for Azure DevOps and which organizations and projects this connection has been granted. Call this first. If nothing is granted, ask the user to grant organizations or projects in Quicker Portal under Azure DevOps MCP.',
      object(), { ...read, execution: 'server' }),

    // --- where ---------------------------------------------------------------
    tool('list_devops_organizations', 'mcpDevOpsListOrganizations',
      'List the Azure DevOps organizations this connection may use. Only granted organizations are returned, even if the signed-in account belongs to more.',
      object(), read),
    tool('list_devops_projects', 'mcpDevOpsListProjects',
      'List the projects in an organization that this connection may use. Only granted projects are returned.',
      object({ organization }, ['organization']), read),
    tool('list_devops_teams', 'mcpDevOpsListTeams',
      'List the teams in a project.',
      object({ organization, project }, ['organization', 'project']), read),
    tool('search_devops_people', 'mcpDevOpsSearchIdentities',
      'Find people or groups by name or email so they can be mentioned in a comment. Returns identity ids to pass as mentions.',
      object({ organization, search: { ...string('At least two characters of a name or email.'), minLength: 2, maxLength: 200 } }, ['organization', 'search']), read),

    // --- work items ----------------------------------------------------------
    tool('list_devops_work_item_types', 'mcpDevOpsListWorkItemTypes',
      'List the work item types in a project, with the states each one allows. Read this before creating an item or changing its state.',
      object({ organization, project }, ['organization', 'project']), read),
    tool('list_devops_areas', 'mcpDevOpsListAreas',
      'List area paths in a project.',
      object({ organization, project }, ['organization', 'project']), read),
    tool('list_devops_iterations', 'mcpDevOpsListIterations',
      'List iterations (sprints) in a project, with start and finish dates.',
      object({ organization, project }, ['organization', 'project']), read),
    tool('query_devops_work_items', 'mcpDevOpsQueryWorkItems',
      'Find work items. Prefer the structured filters, which are always scoped to the project and correctly escaped; pass wiql only when the filters cannot express the question. Results outside the granted projects are withheld and counted.',
      object({
        organization,
        project,
        filters: object({
          types: array({ type: 'string', maxLength: 128 }, 'Work item types, for example Bug or User Story.', { maxItems: 20 }),
          states: array({ type: 'string', maxLength: 128 }, 'States, for example Active or Resolved.', { maxItems: 20 }),
          assignedToMe: boolean('Only items assigned to the signed-in account.'),
          assignedTo: { ...string('Display name or email of the assignee.'), maxLength: 256 },
          areaPath: { ...string('Area path; includes items under it.'), maxLength: 1024 },
          iterationPath: { ...string('Iteration path; includes items under it.'), maxLength: 1024 },
          currentIteration: boolean('Only items in the current iteration.'),
          text: { ...string('Words to find in the title or description.'), maxLength: 256 },
          tags: array({ type: 'string', maxLength: 128 }, 'Tags every result must have.', { maxItems: 10 }),
          changedSinceDays: integer('Only items changed in this many days.', 1, 3650),
          orderBy: { type: 'string', enum: ['changed', 'created', 'priority'] }
        }),
        wiql: { ...string('A WIQL SELECT statement, only when filters cannot express the query.'), maxLength: 32_000 },
        top: integer('Maximum results, default 100.', 1, 1000)
      }, ['organization', 'project']), read),
    tool('get_devops_work_item', 'mcpDevOpsGetWorkItem',
      'Read one work item with all its fields, links and its revision. Read immediately before updating it, and pass rev as expectedRevision.',
      object({ organization, id: workItemId }, ['organization', 'id']), read),
    tool('create_devops_work_item', 'mcpDevOpsCreateWorkItem',
      'Create a work item. Confirm the type, title and important fields with the user first.',
      object({
        organization,
        project,
        type: { ...string('Work item type, for example Bug, Task or User Story.'), minLength: 1, maxLength: 128 },
        fields: fieldValues
      }, ['organization', 'project', 'type', 'fields']), write),
    tool('update_devops_work_item', 'mcpDevOpsUpdateWorkItem',
      'Change fields on a work item. Pass the rev from get_devops_work_item as expectedRevision; if the update reports a conflict, read the item again rather than forcing the change.',
      object({
        organization,
        id: workItemId,
        fields: fieldValues,
        removeFields: array({ type: 'string', maxLength: 128 }, 'Field reference names to clear.', { maxItems: 30 }),
        expectedRevision: integer('The rev returned by get_devops_work_item.', 1, 1_000_000)
      }, ['organization', 'id', 'expectedRevision']), { ...write, idempotent: true }),
    tool('delete_devops_work_item', 'mcpDevOpsDeleteWorkItem',
      'Move a work item to the recycle bin, from where it can be restored. Only after the user explicitly approves this exact item.',
      object({ organization, id: workItemId, confirm }, ['organization', 'id', 'confirm']), destructive),

    // --- messages ------------------------------------------------------------
    tool('list_devops_work_item_comments', 'mcpDevOpsListComments',
      'Read the discussion on a work item, newest first.',
      object({ organization, project, workItemId, top: integer('Maximum comments, default 50.', 1, 200) }, ['organization', 'project', 'workItemId']), read),
    tool('add_devops_work_item_comment', 'mcpDevOpsAddComment',
      'Post a comment on a work item. This is how to message someone in Azure DevOps: find them with search_devops_people and pass them in mentions, which sends them a notification. Plain @name text notifies nobody.',
      object({
        organization,
        project,
        workItemId,
        text: { ...string('Comment text. Line breaks are kept.'), minLength: 1, maxLength: 20_000 },
        mentions: array(mention, 'People to notify.', { maxItems: 20 })
      }, ['organization', 'project', 'workItemId', 'text']), write),

    // --- code ----------------------------------------------------------------
    tool('list_devops_repositories', 'mcpDevOpsListRepositories',
      'List Git repositories in a project, with their default branches.',
      object({ organization, project }, ['organization', 'project']), read),
    tool('list_devops_branches', 'mcpDevOpsListBranches',
      'List branches in a repository.',
      object({ organization, project, repository }, ['organization', 'project', 'repository']), read),
    tool('list_devops_files', 'mcpDevOpsListItems',
      'List files and folders at a path in a repository, optionally on a branch.',
      object({ organization, project, repository, path, branch, recursive: boolean('Include everything below the path, capped at 2000 entries.') }, ['organization', 'project', 'repository']), read),
    tool('read_devops_file', 'mcpDevOpsReadFile',
      'Read one text file from a repository, up to 2 MB.',
      object({ organization, project, repository, path, branch }, ['organization', 'project', 'repository', 'path']), read),
    tool('list_devops_commits', 'mcpDevOpsListCommits',
      'List recent commits in a repository, optionally on a branch or touching a path.',
      object({ organization, project, repository, branch, path, top: integer('Maximum commits, default 30.', 1, 200) }, ['organization', 'project', 'repository']), read),

    // --- pull requests -------------------------------------------------------
    tool('list_devops_pull_requests', 'mcpDevOpsListPullRequests',
      'List pull requests in a project or one repository.',
      object({ organization, project, repository, status: { type: 'string', enum: ['active', 'completed', 'abandoned', 'all'] }, top: integer('Maximum results, default 50.', 1, 200) }, ['organization', 'project']), read),
    tool('get_devops_pull_request', 'mcpDevOpsGetPullRequest',
      'Read a pull request with its description, reviewers and discussion threads.',
      object({ organization, project, repository, id: integer('Pull request id.', 1, 2_147_483_647) }, ['organization', 'project', 'repository', 'id']), read),
    tool('add_devops_pull_request_comment', 'mcpDevOpsAddPullRequestComment',
      'Start a discussion thread on a pull request, or reply to one by passing threadId.',
      object({
        organization, project, repository,
        id: integer('Pull request id.', 1, 2_147_483_647),
        text: { ...string('Comment text in Markdown.'), minLength: 1, maxLength: 20_000 },
        threadId: integer('Existing thread to reply to.', 1, 2_147_483_647)
      }, ['organization', 'project', 'repository', 'id', 'text']), write),
    tool('create_devops_pull_request', 'mcpDevOpsCreatePullRequest',
      'Open a pull request. It is created as a draft unless isDraft is false, so reviewers are not asked for their time until the user is ready.',
      object({
        organization, project, repository,
        sourceBranch: branch,
        targetBranch: branch,
        title: { ...string('Title.'), minLength: 1, maxLength: 400 },
        description: { ...string('Description in Markdown.'), maxLength: 4000 },
        isDraft: boolean('Create as a draft. Defaults to true.')
      }, ['organization', 'project', 'repository', 'sourceBranch', 'targetBranch', 'title']), write),

    // --- pipelines -----------------------------------------------------------
    tool('list_devops_pipelines', 'mcpDevOpsListPipelines',
      'List pipelines in a project.',
      object({ organization, project }, ['organization', 'project']), read),
    tool('list_devops_pipeline_runs', 'mcpDevOpsListPipelineRuns',
      'List recent runs of a pipeline with their state and result.',
      object({ organization, project, pipelineId: integer('Pipeline id.', 1, 2_147_483_647), top: integer('Maximum runs, default 20.', 1, 100) }, ['organization', 'project', 'pipelineId']), read),
    tool('get_devops_build', 'mcpDevOpsGetBuild',
      'Read a build or run result, including which steps failed and their error messages. Use this to explain why a pipeline failed.',
      object({ organization, project, buildId: integer('Build or run id.', 1, 2_147_483_647) }, ['organization', 'project', 'buildId']), read),
    tool('get_devops_build_log', 'mcpDevOpsGetBuildLog',
      'Read the last lines of one step log from a build. Use the logId from a failed step in get_devops_build.',
      object({ organization, project, buildId: integer('Build id.', 1, 2_147_483_647), logId: integer('Log id.', 1, 100_000), tailLines: integer('Lines from the end, default 200.', 1, 2000) }, ['organization', 'project', 'buildId', 'logId']), read),
    tool('run_devops_pipeline', 'mcpDevOpsRunPipeline',
      'Queue a pipeline run. Runs deploy, publish and spend agent minutes, so confirm the exact pipeline and branch with the user first. Template parameters are simple values; pipeline variables cannot be set.',
      object({
        organization, project,
        pipelineId: integer('Pipeline id.', 1, 2_147_483_647),
        branch,
        templateParameters: { type: 'object', description: 'Runtime parameters declared by the pipeline, as simple values.', additionalProperties: { type: ['string', 'number', 'boolean'] }, maxProperties: 30 }
      }, ['organization', 'project', 'pipelineId']), write),

    // --- wiki ----------------------------------------------------------------
    tool('list_devops_wikis', 'mcpDevOpsListWikis',
      'List wikis in a project.',
      object({ organization, project }, ['organization', 'project']), read),
    tool('get_devops_wiki_page', 'mcpDevOpsGetWikiPage',
      'Read a wiki page and its child pages. Returns a version to pass when saving.',
      object({ organization, project, wiki: { ...string('Wiki name or id.'), minLength: 1, maxLength: 128 }, path: { ...string('Page path, for example /Home.'), maxLength: 1024 } }, ['organization', 'project', 'wiki']), read),
    tool('save_devops_wiki_page', 'mcpDevOpsSaveWikiPage',
      'Create a wiki page, or update one by passing the version from get_devops_wiki_page. A stale version is refused rather than overwriting a newer edit.',
      object({
        organization, project,
        wiki: { ...string('Wiki name or id.'), minLength: 1, maxLength: 128 },
        path: { ...string('Page path, for example /Release Notes/1.2.'), minLength: 2, maxLength: 1024 },
        content: { ...string('Page content in Markdown.'), maxLength: 1_000_000 },
        expectedVersion: { ...string('Version from get_devops_wiki_page. Omit only to create a new page.'), maxLength: 128 }
      }, ['organization', 'project', 'wiki', 'path', 'content']), write),

    tool('list_devops_test_plans', 'mcpDevOpsListTestPlans',
      'List test plans in a project.',
      object({ organization, project }, ['organization', 'project']), read)
  ];
}
