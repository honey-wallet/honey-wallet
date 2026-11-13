import { Redirect, useLocalSearchParams } from 'expo-router';
import { appPathOfShareLink } from '@/lib/share-links';

/**
 * A shared thesis's link (honeywallet.org/p/<id>) as a route, for when it reaches the
 * router without +native-intent rewriting it: the thesis as a jar page.
 */
export default function SharedThesisLink() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const path = appPathOfShareLink(`/p/${id}`);
  return path ? (
    <Redirect href={{ pathname: '/jar/[id]', params: { id: path.slice('/jar/'.length) } }} />
  ) : (
    <Redirect href="/feed" />
  );
}
