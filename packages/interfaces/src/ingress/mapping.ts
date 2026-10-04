/**
 * S7 provider-ingress mapping: verified envelope + deployment binding to a
 * trusted handler context.
 *
 * No-manufacture guarantee: this mapper takes ONLY verifier output
 * (`VerifiedIngressEnvelope`) plus the deployment binding
 * (`IngressBinding`) — never raw request input. The route upholds the other
 * half by running the verifier first and only mapping its accepted output.
 * Together, no raw request bytes, headers, or path segments can fabricate a
 * trusted context: authority flows from the binding (team/owner/namespace)
 * and the verified causation envelope alone.
 *
 * DESIGN section 8: the handler retains `actor=null`; attribution uses the
 * verified source, and team derives from the verified occurrence (here, the
 * deployment-bound namespace), never an arbitrary payload grant.
 */
import type { VerifiedIngressEnvelope } from '@canlang/contracts';
import type { DelegatedContext, IngressBinding } from '../ports.js';

/**
 * Build the trusted handler context for one verified provider event. Pure:
 * `actor` is always null, team/owner/namespace come from the deployment
 * binding, and the verifier's envelope rides through as `causation`.
 */
export function mapVerifiedIngress(
  binding: IngressBinding,
  envelope: VerifiedIngressEnvelope,
): DelegatedContext {
  return {
    actor: null,
    team: binding.team,
    owner: binding.owner,
    namespace: binding.namespace,
    causation: envelope,
  };
}
