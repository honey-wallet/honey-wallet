import Image from 'next/image';
import styles from './product-phone.module.css';

// export type ProductScreen = 'feed' | 'wallet' | 'jar';
export type ProductScreen = 'feed' | 'everyone' | 'wallet' | 'jar';
const LABELS: Record<ProductScreen, string> = {
  feed: 'Honey social feed with friends’ trades and copyable jars',
  everyone: 'Honey feed of jars anyone can copy',
  wallet: 'Honey wallet with token balances, holdings and money actions',
  jar: 'Honey jar with its performance chart and token allocations',
};

/** Unedited native captures, with a CSS device frame. Values are sample data. */
export function ProductPhone({
  screen,
  className = '',
  eager = false,
}: {
  screen: ProductScreen;
  className?: string;
  eager?: boolean;
}) {
  return (
    <div className={`${styles.phone} ${className}`}>
      <div className={styles.display}>
        <Image
          alt={`${LABELS[screen]}. Product preview with sample data.`}
          className={styles.light}
          height={2622}
          loading={eager ? 'eager' : 'lazy'}
          sizes="(max-width: 767px) 50vw, 340px"
          src={`/screens/current/${screen}-light.png`}
          width={1206}
        />
        <Image
          alt=""
          aria-hidden="true"
          className={styles.dark}
          height={2622}
          loading={eager ? 'eager' : 'lazy'}
          sizes="(max-width: 767px) 50vw, 340px"
          src={`/screens/current/${screen}-dark.png`}
          width={1206}
        />
      </div>
    </div>
  );
}
