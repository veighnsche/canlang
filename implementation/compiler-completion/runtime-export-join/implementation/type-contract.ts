import { hasRole, require as guard, type HandlerRoleContext } from '@canlang/state/effects/guards';
import { hasRole as facadeRole, require as facadeGuard } from '@canlang/stdlib';
import { hasRole as compatibilityRole, require as compatibilityGuard } from '@canlang/cloudflare/runtime/stdlib';
import type { HandlerContext } from '@canlang/cloudflare/runtime/invoke';

declare const existing: HandlerContext;
const structural: HandlerRoleContext = existing;
const booleanResult: boolean = hasRole(structural, 'members');
const oldRoleCall: (c: HandlerContext, role: string, subject?: unknown) => boolean = hasRole;
const facade: typeof hasRole = facadeRole;
const compatibility: typeof hasRole = compatibilityRole;
const facadeAssertion: typeof guard = facadeGuard;
const compatibilityAssertion: typeof guard = compatibilityGuard;
void [booleanResult, oldRoleCall, facade, compatibility, facadeAssertion, compatibilityAssertion];
