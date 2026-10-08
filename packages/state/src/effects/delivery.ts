import type { ReceiptProperty, SelectedReceiptProjection } from '@canlang/contracts';
import { StateError } from '../errors.js';

/** Installed by canonical scenario execution; observation stays with its owner. */
export interface DeliveryContext {
  readonly canonical?: {
    observeDelivery?(
      locator: { readonly record: unknown; readonly field: string },
      selected: readonly ReceiptProperty[],
    ): Promise<SelectedReceiptProjection | null>;
  };
}

/** Forward the original locator and selection to canonical receipt observation. */
export async function delivery(
  c: DeliveryContext,
  locator: { readonly record: unknown; readonly field: string },
  selected: readonly ReceiptProperty[],
): Promise<SelectedReceiptProjection | null> {
  if (typeof c.canonical?.observeDelivery !== 'function') {
    throw new StateError('validation', 'delivery requires canonical receipt observation scope.');
  }
  return c.canonical.observeDelivery(locator, selected);
}
