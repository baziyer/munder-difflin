/** Append a visible delivery, or refresh the one automation delivery that a
 * dedupe key represents. Human-authored messages have no key and are never
 * collapsed: repeating an instruction can be intentional. */
export function upsertQueuedMessage<T extends { dedupeKey?: string }>(
  queue: T[],
  candidate: T,
): T[] {
  if (!candidate.dedupeKey) return [...queue, candidate];
  const index = queue.findIndex((item) => item.dedupeKey === candidate.dedupeKey);
  if (index < 0) return [...queue, candidate];
  return queue.map((item, itemIndex) => itemIndex === index ? candidate : item);
}
