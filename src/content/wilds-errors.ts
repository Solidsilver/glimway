import { REPLAYED, TRANSPORT_ERRORS } from './errors.ts'

const INVALID_REQUEST = 'That request was not understood. Try again.'

/** Claim and relight refusals have domain meaning; transport failures stay separate. */
export const WILDS_CLAIM_ERRORS: Readonly<Record<string, string>> = {
  ...REPLAYED,
  'old-cycle': 'Someone got there first — it will come back.',
  'entity-unavailable': 'Someone got there first — it will come back.',
  'already-claimed': 'You have already claimed this one.',
  'not-defeated': 'The camp still stands — its fight isn’t over.',
  'condition-unmet': 'You weren’t near for that fight. The next one is yours to join.',
  'too-far-away': 'Too far away — step closer.',
  'not-in-wilds': 'That only works out in the Wilds.',
  'beyond-border': 'The land goes no further.',
  'beyond-sight': 'Too far to make out from here. Walk closer.',
  'epoch-ended': 'The drift has turned. The land is new.',
  'claim-rate-limited': 'That is plenty of gathering for one minute. Take a breath.',
  'already-lit': 'That lantern is already lit.',
  'lantern-not-found': 'That lantern is no longer here.',
  'entity-not-found': 'That place is no longer here.',
  'world-access-denied': 'That world is no longer open to you.',
  'invalid-request': INVALID_REQUEST,
  'invalid-claim': INVALID_REQUEST,
  'lantern-id-required': INVALID_REQUEST,
  offline: 'Needs a connection. The Wilds keep what you have not claimed.',
  superseded: TRANSPORT_ERRORS.superseded,
  busy: TRANSPORT_ERRORS.busy,
  unknown: 'The Wilds didn’t answer. Nothing was taken — try again in a moment.'
}

export function wildsClaimError(code: string): string {
  return WILDS_CLAIM_ERRORS[code] ?? WILDS_CLAIM_ERRORS.unknown
}
