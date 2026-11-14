import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipients } from '../src/lib/whisper.ts';

const users = [
  { session: 1, channelId: 5 }, // me
  { session: 2, channelId: 5 },
  { session: 3, channelId: 5 },
  { session: 4, channelId: 6 }, // linked
  { session: 5, channelId: 7 }, // linked through 6
  { session: 6, channelId: 8 }  // elsewhere
];
const links = (id: number): number[] => ({ 5: [6], 6: [5, 7], 7: [6] } as Record<number, number[]>)[id] ?? [];

test('everyone who would hear you except the ones left out, never yourself', () => {
  assert.deepEqual(recipients(1, 5, users, links, new Set([2])), [3, 4, 5]);
});

test('linked channels count, also through other links', () => {
  assert.deepEqual(recipients(1, 5, users, links, new Set()), [2, 3, 4, 5]);
});

test('without links only the own channel hears you', () => {
  assert.deepEqual(recipients(1, 5, users, () => [], new Set()), [2, 3]);
});

test('nobody left to talk to gives an empty list', () => {
  assert.deepEqual(recipients(1, 5, users, () => [], new Set([2, 3])), []);
});
