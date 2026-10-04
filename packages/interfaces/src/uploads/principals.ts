/**
 * S6 upload-transport principals: receiving-identity derivation and
 * delivery-binding construction for bridge v1.
 *
 * `receiverFromIdentity` binds the resolved caller to the L4 receiving
 * context (ports.ts `UploadReceiver` mirrors L4 `ReceivingContext`):
 * uploads never admit public callers, so a null actor is `forbidden`.
 * The `team`/`owner` slots fall back to the user id in non-team contexts
 * (lane-06 decision: L4's binder rejects empty fields, so per-user uploads
 * stay expressible). `bindingForIntent` tags the caller retry identity
 * (`upload_id`) with the constant `bridge-v1` adapter and the target
 * field pointer.
 */
import type { ResolvedIdentity, UploadIntentRequest } from '@canlang/contracts';
import { IdentityError } from '@canlang/identity';
import type { UploadBinding, UploadReceiver } from '../ports.js';

/** Delivery adapter tag for bridge v1 intent provenance. */
export const UPLOAD_ADAPTER_BRIDGE_V1 = 'bridge-v1';

/**
 * Derive the receiving identity for upload provenance. Throws
 * `IdentityError('forbidden')` when the identity has no actor — uploads
 * never admit public.
 */
export function receiverFromIdentity(
  appId: string,
  identity: ResolvedIdentity,
): UploadReceiver {
  const actor = identity.actor;
  if (actor === null) {
    throw new IdentityError('forbidden', 'Authentication required.');
  }
  const team = identity.team?.team_id ?? actor.user_id;
  return {
    app: appId,
    team,
    owner: team,
    principal: actor.user_id,
  };
}

/**
 * Delivery binding for intent provenance: constant `bridge-v1` adapter,
 * caller retry identity, target field pointer.
 */
export function bindingForIntent(request: UploadIntentRequest): UploadBinding {
  return {
    adapter: UPLOAD_ADAPTER_BRIDGE_V1,
    deliveryId: request.upload_id,
    resultPath: request.field,
  };
}
