import { signInWithGoogleAction } from "./actions";

// "Continue with Google" button. Uses a server-action form so the OAuth
// redirect happens server-side — no client JS needed and no chance of the
// access token leaking into the browser bundle.
//
// `next` is the post-auth destination. For new users the callback route
// overrides this and sends them to /welcome regardless; for returning
// users it's honored.
export default function GoogleSignInButton({ next }: { next?: string }) {
  return (
    <form action={signInWithGoogleAction} className="w-full">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <button
        type="submit"
        className="w-full flex items-center justify-center gap-2.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors"
      >
        <GoogleGlyph />
        Continue with Google
      </button>
    </form>
  );
}

// Inline SVG of the Google "G" mark — multicolor to match Google's own
// brand guidelines so the button doesn't look counterfeit. Sized to
// match the button text.
function GoogleGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.96H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.04l3.007-2.333z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.96L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
