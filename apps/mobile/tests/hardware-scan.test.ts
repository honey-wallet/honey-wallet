import { expect, it } from 'vitest';
import { createHardwareScanner, isHardwareUr } from '../src/lib/hardware-scan';

// Encoded with Keystone's registry and @ngraveio/bc-ur from the Hardhat phrase
// ("test test … junk"): its account key m/44'/60'/0', as one QR and as an animated one.
const SINGLE =
  'ur:crypto-hdkey/olaxhdclaoamrocwpslnbshtjyfwpdhfieteeslanlgoqdpsnyhglfcxaemdbgknstlepyjsykaahdcxcphdchnyyktosklkvdmuzonbjnfmyapsiebtfdcsaovtplessosffhskpdtocsbgamtaaddyotadlncsdwykcsfnykaeykaocycmptfmtiaxaxattaaddyoyadlraewklawkasisgrihkkjkjyjljtihbkjohsiaiajlkpjtjydmjkjyhsjtiehsjpieftfpwdmt';
const PARTS = [
  'ur:crypto-hdkey/1-5/lpadahcslncyftfpwdmthdcwolaxhdclaoamrocwpslnbshtjyfwpdhfieteeslanlgoqdpsnyhglfaxpmmssb',
  'ur:crypto-hdkey/2-5/lpaoahcslncyftfpwdmthdcwcxaemdbgknstlepyjsykaahdcxcphdchnyyktosklkvdmuzonbjnfmwkcaptax',
  'ur:crypto-hdkey/3-5/lpaxahcslncyftfpwdmthdcwyapsiebtfdcsaovtplessosffhskpdtocsbgamtaaddyotadlncsdwvahpvepa',
  'ur:crypto-hdkey/4-5/lpaaahcslncyftfpwdmthdcwykcsfnykaeykaocycmptfmtiaxaxattaaddyoyadlraewklawkasisflsroxdi',
  'ur:crypto-hdkey/5-5/lpahahcslncyftfpwdmthdcwgrihkkjkjyjljtihbkjohsiaiajlkpjtjydmjkjyhsjtiehsjpieaeztvyhhyn',
  'ur:crypto-hdkey/6-5/lpamahcslncyftfpwdmthdcwcxaemdbgknstlepyjsykaahdcxcphdchnyyktosklkvdmuzonbjnfmpepmghfd',
  'ur:crypto-hdkey/7-5/lpatahcslncyftfpwdmthdcwolaxhdclaoamrocwpslnbshtjyfwpdhfieteeslanlgoqdpsnyhglfmkkimsah',
  'ur:crypto-hdkey/8-5/lpayahcslncyftfpwdmthdcwsniyqzfzbnplhhtltsaximhsembslpdlleaylrehjyuofyenfdhyrfdivtmkiy',
  'ur:crypto-hdkey/9-5/lpasahcslncyftfpwdmthdcwolaxhdclaoamrocwpslnbshtjyfwpdhfieteeslanlgoqdpsnyhglfqzsfjnhl',
  'ur:crypto-hdkey/10-5/lpbkahcslncyftfpwdmthdcwcxaemdbgknstlepyjsykaahdcxcphdchnyyktosklkvdmuzonbjnfmfxkegumd',
  'ur:crypto-hdkey/11-5/lpbdahcslncyftfpwdmthdcwrttdwprofyfxhhdljlmuntkibdsodretmudrcnwlwnwpbwrlftgwyautspdark',
  'ur:crypto-hdkey/12-5/lpbnahcslncyftfpwdmthdcwmusolojzfgpfvadmtlrfpsylkelolprlynsorkiswprhghndghbybghkswwmtd',
  'ur:crypto-hdkey/13-5/lpbtahcslncyftfpwdmthdcwrttdwprofyfxhhdljlmuntkibdsodretmudrcnwlwnwpbwrlftgwyafgcsdakp',
  'ur:crypto-hdkey/14-5/lpbaahcslncyftfpwdmthdcwdpqzsnwdeydrlegysoihwffyceveylaelstsincaastssskntdkeknpebnbwie',
  'ur:crypto-hdkey/15-5/lpbsahcslncyftfpwdmthdcwfgttcllufnlfjtneprvtmtlbhepttnkkjnbntypsvehyeovtaekpfyfncxvahe',
];
const FIRST = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

it('reads a single-frame account code', () => {
  expect(isHardwareUr(SINGLE)).toBe(true);
  const scan = createHardwareScanner().feed(SINGLE);
  expect(scan.state).toBe('done');
  if (scan.state === 'done') {
    expect(scan.result.accounts[0]?.address).toBe(FIRST);
    expect(scan.result.accounts).toHaveLength(5);
  }
});

it('puts an animated code together from frames in any order, with one missed', () => {
  const scanner = createHardwareScanner();
  // The camera joined late and missed frame 2: the mixed frames after it fill the gap.
  const frames = [PARTS[3], PARTS[0], PARTS[3], PARTS[2], PARTS[4], ...PARTS.slice(5)];
  let last = scanner.feed('not a code');
  expect(last).toEqual({ state: 'scanning', progress: 0, foreign: true });
  for (const frame of frames) {
    last = scanner.feed(frame as string);
    if (last.state !== 'scanning') break;
    expect(last.progress).toBeGreaterThanOrEqual(0);
  }
  expect(last.state).toBe('done');
  if (last.state === 'done') expect(last.result.accounts[0]?.address).toBe(FIRST);
});

it('explains a code it can’t read, and reads the next one', () => {
  const scanner = createHardwareScanner();
  const scan = scanner.feed('ur:crypto-hdkey/lpadahcslncyftfpwdmt');
  expect(scan.state).toBe('error');
  if (scan.state === 'error')
    expect(scan.message).toMatch(/didn’t read right|isn’t an account code/);
  // The scanner started over, so a good code right after it still reads.
  const next = scanner.feed(SINGLE);
  expect(next.state).toBe('done');
  expect(isHardwareUr('ur:crypto-psbt/abc')).toBe(false);
});

it('starts over when the device switches to another code mid-scan', () => {
  const scanner = createHardwareScanner();
  expect(scanner.feed(PARTS[0] as string).state).toBe('scanning');
  // A different code (the single-frame one) replaces the half-read animated one.
  const switched = scanner.feed(SINGLE);
  expect(switched.state).toBe('done');
  if (switched.state === 'done') expect(switched.result.accounts[0]?.address).toBe(FIRST);
});

it('reports other QR codes as foreign', () => {
  const scan = createHardwareScanner().feed('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  expect(scan).toMatchObject({ state: 'scanning', foreign: true });
});
