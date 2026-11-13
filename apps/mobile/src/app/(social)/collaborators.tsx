import type { SocialProfileCard } from '@honey-wallet/api-client';
import { useLocalSearchParams } from 'expo-router';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { SocialAvatar } from '@/components/social/parts';
import { tap } from '@/lib/haptics';
import { leaveSheetTo } from '@/lib/navigation';

/** The people in `?people=` (JSON cards, as `openCollaborators` sends them). */
function parse(raw: string | undefined): SocialProfileCard[] {
  try {
    const list: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (p): p is SocialProfileCard =>
          !!p && typeof p.handle === 'string' && typeof p.displayName === 'string',
      )
      .map((p) => ({
        handle: p.handle,
        displayName: p.displayName,
        avatarSeed: typeof p.avatarSeed === 'string' ? p.avatarSeed : '',
      }));
  } catch {
    return [];
  }
}

/**
 * A group jar's people, like Instagram's collaborators: one row each (face, name,
 * @handle), opened from "Nina Osei and 2 others". A row opens that person's profile.
 */
export default function CollaboratorsSheet() {
  const { people } = useLocalSearchParams<{ people?: string }>();
  return (
    <SheetScreen title="Collaborators">
      {parse(people).map((who) => (
        <SheetRow
          key={who.handle}
          leading={<SocialAvatar who={who} size={40} />}
          title={who.displayName}
          subtitle={`@${who.handle}`}
          accessory="chevron"
          onPress={() => {
            tap();
            leaveSheetTo({ pathname: '/u/[handle]', params: { handle: who.handle } });
          }}
        />
      ))}
    </SheetScreen>
  );
}
