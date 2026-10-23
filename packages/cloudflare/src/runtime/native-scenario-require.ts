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

type SourceLoopItem=(id:string,item:unknown,body:Function)=>Promise<void>;
const sourceLoopItems=new WeakMap<object,SourceLoopItem>();
export function bindNativeScenarioSourceLoopItem(context:object,execute:SourceLoopItem):void{
  if(sourceLoopItems.has(context))throw new StateError('validation','Source loop item cannot be rebound.');sourceLoopItems.set(context,execute);
}
export async function nativeScenarioSourceLoopItem(context:unknown,id:string,item:unknown,body:Function):Promise<void>{
  const execute=typeof context==='object'&&context!==null?sourceLoopItems.get(context):undefined;
  if(execute===undefined||typeof body!=='function')throw new StateError('validation','Source loop item needs its actual original installed execution.');
  return execute(id,item,body);
}

/** One checked original copy constructor inside its actual issued loop item. */
type SourceLoopCopy=(id:string,item:unknown,parent:unknown,body:Function)=>Promise<void>;
const sourceLoopCopies=new WeakMap<object,SourceLoopCopy>();
export function bindNativeScenarioSourceLoopCopy(context:object,copy:SourceLoopCopy):void{
  if(sourceLoopCopies.has(context))throw new StateError('validation','Source loop copy cannot be rebound.');
  sourceLoopCopies.set(context,copy);
}
export async function nativeScenarioSourceLoopCopy(context:unknown,id:string,item:unknown,parent:unknown,body:Function):Promise<void>{
  const copy=typeof context==='object'&&context!==null?sourceLoopCopies.get(context):undefined;
  if(copy===undefined||typeof body!=='function')throw new StateError('validation','Source copy needs its actual original owner loop.');
  return copy(id,item,parent,body);
}

type SourceSendData=(body:Function,inputs:Readonly<Record<string,unknown>>)=>Promise<unknown>;
const sourceSendDataReaders=new WeakMap<object,SourceSendData>();
/** Only the genuine source-only execution can authorize its original SEND DATA. */
export function bindNativeScenarioSourceSendData(context:object,evaluate:SourceSendData):void{
  if(sourceSendDataReaders.has(context))throw new StateError('validation','Source SEND DATA reader cannot be rebound.');
  sourceSendDataReaders.set(context,evaluate);
}
export async function nativeScenarioSourceSendData(context:unknown,body:Function,inputs:Readonly<Record<string,unknown>>):Promise<unknown>{
  const evaluate=typeof context==='object'&&context!==null?sourceSendDataReaders.get(context):undefined;
  if(evaluate===undefined||typeof body!=='function')throw new StateError('validation','Source SEND DATA needs its actual installed owner execution.');
  return evaluate(body,inputs);
}

type SourceCancel=(source:unknown,root:unknown)=>Promise<void>;
const sourceCancelReaders=new WeakMap<object,SourceCancel>();
/** Original source coordinates and a genuine admitted model view select the key. */
export function bindNativeScenarioSourceCancel(context:object,evaluate:SourceCancel):void{
  if(sourceCancelReaders.has(context))throw new StateError('validation','Source CANCEL reader cannot be rebound.');
  sourceCancelReaders.set(context,evaluate);
}
export async function nativeScenarioSourceCancel(context:unknown,source:unknown,root:unknown):Promise<void>{
  const evaluate=typeof context==='object'&&context!==null?sourceCancelReaders.get(context):undefined;
  if(evaluate===undefined)throw new StateError('validation','Source CANCEL needs its actual installed owner execution.');
  return evaluate(source,root);
}


type SourceSchedule=(source:unknown,root:unknown,at:unknown,payload:unknown,key?:unknown)=>Promise<void>;
const sourceScheduleReaders=new WeakMap<object,SourceSchedule>();
export function bindNativeScenarioSourceSchedule(context:object,evaluate:SourceSchedule):void{
  if(sourceScheduleReaders.has(context))throw new StateError('validation','Source SCHEDULE reader cannot be rebound.');
  sourceScheduleReaders.set(context,evaluate);
}
export async function nativeScenarioSourceSchedule(context:unknown,source:unknown,root:unknown,at:unknown,payload:unknown,key?:unknown):Promise<void>{
  const evaluate=typeof context==='object'&&context!==null?sourceScheduleReaders.get(context):undefined;
  if(evaluate===undefined)throw new StateError('validation','Source SCHEDULE needs its actual installed owner execution.');
  return evaluate(source,root,at,payload,key);
}

