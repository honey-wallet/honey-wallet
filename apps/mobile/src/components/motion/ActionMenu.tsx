import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { HEADER_BUTTON } from '@/components/wallet/parts';
import { useTheme } from '@/theme';
import { MenuDropdown } from './MenuDropdown';

export type Action = {
  /** Short and fixed, one line: "Share", "View profile", "Open jar". */
  label: string;
  icon: IconName;
  onPress: () => void;
  /** Drawn in place of the icon, e.g. a token's logo. */
  leading?: ReactNode;
  /** Deletes or leaves something: drawn in red. */
  destructive?: boolean;
};

/**
 * A standard round header button (••• by default) that opens a list of actions,
 * growing out of the button with the same motion as the sort menu. `bare` drops the
 * circle behind the icon, for headers whose other buttons have none.
 */
export function ActionMenu({
  actions,
  icon = 'more',
  size = 18,
  bare = false,
}: {
  actions: Action[];
  icon?: IconName;
  size?: number;
  bare?: boolean;
}) {
  const c = useTheme();
  return (
    <MenuDropdown
      options={actions.map((a) => ({
        value: a.label,
        label: a.label,
        icon: a.icon,
        leading: a.leading,
        destructive: a.destructive,
      }))}
      value=""
      onChange={(label) => actions.find((a) => a.label === label)?.onPress()}
      triggerStyle={{
        width: HEADER_BUTTON,
        height: HEADER_BUTTON,
        borderRadius: HEADER_BUTTON / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bare ? 'transparent' : c.raised,
      }}
      trigger={() => <Icon name={icon} size={size} color={c.text} />}
    />
  );
}
