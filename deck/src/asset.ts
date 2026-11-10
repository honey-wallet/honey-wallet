/**
 * A file in public/, under the base the deck is built for: "/" on its own, "/deck/" on the
 * website (www.honeywallet.org/deck). Plain "/logos/…" strings would skip the base.
 */
export const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
