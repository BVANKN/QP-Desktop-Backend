// Plan catalog — the single source of truth for what each plan can do.
// Entitlement keys are stable identifiers the desktop app checks. Adding a
// plan or feature happens here and nowhere else.
export const FEATURES = Object.freeze({
  DATAVERSE_TABLES: 'dataverse.tables',
  DATAVERSE_COLUMNS: 'dataverse.columns',
  POWER_AUTOMATE: 'dataverse.flows',
  DATAVERSE_ADVANCED: 'dataverse.advanced', // connection refs, model apps, solutions, env vars, security, workbench
  REPORTS: 'reports.insights',
  DEVELOPER_APPS: 'developer.apps'
});

export const PLANS = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Free',
    price: '$0',
    tagline: 'Explore Dataverse schema and cloud flows.',
    features: Object.freeze([
      FEATURES.DATAVERSE_TABLES,
      FEATURES.DATAVERSE_COLUMNS,
      FEATURES.POWER_AUTOMATE
    ])
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro',
    price: '$19',
    tagline: 'Full studio: reports, developer apps, and every Dataverse module.',
    features: Object.freeze([
      FEATURES.DATAVERSE_TABLES,
      FEATURES.DATAVERSE_COLUMNS,
      FEATURES.POWER_AUTOMATE,
      FEATURES.DATAVERSE_ADVANCED,
      FEATURES.REPORTS,
      FEATURES.DEVELOPER_APPS
    ])
  })
});

export const DEFAULT_PLAN_ID = 'free';

export function planById(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
}

export function publicPlanCatalog() {
  return Object.values(PLANS).map(plan => ({
    id: plan.id,
    name: plan.name,
    price: plan.price,
    tagline: plan.tagline,
    features: [...plan.features]
  }));
}
