import { removeLeagueAction } from "./actions";

// Small inline form so the row's "Remove" button is a real form submission
// (server action) rather than a client click handler. Keeps the page a
// pure Server Component.
export default function RemoveLeagueButton({
  leagueId,
}: {
  leagueId: string;
}) {
  return (
    <form action={removeLeagueAction}>
      <input type="hidden" name="league_id" value={leagueId} />
      <button
        type="submit"
        className="text-xs text-zinc-500 hover:text-red-600 dark:hover:text-red-400"
      >
        Remove
      </button>
    </form>
  );
}
