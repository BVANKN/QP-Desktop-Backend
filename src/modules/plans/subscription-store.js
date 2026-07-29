// Subscription records live apart from user records (data/plans/), so
// billing state can evolve — invoices, renewals, payment providers — without
// touching identity data. The user's `planId` is only a cached hint; the
// subscription store is authoritative and entitlements are always computed
// from here.
import { JsonStore } from '../../lib/json-store.js';
import { randomId } from '../../lib/crypto.js';
import { DEFAULT_PLAN_ID, planById } from './plan-catalog.js';

const subscriptionsStore = new JsonStore('plans/subscriptions.json', { subscriptions: {} });

export async function subscriptionForUser(userId) {
  const db = await subscriptionsStore.read();
  return Object.values(db.subscriptions).find(subscription => subscription.userId === userId && subscription.status === 'active') || null;
}

export async function ensureSubscription(userId, planId = DEFAULT_PLAN_ID) {
  return subscriptionsStore.update(db => {
    const existing = Object.values(db.subscriptions).find(subscription => subscription.userId === userId && subscription.status === 'active');
    if (existing) return { result: existing };
    const now = new Date().toISOString();
    const subscription = {
      id: randomId('sub'),
      userId,
      planId: planById(planId).id,
      status: 'active',
      startedAt: now,
      updatedAt: now,
      // Payment processing is intentionally out of scope; when it lands,
      // provider references (customer id, invoice ids) attach here.
      payment: { provider: 'none', reference: null }
    };
    db.subscriptions[subscription.id] = subscription;
    return { result: subscription };
  });
}

export async function changePlan(userId, nextPlanId) {
  const plan = planById(nextPlanId);
  return subscriptionsStore.update(db => {
    const now = new Date().toISOString();
    let subscription = Object.values(db.subscriptions).find(entry => entry.userId === userId && entry.status === 'active');
    if (!subscription) {
      subscription = {
        id: randomId('sub'),
        userId,
        planId: plan.id,
        status: 'active',
        startedAt: now,
        updatedAt: now,
        payment: { provider: 'none', reference: null }
      };
      db.subscriptions[subscription.id] = subscription;
    } else {
      subscription.planId = plan.id;
      subscription.updatedAt = now;
    }
    return { result: subscription };
  });
}

// The entitlement set placed inside signed access tokens. Derived, never stored.
export async function entitlementsForUser(userId) {
  const subscription = await subscriptionForUser(userId);
  const plan = planById(subscription?.planId || DEFAULT_PLAN_ID);
  return { planId: plan.id, features: [...plan.features] };
}
