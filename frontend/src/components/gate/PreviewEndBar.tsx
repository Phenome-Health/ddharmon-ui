import { COMMIT_BAR_PIN, COMMIT_BAR_SURFACE } from "@/components/gate/CommitBar";

/**
 * WHERE A PREVIEW RUN ENDS (08-31, D1 = (a), Bhargav 2026-11-07).
 *
 * A Preview calls no model, so its Gate 1 is the last screen it has: nothing is sent on to Gate 2 and there is nothing
 * to buy. The commit bar would offer exactly that — a Continue with a price — so a Preview gets this bar in its place:
 * the same pin, the same surface (`COMMIT_BAR_PIN` / `COMMIT_BAR_SURFACE`), one plain sentence saying the run stops
 * here and that matching the groups to CDEs is a paid run, and the free export of the groups as the reviewer left them.
 *
 * NO "RUN THE PAID STAGES" BUTTON, deliberately (D1 chose (a) over (b)): a re-run would not carry the reviewer's
 * Preview edits, and a button that looked as if it did would lose them silently. The sentence names where a paid run
 * starts instead.
 */
export function PreviewEndBar({
  download,
}: {
  /** The free "Download groups (CSV)" control, beside the sentence where the commit bar's button would be. */
  download?: React.ReactNode;
}) {
  return (
    <div data-testid="preview-end-pin" className={COMMIT_BAR_PIN}>
      <div data-testid="preview-end" className={COMMIT_BAR_SURFACE}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-[68ch] text-sm text-on-raised">
            A Preview stops here. Matching these groups to common data elements is a paid run, started from New run.
          </p>
          {download}
        </div>
      </div>
    </div>
  );
}
