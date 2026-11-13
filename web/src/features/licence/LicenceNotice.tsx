/** Sent as `notice_version` with every submit; a wording change needs a new version (L2.1). */
export const LICENCE_NOTICE_VERSION = 'licence-notice-v1' as const;

/**
 * `licence-notice-v1` (constant LICENCE_NOTICE_V1), shown above the captures every time they open.
 * The wording is a contributor draft built from the SCRY_LICENCE_FALLBACK.md L2.1 bullets. Exact
 * copy is the owner's call: DECISION_PENDING (suas-specs #73 R10.1 proposal).
 */
export function LicenceNotice() {
  return (
    <section aria-labelledby="licence-notice" className="flex flex-col gap-3">
      <h3 id="licence-notice" className="text-20 font-bold">
        Before you send photos of your licence
      </h3>
      <p>
        Some states print "Veteran" on the driver licence or state ID. You can send photos of yours
        for a SUAS admin to look at. This is your choice.
      </p>
      <ul className="flex list-disc flex-col gap-2 pl-6">
        <li>
          <strong>What we send, and to whom:</strong> photos of the front and back of your licence
          go to SUAS and to our licence reader (Scry), which reads them and deletes its copies. Your
          selfie goes to SUAS only.
        </li>
        <li>
          <strong>Who looks:</strong> a SUAS admin looks at the photos and your selfie. A second
          SUAS admin confirms any approval.
        </li>
        <li>
          <strong>When they are deleted:</strong> the photos and the selfie are deleted when the
          admin decides, or after 30 days at most.
        </li>
        <li>
          <strong>What we keep:</strong> a keyed fingerprint of your licence's issuing state and
          number, whether the licence matches the details you gave VA (yes or no), and the decision.
          The fingerprint can't be turned back into your licence number.
        </li>
        <li>
          <strong>If you'd rather not send your licence:</strong> choose "Tell us you served"
          instead. You can still ask for help.
        </li>
        <li>
          <strong>If we can't confirm you:</strong> it is not a finding that you didn't serve.
        </li>
        <li>
          <strong>SUAS has no connection to any DMV or to VA.</strong>
        </li>
        <li>
          <strong>If you disagree:</strong> if we say your licence is already in use and it is
          yours, you can ask us to look again from this page.
        </li>
        <li>
          <strong>Helping other Veterans needs no check.</strong>
        </li>
      </ul>
    </section>
  );
}
