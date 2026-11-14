// Shared invite policies keep enforcement and expiry on the same windows.
export const INVITE_LIMIT_PER_VETERAN = {
  bucket: 'trusted_contact.invite.veteran',
  limit: 10,
  windowSeconds: 86_400,
};
export const INVITE_LIMIT_PER_ADDRESS = {
  bucket: 'trusted_contact.invite.veteran_address',
  limit: 3,
  windowSeconds: 86_400,
};

/**
 * Recipient protection across Veterans: at most this many invite emails to one address per
 * tenant per 24 hours. Past it the invite is still created and answered exactly as usual, and
 * only the email is suppressed (Notification UNDELIVERABLE with this reason, audited), so no
 * caller learns that someone else invited the address.
 */
export const INVITE_EMAIL_CAP_PER_RECIPIENT = {
  bucket: 'trusted_contact.invite.recipient',
  limit: 5,
  windowSeconds: 86_400,
};
