'use client';

/**
 * The share pages' main button. With Honey installed, the shared link itself already
 * opened the app (a universal link / app link); someone reading this page either hasn't
 * got Honey or opened the link in a browser. So it tries the app's own scheme at the
 * same screen, and if the page is still showing a moment later (no app took over), goes
 * to /get, which sends phones to their store.
 */
export function OpenInApp({ appPath, label }: { appPath: string; label: string }) {
  return (
    <a
      href="/get"
      onClick={(event) => {
        event.preventDefault();
        const fallback = window.setTimeout(() => {
          if (!document.hidden) window.location.href = '/get';
        }, 1500);
        // Leaving for the app hides the page: then there's nothing to fall back to.
        document.addEventListener(
          'visibilitychange',
          () => {
            if (document.hidden) window.clearTimeout(fallback);
          },
          { once: true },
        );
        window.location.href = `honeywallet://${appPath}`;
      }}
      className="rounded-full bg-[#F5C451] px-5 py-3.5 text-center font-semibold text-[#242329] transition-transform active:scale-[0.98]"
    >
      {label}
    </a>
  );
}
