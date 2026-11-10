import { LogoLink } from './logo';

/* The privacy policy, terms, support and deletion pages are static files in public/. */
const LINKS = [
  { label: 'GitHub', href: 'https://github.com/honey-wallet/honey-wallet' },
  { label: 'X', href: 'https://x.com/0xhoneywallet' },
  { label: 'Support', href: '/support' },
] as const;

const LEGAL = [
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
  { label: 'Delete your data', href: '/delete-account' },
] as const;

const linkClass =
  'rounded-full px-3.5 py-2 max-sm:px-2.5 max-sm:py-2.5 text-fg-muted text-sm transition-colors duration-fast ease-smooth-out hover:bg-surface-2 hover:text-foreground';

/**
 * Minimal on purpose: the code, X and support. Only the legal
 * line is separated, and by spacing, not by a rule.
 */
export function SiteFooter() {
  return (
    <footer className="container-x px-4 pt-6 pb-10 sm:px-6 lg:px-8">
      {/* One row at every width: the mark on the left, the links on the right. */}
      <div className="flex items-center justify-between gap-4 px-2">
        <LogoLink />

        <nav aria-label="Footer">
          <ul className="flex items-center gap-2 max-sm:-mr-2.5 max-sm:gap-0.5">
            {LINKS.map((link) => (
              <li key={link.label}>
                <a
                  className={linkClass}
                  href={link.href}
                  rel="noopener noreferrer"
                  target={link.href.startsWith('/') ? undefined : '_blank'}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {/* On a phone the legal links come first and the copyright closes the page. */}
      <div className="mt-6 px-2 sm:mt-8">
        <div className="flex flex-col-reverse gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-2">
          <p className="text-fg-subtle text-xs">&copy; {new Date().getFullYear()} Honey Wallet</p>
          <nav aria-label="Legal">
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {LEGAL.map((link) => (
                <li key={link.href}>
                  <a
                    className="inline-block py-1 max-sm:py-2.5 text-fg-subtle underline-offset-4 transition-colors duration-fast hover:text-foreground hover:underline"
                    href={link.href}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
