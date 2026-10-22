/** Generated Require calls can enter only their genuine mutation's private reader. */
import { StateError } from '@canlang/state/errors';

type Evaluate = (predicate: Function, inputs: Readonly<Record<string, unknown>>) => Promise<boolean>;
const readers = new WeakMap<object, Evaluate>();

export function bindNativeScenarioRequire(context: object, evaluate: Evaluate): void {
  if (readers.has(context)) throw new StateError('validation', 'Scenario Require reader cannot be rebound.');
  readers.set(context, evaluate);
}

export async function nativeScenarioRequire(context: unknown, predicate: Function,
  inputs: Readonly<Record<string, unknown>>): Promise<boolean> {
  const evaluate = typeof context === 'object' && context !== null ? readers.get(context) : undefined;
  if (evaluate === undefined || typeof predicate !== 'function') {
    throw new StateError('validation', 'Scenario Require needs its actual installed mutation reader.');
  }
  return evaluate(predicate, inputs);
}

type EventEvaluate = (descriptor: unknown, predicate: Function) => Promise<boolean>;
const eventReaders = new WeakMap<object, EventEvaluate>();

/** Only the live due-handler context can evaluate its checked private IF. */
export function bindNativeScenarioEventDecision(context: object, evaluate: EventEvaluate): void {
  if (eventReaders.has(context)) throw new StateError('validation', 'Event decision reader cannot be rebound.');
  eventReaders.set(context, evaluate);
}

export async function nativeScenarioEventDecision(context: unknown, descriptor: unknown,
  predicate: Function): Promise<boolean> {
  const evaluate = typeof context === 'object' && context !== null ? eventReaders.get(context) : undefined;
  if (evaluate === undefined || typeof predicate !== 'function') {
    throw new StateError('validation', 'Event decision needs its actual admitted due owner.');
  }
  return evaluate(descriptor, predicate);
}

type TermEvaluate = (descriptor: unknown, select: Function) => Promise<unknown>;
const termReaders = new WeakMap<object, TermEvaluate>();

/** The paid-term query closure is bound only to its live admitted mutation. */
export function bindNativeScenarioTermDecision(context: object, evaluate: TermEvaluate): void {
  if (termReaders.has(context)) throw new StateError('validation', 'Term decision reader cannot be rebound.');
  termReaders.set(context, evaluate);
}

export async function nativeScenarioTermDecision(context: unknown, descriptor: unknown,
  select: Function): Promise<unknown> {
  const evaluate = typeof context === 'object' && context !== null ? termReaders.get(context) : undefined;
  if (evaluate === undefined || typeof select !== 'function') {
    throw new StateError('validation', 'Term decision needs its actual admitted mutation owner.');
  }
  return evaluate(descriptor, select);
}

type LeaveEvaluate = (descriptor: unknown, body: Function) => Promise<void>;
const leaveReaders = new WeakMap<object, LeaveEvaluate>();

/** The complete Leave request body belongs to one admitted serial owner session. */
export function bindNativeScenarioLeaveRequestDecision(context: object, evaluate: LeaveEvaluate): void {
  if (leaveReaders.has(context)) throw new StateError('validation', 'Leave request decision cannot be rebound.');
  leaveReaders.set(context, evaluate);
}

export async function nativeScenarioLeaveRequestDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? leaveReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Leave request needs its actual admitted mutation owner.');
  }
  return evaluate(descriptor, body);
}

const leaveDecideReaders = new WeakMap<object, LeaveEvaluate>();

/** The complete Leave decision body belongs to its one admitted mutation owner. */
export function bindNativeScenarioLeaveDecideDecision(context: object, evaluate: LeaveEvaluate): void {
  if (leaveDecideReaders.has(context)) throw new StateError('validation', 'Leave decision cannot be rebound.');
  leaveDecideReaders.set(context, evaluate);
}

export async function nativeScenarioLeaveDecideDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? leaveDecideReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Leave decision needs its actual admitted mutation owner.');
  }
  return evaluate(descriptor, body);
}

const referRejectReaders = new WeakMap<object, LeaveEvaluate>();

/** A stamped finite owner decision may run only in its live admitted mutation. */
export function bindNativeScenarioReferRejectDecision(context: object, evaluate: LeaveEvaluate): void {
  if (referRejectReaders.has(context)) throw new StateError('validation', 'Referral rejection decision cannot be rebound.');
  referRejectReaders.set(context, evaluate);
}

export async function nativeScenarioReferRejectDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? referRejectReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Referral rejection needs its actual admitted mutation owner.');
  }
  return evaluate(descriptor, body);
}

const memberRetryReaders = new WeakMap<object, LeaveEvaluate>();

/** The exact CanMember retry body belongs to its one admitted Term owner. */
export function bindNativeScenarioMemberRetryDecision(context: object, evaluate: LeaveEvaluate): void {
  if (memberRetryReaders.has(context)) throw new StateError('validation', 'Member retry decision cannot be rebound.');
  memberRetryReaders.set(context, evaluate);
}

export async function nativeScenarioMemberRetryDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? memberRetryReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Member retry needs its actual admitted Term mutation owner.');
  }
  return evaluate(descriptor, body);
}

const invoiceOverdueReaders = new WeakMap<object, LeaveEvaluate>();

/** The overdue Mail decision belongs to its admitted Invoice due event. */
export function bindNativeScenarioInvoiceOverdueDecision(context: object, evaluate: LeaveEvaluate): void {
  if (invoiceOverdueReaders.has(context)) throw new StateError('validation', 'Invoice overdue decision cannot be rebound.');
  invoiceOverdueReaders.set(context, evaluate);
}

export async function nativeScenarioInvoiceOverdueDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? invoiceOverdueReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Invoice overdue needs its actual admitted due mutation owner.');
  }
  return evaluate(descriptor, body);
}

const rentMovementRefundReaders = new WeakMap<object, LeaveEvaluate>();

/** One admitted Movement owner executes the checked refund and credit body. */
export function bindNativeScenarioRentMovementRefundDecision(context: object, evaluate: LeaveEvaluate): void {
  if (rentMovementRefundReaders.has(context)) throw new StateError('validation', 'Movement refund decision cannot be rebound.');
  rentMovementRefundReaders.set(context, evaluate);
}

export async function nativeScenarioRentMovementRefundDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? rentMovementRefundReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Movement refund needs its actual admitted owner mutation.');
  }
  return evaluate(descriptor, body);
}

const invoiceCollectReaders = new WeakMap<object, LeaveEvaluate>();

/** One admitted Invoice owner executes the checked collection body. */
export function bindNativeScenarioInvoiceCollectDecision(context: object, evaluate: LeaveEvaluate): void {
  if (invoiceCollectReaders.has(context)) throw new StateError('validation', 'Invoice collect decision cannot be rebound.');
  invoiceCollectReaders.set(context, evaluate);
}

export async function nativeScenarioInvoiceCollectDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? invoiceCollectReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Invoice collect needs its actual admitted owner mutation.');
  }
  return evaluate(descriptor, body);
}

const invoiceIssueReaders = new WeakMap<object, LeaveEvaluate>();

/** One admitted Invoice owner executes the exact checked issue body. */
export function bindNativeScenarioInvoiceIssueDecision(context: object, evaluate: LeaveEvaluate): void {
  if (invoiceIssueReaders.has(context)) throw new StateError('validation', 'Invoice issue decision cannot be rebound.');
  invoiceIssueReaders.set(context, evaluate);
}

export async function nativeScenarioInvoiceIssueDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? invoiceIssueReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Invoice issue needs its actual admitted owner mutation.');
  }
  return evaluate(descriptor, body);
}

const rentNoticeReaders = new WeakMap<object, LeaveEvaluate>();

/** The exact CanRent notice handler runs inside its retained event owner. */
export function bindNativeScenarioRentNoticeDecision(context: object, evaluate: LeaveEvaluate): void {
  if (rentNoticeReaders.has(context)) throw new StateError('validation', 'Rent notice decision cannot be rebound.');
  rentNoticeReaders.set(context, evaluate);
}

export async function nativeScenarioRentNoticeDecision(context: unknown, descriptor: unknown,
  body: Function): Promise<void> {
  const evaluate = typeof context === 'object' && context !== null ? rentNoticeReaders.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Rent notice needs its actual retained owner event.');
  }
  return evaluate(descriptor, body);
}

type AllowanceEvaluate = (descriptor: unknown, row: unknown, body: Function) => Promise<unknown>;
const leaveDecideAllowances = new WeakMap<object, AllowanceEvaluate>();

/** An Allowance aggregate is available only inside its checked Leave decision. */
export function bindNativeLeaveDecideAllowance(context: object, evaluate: AllowanceEvaluate): void {
  if (leaveDecideAllowances.has(context)) throw new StateError('validation', 'Leave Allowance aggregate cannot be rebound.');
  leaveDecideAllowances.set(context, evaluate);
}

export async function withLeaveDecideAllowance(context: unknown, descriptor: unknown,
  row: unknown, body: Function): Promise<unknown> {
  const evaluate = typeof context === 'object' && context !== null ? leaveDecideAllowances.get(context) : undefined;
  if (evaluate === undefined || typeof body !== 'function') {
    throw new StateError('validation', 'Leave Allowance aggregate needs its actual admitted owner decision.');
  }
  return evaluate(descriptor, row, body);
}

// One original localized formatter, evaluated in its owning source observation.
type EventNoticeFormatEvaluate=(descriptor:unknown,field:unknown,body:Function)=>Promise<unknown>;
const eventNoticeFormats=new WeakMap<object,EventNoticeFormatEvaluate>();
export function bindNativeScenarioEventNoticeFormat(context:object,evaluate:EventNoticeFormatEvaluate):void {
  if(eventNoticeFormats.has(context)) throw new StateError('validation','Event notice formatter cannot be rebound.');
  eventNoticeFormats.set(context,evaluate);
}
export async function nativeScenarioEventNoticeFormat(context:unknown,descriptor:unknown,field:unknown,body:Function):Promise<unknown> {
  const evaluate=typeof context==='object' && context!==null?eventNoticeFormats.get(context):undefined;
  if(evaluate===undefined || typeof body!=='function') throw new StateError('validation','Event notice formatter needs its actual owner source frame.');
  return evaluate(descriptor,field,body);
}

/** The literal owning loop receives only its original admitted current domain. */
type SourceLoopRead = (id:string,parent:unknown,predicate:Function|null)=>Promise<readonly unknown[]>;
const sourceLoops = new WeakMap<object,SourceLoopRead>();
export function bindNativeScenarioSourceLoop(context:object,read:SourceLoopRead):void {
  if(sourceLoops.has(context))throw new StateError('validation','Source loop cannot be rebound.');
  sourceLoops.set(context,read);
}
export async function nativeScenarioSourceLoop(context:unknown,id:string,parent:unknown,predicate:Function|null=null):Promise<readonly unknown[]> {
  const read=typeof context==='object'&&context!==null?sourceLoops.get(context):undefined;
  if(read===undefined)throw new StateError('validation','Source loop needs its original admitted owner session.');
  return read(id,parent,predicate);
}
