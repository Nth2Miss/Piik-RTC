import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from './room-store.js';
import { RoomLifecycle, PRESENCE_LIFETIME, EMPTY_ROOM_TIMEOUT } from './room-lifecycle.js';

test('abrupt disconnect starts vacancy at the heartbeat deadline, not at the next sweep', () => {
  const store = new RoomStore();
  const start = 1_000_000;
  store.create({ id: 'test', ownerId: 'u', name: 'test', description: '', inviteKey: 'k', createdAt: start, updatedAt: start });
  store.occupied('test', start);
  const sessions = new Map([['s', { roomId: 'test', lastSeen: start, expiresAt: start + 3600_000 }]]);
  const lifecycle = new RoomLifecycle(store, sessions);
  try {
    lifecycle.sweep(start + PRESENCE_LIFETIME + 30_000);
    assert.equal(store.get('test').emptySince, start + PRESENCE_LIFETIME);
    lifecycle.sweep(start + PRESENCE_LIFETIME + EMPTY_ROOM_TIMEOUT - 1);
    assert.ok(store.get('test'));
    lifecycle.sweep(start + PRESENCE_LIFETIME + EMPTY_ROOM_TIMEOUT);
    assert.equal(store.get('test'), undefined); assert.equal(sessions.size, 0);
  } finally { store.close(); }
});
test('restart restores idle deadline from persisted last activity instead of granting another 15 minutes', () => {
  const store = new RoomStore();
  const start = 2_000_000;
  store.create({ id: 'test', ownerId: 'u', name: 'test', description: '', inviteKey: 'k', createdAt: start, updatedAt: start });
  store.occupied('test', start);
  try {
    store.resetPresence(PRESENCE_LIFETIME);
    const lifecycle = new RoomLifecycle(store, new Map());
    lifecycle.sweep(start + PRESENCE_LIFETIME + EMPTY_ROOM_TIMEOUT);
    assert.equal(store.get('test'), undefined);
  } finally { store.close(); }
});
