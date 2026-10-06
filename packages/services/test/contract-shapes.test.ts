/**
 * S2 conformance: services contract shapes accept their documented fixtures.
 * Compile-time assignability plus runtime shape assertions; adapter behavior
 * lands with the `@canlang/services` implementation (S4+).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AdapterFeatures,
  CapabilityCompletion,
  CapabilityContract,
  DeliveryError,
  DeliveryResult,
  EmailAccepted,
  EmailSendInput,
  ErrorAccepted,
  ErrorReport,
  OperationOutcome,
  PageRequest,
  PaymentCancelInput,
  PaymentCollectInput,
  PaymentReconcileInput,
  PaymentRefundInput,
  PaymentState,
  ProviderBinding,
  ProviderLimits,
  ProviderPage,
  VerifiedIngressEnvelope,
} from '@canlang/contracts';

describe('services contracts', () => {
  it('keeps delivery receipts and errors closed', () => {
    const receipt: DeliveryResult = { id: 'del_1', status: 'pending' };
    const error: DeliveryError = {
      code: 'provider',
      message: 'Delivery rejected',
    };
    assert.deepEqual(Object.keys(receipt).sort(), ['id', 'status']);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message']);
  });

  it('accepts the four documented completion envelopes', () => {
    const succeeded: CapabilityCompletion<EmailAccepted> = {
      delivery_id: 'del_1',
      status: 'succeeded',
      result: { reference: 'mail_1' },
      error: null,
    };
    const failed: CapabilityCompletion<EmailAccepted> = {
      delivery_id: 'del_2',
      status: 'failed',
      result: null,
      error: { code: 'provider', message: 'Rejected' },
    };
    const unknown: CapabilityCompletion<EmailAccepted> = {
      delivery_id: 'del_3',
      status: 'unknown',
      result: null,
      error: null,
    };
    const skipped: CapabilityCompletion<EmailAccepted> = {
      delivery_id: 'del_4',
      status: 'skipped',
      result: null,
      error: null,
    };
    assert.equal(succeeded.result?.reference, 'mail_1');
    assert.equal(failed.error?.code, 'provider');
    assert.equal(unknown.result, null);
    assert.equal(skipped.error, null);
  });

  it('models EmailV1 inputs and acceptance', () => {
    const input: EmailSendInput = {
      to: 'reviewer@example.test',
      subject: 'Review',
      body: 'Plan',
      attachments: [],
    };
    const accepted: EmailAccepted = { reference: 'mail_1' };
    assert.equal(input.attachments.length, 0);
    assert.equal(accepted.reference, 'mail_1');
  });

  it('models payment state, collect and refund inputs', () => {
    // Amounts are lane-2 wire money (decimal-string minors + currency).
    const money = { minor: '2500', currency: 'EUR' };
    const state: PaymentState = {
      reference: 'pay_1',
      revision: 2,
      provider_reference: 'pi_1',
      amount: money,
      status: 'pending',
      checkout_url: null,
      failure: null,
    };
    const collect: PaymentCollectInput = {
      customer: 'cus_1',
      amount: money,
      reference: 'pay_1',
      consent: null,
    };
    const refund: PaymentRefundInput = {
      payment: 'pay_1',
      amount: money,
      reference: 'rf_1',
    };
    const cancel: PaymentCancelInput = { reference: 'pay_1' };
    const reconcile: PaymentReconcileInput = { reference: 'pay_1' };
    assert.equal(state.status, 'pending');
    assert.equal(state.failure, null);
    assert.equal(collect.consent, null);
    assert.equal(refund.reference, 'rf_1');
    assert.equal(cancel.reference, 'pay_1');
    assert.equal(reconcile.reference, 'pay_1');
  });

  it('models error reports and shared operation outcomes', () => {
    const report: ErrorReport = {
      id: 'err_1',
      message: 'boom',
      occurred_at: {
        kind: 'datetime',
        ms: BigInt(Date.parse('2026-10-04T15:00:00Z')),
      },
      stack: null,
      release: '1.0.0',
      environment: null,
    };
    const accepted: ErrorAccepted = { reference: 'rep_1' };
    const outcome: OperationOutcome = {
      source: 'Billing',
      revision: 1,
      state: 'pending',
    };
    assert.equal(report.release, '1.0.0');
    assert.equal(accepted.reference, 'rep_1');
    assert.equal(outcome.state, 'pending');
  });

  it('models bindings, features, limits and pagination', () => {
    const binding: ProviderBinding = {
      capability: 'std.EmailV1',
      capabilityVersion: 1,
      deployment: 'deployment.mail',
      account: 'acct_1',
    };
    const contract: CapabilityContract = {
      name: 'std.EmailV1',
      version: 1,
      operations: [
        {
          name: 'send',
          inputs: {
            to: 'email',
            subject: 'text',
            body: 'text',
            attachments: 'file[]',
          },
          result: 'EmailAccepted',
        },
      ],
      events: [],
    };
    const features: AdapterFeatures = {
      operations: ['send'],
      events: [],
      pagination: false,
      reconciliation: true,
    };
    const limits: ProviderLimits = {
      maxPageSize: null,
      maxTransportBytes: 25_000_000,
    };
    const request: PageRequest = { cursor: null, limit: 50 };
    const page: ProviderPage<string> = { items: ['a'], nextCursor: null };
    assert.equal(binding.deployment, 'deployment.mail');
    assert.equal(contract.version, 1);
    assert.equal(contract.operations[0]?.result, 'EmailAccepted');
    assert.equal(contract.operations[0]?.inputs['to'], 'email');
    assert.equal(features.reconciliation, true);
    assert.equal(limits.maxTransportBytes, 25_000_000);
    assert.equal(request.limit, 50);
    assert.equal(page.items.length, 1);
  });

  it('models the verified ingress causation envelope', () => {
    const envelope: VerifiedIngressEnvelope = {
      namespace: 'shop-1/billing',
      producerEventId: 'evt_1',
      operationKind: 'charge',
      requestDigest: 'sha256:abc',
      deliveryId: 'del_9',
    };
    assert.equal(envelope.operationKind, 'charge');
    assert.equal(envelope.deliveryId, 'del_9');
  });
});
