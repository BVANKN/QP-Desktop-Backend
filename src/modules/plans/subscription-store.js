// Subscription records live apart from user records (data/plans/), so
// billing state can evolve — invoices, renewals, payment providers — without
// touching identity data. The user's `planId` is only a cached hint; the
// subscription store is authoritative and entitlements are always computed
// from here.
import { JsonStore } from '../../lib/json-store.js';
import { randomId } from '../../lib/crypto.js';
import { mongoCollection, mongoEnabled } from '../../lib/mongo.js';
import { DEFAULT_PLAN_ID, planById } from './plan-catalog.js';

const subscriptionsStore = new JsonStore('plans/subscriptions.json', { subscriptions: {} });

export async function subscriptionForUser(userId) {
  if (mongoEnabled()) {
    const document = await (await mongoCollection('subscriptions')).findOne({ userId, status: 'active' });
    if (!document) return null;
    const { _id, ...subscription } = document;
    return subscription;
  }
  const db = await subscriptionsStore.read();
  return Object.values(db.subscriptions).find(subscription => subscription.userId === userId && subscription.status === 'active') || null;
}

export async function ensureSubscription(userId, planId = DEFAULT_PLAN_ID) {
  const now = new Date().toISOString();
  const subscription = {
    id: randomId('sub'),
    userId,
    planId: planById(planId).id,
    status: 'active',
    startedAt: now,
    updatedAt: now,
    payment: { provider: 'none', reference: null }
  };
  if (mongoEnabled()) {
    const collection = await mongoCollection('subscriptions');
    const existing = await collection.findOne({ userId, status: 'active' });
    if (existing) {
      const { _id, ...value } = existing;
      return value;
    }
    try {
      await collection.insertOne(subscription);
      return subscription;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const winner = await collection.findOne({ userId, status: 'active' });
      if (!winner) throw error;
      const { _id, ...value } = winner;
      return value;
    }
  }
  return subscriptionsStore.update(db => {
    const existing = Object.values(db.subscriptions).find(entry => entry.userId === userId && entry.status === 'active');
    if (existing) return { result: existing };
    db.subscriptions[subscription.id] = subscription;
    return { result: subscription };
  });
}

export async function changePlan(userId, nextPlanId) {
  const plan = planById(nextPlanId);
  const now = new Date().toISOString();
  if (mongoEnabled()) {
    const collection = await mongoCollection('subscriptions');
    const updated = await collection.findOneAndUpdate(
      { userId, status: 'active' },
      {
        $set: { planId: plan.id, updatedAt: now },
        $setOnInsert: {
          id: randomId('sub'),
          userId,
          status: 'active',
          startedAt: now,
          payment: { provider: 'none', reference: null }
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
    const { _id, ...subscription } = updated;
    return subscription;
  }
  return subscriptionsStore.update(db => {
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
