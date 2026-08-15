import { createHmac, timingSafeEqual } from 'node:crypto';

export interface HumanAnswerReceiptInput {
  taskId: string;
  question: string;
  answer: string;
  answeredAt: string;
  endpointId: string;
}

const RECEIPT_VERSION = 'v1';

function payload(input: HumanAnswerReceiptInput): string {
  return JSON.stringify([
    RECEIPT_VERSION,
    input.taskId,
    input.question,
    input.answer,
    input.answeredAt,
    input.endpointId,
  ]);
}

/** Authenticate a human answer that arrived through one verified webhook
 * endpoint. The endpoint secret never enters the task ledger. */
export function signHumanAnswerReceipt(secret: string, input: HumanAnswerReceiptInput): string {
  const mac = createHmac('sha256', secret).update(payload(input)).digest('hex');
  return `${RECEIPT_VERSION}:${mac}`;
}

export function verifyHumanAnswerReceipt(
  secret: string,
  input: HumanAnswerReceiptInput,
  receipt: string,
): boolean {
  if (!secret || !receipt.startsWith(`${RECEIPT_VERSION}:`)) return false;
  const expected = Buffer.from(signHumanAnswerReceipt(secret, input));
  const actual = Buffer.from(receipt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
