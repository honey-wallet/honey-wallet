import { Redirect, useLocalSearchParams } from 'expo-router';
import { appPathOfShareLink } from '@/lib/share-links';

/**
 * A shared jar's link (honeywallet.org/j/<id>) as a route, for when it reaches the router
 * without +native-intent rewriting it: its jar page, where Copy buys it.
 */
export default function SharedJarLink() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const path = appPathOfShareLink(`/j/${id}`);
  return path ? (
    <Redirect href={{ pathname: '/jar/[id]', params: { id: path.slice('/jar/'.length) } }} />
  ) : (
    <Redirect href="/jars" />
  );
}