const sourceSendQueryReaders=new WeakMap<object,(id:string,parent:unknown)=>Promise<readonly Record<string,unknown>[]>>();
export function bindNativeScenarioSourceSendQuery(context:object,read:(id:string,parent:unknown)=>Promise<readonly Record<string,unknown>[]>):void{
  if(sourceSendQueryReaders.has(context))throw new StateError('validation','Source SEND query reader cannot be rebound.');
  sourceSendQueryReaders.set(context,read);
}
/** Existing callers keep their original guarded records path. Only the live
 * source SEND frame supplies this separate projected argument reader. */
export async function nativeScenarioSourceSendQuery(context:unknown,id:string,parent:unknown,fallback:()=>Promise<readonly Record<string,unknown>[]>):Promise<readonly Record<string,unknown>[]>{
  const read=typeof context==='object'&&context!==null?sourceSendQueryReaders.get(context):undefined;
  if(typeof fallback!=='function')throw new StateError('validation','Source SEND query needs its original guarded query.');
  return read===undefined?fallback():read(id,parent);
}

const sourceEmitDataReaders=new WeakMap<object,(body:Function,inputs:Readonly<Record<string,unknown>>)=>Promise<unknown>>();
export function bindNativeScenarioSourceEmitData(context:object,evaluate:(body:Function,inputs:Readonly<Record<string,unknown>>)=>Promise<unknown>):void{
  if(sourceEmitDataReaders.has(context))throw new StateError('validation','Source EMIT DATA reader cannot be rebound.');
  sourceEmitDataReaders.set(context,evaluate);
}
export async function nativeScenarioSourceEmitData(context:unknown,body:Function,inputs:Readonly<Record<string,unknown>>):Promise<unknown>{
  const evaluate=typeof context==='object'&&context!==null?sourceEmitDataReaders.get(context):undefined;
  if(evaluate===undefined||typeof body!=='function')throw new StateError('validation','Source EMIT DATA needs its actual installed event owner.');
  return evaluate(body,inputs);
}

const sourceEmitQueryReaders=new WeakMap<object,(id:string,parent:unknown)=>Promise<readonly Record<string,unknown>[]>>();
export function bindNativeScenarioSourceEmitQuery(context:object,read:(id:string,parent:unknown)=>Promise<readonly Record<string,unknown>[]>):void{
  if(sourceEmitQueryReaders.has(context))throw new StateError('validation','Source EMIT aggregate reader cannot be rebound.');
  sourceEmitQueryReaders.set(context,read);
}
export async function nativeScenarioSourceEmitQuery(context:unknown,id:string,parent:unknown):Promise<readonly Record<string,unknown>[]>{
  const read=typeof context==='object'&&context!==null?sourceEmitQueryReaders.get(context):undefined;
  if(read===undefined)throw new StateError('validation','Source EMIT aggregate needs its actual independent DATA execution.');
  return read(id,parent);
}

const sourceLetDataReaders=new WeakMap<object,(source:unknown,root:unknown)=>Promise<unknown>>();
export function bindNativeScenarioSourceLetData(context:object,read:(source:unknown,root:unknown)=>Promise<unknown>):void{
  if(sourceLetDataReaders.has(context))throw new StateError('validation','Scalar LET DATA reader cannot be rebound.');
  sourceLetDataReaders.set(context,read);
}
export async function nativeScenarioSourceLetData(context:unknown,source:unknown,root:unknown):Promise<unknown>{
  const read=typeof context==='object'&&context!==null?sourceLetDataReaders.get(context):undefined;
  if(read===undefined)throw new StateError('validation','Scalar LET DATA needs its actual source owner.');
  return read(source,root);
}
