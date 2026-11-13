import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useState } from 'react';
import { Linking, Platform, TextInput, View } from 'react-native';
import { PillButton } from '@/components/onboarding/PillButton';
import { closeSheet, SheetScreen, SheetSection, SheetText } from '@/components/sheets/Sheet';
import { Chip } from '@/components/wallet/Chip';
import { tap } from '@/lib/haptics';
import { warningOn } from '@/lib/warnings';
import { makeStyles, radius, useTheme } from '@/theme';

const SUPPORT = 'support@honeywallet.org';

const TOPICS = ['Account', 'Transactions', 'Security', 'Other'] as const;
type Topic = (typeof TOPICS)[number];

/** Send the Honey team a message, filed under a topic. */
export default function ContactSheet() {
  const styles = useStyles();
  const c = useTheme();
  const [topic, setTopic] = useState<Topic>('Account');
  const [message, setMessage] = useState('');
  // Toasts draw under this sheet, so the no-mail-app fallback says so in the sheet.
  const [copied, setCopied] = useState(false);
  const ready = message.trim().length > 0;

  // Sent from the phone's own mail app, so replies reach the user's inbox. Before: a
  // "Message sent" toast that sent nothing.
  const send = async () => {
    tap();
    const version = Constants.expoConfig?.version ?? '?';
    const body = `${message.trim()}\n\n—\nHoney ${version} · ${Platform.OS} ${Platform.Version}`;
    const url = `mailto:${SUPPORT}?subject=${encodeURIComponent(`Honey: ${topic}`)}&body=${encodeURIComponent(body)}`;
    try {
      await Linking.openURL(url);
      closeSheet();
    } catch {
      // No mail app set up: hand over the address and the message instead.
      await Clipboard.setStringAsync(`${SUPPORT}\n\n${body}`);
      setCopied(true);
    }
  };

  return (
    <SheetScreen
      title="Contact us"
      footer={
        <PillButton
          label={copied ? 'Copied: paste it in any email app' : 'Send email'}
          disabled={!ready}
          onPress={() => void send()}
        />
      }
    >
      <SheetText lead>
        {copied
          ? `No mail app is set up, so we copied ${SUPPORT} and your message. Paste them into any email app.`
          : `Opens your mail app to ${SUPPORT}. We reply within a day.`}
      </SheetText>

      <SheetSection title="Topic" />
      <View style={styles.chips}>
        {TOPICS.map((t) => {
          const selected = t === topic;
          return (
            <Chip
              key={t}
              label={t}
              variant="filled"
              accessibilityRole="radio"
              selected={selected}
              onPress={() => setTopic(t)}
            />
          );
        })}
      </View>

      <SheetSection title="Message" />
      <TextInput
        value={message}
        onChangeText={setMessage}
        placeholder={`Tell us what's going on.${warningOn('contactNeverShare') ? ' Never share your recovery phrase.' : ''}`}
        placeholderTextColor={c.placeholder}
        multiline
        textAlignVertical="top"
        style={styles.input}
        selectionColor={c.primary}
        accessibilityLabel="Message"
      />
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  input: {
    minHeight: 96,
    padding: 14,
    ...radius(16),
    color: c.text,
    fontSize: 16,
    lineHeight: 22,
    backgroundColor: c.card,
  },
}));
