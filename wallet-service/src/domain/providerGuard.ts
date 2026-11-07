import { conflict, forbidden, notFound } from '../errors';

export type ProviderOutcome = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
type ResourceStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

/**
 * Shared checks for the simulated provider controls (top-ups and payouts).
 * Returns the transition to apply, or NOOP for a safe repeat of the recorded outcome.
 */
export function setOutcomeGuard(
  demoMode: boolean,
  resource: { synthetic: boolean; providerReference: string; status: ResourceStatus } | null,
  input: { outcome: ProviderOutcome; providerReference: string },
): ProviderOutcome | 'NOOP' {
  if (!demoMode) throw forbidden('DEMO_DISABLED', 'Demo provider controls are disabled');
  if (!resource) throw notFound('NOT_FOUND', 'Resource not found');
  if (!resource.synthetic) throw forbidden('RESOURCE_NOT_SYNTHETIC', 'Only synthetic resources can be resolved from the demo control');
  if (resource.providerReference !== input.providerReference) throw conflict('PROVIDER_OUTCOME_CONFLICT', 'The provider reference does not match this resource');
  if (resource.status === input.outcome) return 'NOOP';
  if (resource.status === 'SUCCEEDED' || resource.status === 'FAILED') {
    throw conflict('PROVIDER_OUTCOME_CONFLICT', `The resource already finished as ${resource.status}; a terminal outcome cannot be reversed`);
  }
  return input.outcome;
}
