/**
 * Which Azure DevOps organizations and projects an MCP connection may reach.
 *
 * Signing in proves who someone is. It says nothing about how much of what they
 * can see they want an AI to see, so a Azure DevOps connection starts granted
 * nothing and each organization is added either whole or project by project.
 *
 * The desktop enforces this against every request and every result, and
 * re-normalizes it there. It is validated here as well so that what is stored,
 * and shown back to the person, is exactly what will be enforced.
 */

const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;
const MAX_ORGANIZATIONS = 50;
const MAX_PROJECTS_PER_ORGANIZATION = 200;

function validProjectName(value) {
  const name = String(value ?? '').trim().slice(0, 64);
  if (!name || /[\u0000-\u001f\\/?#%]/.test(name) || name.startsWith('.') || name.startsWith('_')) return '';
  return name;
}

export function normalizeDevOpsGrant(input) {
  const organizations = {};
  const source = input && typeof input === 'object' && input.organizations && typeof input.organizations === 'object'
    ? input.organizations
    : {};
  for (const [rawName, rawGrant] of Object.entries(source).slice(0, MAX_ORGANIZATIONS)) {
    const name = String(rawName ?? '').trim();
    if (!ORGANIZATION.test(name)) continue;
    const grant = rawGrant && typeof rawGrant === 'object' ? rawGrant : {};
    const projects = [...new Set((Array.isArray(grant.projects) ? grant.projects : [])
      .map(validProjectName)
      .filter(Boolean))].slice(0, MAX_PROJECTS_PER_ORGANIZATION);
    // An organization with nothing in it grants nothing, so it is not kept:
    // storing it would show a grant that does not exist.
    if (grant.allProjects !== true && !projects.length) continue;
    organizations[name.toLowerCase()] = { name, allProjects: grant.allProjects === true, projects };
  }
  return { organizations };
}

export function summarizeDevOpsGrant(grant) {
  const normalized = normalizeDevOpsGrant(grant);
  const entries = Object.values(normalized.organizations);
  return {
    organizations: entries.length,
    wholeOrganizations: entries.filter(entry => entry.allProjects).length,
    projects: entries.reduce((total, entry) => total + (entry.allProjects ? 0 : entry.projects.length), 0),
    empty: entries.length === 0
  };
}
